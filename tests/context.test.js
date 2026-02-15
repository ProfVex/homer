import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, indexStats } from "../lib/context.js";

describe("context.js", () => {
  describe("buildSystemPrompt()", () => {
    it("returns a string", () => {
      const prompt = buildSystemPrompt(process.cwd(), "");
      assert.equal(typeof prompt, "string");
      assert.ok(prompt.length > 0, "prompt should not be empty");
    });

    it("includes HOMER_DONE instruction", () => {
      const prompt = buildSystemPrompt(process.cwd(), "");
      assert.ok(prompt.includes("HOMER_DONE"), "should instruct agent about HOMER_DONE");
    });

    it("includes HOMER_BLOCKED instruction", () => {
      const prompt = buildSystemPrompt(process.cwd(), "");
      assert.ok(prompt.includes("HOMER_BLOCKED"), "should instruct agent about HOMER_BLOCKED");
    });

    it("includes DRY rules", () => {
      const prompt = buildSystemPrompt(process.cwd(), "");
      assert.ok(
        prompt.includes("do NOT re-scan") || prompt.includes("do NOT recreate"),
        "should include DRY instructions",
      );
    });

    it("mentions Homer as orchestrator", () => {
      const prompt = buildSystemPrompt(process.cwd(), "");
      assert.ok(prompt.includes("Homer"), "should mention Homer");
    });

    it("includes commit instruction", () => {
      const prompt = buildSystemPrompt(process.cwd(), "");
      assert.ok(prompt.includes("Commit"), "should instruct agent to commit changes");
    });
  });

  describe("indexStats()", () => {
    it("returns null for unknown repo", () => {
      const stats = indexStats("nonexistent/repo-12345-does-not-exist");
      assert.equal(stats, null);
    });

    it("returns object with expected fields when index exists", () => {
      // This will use the current project's index if it exists
      // If not, it returns null which is also valid
      const stats = indexStats("");
      if (stats !== null) {
        assert.equal(typeof stats.exportCount, "number");
        assert.equal(typeof stats.fileCount, "number");
        assert.equal(typeof stats.depCount, "number");
        assert.equal(typeof stats.hasClaudeMd, "boolean");
        assert.equal(typeof stats.ageMinutes, "number");
      }
    });
  });
});
