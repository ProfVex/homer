import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cosineSimilarity,
  serializeVector,
  deserializeVector,
  EMBEDDING_DIMENSION,
  isModelLoaded,
} from "../lib/embeddings.js";

describe("embeddings.js", () => {
  describe("EMBEDDING_DIMENSION", () => {
    it("is 384 (all-MiniLM-L6-v2)", () => {
      assert.equal(EMBEDDING_DIMENSION, 384);
    });
  });

  describe("cosineSimilarity", () => {
    it("returns 1.0 for identical normalized vectors", () => {
      const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      // Normalize
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      const normalized = new Float32Array(v.map(x => x / norm));
      const sim = cosineSimilarity(normalized, normalized);
      assert.ok(Math.abs(sim - 1.0) < 0.001, `expected ~1.0, got ${sim}`);
    });

    it("returns ~0 for orthogonal vectors", () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      const sim = cosineSimilarity(a, b);
      assert.ok(Math.abs(sim) < 0.001, `expected ~0, got ${sim}`);
    });

    it("returns -1 for opposite vectors", () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([-1, 0, 0]);
      const sim = cosineSimilarity(a, b);
      assert.ok(Math.abs(sim - (-1)) < 0.001, `expected ~-1, got ${sim}`);
    });

    it("returns 0 for mismatched lengths", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([1, 0, 0]);
      const sim = cosineSimilarity(a, b);
      assert.equal(sim, 0);
    });
  });

  describe("serializeVector / deserializeVector", () => {
    it("roundtrips a Float32Array", () => {
      const original = new Float32Array([0.1, 0.2, -0.3, 0.99, 0.0]);
      const buf = serializeVector(original);
      assert.ok(Buffer.isBuffer(buf), "should return a Buffer");

      const restored = deserializeVector(buf);
      assert.equal(restored.length, original.length);
      for (let i = 0; i < original.length; i++) {
        assert.ok(Math.abs(restored[i] - original[i]) < 0.0001, `mismatch at index ${i}`);
      }
    });

    it("handles 384-dim vector (full embedding size)", () => {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) vec[i] = Math.random() * 2 - 1;
      const buf = serializeVector(vec);
      const restored = deserializeVector(buf);
      assert.equal(restored.length, 384);
      assert.equal(buf.byteLength, 384 * 4, "384 floats * 4 bytes each");
    });

    it("deserializeVector returns null for null input", () => {
      const result = deserializeVector(null);
      assert.equal(result, null);
    });
  });

  describe("isModelLoaded", () => {
    it("returns false before loading (model not loaded in tests)", () => {
      // We don't load the model in tests — too slow and downloads ~23MB
      assert.equal(isModelLoaded(), false);
    });
  });
});
