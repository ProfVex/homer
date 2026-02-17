/**
 * Memory v2 — Solution-oriented memory for Homer agents.
 *
 * Six memory types:
 *   file_knowledge         — What we know about each file (co-changes, errors, fixes)
 *   solutions              — Error → Fix mappings with confidence scores
 *   task_runs              — Structured history of what happened per task per agent
 *   repo_rules             — Learned patterns with Bayesian hit/miss tracking
 *   verification_episodes  — Per-verification structured records (US-003)
 *   error_file_relations   — Error → File causal links (US-003)
 *
 * Design principles:
 *   - Write at verification time (not just on agent death)
 *   - Read returns task-specific context (not generic repo-wide rules)
 *   - Every injected token must earn its place in the agent's context window
 *   - Deterministic queries (by path, error key, task key) — no semantic search needed
 *
 * Storage: SQLite via bun:sqlite, one DB per repo at:
 *   ~/.homer/context/{repo-slug}/memory.db
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Constants ───────────────────────────────────────────────────────────────

const HOMER_DIR = join(homedir(), ".homer");
const CONTEXT_DIR = join(HOMER_DIR, "context");

// Co-change threshold: files must appear together in N+ task_runs to be linked
const COCHANGE_MIN_RUNS = 2;

// MemRL-inspired Q-value learning rate (EMA: Q_new = Q_old + α(r - Q_old))
const ALPHA = 0.3;

// Max items per read function output
const MAX_SOLUTIONS_PER_FILE = 3;
const MAX_TASK_HISTORY = 5;
const MAX_RULES = 8;

// ── Singleton state ─────────────────────────────────────────────────────────

let db = null;
let currentSlug = null;
let _lastInjectedRuleIds = [];

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_V2 = `
  -- What we know about each file
  CREATE TABLE IF NOT EXISTS file_knowledge (
    path        TEXT PRIMARY KEY,
    imports     TEXT,
    exports     TEXT,
    cochanges   TEXT,
    last_error  TEXT,
    last_fix    TEXT,
    touch_count INTEGER DEFAULT 0,
    updated_at  TEXT NOT NULL
  );

  -- Error → Fix mappings (the money table)
  CREATE TABLE IF NOT EXISTS solutions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    error_key   TEXT NOT NULL,
    error_text  TEXT NOT NULL,
    fix_summary TEXT,
    fix_files   TEXT,
    confidence  REAL DEFAULT 0.5,
    attempts    INTEGER DEFAULT 1,
    resolved    INTEGER DEFAULT 0,
    task_key    TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  -- What happened on each task attempt
  CREATE TABLE IF NOT EXISTS task_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key        TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    tool_id         TEXT,
    outcome         TEXT NOT NULL DEFAULT 'running',
    attempts        INTEGER DEFAULT 0,
    files_touched   TEXT,
    errors          TEXT,
    duration_ms     INTEGER,
    notes           TEXT,
    created_at      TEXT NOT NULL
  );

  -- Learned patterns with hit/miss tracking
  CREATE TABLE IF NOT EXISTS repo_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scope       TEXT NOT NULL DEFAULT 'repo',
    rule        TEXT NOT NULL,
    confidence  REAL DEFAULT 0.5,
    source      TEXT,
    hits        INTEGER DEFAULT 0,
    misses      INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(scope, rule)
  );

  -- Per-verification structured records (US-003)
  CREATE TABLE IF NOT EXISTS verification_episodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key    TEXT,
    agent_id    TEXT NOT NULL,
    attempt     INTEGER NOT NULL,
    passed      INTEGER NOT NULL DEFAULT 0,
    checks      TEXT NOT NULL,
    files       TEXT,
    created_at  TEXT NOT NULL
  );

  -- Error → File causal links (US-003)
  CREATE TABLE IF NOT EXISTS error_file_relations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    error_key   TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    relation    TEXT NOT NULL DEFAULT 'caused_by',
    occurrences INTEGER DEFAULT 1,
    created_at  TEXT NOT NULL,
    UNIQUE(error_key, file_path, relation)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_solutions_error ON solutions(error_key);
  CREATE INDEX IF NOT EXISTS idx_solutions_conf ON solutions(confidence DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_key);
  CREATE INDEX IF NOT EXISTS idx_runs_agent ON task_runs(agent_id);
  CREATE INDEX IF NOT EXISTS idx_rules_scope ON repo_rules(scope);
  CREATE INDEX IF NOT EXISTS idx_episodes_task ON verification_episodes(task_key);
  CREATE INDEX IF NOT EXISTS idx_episodes_agent ON verification_episodes(agent_id);
  CREATE INDEX IF NOT EXISTS idx_relations_error ON error_file_relations(error_key);
  CREATE INDEX IF NOT EXISTS idx_relations_file ON error_file_relations(file_path);
`;

// ── Init / Cleanup ──────────────────────────────────────────────────────────

/**
 * Open (or create) the memory database for a repo.
 * Handles migration from v1 schema if old tables exist.
 *
 * @param {string} repoSlug — slug from context.js (e.g. "profvex-homer")
 */
export function initMemory(repoSlug) {
  if (db && currentSlug === repoSlug) return;
  if (db) closeMemory();

  const dir = join(CONTEXT_DIR, repoSlug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, "memory.db");
  db = new Database(dbPath);

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  // Check if migration needed (v1 → v2)
  const hasOldSchema = _hasTable("entities");
  const hasNewSchema = _hasTable("file_knowledge");

  if (hasOldSchema && !hasNewSchema) {
    _migrateV1toV2();
  } else if (!hasNewSchema) {
    db.exec(SCHEMA_V2);
  }

  // Ensure US-003 tables exist on existing v2 DBs (additive, IF NOT EXISTS is safe)
  if (!_hasTable("verification_episodes")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT, agent_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, passed INTEGER NOT NULL DEFAULT 0,
        checks TEXT NOT NULL, files TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS error_file_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, error_key TEXT NOT NULL, file_path TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'caused_by', occurrences INTEGER DEFAULT 1,
        created_at TEXT NOT NULL, UNIQUE(error_key, file_path, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_task ON verification_episodes(task_key);
      CREATE INDEX IF NOT EXISTS idx_episodes_agent ON verification_episodes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_relations_error ON error_file_relations(error_key);
      CREATE INDEX IF NOT EXISTS idx_relations_file ON error_file_relations(file_path);
    `);
  }

  currentSlug = repoSlug;
}

/**
 * Close the memory database.
 */
export function closeMemory() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
    currentSlug = null;
  }
}

/**
 * Get the raw database handle (for tests).
 */
export function getDb() {
  return db;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function _hasTable(name) {
  if (!db) return false;
  const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

function _parseJSON(str, fallback = []) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Write: Record Verification ──────────────────────────────────────────────

/**
 * Record a verification run. Called by engine after EACH verify (pass or fail).
 *
 * @param {string} agentId — "agent-3"
 * @param {string} taskKey — "story:US-001" or "issue:42"
 * @param {object} verifyResult — from runVerification(): { passed, results: [{name, cmd, passed, output, errorKey?}] }
 * @param {string[]} filesTouched — file paths extracted from agent output
 * @param {string} [toolId] — "claude" | "aider" etc.
 */
export function recordVerification(agentId, taskKey, verifyResult, filesTouched = [], toolId = null, attempt = 1) {
  if (!db || !taskKey) return;

  const ts = now();
  const filesJson = JSON.stringify(filesTouched);
  const failed = verifyResult.results.filter(r => !r.passed);

  // US-003 AC1/AC2: Record structured episode for every verification run
  try { recordEpisode(agentId, taskKey, attempt, verifyResult, filesTouched); } catch {}

  // Build structured errors array
  const errors = failed.map(r => ({
    check: r.name,
    error_key: r.errorKey || `${r.name}:unknown`,
    output: (r.output || "").slice(0, 500),
  }));
  const errorsJson = JSON.stringify(errors);

  // Check if there's already a run for this agent+task
  const existing = db.query(
    "SELECT id, attempts FROM task_runs WHERE agent_id = ? AND task_key = ? ORDER BY created_at DESC LIMIT 1"
  ).get(agentId, taskKey);

  if (existing) {
    // Update existing run
    db.query(`
      UPDATE task_runs SET
        attempts = attempts + 1,
        files_touched = ?,
        errors = ?,
        outcome = ?
      WHERE id = ?
    `).run(filesJson, errorsJson, verifyResult.passed ? "passed" : "running", existing.id);
  } else {
    // Insert new run
    db.query(`
      INSERT INTO task_runs (task_key, agent_id, tool_id, outcome, attempts, files_touched, errors, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(taskKey, agentId, toolId, verifyResult.passed ? "passed" : "running", filesJson, errorsJson, ts);
  }

  // Update file_knowledge for each file touched
  for (const fp of filesTouched) {
    _touchFile(fp, failed.length > 0 ? errors[0]?.output?.slice(0, 200) : null);
  }

  // Upsert solutions for each failed check
  for (const err of errors) {
    _upsertSolution(err.error_key, err.output, taskKey);
  }
}

/**
 * Record a verification episode (US-003 AC1/AC2).
 * Called after EACH verification run — creates a per-attempt record with
 * structured check data and error→file causal relations.
 *
 * @param {string} agentId
 * @param {string} taskKey
 * @param {number} attempt — current verify attempt number
 * @param {object} verifyResult — { passed, results: [{name, cmd, passed, output, errorKey?}] }
 * @param {string[]} filesTouched
 */
export function recordEpisode(agentId, taskKey, attempt, verifyResult, filesTouched = []) {
  if (!db) return;

  const ts = now();

  // Build structured checks array: which ran, which passed/failed, truncated output
  const checks = verifyResult.results.map(r => ({
    name: r.name,
    passed: r.passed,
    error_key: r.errorKey || null,
    output: r.passed ? null : (r.output || "").slice(0, 200),
  }));

  db.query(`
    INSERT INTO verification_episodes (task_key, agent_id, attempt, passed, checks, files, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskKey, agentId, attempt, verifyResult.passed ? 1 : 0, JSON.stringify(checks), JSON.stringify(filesTouched), ts);

  // AC7: For each failed check, add error→file causal relations
  const failed = checks.filter(c => !c.passed && c.error_key);
  for (const check of failed) {
    for (const fp of filesTouched) {
      const existing = db.query(
        "SELECT id FROM error_file_relations WHERE error_key = ? AND file_path = ? AND relation = 'caused_by'"
      ).get(check.error_key, fp);

      if (existing) {
        db.query("UPDATE error_file_relations SET occurrences = occurrences + 1 WHERE id = ?").run(existing.id);
      } else {
        db.query(`
          INSERT INTO error_file_relations (error_key, file_path, relation, created_at)
          VALUES (?, ?, 'caused_by', ?)
        `).run(check.error_key, fp, ts);
      }
    }
  }
}

/**
 * Record a successful completion. Called when agent passes verification.
 *
 * @param {string} agentId
 * @param {string} taskKey
 * @param {string[]} filesTouched
 * @param {number} verifyAttempts — how many tries it took
 * @param {string[]} [injectedRuleIds] — IDs of rules that were injected into this agent's prompt
 */
export function recordSuccess(agentId, taskKey, filesTouched = [], verifyAttempts = 1, injectedRuleIds = []) {
  if (!db || !taskKey) return;

  const ts = now();

  // Update task_run outcome
  db.query(`
    UPDATE task_runs SET outcome = 'passed', duration_ms = ?, attempts = ?
    WHERE agent_id = ? AND task_key = ?
    ORDER BY created_at DESC LIMIT 1
  `).run(null, verifyAttempts, agentId, taskKey);

  // Resolve solutions that this agent encountered
  // Find errors from previous failed attempts on this task run
  const run = db.query(
    "SELECT errors FROM task_runs WHERE agent_id = ? AND task_key = ? ORDER BY created_at DESC LIMIT 1"
  ).get(agentId, taskKey);

  if (run?.errors) {
    const prevErrors = _parseJSON(run.errors);
    for (const err of prevErrors) {
      if (err.error_key) {
        // EMA Q-value update: Q_new = Q_old + α(reward - Q_old), reward=+1 for success
        // In SQLite: confidence reads old value on RHS, so formula is direct
        db.query(`
          UPDATE solutions SET
            resolved = 1,
            fix_files = ?,
            confidence = MIN(confidence + ${ALPHA} * (1.0 - confidence), 1.0),
            updated_at = ?
          WHERE error_key = ? AND resolved = 0
        `).run(JSON.stringify(filesTouched), ts, err.error_key);

        // Generate reflection: structured natural language from error→fix data
        const reflection = _generateReflection(err, filesTouched, agentId, verifyAttempts);
        if (reflection) {
          db.query("UPDATE solutions SET fix_summary = ? WHERE error_key = ? AND resolved = 1 AND fix_summary IS NULL")
            .run(reflection, err.error_key);
        }

        // Update file_knowledge with the fix
        for (const fp of filesTouched) {
          db.query(`
            UPDATE file_knowledge SET last_fix = ?, updated_at = ?
            WHERE path = ? AND last_error IS NOT NULL
          `).run(reflection || `Fixed by ${agentId}: ${err.error_key}`, ts, fp);
        }
      }
    }
  }

  // Track rule effectiveness (Bayesian: confidence = (hits+1) / (hits+misses+2))
  // Note: in SQLite UPDATE, RHS reads old values, so use hits+1 and hits+1+misses+2
  for (const ruleId of injectedRuleIds) {
    db.query("UPDATE repo_rules SET hits = hits + 1, confidence = CAST(hits + 1 + 1 AS REAL) / (hits + 1 + misses + 2), updated_at = ? WHERE id = ?")
      .run(ts, ruleId);
  }

  // Compute co-changes
  _updateCochanges(filesTouched);

  // Create rule if task needed multiple attempts
  if (verifyAttempts > 1 && filesTouched.length > 0) {
    const scope = `file:${filesTouched[0]}`;
    upsertRule(scope,
      `Task ${taskKey} needed ${verifyAttempts} verification attempts on ${filesTouched.slice(0, 3).join(", ")}. Check carefully before signaling done.`,
      0.6,
      `${agentId} on ${taskKey}`
    );
  }
}

/**
 * Record a failure (agent failed, blocked, crashed, or timed out).
 *
 * @param {string} agentId
 * @param {string} taskKey
 * @param {string} reason — failure description
 * @param {string} outcome — "failed" | "blocked" | "crashed" | "timeout"
 * @param {string[]} [filesTouched]
 * @param {string[]} [injectedRuleIds]
 */
export function recordFailure(agentId, taskKey, reason, outcome = "failed", filesTouched = [], injectedRuleIds = []) {
  if (!db) return;

  const ts = now();

  if (taskKey) {
    // Generate failure reflection (Reflexion-style verbal feedback)
    const failReflection = _generateFailureReflection(agentId, taskKey, reason, outcome, filesTouched);

    // Update or insert task_run
    const existing = db.query(
      "SELECT id FROM task_runs WHERE agent_id = ? AND task_key = ? ORDER BY created_at DESC LIMIT 1"
    ).get(agentId, taskKey);

    if (existing) {
      db.query("UPDATE task_runs SET outcome = ?, notes = ? WHERE id = ?")
        .run(outcome, failReflection || reason?.slice(0, 500), existing.id);
    } else {
      db.query(`
        INSERT INTO task_runs (task_key, agent_id, outcome, notes, files_touched, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskKey, agentId, outcome, failReflection || reason?.slice(0, 500), JSON.stringify(filesTouched), ts);
    }
  }

  // EMA Q-value update for failure: Q_new = Q_old + α(reward - Q_old), reward=-1
  // This pulls confidence toward 0 proportionally (unresolved solutions lose more when high)
  for (const fp of filesTouched) {
    db.query(`
      UPDATE solutions SET confidence = MAX(confidence + ${ALPHA} * (-1.0 - confidence), 0.0), updated_at = ?
      WHERE error_key LIKE ? AND resolved = 0
    `).run(ts, `%${fp}%`);
  }

  // Track rule ineffectiveness (Bayesian: confidence = (hits+1) / (hits+misses+2))
  // Note: in SQLite UPDATE, RHS reads old values, so account for misses+1
  for (const ruleId of injectedRuleIds) {
    db.query("UPDATE repo_rules SET misses = misses + 1, confidence = CAST(hits + 1 AS REAL) / (hits + misses + 1 + 2), updated_at = ? WHERE id = ?")
      .run(ts, ruleId);
  }

  // Prune dead rules (confidence bottomed out)
  db.query("DELETE FROM repo_rules WHERE confidence <= 0.05 AND misses > 3").run();

  // AC4: Create rules from persistent verification errors
  // Look at the most recent task_run for this agent to find persistent error patterns
  if (taskKey && filesTouched.length > 0) {
    const run = db.query(
      "SELECT errors FROM task_runs WHERE agent_id = ? AND task_key = ? ORDER BY created_at DESC LIMIT 1"
    ).get(agentId, taskKey);
    if (run?.errors) {
      const errors = _parseJSON(run.errors);
      for (const err of errors.slice(0, 2)) {
        if (err.error_key) {
          const scope = `file:${filesTouched[0]}`;
          const checkType = err.error_key.split(":")[0] || "check";
          upsertRule(scope,
            `${checkType} error "${err.error_key}" persists — previous approach failed. Try a different strategy.`,
            0.4,
            `${agentId} failure on ${taskKey}`
          );
          // Also create check-scoped rule for AC8
          upsertRule(`check:${checkType}`,
            `${err.error_key} was NOT resolved — may need a different fix approach.`,
            0.3,
            `${agentId} failure`
          );
        }
      }
    }
  }
}

// ── Write: File Knowledge ───────────────────────────────────────────────────

/**
 * Touch a file — increment touch count, optionally set last error.
 * @private
 */
function _touchFile(filePath, lastError = null) {
  if (!db) return;
  const ts = now();

  const existing = db.query("SELECT path FROM file_knowledge WHERE path = ?").get(filePath);
  if (existing) {
    if (lastError) {
      db.query("UPDATE file_knowledge SET touch_count = touch_count + 1, last_error = ?, updated_at = ? WHERE path = ?")
        .run(lastError, ts, filePath);
    } else {
      db.query("UPDATE file_knowledge SET touch_count = touch_count + 1, updated_at = ? WHERE path = ?")
        .run(ts, filePath);
    }
  } else {
    db.query(`
      INSERT INTO file_knowledge (path, touch_count, last_error, updated_at)
      VALUES (?, 1, ?, ?)
    `).run(filePath, lastError, ts);
  }
}

/**
 * Update file knowledge (imports, exports, co-changes).
 * Called during project indexing or from agent output analysis.
 *
 * @param {string} filePath
 * @param {object} data — { imports?: string[], exports?: string[], cochanges?: string[] }
 */
export function updateFileKnowledge(filePath, data = {}) {
  if (!db) return;
  const ts = now();

  const existing = db.query("SELECT path FROM file_knowledge WHERE path = ?").get(filePath);
  if (existing) {
    const updates = [];
    const params = [];
    if (data.imports) { updates.push("imports = ?"); params.push(JSON.stringify(data.imports)); }
    if (data.exports) { updates.push("exports = ?"); params.push(JSON.stringify(data.exports)); }
    if (data.cochanges) { updates.push("cochanges = ?"); params.push(JSON.stringify(data.cochanges)); }
    if (updates.length > 0) {
      updates.push("updated_at = ?");
      params.push(ts, filePath);
      db.query(`UPDATE file_knowledge SET ${updates.join(", ")} WHERE path = ?`).run(...params);
    }
  } else {
    db.query(`
      INSERT INTO file_knowledge (path, imports, exports, cochanges, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      filePath,
      data.imports ? JSON.stringify(data.imports) : null,
      data.exports ? JSON.stringify(data.exports) : null,
      data.cochanges ? JSON.stringify(data.cochanges) : null,
      ts
    );
  }
}

// ── Write: Solutions ────────────────────────────────────────────────────────

/**
 * Upsert a solution entry for an error.
 * @private
 */
function _upsertSolution(errorKey, errorText, taskKey) {
  if (!db || !errorKey) return;
  const ts = now();

  const existing = db.query("SELECT id, attempts FROM solutions WHERE error_key = ?").get(errorKey);
  if (existing) {
    db.query(`
      UPDATE solutions SET
        attempts = attempts + 1,
        error_text = ?,
        task_key = COALESCE(?, task_key),
        updated_at = ?
      WHERE id = ?
    `).run(errorText?.slice(0, 500), taskKey, ts, existing.id);
  } else {
    db.query(`
      INSERT INTO solutions (error_key, error_text, task_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(errorKey, (errorText || "").slice(0, 500), taskKey, ts, ts);
  }
}

// ── Write: Rules ────────────────────────────────────────────────────────────

/**
 * Upsert a procedural rule. If same scope+rule exists, boosts confidence.
 *
 * @param {string} scope — "repo" | "file:lib/auth.js" | "check:typecheck"
 * @param {string} rule — the instruction/pattern
 * @param {number} [confidence=0.5]
 * @param {string} [source] — which agent/task created this
 */
export function upsertRule(scope, rule, confidence = 0.5, source) {
  if (!db) return;
  const ts = now();

  const existing = db.query("SELECT id, confidence, hits, misses FROM repo_rules WHERE scope = ? AND rule = ?").get(scope, rule);
  if (existing) {
    const newConf = Math.min(existing.confidence + 0.1, 1.0);
    db.query("UPDATE repo_rules SET confidence = ?, source = COALESCE(?, source), updated_at = ? WHERE id = ?")
      .run(newConf, source, ts, existing.id);
  } else {
    db.query(`
      INSERT INTO repo_rules (scope, rule, confidence, source, hits, misses, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `).run(scope, rule, confidence, source, ts, ts);
  }
}

/**
 * Strengthen a rule (called when it led to success).
 */
export function strengthenRule(id, amount = 0.1) {
  if (!db) return;
  db.query("UPDATE repo_rules SET hits = hits + 1, confidence = MIN(confidence + ?, 1.0), updated_at = ? WHERE id = ?")
    .run(amount, now(), id);
}

/**
 * Weaken a rule (called when it didn't help).
 */
export function weakenRule(id, amount = 0.1) {
  if (!db) return;
  db.query("UPDATE repo_rules SET misses = misses + 1, confidence = MAX(confidence - ?, 0.0), updated_at = ? WHERE id = ?")
    .run(amount, now(), id);
  db.query("DELETE FROM repo_rules WHERE id = ? AND confidence <= 0.0").run(id);
}

// ── Write: Co-change Computation ────────────────────────────────────────────

/**
 * Update co-change relationships between files.
 * Files that appear together in multiple task_runs get linked.
 * @private
 */
function _updateCochanges(filesTouched) {
  if (!db || filesTouched.length < 2) return;

  const ts = now();

  // For each pair of files, check how many runs they co-appear in
  for (let i = 0; i < filesTouched.length; i++) {
    for (let j = i + 1; j < filesTouched.length; j++) {
      const a = filesTouched[i];
      const b = filesTouched[j];

      // Count co-occurrences across all task_runs
      const rows = db.query("SELECT files_touched FROM task_runs WHERE files_touched IS NOT NULL").all();
      let coCount = 0;
      for (const row of rows) {
        const files = _parseJSON(row.files_touched);
        if (files.includes(a) && files.includes(b)) coCount++;
      }

      if (coCount >= COCHANGE_MIN_RUNS) {
        // Update both files' cochanges
        _addCochange(a, b, ts);
        _addCochange(b, a, ts);
      }
    }
  }
}

function _addCochange(filePath, cochangePath, ts) {
  const row = db.query("SELECT cochanges FROM file_knowledge WHERE path = ?").get(filePath);
  if (!row) return;

  const existing = _parseJSON(row.cochanges);
  if (!existing.includes(cochangePath)) {
    existing.push(cochangePath);
    db.query("UPDATE file_knowledge SET cochanges = ?, updated_at = ? WHERE path = ?")
      .run(JSON.stringify(existing.slice(0, 10)), ts, filePath); // Cap at 10 co-changes
  }
}

// ── Read: Task-Specific Memory ──────────────────────────────────────────────

/**
 * Build task-specific memory for an agent about to start work.
 * Returns a formatted string with relevant solutions, history, and rules.
 *
 * @param {string} taskKey — "story:US-001" or "issue:42"
 * @param {string[]} [filePaths] — expected files this task will touch
 * @returns {string} — formatted memory section, or "" if empty
 */
export function buildTaskMemory(taskKey, filePaths = []) {
  if (!db) return "";

  const sections = [];

  // 1. Previous attempts on this task
  const history = getTaskHistory(taskKey);
  if (history.length > 0) {
    sections.push("PREVIOUS ATTEMPTS ON THIS TASK:");
    for (const run of history.slice(-MAX_TASK_HISTORY)) {
      const errSummary = _parseJSON(run.errors)
        .map(e => e.check + (e.output ? `: ${e.output.slice(0, 80)}` : ""))
        .join("; ");
      sections.push(`  ${run.agent_id} → ${run.outcome} (${run.attempts} verify attempts)${errSummary ? ": " + errSummary : ""}`);
    }
  }

  // 2. Known solutions for files likely to be involved
  //    Two-Phase Retrieval (MemRL-inspired):
  //    Phase A: Broad match by file path (relevance filter)
  //    Phase B: Rank by composite score = (1-λ)·resolved + λ·confidence
  const fileSolutions = [];
  const seenErrorKeys = new Set();
  for (const fp of filePaths.slice(0, 5)) {
    const sols = db.query(`
      SELECT error_key, error_text, fix_summary, confidence, resolved
      FROM solutions
      WHERE error_key LIKE ?
      ORDER BY (0.5 * resolved + 0.5 * confidence) DESC
      LIMIT ?
    `).all(`%${fp}%`, MAX_SOLUTIONS_PER_FILE);

    for (const s of sols) {
      if (!seenErrorKeys.has(s.error_key)) {
        seenErrorKeys.add(s.error_key);
        fileSolutions.push(s);
      }
    }
  }

  // Also pull task-scoped solutions (Phase A broadening)
  if (taskKey) {
    const taskSols = db.query(`
      SELECT error_key, error_text, fix_summary, confidence, resolved
      FROM solutions
      WHERE task_key = ?
      ORDER BY (0.5 * resolved + 0.5 * confidence) DESC
      LIMIT 3
    `).all(taskKey);

    for (const s of taskSols) {
      if (!seenErrorKeys.has(s.error_key)) {
        seenErrorKeys.add(s.error_key);
        fileSolutions.push(s);
      }
    }
  }

  // Phase B: final ranking by composite score
  fileSolutions.sort((a, b) =>
    (0.5 * b.resolved + 0.5 * b.confidence) - (0.5 * a.resolved + 0.5 * a.confidence)
  );

  if (fileSolutions.length > 0) {
    sections.push("");
    sections.push("KNOWN ERRORS ON THESE FILES:");
    for (const s of fileSolutions.slice(0, 6)) {
      const status = s.resolved ? `✓ SOLVED (${Math.round(s.confidence * 100)}%)` : `⚠ UNSOLVED`;
      sections.push(`  ${s.error_key} [${status}]`);
      if (s.fix_summary) sections.push(`    Fix: ${s.fix_summary.slice(0, 120)}`);
      if (!s.resolved) sections.push(`    Error: ${s.error_text.slice(0, 120)}`);
    }
  }

  // 3. File co-changes (what else might need updating)
  const cochangeWarnings = [];
  for (const fp of filePaths.slice(0, 5)) {
    const fk = db.query("SELECT cochanges, last_error FROM file_knowledge WHERE path = ?").get(fp);
    if (fk?.cochanges) {
      const cc = _parseJSON(fk.cochanges);
      if (cc.length > 0) {
        cochangeWarnings.push(`  ${fp} → also update: ${cc.join(", ")}`);
      }
    }
  }
  if (cochangeWarnings.length > 0) {
    sections.push("");
    sections.push("FILE DEPENDENCIES (files usually changed together):");
    sections.push(...cochangeWarnings);
  }

  // 4. Applicable rules (AC8: include check-scoped verification rules)
  const rules = _getApplicableRules(filePaths, { includeCheckScoped: true });
  if (rules.length > 0) {
    sections.push("");
    sections.push("PATTERNS FROM MEMORY:");
    for (const r of rules.slice(0, MAX_RULES)) {
      const conf = Math.round(r.confidence * 100);
      sections.push(`  - ${r.rule} (${conf}% confidence, ${r.hits}/${r.hits + r.misses} success)`);
    }
  }

  if (sections.length === 0) return "";
  return ["\nMEMORY (from previous work on this repo):", "", ...sections].join("\n");
}

/**
 * Build error-specific context for a verification retry.
 * More targeted than buildTaskMemory — focuses on THIS specific error.
 *
 * @param {string} errorKey — normalized error identifier
 * @param {string} [filePath] — file where error occurred
 * @returns {string} — formatted context, or "" if no relevant memory
 */
export function buildErrorContext(errorKey, filePath) {
  if (!db) return "";

  const parts = [];

  // Two-Phase Retrieval for error context:
  // Phase A: exact match first, then prefix match for related errors
  // Phase B: rank by composite score (resolved status + confidence)
  const solution = db.query(`
    SELECT error_key, error_text, fix_summary, fix_files, confidence, resolved, attempts
    FROM solutions WHERE error_key = ?
  `).get(errorKey);

  if (solution) {
    if (solution.resolved && solution.fix_summary) {
      parts.push(`MEMORY: This error was resolved before (${Math.round(solution.confidence * 100)}% confidence).`);
      parts.push(`  Fix: ${solution.fix_summary}`);
      if (solution.fix_files) {
        const files = _parseJSON(solution.fix_files);
        if (files.length > 0) parts.push(`  Files modified: ${files.join(", ")}`);
      }
    } else {
      parts.push(`MEMORY: This error has been seen ${solution.attempts} time(s) but NOT resolved yet.`);
      parts.push(`  Previous approach failed — try a DIFFERENT strategy.`);
    }
  }

  // Phase A broadening: check for related errors (same check type or same file)
  if (!solution?.resolved) {
    const prefix = errorKey.split(":").slice(0, 2).join(":");
    const related = db.query(`
      SELECT error_key, fix_summary, confidence, resolved
      FROM solutions
      WHERE error_key LIKE ? AND error_key != ? AND resolved = 1
      ORDER BY confidence DESC
      LIMIT 2
    `).all(`${prefix}%`, errorKey);

    if (related.length > 0) {
      parts.push(`  Related fixes that may help:`);
      for (const r of related) {
        parts.push(`    ${r.error_key}: ${(r.fix_summary || "").slice(0, 100)} (${Math.round(r.confidence * 100)}%)`);
      }
    }
  }

  // Check file co-changes
  if (filePath) {
    const fk = db.query("SELECT cochanges, last_fix FROM file_knowledge WHERE path = ?").get(filePath);
    if (fk?.cochanges) {
      const cc = _parseJSON(fk.cochanges);
      if (cc.length > 0) {
        parts.push(`  Note: ${filePath} is usually changed alongside: ${cc.join(", ")}`);
      }
    }
    if (fk?.last_fix) {
      parts.push(`  Last fix on ${filePath}: ${fk.last_fix.slice(0, 150)}`);
    }
  }

  return parts.join("\n");
}

/**
 * Build reroute context for a task being reassigned to a fresh agent.
 * Pulls structured history from task_runs + relevant solutions.
 *
 * @param {string} taskKey — "story:US-001" or "issue:42"
 * @param {string[]} [filePaths] — files the previous agent touched
 * @returns {string} — formatted context, or "" if no history
 */
export function buildRerouteContext(taskKey, filePaths = []) {
  if (!db) return "";

  const sections = [];

  // 1. Task-specific history (structured)
  const history = getTaskHistory(taskKey);
  if (history.length > 0) {
    sections.push("MEMORY — WHAT PREVIOUS AGENTS TRIED ON THIS TASK:");
    for (const run of history) {
      sections.push(`  ${run.agent_id}: ${run.outcome} (${run.attempts} attempts)`);
      const errors = _parseJSON(run.errors);
      for (const err of errors.slice(0, 3)) {
        sections.push(`    ${err.check}: ${(err.output || "").slice(0, 150)}`);
      }
      if (run.notes) sections.push(`    Note: ${run.notes.slice(0, 150)}`);
    }
  }

  // 2. Known solutions for involved files (two-phase: match then rank by composite score)
  const solutions = [];
  for (const fp of filePaths.slice(0, 5)) {
    const sols = db.query(`
      SELECT error_key, fix_summary, confidence, resolved
      FROM solutions WHERE error_key LIKE ?
      ORDER BY (0.5 * resolved + 0.5 * confidence) DESC LIMIT 3
    `).all(`%${fp}%`);
    for (const s of sols) {
      if (!solutions.find(x => x.error_key === s.error_key)) solutions.push(s);
    }
  }
  // Phase B: final sort by composite score
  solutions.sort((a, b) =>
    (0.5 * b.resolved + 0.5 * b.confidence) - (0.5 * a.resolved + 0.5 * a.confidence)
  );

  if (solutions.length > 0) {
    sections.push("");
    sections.push("MEMORY — KNOWN SOLUTIONS FOR INVOLVED FILES:");
    for (const s of solutions.slice(0, 5)) {
      if (s.resolved && s.fix_summary) {
        sections.push(`  ✓ ${s.error_key}: ${s.fix_summary.slice(0, 120)} (${Math.round(s.confidence * 100)}%)`);
      } else {
        sections.push(`  ⚠ ${s.error_key}: UNSOLVED — previous approaches failed`);
      }
    }
  }

  // 3. Applicable rules
  const rules = _getApplicableRules(filePaths);
  if (rules.length > 0) {
    sections.push("");
    sections.push("MEMORY — KNOWN PATTERNS:");
    for (const r of rules.slice(0, 5)) {
      sections.push(`  - ${r.rule} (${Math.round(r.confidence * 100)}%)`);
    }
  }

  if (sections.length === 0) return "";
  return sections.join("\n");
}

/**
 * Build rule hints for retry warning (backwards compatible with v1 API).
 *
 * @param {string[]} filePaths
 * @param {string[]} errorKeys
 * @returns {string}
 */
export function buildRuleHints(filePaths = [], errorKeys = []) {
  if (!db) return "";

  const hints = [];

  // Error-specific solutions
  for (const ek of errorKeys.slice(0, 3)) {
    const normalizedKey = ek.replace(/\s+/g, "-").toLowerCase().slice(0, 50);
    const sol = db.query("SELECT fix_summary, confidence, resolved FROM solutions WHERE error_key LIKE ? AND resolved = 1 ORDER BY confidence DESC LIMIT 1")
      .get(`%${normalizedKey}%`);
    if (sol?.fix_summary) {
      hints.push(`- Previous fix for "${ek}": ${sol.fix_summary.slice(0, 100)} (${Math.round(sol.confidence * 100)}%)`);
    }
  }

  // File-scoped rules
  for (const fp of filePaths.slice(0, 3)) {
    const rules = getRulesForScope(`file:${fp}`);
    for (const r of rules.slice(0, 2)) {
      const line = `- ${r.rule} (${Math.round(r.confidence * 100)}%)`;
      if (!hints.includes(line)) hints.push(line);
    }
  }

  // Repo-level rules
  const repoRules = getRepoRules();
  for (const r of repoRules.slice(0, 3)) {
    const line = `- ${r.rule} (${Math.round(r.confidence * 100)}%)`;
    if (!hints.includes(line)) hints.push(line);
  }

  if (hints.length === 0) return "";
  return ["", "KNOWN PATTERNS FROM MEMORY:", ...hints.slice(0, 6)].join("\n");
}

// ── Read: Specific Queries ──────────────────────────────────────────────────

/**
 * Get all task runs for a specific task.
 */
export function getTaskHistory(taskKey) {
  if (!db) return [];
  return db.query(`
    SELECT id, task_key, agent_id, tool_id, outcome, attempts, files_touched, errors, duration_ms, notes, created_at
    FROM task_runs WHERE task_key = ?
    ORDER BY created_at ASC
  `).all(taskKey);
}

/**
 * Get rules for a scope (+ repo fallback).
 */
export function getRulesForScope(scope) {
  if (!db) return [];
  return db.query(`
    SELECT id, scope, rule, confidence, hits, misses, updated_at
    FROM repo_rules
    WHERE (scope = ? OR scope = 'repo')
      AND confidence > 0.1
    ORDER BY confidence DESC
    LIMIT 10
  `).all(scope);
}

/**
 * Get all high-confidence repo-level rules.
 */
export function getRepoRules() {
  if (!db) return [];
  return db.query(`
    SELECT id, scope, rule, confidence, hits, misses, updated_at
    FROM repo_rules
    WHERE confidence > 0.3
    ORDER BY confidence DESC
    LIMIT 15
  `).all();
}

/**
 * Get files with high touch counts (conflict risk).
 */
export function getHighRiskFiles() {
  if (!db) return [];
  return db.query(`
    SELECT path, touch_count, last_error, cochanges
    FROM file_knowledge
    WHERE touch_count > 1
    ORDER BY touch_count DESC
    LIMIT 10
  `).all();
}

/**
 * Get recent failures from task_runs.
 */
export function getRecentFailures(limit = 5) {
  if (!db) return [];
  return db.query(`
    SELECT agent_id, task_key, outcome, errors, notes, created_at
    FROM task_runs
    WHERE outcome IN ('failed', 'blocked', 'crashed', 'timeout')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get file knowledge for a specific path.
 */
export function getFileKnowledge(filePath) {
  if (!db) return null;
  return db.query("SELECT * FROM file_knowledge WHERE path = ?").get(filePath);
}

/**
 * Get verification episodes for a task (US-003).
 */
export function getVerificationEpisodes(taskKey, limit = 20) {
  if (!db) return [];
  return db.query(`
    SELECT id, task_key, agent_id, attempt, passed, checks, files, created_at
    FROM verification_episodes WHERE task_key = ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(taskKey, limit);
}

/**
 * Get error→file relations for an error key (US-003 AC7).
 */
export function getErrorFileRelations(errorKey) {
  if (!db) return [];
  return db.query(`
    SELECT error_key, file_path, relation, occurrences
    FROM error_file_relations WHERE error_key = ?
    ORDER BY occurrences DESC
  `).all(errorKey);
}

/**
 * Get applicable rules for a set of files.
 * @private
 */
function _getApplicableRules(filePaths, { includeCheckScoped = false } = {}) {
  if (!db) return [];

  const rules = [];
  const seen = new Set();

  // File-scoped rules
  for (const fp of filePaths.slice(0, 5)) {
    const fileRules = db.query(`
      SELECT id, scope, rule, confidence, hits, misses FROM repo_rules
      WHERE scope = ? AND confidence > 0.1
      ORDER BY confidence DESC LIMIT 3
    `).all(`file:${fp}`);

    for (const r of fileRules) {
      if (!seen.has(r.rule)) { seen.add(r.rule); rules.push(r); }
    }
  }

  // AC8: Check-scoped rules (verification-specific patterns)
  if (includeCheckScoped) {
    const checkRules = db.query(`
      SELECT id, scope, rule, confidence, hits, misses FROM repo_rules
      WHERE scope LIKE 'check:%' AND confidence > 0.2
      ORDER BY confidence DESC LIMIT 5
    `).all();

    for (const r of checkRules) {
      if (!seen.has(r.rule)) { seen.add(r.rule); rules.push(r); }
    }
  }

  // Repo-level rules
  const repoRules = db.query(`
    SELECT id, scope, rule, confidence, hits, misses FROM repo_rules
    WHERE scope = 'repo' AND confidence > 0.3
    ORDER BY confidence DESC LIMIT 5
  `).all();

  for (const r of repoRules) {
    if (!seen.has(r.rule)) { seen.add(r.rule); rules.push(r); }
  }

  // Track injected rule IDs for AC5/AC6
  _lastInjectedRuleIds = rules.map(r => r.id);

  return rules;
}

/**
 * Get the IDs of rules that were injected in the most recent memory build.
 * Used by engine.js to track which rules to strengthen/weaken on task completion.
 *
 * @returns {number[]}
 */
export function getLastInjectedRuleIds() {
  return [..._lastInjectedRuleIds];
}

// ── Backwards Compatibility (v1 API surface for engine.js + context.js) ─────

/**
 * Extract memories from agent output. V2 version: simpler, focused on files only.
 * Engine should prefer recordVerification/recordSuccess/recordFailure directly.
 *
 * @param {object} agent — the agent object
 */
export function extractMemories(agent) {
  if (!db) return;

  const agentId = agent.id;
  const tKey = agent.story ? `story:${agent.story.id}`
    : agent.issue ? `issue:${agent.issue.number}`
    : null;

  const cleanOutput = stripAnsi(agent.outputBuffer || "");

  // Extract file paths
  const filePaths = [];
  const re = /(?:^|\s)((?:src|lib|app|pages|components|hooks|utils|test|tests|spec|config|public|assets|api|scripts|bin|deploy|docker|k8s|infra)\/[^\s,)]+\.[a-z]{1,5})/gi;
  let match;
  while ((match = re.exec(cleanOutput)) !== null) {
    const fp = match[1].replace(/[,.)]+$/, "");
    if (!filePaths.includes(fp)) filePaths.push(fp);
  }

  // Touch each file
  for (const fp of filePaths) {
    _touchFile(fp);
  }

  // Record task run if not already done via structured path
  if (tKey) {
    const existing = db.query("SELECT id FROM task_runs WHERE agent_id = ? AND task_key = ?").get(agentId, tKey);
    if (!existing) {
      const outcome = agent.status === "done" ? "passed"
        : agent.status === "failed" || agent.status === "rerouted" ? "failed"
        : agent.status === "blocked" ? "blocked"
        : agent.status === "exited" ? "crashed"
        : "failed";

      db.query(`
        INSERT INTO task_runs (task_key, agent_id, tool_id, outcome, attempts, files_touched, duration_ms, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tKey, agentId, agent.tool?.id || null, outcome,
        agent.verifyAttempts || 0, JSON.stringify(filePaths),
        agent.startedAt ? Date.now() - agent.startedAt : null,
        agent.blockReason || agent.failReason || null,
        now()
      );
    }
  }

  // Extract rules from verify history
  if (agent.verifyHistory?.length >= 2) {
    _extractRulesFromHistory(agent, filePaths);
  }
}

/**
 * Analyze verify history to detect patterns that should become rules.
 * @private
 */
function _extractRulesFromHistory(agent, filePaths) {
  const errorCounts = new Map();
  for (const h of agent.verifyHistory) {
    const errKeys = (h.errors || "").match(/TS\d{4,5}|Error:\s*.{10,50}/g) || [];
    for (const e of errKeys) {
      errorCounts.set(e, (errorCounts.get(e) || 0) + 1);
    }
  }

  const tKey = agent.story ? `story:${agent.story.id}`
    : agent.issue ? `issue:${agent.issue.number}`
    : "task";

  for (const [err, count] of errorCounts) {
    if (count >= 2) {
      const scope = filePaths.length > 0 ? `file:${filePaths[0]}` : "repo";
      const wasResolved = agent.status === "done";

      if (wasResolved) {
        upsertRule(scope,
          `"${err}" is tricky on this file — needed ${agent.verifyAttempts} attempts to resolve.`,
          0.6,
          `${agent.id} on ${tKey}`);
      } else {
        upsertRule(scope,
          `"${err}" was NOT resolved — may need a different approach or manual fix.`,
          0.4,
          `${agent.id} failure`);
      }
    }
  }
}

// ── Backwards Compat: buildMemorySection (used by context.js via buildSystemPrompt) ──

/**
 * Build a MEMORY section for system prompt injection.
 * V2: delegates to buildTaskMemory for task-aware context.
 * Falls back to generic repo-level context if no task info provided.
 *
 * @param {string} taskDescription — task being assigned (may be used for scoping)
 * @returns {Promise<string>} — formatted memory section (async for API compat)
 */
export async function buildMemorySection(taskDescription) {
  if (!db) return "";

  // Extract file paths from description for scoping
  const filePaths = [];
  const re = /(?:src|lib|app|pages|components|hooks|utils|test|tests|spec|config|public|assets)\/[^\s,)]+\.[a-z]{1,5}/gi;
  let m;
  while ((m = re.exec(taskDescription || "")) !== null) {
    filePaths.push(m[0].replace(/[,.)]+$/, ""));
  }

  // Use buildTaskMemory if we have context
  if (filePaths.length > 0) {
    return buildTaskMemory(null, filePaths);
  }

  // Generic fallback
  const sections = [];

  const rules = getRepoRules();
  if (rules.length > 0) {
    sections.push("PATTERNS THAT WORK:");
    for (const r of rules.slice(0, 5)) {
      sections.push(`- ${r.rule} (${Math.round(r.confidence * 100)}%)`);
    }
  }

  const risky = getHighRiskFiles();
  if (risky.length > 0) {
    sections.push("");
    sections.push("CAUTION (frequently modified files):");
    for (const f of risky.slice(0, 3)) {
      sections.push(`- ${f.path}: modified by ${f.touch_count} agents`);
    }
  }

  const failures = getRecentFailures(3);
  if (failures.length > 0) {
    sections.push("");
    sections.push("RECENT FAILURES (avoid repeating):");
    for (const f of failures) {
      const errSummary = _parseJSON(f.errors).map(e => e.check).join(", ");
      sections.push(`- ${f.agent_id} on ${f.task_key}: ${f.outcome}${errSummary ? " (" + errSummary + ")" : ""}`);
    }
  }

  if (sections.length === 0) return "";
  return ["\nMEMORY (from previous work on this repo):", "", ...sections].join("\n");
}

// ── Consolidation ───────────────────────────────────────────────────────────

/**
 * Consolidate memory: prune old low-value entries.
 */
export function consolidate() {
  if (!db) return;

  // Delete solutions with very low confidence and no resolution
  db.query("DELETE FROM solutions WHERE confidence < 0.1 AND resolved = 0").run();

  // Delete rules with zero confidence
  db.query("DELETE FROM repo_rules WHERE confidence <= 0.05").run();

  // Trim old task_runs (keep last 100 per task)
  db.query(`
    DELETE FROM task_runs WHERE id NOT IN (
      SELECT id FROM task_runs ORDER BY created_at DESC LIMIT 500
    )
  `).run();
}

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * Get memory database statistics.
 */
export function memoryStats() {
  if (!db) return null;

  const files = db.query("SELECT COUNT(*) as count FROM file_knowledge").get();
  const solutions = db.query("SELECT COUNT(*) as count FROM solutions").get();
  const resolved = db.query("SELECT COUNT(*) as count FROM solutions WHERE resolved = 1").get();
  const runs = db.query("SELECT COUNT(*) as count FROM task_runs").get();
  const rules = db.query("SELECT COUNT(*) as count FROM repo_rules").get();
  const verifyEpisodes = db.query("SELECT COUNT(*) as count FROM verification_episodes").get();
  const errorRelations = db.query("SELECT COUNT(*) as count FROM error_file_relations").get();

  return {
    files: files.count,
    solutions: solutions.count,
    solvedSolutions: resolved.count,
    taskRuns: runs.count,
    rules: rules.count,
    verificationEpisodes: verifyEpisodes.count,
    errorFileRelations: errorRelations.count,
    // Backwards compat fields
    entities: files.count,
    relations: errorRelations.count,
    episodes: verifyEpisodes.count || runs.count,
  };
}

// ── Migration (v1 → v2) ────────────────────────────────────────────────────

function _migrateV1toV2() {
  if (!db) return;

  // Create new tables
  db.exec(SCHEMA_V2);

  try {
    // Migrate entities (type='file') → file_knowledge
    const fileEntities = db.query("SELECT id, name, importance FROM entities WHERE type = 'file'").all();
    for (const ent of fileEntities) {
      const path = ent.name || ent.id.replace("file:", "");
      db.query("INSERT OR IGNORE INTO file_knowledge (path, touch_count, updated_at) VALUES (?, ?, ?)")
        .run(path, Math.round(ent.importance * 10), now());
    }

    // Migrate episodes → task_runs
    const episodes = db.query("SELECT agent_id, task_key, event_type, content, entities, created_at FROM episodes WHERE task_key IS NOT NULL").all();
    const taskAgentMap = new Map(); // track to avoid duplicates

    for (const ep of episodes) {
      const key = `${ep.agent_id}:${ep.task_key}`;
      if (taskAgentMap.has(key)) continue;
      taskAgentMap.set(key, true);

      const outcome = ep.event_type === "success" ? "passed"
        : ep.event_type === "failure" ? "failed"
        : ep.event_type === "blocked" ? "blocked"
        : "failed";

      db.query(`
        INSERT INTO task_runs (task_key, agent_id, outcome, notes, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(ep.task_key, ep.agent_id, outcome, ep.content?.slice(0, 500), ep.created_at);
    }

    // Migrate rules → repo_rules
    const oldRules = db.query("SELECT scope, rule, confidence, source, created_at, updated_at FROM rules").all();
    for (const r of oldRules) {
      db.query(`
        INSERT OR IGNORE INTO repo_rules (scope, rule, confidence, source, hits, misses, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, 0, ?, ?)
      `).run(r.scope, r.rule, r.confidence, r.source, r.created_at, r.updated_at);
    }

    // Drop old tables
    db.exec("DROP TABLE IF EXISTS entities_fts");
    db.exec("DROP TABLE IF EXISTS episodes_fts");
    db.exec("DROP TABLE IF EXISTS rules_fts");
    // Drop triggers (they reference old tables)
    db.exec("DROP TRIGGER IF EXISTS entities_ai");
    db.exec("DROP TRIGGER IF EXISTS entities_ad");
    db.exec("DROP TRIGGER IF EXISTS entities_au");
    db.exec("DROP TRIGGER IF EXISTS episodes_ai");
    db.exec("DROP TRIGGER IF EXISTS episodes_ad");
    db.exec("DROP TRIGGER IF EXISTS rules_ai");
    db.exec("DROP TRIGGER IF EXISTS rules_ad");
    db.exec("DROP TRIGGER IF EXISTS rules_au");
    db.exec("DROP TABLE IF EXISTS entities");
    db.exec("DROP TABLE IF EXISTS relations");
    db.exec("DROP TABLE IF EXISTS episodes");
    db.exec("DROP TABLE IF EXISTS rules");
  } catch (e) {
    // Migration failed — new tables are already created, old data is just lost
    // This is acceptable since most memory DBs will be fresh
  }
}

// ── Reflection Generation (Reflexion-inspired) ─────────────────────────────

/**
 * Generate a structured natural language reflection from error → fix data.
 * No LLM call — deterministic template based on structured error info.
 *
 * Reflexion pattern: failures → natural language → episodic memory → future injection.
 * We produce reflections like:
 *   "TS2322 on lib/auth.js: type mismatch. Fixed by modifying lib/auth.js, lib/types.ts (2 attempts)."
 *   "test:auth.test.js — assertion failures. Resolved after editing lib/auth.js (3 attempts)."
 *
 * @param {object} err — { check, error_key, output }
 * @param {string[]} filesTouched — files the fix modified
 * @param {string} agentId
 * @param {number} verifyAttempts
 * @returns {string|null}
 * @private
 */
function _generateReflection(err, filesTouched, agentId, verifyAttempts) {
  if (!err?.error_key) return null;

  const parts = [];

  // Parse error key for structured info
  const keyParts = err.error_key.split(":");
  const checkType = keyParts[0] || "check";

  // Extract the most useful bit of the error output
  const errorSnippet = _extractErrorSnippet(err.output || "");

  // Build the "what happened" part
  if (checkType === "typecheck" && keyParts[1]) {
    parts.push(`${keyParts[1]} error`);
    if (keyParts[2]) parts.push(`in ${keyParts[2]}`);
  } else if (checkType === "test" && keyParts[1]) {
    parts.push(`Test failure in ${keyParts[1]}`);
  } else if (checkType === "lint" && keyParts[1]) {
    parts.push(`Lint violation: ${keyParts[1]}`);
  } else {
    parts.push(`${checkType} error`);
  }

  if (errorSnippet) {
    parts.push(`— ${errorSnippet}`);
  }

  // Build the "how it was fixed" part
  const fixFiles = filesTouched.slice(0, 3).join(", ");
  if (fixFiles) {
    parts.push(`. Fixed by modifying ${fixFiles}`);
  }

  if (verifyAttempts > 1) {
    parts.push(` (${verifyAttempts} attempts)`);
  }

  parts.push(".");

  return parts.join("").slice(0, 300);
}

/**
 * Generate a failure reflection for reroute/retry context.
 * This gets stored in task_runs.notes and injected into the next agent.
 *
 * @param {string} agentId
 * @param {string} taskKey
 * @param {string} reason
 * @param {string} outcome — "failed" | "blocked" | "crashed"
 * @param {string[]} filesTouched
 * @returns {string|null}
 * @private
 */
function _generateFailureReflection(agentId, taskKey, reason, outcome, filesTouched) {
  if (!reason) return null;

  const parts = [];

  switch (outcome) {
    case "blocked":
      parts.push(`Agent ${agentId} was BLOCKED: ${reason.slice(0, 200)}.`);
      parts.push(" Next agent should find an alternative approach or request human help.");
      break;
    case "crashed":
      parts.push(`Agent ${agentId} CRASHED: ${reason.slice(0, 200)}.`);
      parts.push(" This may indicate a tool issue rather than a code problem.");
      break;
    case "timeout":
      parts.push(`Agent ${agentId} TIMED OUT on ${taskKey}.`);
      if (filesTouched.length > 0) {
        parts.push(` Was working on: ${filesTouched.slice(0, 3).join(", ")}.`);
      }
      parts.push(" Next agent should take a more focused approach.");
      break;
    default:
      parts.push(`Agent ${agentId} FAILED: ${reason.slice(0, 200)}.`);
      if (filesTouched.length > 0) {
        parts.push(` Files touched: ${filesTouched.slice(0, 3).join(", ")}.`);
      }
      parts.push(" Next agent should try a DIFFERENT strategy.");
      break;
  }

  return parts.join("").slice(0, 500);
}

/**
 * Extract the most useful error snippet from raw output.
 * Pulls out the first meaningful error message, stripping noise.
 * @private
 */
function _extractErrorSnippet(output) {
  if (!output) return null;

  // Try to find a clear error message
  const patterns = [
    /Type '([^']+)' is not assignable to type '([^']+)'/,
    /Property '([^']+)' does not exist on type '([^']+)'/,
    /Cannot find (?:module|name) '([^']+)'/,
    /Expected (\d+) arguments?, but got (\d+)/,
    /(?:Error|FAIL|AssertionError):\s*(.{10,80})/i,
    /expected (.{5,40}) to (?:equal|be|match) (.{5,40})/i,
  ];

  for (const pat of patterns) {
    const m = output.match(pat);
    if (m) return m[0].slice(0, 100);
  }

  // Fallback: first non-empty line that looks like an error
  const lines = output.split("\n").filter(l => l.trim().length > 10);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/error|fail|cannot|unexpected|missing/i)) {
      return trimmed.slice(0, 100);
    }
  }

  return null;
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
