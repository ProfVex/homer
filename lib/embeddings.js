/**
 * Embeddings — local vector embedding utilities for Homer memory.
 *
 * Uses @huggingface/transformers with all-MiniLM-L6-v2 (384-dim).
 * Runs entirely locally, no API key needed.
 *
 * Model is lazy-loaded on first embed() call and cached for the session.
 * Model files are cached in ~/.homer/models/ across sessions.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Constants ───────────────────────────────────────────────────────────────

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;
const CACHE_DIR = join(homedir(), ".homer", "models");

// ── Singleton state ─────────────────────────────────────────────────────────

let extractor = null;
let loadingPromise = null;

// ── Model Loading ───────────────────────────────────────────────────────────

/**
 * Lazy-load the embedding model. Safe to call multiple times —
 * returns the cached pipeline if already loaded, or waits if loading in progress.
 */
export async function loadModel() {
  if (extractor) return extractor;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    // Ensure cache directory exists
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }

    let pipeline, env;
    try {
      ({ pipeline, env } = await import("@huggingface/transformers"));
    } catch {
      throw new Error(
        "Embeddings require @huggingface/transformers. Install with: bun add @huggingface/transformers"
      );
    }

    // Point model cache to our directory
    env.cacheDir = CACHE_DIR;
    // Disable remote model fetching after first download (offline mode)
    // env.allowRemoteModels = true; // Keep true for first download

    extractor = await pipeline("feature-extraction", MODEL_ID, {
      quantized: true, // Use quantized model for smaller size + faster inference
    });

    return extractor;
  })();

  try {
    extractor = await loadingPromise;
    return extractor;
  } finally {
    loadingPromise = null;
  }
}

/**
 * Check if the model is loaded without triggering a load.
 */
export function isModelLoaded() {
  return extractor !== null;
}

// ── Embedding ───────────────────────────────────────────────────────────────

/**
 * Embed a single text string into a Float32Array(384).
 * Loads the model on first call.
 *
 * @param {string} text — text to embed (truncated to ~512 tokens internally by the model)
 * @returns {Promise<Float32Array>}
 */
export async function embed(text) {
  const model = await loadModel();
  const result = await model(text, { pooling: "mean", normalize: true });
  return new Float32Array(result.data);
}

/**
 * Embed multiple texts in a batch. More efficient than calling embed() in a loop.
 *
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>}
 */
export async function embedBatch(texts) {
  if (texts.length === 0) return [];

  const model = await loadModel();
  const result = await model(texts, { pooling: "mean", normalize: true });

  // Result shape: [batch_size, EMBEDDING_DIM]
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    const start = i * EMBEDDING_DIM;
    vectors.push(new Float32Array(result.data.slice(start, start + EMBEDDING_DIM)));
  }
  return vectors;
}

// ── Similarity ──────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors. Both must be normalized (which embed() does).
 * For normalized vectors, cosine similarity = dot product.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} similarity in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// ── Serialization ───────────────────────────────────────────────────────────

/**
 * Serialize a Float32Array to a Buffer for storage in SQLite BLOB column.
 *
 * @param {Float32Array} vec
 * @returns {Buffer}
 */
export function serializeVector(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize a Buffer (from SQLite BLOB) back to Float32Array.
 *
 * @param {Buffer|Uint8Array} blob
 * @returns {Float32Array}
 */
export function deserializeVector(blob) {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ── Exports ─────────────────────────────────────────────────────────────────

export const EMBEDDING_DIMENSION = EMBEDDING_DIM;
