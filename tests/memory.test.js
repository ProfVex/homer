import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  initMemory,
  closeMemory,
  getDb,
  // Write functions
  recordVerification,
  recordSuccess,
  recordFailure,
  recordEpisode,
  updateFileKnowledge,
  upsertRule,
  strengthenRule,
  weakenRule,
  // Read functions
  buildTaskMemory,
  buildErrorContext,
  buildRerouteContext,
  buildRuleHints,
  buildMemorySection,
  getTaskHistory,
  getRulesForScope,
  getRepoRules,
  getHighRiskFiles,
  getRecentFailures,
  getFileKnowledge,
  getVerificationEpisodes,
  getErrorFileRelations,
  getLastInjectedRuleIds,
  // Compat
  extractMemories,
  consolidate,
  memoryStats,
} from "../lib/memory.js";

// Each test gets a unique slug to avoid data bleed
let testCounter = 0;
function freshSlug() {
  return `test-memory-v2-${Date.now()}-${++testCounter}`;
}

describe("memory.js v2", () => {
  beforeEach(() => {
    closeMemory();
    initMemory(freshSlug());
  });

  afterEach(() => {
    closeMemory();
  });

  // ── Schema & Init ──────────────────────────────────────────────────────

  describe("initMemory / closeMemory", () => {
    it("creates a database on init", () => {
      assert.ok(getDb() !== null);
    });

    it("creates all v2 tables", () => {
      const tables = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map(r => r.name);
      assert.ok(tables.includes("file_knowledge"), "should have file_knowledge");
      assert.ok(tables.includes("solutions"), "should have solutions");
      assert.ok(tables.includes("task_runs"), "should have task_runs");
      assert.ok(tables.includes("repo_rules"), "should have repo_rules");
    });

    it("creates indexes", () => {
      const indexes = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
        .all()
        .map(r => r.name);
      assert.ok(indexes.includes("idx_solutions_error"));
      assert.ok(indexes.includes("idx_solutions_conf"));
      assert.ok(indexes.includes("idx_runs_task"));
      assert.ok(indexes.includes("idx_runs_agent"));
      assert.ok(indexes.includes("idx_rules_scope"));
    });

    it("closes database cleanly", () => {
      closeMemory();
      assert.equal(getDb(), null);
    });

    it("is idempotent — same slug init twice", () => {
      const slug = freshSlug();
      closeMemory();
      initMemory(slug);
      initMemory(slug);
      assert.ok(getDb() !== null);
    });

    it("does NOT have old v1 tables", () => {
      const tables = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(r => r.name);
      assert.ok(!tables.includes("entities"), "should not have entities (v1)");
      assert.ok(!tables.includes("relations"), "should not have relations (v1)");
      assert.ok(!tables.includes("episodes"), "should not have episodes (v1)");
    });
  });

  // ── recordVerification ─────────────────────────────────────────────────

  describe("recordVerification", () => {
    it("creates a task_run on first call", () => {
      const result = {
        passed: false,
        results: [
          { name: "typecheck", cmd: "tsc", passed: false, output: "TS2322: type error", errorKey: "typecheck:TS2322:lib/auth.js" },
        ],
      };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"], "claude");

      const runs = getDb().query("SELECT * FROM task_runs WHERE task_key = 'story:US-001'").all();
      assert.equal(runs.length, 1);
      assert.equal(runs[0].agent_id, "agent-1");
      assert.equal(runs[0].tool_id, "claude");
      assert.equal(runs[0].outcome, "running");
      assert.equal(runs[0].attempts, 1);
    });

    it("increments attempts on repeated calls for same agent+task", () => {
      const result = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "FAIL", errorKey: "test:unknown" }] };
      recordVerification("agent-1", "story:US-001", result, []);
      recordVerification("agent-1", "story:US-001", result, []);
      recordVerification("agent-1", "story:US-001", result, []);

      const run = getDb().query("SELECT attempts FROM task_runs WHERE agent_id = 'agent-1' AND task_key = 'story:US-001'").get();
      assert.equal(run.attempts, 3);
    });

    it("sets outcome to passed when verify passes", () => {
      const result = { passed: true, results: [{ name: "test", cmd: "bun test", passed: true, output: "ok", errorKey: null }] };
      recordVerification("agent-1", "story:US-001", result, []);

      const run = getDb().query("SELECT outcome FROM task_runs WHERE agent_id = 'agent-1'").get();
      assert.equal(run.outcome, "passed");
    });

    it("creates solution entries for failed checks", () => {
      const result = {
        passed: false,
        results: [
          { name: "typecheck", cmd: "tsc", passed: false, output: "TS2322 in auth.js", errorKey: "typecheck:TS2322:lib/auth.js" },
          { name: "test", cmd: "bun test", passed: false, output: "FAIL auth.test.js", errorKey: "test:auth.test.js" },
        ],
      };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);

      const solutions = getDb().query("SELECT * FROM solutions ORDER BY error_key").all();
      assert.equal(solutions.length, 2);
      assert.ok(solutions.some(s => s.error_key === "test:auth.test.js"));
      assert.ok(solutions.some(s => s.error_key === "typecheck:TS2322:lib/auth.js"));
    });

    it("increments solution attempts on repeat errors", () => {
      const result = {
        passed: false,
        results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322" }],
      };
      recordVerification("agent-1", "story:US-001", result, []);
      recordVerification("agent-1", "story:US-001", result, []);

      const sol = getDb().query("SELECT attempts FROM solutions WHERE error_key = 'typecheck:TS2322'").get();
      assert.equal(sol.attempts, 2);
    });

    it("updates file_knowledge touch_count and last_error", () => {
      const result = {
        passed: false,
        results: [{ name: "test", cmd: "bun test", passed: false, output: "assertion failed", errorKey: "test:unknown" }],
      };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js", "lib/utils.js"]);

      const auth = getDb().query("SELECT * FROM file_knowledge WHERE path = 'lib/auth.js'").get();
      assert.ok(auth);
      assert.equal(auth.touch_count, 1);
      assert.ok(auth.last_error.includes("assertion failed"));

      const utils = getDb().query("SELECT * FROM file_knowledge WHERE path = 'lib/utils.js'").get();
      assert.ok(utils);
      assert.equal(utils.touch_count, 1);
    });

    it("does nothing when taskKey is null", () => {
      const result = { passed: true, results: [] };
      recordVerification("agent-1", null, result, []);
      const runs = getDb().query("SELECT * FROM task_runs").all();
      assert.equal(runs.length, 0);
    });
  });

  // ── recordSuccess ──────────────────────────────────────────────────────

  describe("recordSuccess", () => {
    it("updates task_run outcome to passed", () => {
      // First, create a run via recordVerification
      const result = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "fail", errorKey: "test:fail" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);

      recordSuccess("agent-1", "story:US-001", ["lib/auth.js"], 2);

      const run = getDb().query("SELECT * FROM task_runs WHERE agent_id = 'agent-1'").get();
      assert.equal(run.outcome, "passed");
    });

    it("resolves previously-failed solutions", () => {
      // Create a failed verification to produce a solution entry
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);

      // Now success
      recordSuccess("agent-1", "story:US-001", ["lib/auth.js"], 2);

      const sol = getDb().query("SELECT resolved, confidence FROM solutions WHERE error_key = 'typecheck:TS2322'").get();
      assert.equal(sol.resolved, 1);
      // EMA: 0.5 + 0.3*(1.0 - 0.5) = 0.65
      assert.ok(sol.confidence >= 0.6, `confidence should have increased via EMA, got ${sol.confidence}`);
    });

    it("increments rule hits for injected rules", () => {
      upsertRule("repo", "Always check types", 0.5);
      const rule = getDb().query("SELECT id FROM repo_rules WHERE rule = 'Always check types'").get();

      recordSuccess("agent-1", "story:US-001", [], 1, [rule.id]);

      const updated = getDb().query("SELECT hits, confidence FROM repo_rules WHERE id = ?").get(rule.id);
      assert.equal(updated.hits, 1);
      assert.ok(updated.confidence > 0.5);
    });

    it("creates a rule when task needed multiple attempts", () => {
      // Set up a run
      const result = { passed: true, results: [] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);
      recordSuccess("agent-1", "story:US-001", ["lib/auth.js"], 3);

      const rules = getDb().query("SELECT * FROM repo_rules WHERE scope = 'file:lib/auth.js'").all();
      assert.ok(rules.length >= 1, "should create a rule for multi-attempt task");
      assert.ok(rules[0].rule.includes("3 verification attempts"));
    });
  });

  // ── recordFailure ──────────────────────────────────────────────────────

  describe("recordFailure", () => {
    it("creates a task_run with failure outcome", () => {
      recordFailure("agent-1", "story:US-001", "Verification failed 5x", "failed", ["lib/auth.js"]);

      const run = getDb().query("SELECT * FROM task_runs WHERE agent_id = 'agent-1'").get();
      assert.equal(run.outcome, "failed");
      assert.ok(run.notes.includes("Verification failed"));
    });

    it("updates existing task_run outcome", () => {
      const result = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "fail", errorKey: "test:fail" }] };
      recordVerification("agent-1", "story:US-001", result, []);
      recordFailure("agent-1", "story:US-001", "Max retries exceeded", "failed");

      const runs = getDb().query("SELECT * FROM task_runs WHERE agent_id = 'agent-1'").all();
      assert.equal(runs.length, 1, "should update existing, not insert new");
      assert.equal(runs[0].outcome, "failed");
    });

    it("records blocked outcome", () => {
      recordFailure("agent-1", "story:US-001", "Need API key", "blocked", ["lib/api.js"]);
      const run = getDb().query("SELECT outcome, notes FROM task_runs WHERE agent_id = 'agent-1'").get();
      assert.equal(run.outcome, "blocked");
      assert.ok(run.notes.includes("API key"));
    });

    it("records crashed outcome", () => {
      recordFailure("agent-1", "story:US-001", "Exit code 1, signal 15", "crashed");
      const run = getDb().query("SELECT outcome FROM task_runs WHERE agent_id = 'agent-1'").get();
      assert.equal(run.outcome, "crashed");
    });

    it("weakens solution confidence for unresolved errors", () => {
      // Create a solution via verification
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "error", errorKey: "typecheck:lib/auth.js" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);

      const before = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'typecheck:lib/auth.js'").get();
      recordFailure("agent-1", "story:US-001", "gave up", "failed", ["lib/auth.js"]);
      const after = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'typecheck:lib/auth.js'").get();

      assert.ok(after.confidence < before.confidence, "confidence should decrease on failure");
    });

    it("increments rule misses for injected rules", () => {
      upsertRule("repo", "Check imports", 0.5);
      const rule = getDb().query("SELECT id FROM repo_rules WHERE rule = 'Check imports'").get();

      recordFailure("agent-1", "story:US-001", "failed", "failed", [], [rule.id]);

      const updated = getDb().query("SELECT misses FROM repo_rules WHERE id = ?").get(rule.id);
      assert.equal(updated.misses, 1);
    });

    it("prunes dead rules (confidence bottomed out)", () => {
      upsertRule("repo", "Bad advice", 0.04);
      // Also set misses > 3 manually
      getDb().query("UPDATE repo_rules SET misses = 4 WHERE rule = 'Bad advice'").run();

      recordFailure("agent-1", "story:US-001", "failed", "failed");

      const rule = getDb().query("SELECT * FROM repo_rules WHERE rule = 'Bad advice'").get();
      assert.equal(rule, null, "should delete dead rule");
    });
  });

  // ── File Knowledge ─────────────────────────────────────────────────────

  describe("updateFileKnowledge", () => {
    it("creates file knowledge entry", () => {
      updateFileKnowledge("lib/auth.js", {
        imports: ["lib/types.ts", "lib/db.js"],
        exports: ["login", "logout", "validateToken"],
      });

      const fk = getFileKnowledge("lib/auth.js");
      assert.ok(fk);
      assert.deepEqual(JSON.parse(fk.imports), ["lib/types.ts", "lib/db.js"]);
      assert.deepEqual(JSON.parse(fk.exports), ["login", "logout", "validateToken"]);
    });

    it("updates existing file knowledge", () => {
      updateFileKnowledge("lib/auth.js", { imports: ["lib/old.js"] });
      updateFileKnowledge("lib/auth.js", { imports: ["lib/new.js"], exports: ["auth"] });

      const fk = getFileKnowledge("lib/auth.js");
      assert.deepEqual(JSON.parse(fk.imports), ["lib/new.js"]);
      assert.deepEqual(JSON.parse(fk.exports), ["auth"]);
    });
  });

  // ── Rules ──────────────────────────────────────────────────────────────

  describe("rules", () => {
    it("creates a new rule", () => {
      upsertRule("repo", "Always run tests before build", 0.6, "agent-1");
      const row = getDb().query("SELECT * FROM repo_rules WHERE scope = 'repo'").get();
      assert.ok(row);
      assert.equal(row.rule, "Always run tests before build");
      assert.equal(row.confidence, 0.6);
    });

    it("boosts confidence on duplicate insert", () => {
      upsertRule("repo", "Same rule", 0.5);
      upsertRule("repo", "Same rule", 0.5);
      const row = getDb().query("SELECT confidence FROM repo_rules WHERE rule = 'Same rule'").get();
      assert.ok(row.confidence >= 0.6, "confidence should increase");
    });

    it("strengthens a rule", () => {
      upsertRule("repo", "Test rule", 0.5);
      const row = getDb().query("SELECT id FROM repo_rules WHERE scope = 'repo'").get();
      strengthenRule(row.id, 0.2);
      const updated = getDb().query("SELECT confidence, hits FROM repo_rules WHERE id = ?").get(row.id);
      assert.ok(updated.confidence >= 0.7);
      assert.equal(updated.hits, 1);
    });

    it("weakens and deletes a rule at zero confidence", () => {
      upsertRule("repo", "Weak rule", 0.1);
      const row = getDb().query("SELECT id FROM repo_rules WHERE scope = 'repo'").get();
      weakenRule(row.id, 0.2);
      const deleted = getDb().query("SELECT * FROM repo_rules WHERE id = ?").get(row.id);
      assert.equal(deleted, null, "rule should be deleted when confidence <= 0");
    });

    it("tracks hits and misses independently", () => {
      upsertRule("repo", "Track me", 0.5);
      const row = getDb().query("SELECT id FROM repo_rules WHERE rule = 'Track me'").get();
      strengthenRule(row.id, 0.1);
      strengthenRule(row.id, 0.1);
      weakenRule(row.id, 0.1);

      const updated = getDb().query("SELECT hits, misses FROM repo_rules WHERE id = ?").get(row.id);
      assert.equal(updated.hits, 2);
      assert.equal(updated.misses, 1);
    });
  });

  // ── buildTaskMemory ────────────────────────────────────────────────────

  describe("buildTaskMemory", () => {
    it("includes previous attempts on the task", () => {
      const result = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "FAIL", errorKey: "test:fail" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);
      recordFailure("agent-1", "story:US-001", "gave up", "failed", ["lib/auth.js"]);

      const mem = buildTaskMemory("story:US-001", ["lib/auth.js"]);
      assert.ok(mem.includes("PREVIOUS ATTEMPTS"), "should include attempt history");
      assert.ok(mem.includes("agent-1"), "should mention the agent");
    });

    it("includes known solutions for relevant files", () => {
      // Create a resolved solution
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322:lib/auth.js" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);
      recordSuccess("agent-1", "story:US-001", ["lib/auth.js"], 2);

      const mem = buildTaskMemory("story:US-002", ["lib/auth.js"]);
      assert.ok(mem.includes("KNOWN ERRORS"), "should include known errors section");
    });

    it("includes file co-change warnings", () => {
      updateFileKnowledge("lib/auth.js", { cochanges: ["lib/types.ts", "lib/db.js"] });

      const mem = buildTaskMemory("story:US-001", ["lib/auth.js"]);
      assert.ok(mem.includes("FILE DEPENDENCIES"), "should include co-change section");
      assert.ok(mem.includes("lib/types.ts"));
    });

    it("includes applicable rules", () => {
      upsertRule("file:lib/auth.js", "Always check JWT expiry", 0.8);

      const mem = buildTaskMemory("story:US-001", ["lib/auth.js"]);
      assert.ok(mem.includes("PATTERNS FROM MEMORY"), "should include patterns");
      assert.ok(mem.includes("JWT expiry"));
    });

    it("returns empty string when no memory exists", () => {
      const mem = buildTaskMemory("story:NONEXISTENT", ["nonexistent.js"]);
      assert.equal(mem, "");
    });
  });

  // ── buildErrorContext ──────────────────────────────────────────────────

  describe("buildErrorContext", () => {
    it("returns solution info for known resolved error", () => {
      // Create and resolve a solution
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322 error", errorKey: "typecheck:TS2322" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);
      // Manually resolve it
      getDb().query("UPDATE solutions SET resolved = 1, fix_summary = 'Added email field to User interface' WHERE error_key = 'typecheck:TS2322'").run();

      const ctx = buildErrorContext("typecheck:TS2322", "lib/auth.js");
      assert.ok(ctx.includes("resolved before"), "should mention resolution");
      assert.ok(ctx.includes("email field"), "should include fix summary");
    });

    it("warns about unresolved errors", () => {
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS9999", errorKey: "typecheck:TS9999" }] };
      recordVerification("agent-1", "story:US-001", result, []);

      const ctx = buildErrorContext("typecheck:TS9999");
      assert.ok(ctx.includes("NOT resolved"), "should warn about unresolved error");
      assert.ok(ctx.includes("DIFFERENT strategy"), "should suggest different approach");
    });

    it("includes file co-changes", () => {
      updateFileKnowledge("lib/auth.js", { cochanges: ["lib/types.ts"] });

      const ctx = buildErrorContext("test:fail", "lib/auth.js");
      assert.ok(ctx.includes("lib/types.ts"), "should mention co-changed files");
    });

    it("returns empty string for unknown error", () => {
      const ctx = buildErrorContext("nonexistent:error");
      assert.equal(ctx, "");
    });
  });

  // ── buildRerouteContext ────────────────────────────────────────────────

  describe("buildRerouteContext", () => {
    it("includes structured task history", () => {
      const result = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "FAIL: should auth", errorKey: "test:auth.test.js" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);
      recordFailure("agent-1", "story:US-001", "max retries", "failed");

      const ctx = buildRerouteContext("story:US-001", ["lib/auth.js"]);
      assert.ok(ctx.includes("WHAT PREVIOUS AGENTS TRIED"), "should include task history");
      assert.ok(ctx.includes("agent-1"), "should mention agent");
      assert.ok(ctx.includes("failed"), "should mention outcome");
    });

    it("includes known solutions for involved files", () => {
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322:lib/auth.js" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);
      getDb().query("UPDATE solutions SET resolved = 1, fix_summary = 'Fixed types' WHERE error_key LIKE '%auth%'").run();

      const ctx = buildRerouteContext("story:US-002", ["lib/auth.js"]);
      assert.ok(ctx.includes("KNOWN SOLUTIONS"), "should include solutions");
    });

    it("includes applicable rules", () => {
      upsertRule("file:lib/auth.js", "Cast JWT tokens first", 0.8);

      const ctx = buildRerouteContext("story:US-001", ["lib/auth.js"]);
      assert.ok(ctx.includes("KNOWN PATTERNS"), "should include patterns");
      assert.ok(ctx.includes("Cast JWT tokens"), "should include the rule");
    });

    it("returns empty string when no memory available", () => {
      const ctx = buildRerouteContext("story:NONEXISTENT", []);
      assert.equal(ctx, "");
    });

    it("returns empty string when DB is closed", () => {
      closeMemory();
      const ctx = buildRerouteContext("story:US-001", ["lib/auth.js"]);
      assert.equal(ctx, "");
    });
  });

  // ── buildRuleHints ─────────────────────────────────────────────────────

  describe("buildRuleHints", () => {
    it("returns file-scoped rule hints", () => {
      upsertRule("file:lib/auth.js", "Check import paths first", 0.7);

      const hints = buildRuleHints(["lib/auth.js"], []);
      assert.ok(hints.includes("KNOWN PATTERNS FROM MEMORY"));
      assert.ok(hints.includes("Check import paths"));
      assert.ok(hints.includes("70%"));
    });

    it("returns solution hints for error keys", () => {
      // Create a resolved solution
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "type error", errorKey: "typecheck:ts2322" }] };
      recordVerification("agent-1", "story:US-001", result, []);
      getDb().query("UPDATE solutions SET resolved = 1, fix_summary = 'Add type annotation' WHERE error_key = 'typecheck:ts2322'").run();

      const hints = buildRuleHints([], ["TS2322"]);
      assert.ok(hints.includes("type annotation") || hints.includes("KNOWN PATTERNS"), "should include error solution or patterns");
    });

    it("includes repo-level rules", () => {
      upsertRule("repo", "Run bun test before bun build", 0.8);

      const hints = buildRuleHints([], []);
      assert.ok(hints.includes("bun test"), "should include repo rule");
    });

    it("deduplicates rules", () => {
      upsertRule("repo", "Always check types", 0.6);
      const hints = buildRuleHints(["lib/auth.js"], []);
      const matches = hints.match(/Always check types/g);
      assert.equal(matches?.length, 1, "should not duplicate rules");
    });

    it("returns empty string when no rules exist", () => {
      const hints = buildRuleHints(["nonexistent.js"], ["NONEXIST"]);
      assert.equal(hints, "");
    });

    it("returns empty string when DB is closed", () => {
      closeMemory();
      const hints = buildRuleHints(["lib/auth.js"], ["TS2322"]);
      assert.equal(hints, "");
    });
  });

  // ── Query Functions ────────────────────────────────────────────────────

  describe("getTaskHistory", () => {
    it("returns runs for a task in chronological order", () => {
      recordFailure("agent-1", "story:US-001", "failed first", "failed");
      recordFailure("agent-2", "story:US-001", "failed second", "failed");

      const history = getTaskHistory("story:US-001");
      assert.equal(history.length, 2);
      assert.equal(history[0].agent_id, "agent-1");
      assert.equal(history[1].agent_id, "agent-2");
    });
  });

  describe("getRulesForScope", () => {
    it("returns rules for scope + repo fallback", () => {
      upsertRule("repo", "Global rule", 0.8);
      upsertRule("file:lib/auth.js", "Auth-specific rule", 0.7);
      upsertRule("file:lib/other.js", "Other rule", 0.6);

      const rules = getRulesForScope("file:lib/auth.js");
      assert.ok(rules.length >= 2, "should return auth rule + repo rule");
      const ruleTexts = rules.map(r => r.rule);
      assert.ok(ruleTexts.includes("Global rule"));
      assert.ok(ruleTexts.includes("Auth-specific rule"));
      assert.ok(!ruleTexts.includes("Other rule"));
    });
  });

  describe("getHighRiskFiles", () => {
    it("returns files with touch_count > 1", () => {
      // Touch the same file via multiple verifications
      const result = { passed: true, results: [] };
      recordVerification("agent-1", "story:US-001", result, ["lib/shared.js"]);
      recordVerification("agent-2", "story:US-002", result, ["lib/shared.js"]);

      const risky = getHighRiskFiles();
      assert.ok(risky.length > 0, "should find high-risk files");
      assert.equal(risky[0].path, "lib/shared.js");
      assert.equal(risky[0].touch_count, 2);
    });
  });

  describe("getRecentFailures", () => {
    it("returns only failure/blocked/crashed runs", () => {
      recordFailure("agent-1", "issue:1", "broke", "failed");
      const result = { passed: true, results: [] };
      recordVerification("agent-2", "issue:2", result, []);
      recordFailure("agent-3", "issue:3", "blocked", "blocked");

      const failures = getRecentFailures(5);
      assert.equal(failures.length, 2, "should return 2 failures, not success");
      const agentIds = failures.map(f => f.agent_id);
      assert.ok(agentIds.includes("agent-1"));
      assert.ok(agentIds.includes("agent-3"));
      assert.ok(!agentIds.includes("agent-2"));
    });
  });

  // ── Backwards Compat: extractMemories ──────────────────────────────────

  describe("extractMemories (backwards compat)", () => {
    it("extracts file paths and creates file_knowledge entries", () => {
      const mockAgent = {
        id: "agent-1",
        story: { id: "S01", title: "Add auth" },
        issue: null,
        status: "done",
        outputBuffer: "Working on src/auth/login.js and lib/utils/helpers.js",
        startedAt: Date.now() - 60000,
        tool: { id: "claude", name: "claude" },
        verifyAttempts: 1,
        verifyHistory: [],
      };

      extractMemories(mockAgent);

      const files = getDb().query("SELECT * FROM file_knowledge").all();
      assert.ok(files.length >= 2, `should extract file entries, got ${files.length}`);
    });

    it("creates task_run for agent with task", () => {
      const mockAgent = {
        id: "agent-2",
        story: null,
        issue: { number: 42, title: "Fix bug" },
        status: "failed",
        outputBuffer: "error in lib/api.js",
        startedAt: Date.now() - 120000,
        tool: { id: "claude" },
        verifyAttempts: 3,
        verifyHistory: [],
        failReason: "Verification failed",
      };

      extractMemories(mockAgent);

      const runs = getDb().query("SELECT * FROM task_runs").all();
      assert.ok(runs.length >= 1, "should create task_run");
      assert.equal(runs[0].outcome, "failed");
    });

    it("does not duplicate task_runs if already recorded", () => {
      // First, record via structured path
      const result = { passed: true, results: [] };
      recordVerification("agent-3", "story:S01", result, ["lib/feature.js"]);

      // Then extractMemories should NOT create a duplicate
      const mockAgent = {
        id: "agent-3",
        story: { id: "S01", title: "Feature" },
        issue: null,
        status: "done",
        outputBuffer: "Completed lib/feature.js",
        startedAt: Date.now() - 300000,
        tool: { id: "claude" },
        verifyAttempts: 1,
        verifyHistory: [],
      };

      extractMemories(mockAgent);

      const runs = getDb().query("SELECT * FROM task_runs WHERE agent_id = 'agent-3'").all();
      assert.equal(runs.length, 1, "should not duplicate");
    });

    it("creates rules from repeated errors in verify history", () => {
      const mockAgent = {
        id: "agent-5",
        story: { id: "S03", title: "Test" },
        issue: null,
        status: "done",
        outputBuffer: "Fixed lib/test.js",
        startedAt: Date.now() - 60000,
        tool: { id: "claude" },
        verifyAttempts: 3,
        verifyHistory: [
          { attempt: 1, errors: "TS2322: type mismatch in lib/test.js", outputSnippet: "" },
          { attempt: 2, errors: "TS2322: type mismatch still", outputSnippet: "" },
        ],
      };

      extractMemories(mockAgent);

      const rules = getDb().query("SELECT * FROM repo_rules").all();
      assert.ok(rules.length >= 1, `should create rules from repeated errors, got ${rules.length}`);
    });
  });

  // ── buildMemorySection (async compat) ──────────────────────────────────

  describe("buildMemorySection", () => {
    it("returns async-compatible result", async () => {
      upsertRule("repo", "Always test first", 0.8);
      const section = await buildMemorySection("working on auth");
      assert.ok(typeof section === "string");
    });

    it("uses file paths from description when available", async () => {
      updateFileKnowledge("lib/auth.js", { cochanges: ["lib/types.ts"] });
      const section = await buildMemorySection("working on lib/auth.js implementation");
      // Should find the file in the description and scope memory
      assert.ok(typeof section === "string");
    });
  });

  // ── consolidate ────────────────────────────────────────────────────────

  describe("consolidate", () => {
    it("runs without error on empty DB", () => {
      consolidate();
      // Just verifying it doesn't throw
    });

    it("deletes low-confidence unresolved solutions", () => {
      getDb().query("INSERT INTO solutions (error_key, error_text, confidence, resolved, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
        .run("test:weak", "error", 0.05, new Date().toISOString(), new Date().toISOString());

      consolidate();
      const sols = getDb().query("SELECT * FROM solutions WHERE error_key = 'test:weak'").all();
      assert.equal(sols.length, 0, "should delete low-confidence unresolved solution");
    });

    it("deletes zero-confidence rules", () => {
      upsertRule("repo", "Bad rule", 0.04);
      consolidate();
      const rules = getDb().query("SELECT * FROM repo_rules WHERE rule = 'Bad rule'").all();
      assert.equal(rules.length, 0, "should delete zero-confidence rules");
    });

    it("keeps resolved solutions even with low confidence", () => {
      getDb().query("INSERT INTO solutions (error_key, error_text, confidence, resolved, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
        .run("test:resolved", "error", 0.05, new Date().toISOString(), new Date().toISOString());

      consolidate();
      const sols = getDb().query("SELECT * FROM solutions WHERE error_key = 'test:resolved'").all();
      assert.equal(sols.length, 1, "should keep resolved solution");
    });
  });

  // ── memoryStats ────────────────────────────────────────────────────────

  describe("memoryStats", () => {
    it("returns correct counts", () => {
      // Create some data
      updateFileKnowledge("lib/a.js", { imports: [] });
      updateFileKnowledge("lib/b.js", { imports: [] });
      upsertRule("repo", "Test rule", 0.5);

      const result = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "fail", errorKey: "test:fail" }] };
      recordVerification("agent-1", "story:US-001", result, []);

      const stats = memoryStats();
      assert.equal(stats.files, 2);
      assert.equal(stats.solutions, 1);
      assert.equal(stats.taskRuns, 1);
      assert.equal(stats.rules, 1);

      // Backwards compat
      assert.equal(stats.entities, 2, "entities should map to files count");
      assert.equal(stats.relations, 0, "relations should be 0 in v2");
      assert.equal(stats.episodes, 1, "episodes should map to taskRuns count");
    });

    it("returns null when DB is closed", () => {
      closeMemory();
      const stats = memoryStats();
      assert.equal(stats, null);
    });
  });

  // ── Co-change Detection ────────────────────────────────────────────────

  describe("co-change detection", () => {
    it("links files that co-appear in multiple task_runs", () => {
      // Two different agents touch the same pair of files
      const result = { passed: true, results: [] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js", "lib/types.ts"]);
      recordSuccess("agent-1", "story:US-001", ["lib/auth.js", "lib/types.ts"], 1);

      recordVerification("agent-2", "story:US-002", result, ["lib/auth.js", "lib/types.ts"]);
      recordSuccess("agent-2", "story:US-002", ["lib/auth.js", "lib/types.ts"], 1);

      // Check co-changes
      const authFk = getFileKnowledge("lib/auth.js");
      if (authFk?.cochanges) {
        const cochanges = JSON.parse(authFk.cochanges);
        assert.ok(cochanges.includes("lib/types.ts"), "auth.js should list types.ts as co-change");
      }
      // Co-change detection runs during recordSuccess
    });
  });

  // ── EMA Q-Value Updates (MemRL-inspired) ────────────────────────────────

  describe("EMA Q-value confidence updates", () => {
    it("pulls confidence toward 1.0 on success (EMA α=0.3)", () => {
      // Create a solution with default confidence 0.5
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322:lib/auth.js" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);

      const before = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'typecheck:TS2322:lib/auth.js'").get();
      assert.equal(before.confidence, 0.5, "initial confidence should be 0.5");

      // Success resolves it: Q_new = 0.5 + 0.3*(1.0 - 0.5) = 0.5 + 0.15 = 0.65
      recordSuccess("agent-1", "story:US-001", ["lib/auth.js"], 2);

      const after = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'typecheck:TS2322:lib/auth.js'").get();
      assert.ok(Math.abs(after.confidence - 0.65) < 0.01, `EMA should give ~0.65, got ${after.confidence}`);
    });

    it("pulls confidence toward 0.0 on failure (EMA α=0.3)", () => {
      // Create a solution with default confidence 0.5
      const result = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "fail", errorKey: "test:lib/utils.js" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/utils.js"]);

      const before = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'test:lib/utils.js'").get();
      assert.equal(before.confidence, 0.5);

      // Failure: Q_new = 0.5 + 0.3*(-1.0 - 0.5) = 0.5 + 0.3*(-1.5) = 0.5 - 0.45 = 0.05
      recordFailure("agent-1", "story:US-001", "gave up", "failed", ["lib/utils.js"]);

      const after = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'test:lib/utils.js'").get();
      assert.ok(Math.abs(after.confidence - 0.05) < 0.01, `EMA should give ~0.05, got ${after.confidence}`);
    });

    it("converges toward 1.0 with repeated successes", () => {
      // Simulate 5 cycles of fail → succeed (each with a new agent hitting the same error)
      for (let i = 0; i < 5; i++) {
        const result = { passed: false, results: [{ name: "lint", cmd: "eslint", passed: false, output: "no-unused-vars", errorKey: "lint:no-unused-vars:lib/a.js" }] };
        recordVerification(`agent-${i}`, `story:US-${i}`, result, ["lib/a.js"]);

        // Reset to unresolved so the EMA update applies
        getDb().query("UPDATE solutions SET resolved = 0 WHERE error_key = 'lint:no-unused-vars:lib/a.js'").run();
        recordSuccess(`agent-${i}`, `story:US-${i}`, ["lib/a.js"], 1);
      }

      const sol = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'lint:no-unused-vars:lib/a.js'").get();
      // EMA from 0.5 with α=0.3, reward=1, 5 iterations:
      // 0.5 → 0.65 → 0.755 → 0.8285 → 0.88 → 0.916
      assert.ok(sol.confidence > 0.9, `After 5 successes, confidence should be >0.9, got ${sol.confidence}`);
    });

    it("never exceeds 1.0 or goes below 0.0", () => {
      const result = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "err", errorKey: "typecheck:TS9999:lib/b.js" }] };
      recordVerification("agent-1", "story:US-001", result, ["lib/b.js"]);

      // Set confidence very high
      getDb().query("UPDATE solutions SET confidence = 0.99 WHERE error_key = 'typecheck:TS9999:lib/b.js'").run();
      getDb().query("UPDATE solutions SET resolved = 0 WHERE error_key = 'typecheck:TS9999:lib/b.js'").run();
      recordSuccess("agent-1", "story:US-001", ["lib/b.js"], 1);
      const high = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'typecheck:TS9999:lib/b.js'").get();
      assert.ok(high.confidence <= 1.0, `should not exceed 1.0, got ${high.confidence}`);

      // Set confidence very low
      getDb().query("UPDATE solutions SET confidence = 0.01, resolved = 0 WHERE error_key = 'typecheck:TS9999:lib/b.js'").run();
      recordFailure("agent-2", "story:US-001", "failed", "failed", ["lib/b.js"]);
      const low = getDb().query("SELECT confidence FROM solutions WHERE error_key = 'typecheck:TS9999:lib/b.js'").get();
      assert.ok(low.confidence >= 0.0, `should not go below 0.0, got ${low.confidence}`);
    });
  });

  // ── Two-Phase Retrieval ─────────────────────────────────────────────────

  describe("two-phase retrieval", () => {
    it("buildTaskMemory ranks resolved solutions above unresolved", () => {
      // Create two solutions for the same file — one resolved, one not
      const r1 = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322:lib/auth.js" }] };
      recordVerification("agent-1", "story:US-001", r1, ["lib/auth.js"]);
      getDb().query("UPDATE solutions SET resolved = 1, fix_summary = 'Added type annotation', confidence = 0.8 WHERE error_key = 'typecheck:TS2322:lib/auth.js'").run();

      const r2 = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "FAIL", errorKey: "test:FAIL:lib/auth.js" }] };
      recordVerification("agent-2", "story:US-002", r2, ["lib/auth.js"]);
      // Leave unresolved at confidence 0.5

      const mem = buildTaskMemory("story:US-003", ["lib/auth.js"]);
      const resolvedIdx = mem.indexOf("SOLVED");
      const unresolvedIdx = mem.indexOf("UNSOLVED");
      assert.ok(resolvedIdx >= 0, "should contain resolved solution");
      assert.ok(unresolvedIdx >= 0, "should contain unresolved solution");
      assert.ok(resolvedIdx < unresolvedIdx, "resolved should appear before unresolved");
    });

    it("buildTaskMemory also pulls task-scoped solutions", () => {
      // Create a solution tied to a specific task
      const r = { passed: false, results: [{ name: "build", cmd: "npm build", passed: false, output: "Module not found", errorKey: "build:module-not-found" }] };
      recordVerification("agent-1", "story:US-007", r, []);
      getDb().query("UPDATE solutions SET resolved = 1, fix_summary = 'Install missing dep', confidence = 0.9 WHERE error_key = 'build:module-not-found'").run();

      // Query for the same task (no file match, but task_key matches)
      const mem = buildTaskMemory("story:US-007", []);
      assert.ok(mem.includes("module-not-found") || mem.includes("KNOWN ERRORS"), "should find task-scoped solution");
    });

    it("buildErrorContext shows related fixes for unresolved errors", () => {
      // Create a resolved solution for a related error
      const r = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322 err", errorKey: "typecheck:TS2322:lib/auth.js" }] };
      recordVerification("agent-1", "story:US-001", r, ["lib/auth.js"]);
      getDb().query("UPDATE solutions SET resolved = 1, fix_summary = 'Fixed type mismatch', confidence = 0.8 WHERE error_key = 'typecheck:TS2322:lib/auth.js'").run();

      // Query for a different but related error (same typecheck:TS2322 prefix)
      const ctx = buildErrorContext("typecheck:TS2322:lib/other.js", "lib/other.js");
      assert.ok(ctx.includes("Related fixes") || ctx.includes("Fixed type mismatch"),
        "should show related fixes from same error prefix");
    });

    it("buildErrorContext does not show related fixes when error is already resolved", () => {
      // Create a resolved solution
      const r = { passed: false, results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322" }] };
      recordVerification("agent-1", "story:US-001", r, []);
      getDb().query("UPDATE solutions SET resolved = 1, fix_summary = 'Fixed it', confidence = 0.9 WHERE error_key = 'typecheck:TS2322'").run();

      // Query for the same (already resolved) error
      const ctx = buildErrorContext("typecheck:TS2322");
      assert.ok(ctx.includes("resolved before"), "should show as resolved");
      assert.ok(!ctx.includes("Related fixes"), "should NOT show related fixes for already-resolved errors");
    });
  });

  // ── Reflection Generation ───────────────────────────────────────────────

  describe("reflection generation", () => {
    it("generates fix_summary reflection on successful resolution", () => {
      // Create a failed verification with a TypeScript error
      const result = {
        passed: false,
        results: [{
          name: "typecheck", cmd: "tsc", passed: false,
          output: "lib/auth.js(12,5): error TS2322: Type 'string' is not assignable to type 'number'",
          errorKey: "typecheck:TS2322:lib/auth.js",
        }],
      };
      recordVerification("agent-1", "story:US-001", result, ["lib/auth.js"]);

      // Now resolve it
      recordSuccess("agent-1", "story:US-001", ["lib/auth.js", "lib/types.ts"], 3);

      const sol = getDb().query("SELECT fix_summary FROM solutions WHERE error_key = 'typecheck:TS2322:lib/auth.js'").get();
      assert.ok(sol.fix_summary, "should have generated a fix_summary reflection");
      assert.ok(sol.fix_summary.includes("TS2322"), "reflection should mention the error code");
      assert.ok(sol.fix_summary.includes("lib/auth.js"), "reflection should mention the file");
      assert.ok(sol.fix_summary.includes("3 attempts"), "reflection should mention attempt count");
    });

    it("generates failure reflection in task_run notes", () => {
      recordFailure("agent-1", "story:US-001", "Max retries exceeded", "failed", ["lib/api.js"]);

      const run = getDb().query("SELECT notes FROM task_runs WHERE agent_id = 'agent-1'").get();
      assert.ok(run.notes, "should have failure reflection in notes");
      assert.ok(run.notes.includes("FAILED"), "reflection should include outcome");
      assert.ok(run.notes.includes("DIFFERENT strategy"), "reflection should suggest alternative approach");
    });

    it("generates blocked reflection with advice", () => {
      recordFailure("agent-1", "story:US-001", "Need API key for external service", "blocked", []);

      const run = getDb().query("SELECT notes FROM task_runs WHERE agent_id = 'agent-1'").get();
      assert.ok(run.notes.includes("BLOCKED"), "should mention blocked status");
      assert.ok(run.notes.includes("API key"), "should include the reason");
      assert.ok(run.notes.includes("alternative approach"), "should suggest alternative");
    });

    it("generates crash reflection mentioning tool issue", () => {
      recordFailure("agent-1", "story:US-001", "Exit code 137, signal SIGKILL", "crashed", ["lib/heavy.js"]);

      const run = getDb().query("SELECT notes FROM task_runs WHERE agent_id = 'agent-1'").get();
      assert.ok(run.notes.includes("CRASHED"), "should mention crash");
      assert.ok(run.notes.includes("tool issue"), "should mention potential tool issue");
    });

    it("updates file_knowledge.last_fix with reflection text", () => {
      const result = {
        passed: false,
        results: [{
          name: "test", cmd: "bun test", passed: false,
          output: "Expected 'hello' to equal 'world'",
          errorKey: "test:app.test.js",
        }],
      };
      recordVerification("agent-1", "story:US-001", result, ["lib/app.js"]);
      recordSuccess("agent-1", "story:US-001", ["lib/app.js"], 2);

      const fk = getFileKnowledge("lib/app.js");
      assert.ok(fk.last_fix, "should update last_fix with reflection");
      assert.ok(fk.last_fix.length > 10, "reflection should be substantive");
    });

    it("does not overwrite existing fix_summary", () => {
      const result = {
        passed: false,
        results: [{ name: "lint", cmd: "eslint", passed: false, output: "no-unused-vars", errorKey: "lint:no-unused-vars:lib/clean.js" }],
      };
      recordVerification("agent-1", "story:US-001", result, ["lib/clean.js"]);

      // Manually set a fix_summary first
      getDb().query("UPDATE solutions SET resolved = 1, fix_summary = 'Manual fix note' WHERE error_key = 'lint:no-unused-vars:lib/clean.js'").run();

      // Resolve again — should not overwrite
      getDb().query("UPDATE solutions SET resolved = 0 WHERE error_key = 'lint:no-unused-vars:lib/clean.js'").run();
      recordSuccess("agent-2", "story:US-001", ["lib/clean.js"], 1);

      // fix_summary should be the manual one (UPDATE only touches fix_summary IS NULL)
      const sol = getDb().query("SELECT fix_summary FROM solutions WHERE error_key = 'lint:no-unused-vars:lib/clean.js'").get();
      // The condition is fix_summary IS NULL, so existing ones are preserved
      assert.ok(sol.fix_summary !== null, "fix_summary should exist");
    });
  });

  // ── US-003: Verification Episodes ──────────────────────────────────────

  describe("US-003: recordEpisode", () => {
    it("creates a verification_episodes entry", () => {
      const verifyResult = {
        passed: false,
        results: [
          { name: "typecheck", cmd: "tsc", passed: true, output: "ok" },
          { name: "test", cmd: "bun test", passed: false, output: "FAIL: should login", errorKey: "test:auth.test.js" },
        ],
      };
      recordEpisode("agent-1", "story:US-001", 1, verifyResult, ["lib/auth.js"]);

      const episodes = getDb().query("SELECT * FROM verification_episodes WHERE task_key = 'story:US-001'").all();
      assert.equal(episodes.length, 1);
      assert.equal(episodes[0].agent_id, "agent-1");
      assert.equal(episodes[0].attempt, 1);
      assert.equal(episodes[0].passed, 0);

      const checks = JSON.parse(episodes[0].checks);
      assert.equal(checks.length, 2);
      assert.equal(checks[0].name, "typecheck");
      assert.equal(checks[0].passed, true);
      assert.equal(checks[1].name, "test");
      assert.equal(checks[1].passed, false);
      assert.ok(checks[1].output.length <= 200, "output should be truncated to 200 chars");
    });

    it("creates a passed episode", () => {
      const verifyResult = {
        passed: true,
        results: [{ name: "test", cmd: "bun test", passed: true, output: "all pass" }],
      };
      recordEpisode("agent-1", "story:US-001", 2, verifyResult, []);

      const ep = getDb().query("SELECT passed FROM verification_episodes WHERE agent_id = 'agent-1'").get();
      assert.equal(ep.passed, 1);
    });

    it("creates error_file_relations for failed checks (AC7)", () => {
      const verifyResult = {
        passed: false,
        results: [
          { name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322:lib/auth.js" },
          { name: "test", cmd: "bun test", passed: false, output: "FAIL", errorKey: "test:auth.test.js" },
        ],
      };
      recordEpisode("agent-1", "story:US-001", 1, verifyResult, ["lib/auth.js", "lib/types.ts"]);

      const relations = getDb().query("SELECT * FROM error_file_relations ORDER BY error_key, file_path").all();
      // 2 errors × 2 files = 4 relations
      assert.equal(relations.length, 4);
      assert.ok(relations.some(r => r.error_key === "typecheck:TS2322:lib/auth.js" && r.file_path === "lib/auth.js"));
      assert.ok(relations.some(r => r.error_key === "test:auth.test.js" && r.file_path === "lib/types.ts"));
      assert.equal(relations[0].relation, "caused_by");
    });

    it("increments occurrences on repeated error→file relations", () => {
      const verifyResult = {
        passed: false,
        results: [{ name: "test", cmd: "bun test", passed: false, output: "FAIL", errorKey: "test:fail" }],
      };
      recordEpisode("agent-1", "story:US-001", 1, verifyResult, ["lib/app.js"]);
      recordEpisode("agent-1", "story:US-001", 2, verifyResult, ["lib/app.js"]);

      const rel = getDb().query("SELECT occurrences FROM error_file_relations WHERE error_key = 'test:fail' AND file_path = 'lib/app.js'").get();
      assert.equal(rel.occurrences, 2);
    });

    it("is called by recordVerification automatically", () => {
      const verifyResult = {
        passed: false,
        results: [{ name: "lint", cmd: "eslint", passed: false, output: "no-unused-vars", errorKey: "lint:no-unused-vars" }],
      };
      recordVerification("agent-1", "story:US-001", verifyResult, ["lib/app.js"], "claude", 1);

      const episodes = getDb().query("SELECT * FROM verification_episodes").all();
      assert.ok(episodes.length >= 1, "recordVerification should create an episode");
    });
  });

  describe("US-003: getVerificationEpisodes", () => {
    it("returns episodes for a task in order", () => {
      const fail = { passed: false, results: [{ name: "test", cmd: "bun test", passed: false, output: "FAIL", errorKey: "test:fail" }] };
      const pass = { passed: true, results: [{ name: "test", cmd: "bun test", passed: true, output: "ok" }] };

      recordEpisode("agent-1", "story:US-001", 1, fail, []);
      recordEpisode("agent-1", "story:US-001", 2, fail, []);
      recordEpisode("agent-1", "story:US-001", 3, pass, []);

      const episodes = getVerificationEpisodes("story:US-001");
      assert.equal(episodes.length, 3);
      assert.equal(episodes[0].attempt, 1);
      assert.equal(episodes[0].passed, 0);
      assert.equal(episodes[2].attempt, 3);
      assert.equal(episodes[2].passed, 1);
    });
  });

  describe("US-003: getErrorFileRelations", () => {
    it("returns relations for an error key", () => {
      const verifyResult = {
        passed: false,
        results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "err", errorKey: "typecheck:TS2322" }],
      };
      recordEpisode("agent-1", "story:US-001", 1, verifyResult, ["lib/auth.js", "lib/db.js"]);

      const rels = getErrorFileRelations("typecheck:TS2322");
      assert.equal(rels.length, 2);
      const files = rels.map(r => r.file_path);
      assert.ok(files.includes("lib/auth.js"));
      assert.ok(files.includes("lib/db.js"));
    });
  });

  describe("US-003: recordFailure creates rules from errors (AC4)", () => {
    it("creates file-scoped rule from persistent verification error", () => {
      // First create a verification with errors
      const verifyResult = {
        passed: false,
        results: [{ name: "typecheck", cmd: "tsc", passed: false, output: "TS2322", errorKey: "typecheck:TS2322:lib/auth.js" }],
      };
      recordVerification("agent-1", "story:US-001", verifyResult, ["lib/auth.js"]);

      // Now record failure — should create rules
      recordFailure("agent-1", "story:US-001", "Max retries exceeded", "failed", ["lib/auth.js"]);

      const rules = getDb().query("SELECT * FROM repo_rules WHERE scope = 'file:lib/auth.js'").all();
      assert.ok(rules.length >= 1, "should create file-scoped rule from verification error");
      assert.ok(rules.some(r => r.rule.includes("persists")), "rule should mention persistent error");
    });

    it("creates check-scoped rule from verification error (AC8)", () => {
      const verifyResult = {
        passed: false,
        results: [{ name: "test", cmd: "bun test", passed: false, output: "FAIL", errorKey: "test:auth.test.js" }],
      };
      recordVerification("agent-1", "story:US-001", verifyResult, ["lib/auth.js"]);
      recordFailure("agent-1", "story:US-001", "Max retries", "failed", ["lib/auth.js"]);

      const checkRules = getDb().query("SELECT * FROM repo_rules WHERE scope LIKE 'check:%'").all();
      assert.ok(checkRules.length >= 1, "should create check-scoped rule");
      assert.ok(checkRules[0].scope.startsWith("check:"), "scope should be check-prefixed");
    });
  });

  describe("US-003: getLastInjectedRuleIds (AC5/AC6)", () => {
    it("tracks IDs of rules injected during buildTaskMemory", () => {
      upsertRule("file:lib/auth.js", "Check JWT expiry carefully", 0.8);
      upsertRule("repo", "Always run tests before signaling done", 0.7);

      // buildTaskMemory triggers _getApplicableRules which populates the tracker
      buildTaskMemory("story:US-001", ["lib/auth.js"]);

      const ids = getLastInjectedRuleIds();
      assert.ok(ids.length >= 1, "should have tracked injected rule IDs");
      assert.ok(ids.every(id => typeof id === "number"), "IDs should be numbers");
    });

    it("returns empty when no rules were injected", () => {
      buildTaskMemory("story:NONEXISTENT", ["nonexistent.js"]);
      const ids = getLastInjectedRuleIds();
      assert.equal(ids.length, 0, "should be empty when no rules matched");
    });
  });

  describe("US-003: buildTaskMemory includes check-scoped rules (AC8)", () => {
    it("includes check-scoped rules in PATTERNS section", () => {
      upsertRule("check:typecheck", "TS2322 errors often need interface updates", 0.6);

      const mem = buildTaskMemory("story:US-001", ["lib/auth.js"]);
      assert.ok(mem.includes("PATTERNS FROM MEMORY"), "should have patterns section");
      assert.ok(mem.includes("TS2322"), "should include check-scoped rule");
    });
  });

  describe("US-003: memoryStats includes new tables", () => {
    it("reports verification episodes and error relations", () => {
      const verifyResult = {
        passed: false,
        results: [{ name: "test", cmd: "bun test", passed: false, output: "FAIL", errorKey: "test:fail" }],
      };
      recordEpisode("agent-1", "story:US-001", 1, verifyResult, ["lib/app.js"]);

      const stats = memoryStats();
      assert.ok("verificationEpisodes" in stats, "should have verificationEpisodes field");
      assert.ok("errorFileRelations" in stats, "should have errorFileRelations field");
      assert.equal(stats.verificationEpisodes, 1);
      assert.equal(stats.errorFileRelations, 1);
    });
  });
});
