import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectTools, getTool, getAvailableTools } from "../lib/tools.js";

describe("tools.js", () => {
  describe("detectTools()", () => {
    it("returns an array of tool objects", () => {
      const tools = detectTools();
      assert.ok(Array.isArray(tools), "should return an array");
      assert.ok(tools.length >= 4, "should have at least 4 known tools");
    });

    it("each tool has required fields", () => {
      const tools = detectTools();
      for (const t of tools) {
        assert.ok(t.id, `tool should have id, got: ${JSON.stringify(t)}`);
        assert.ok(t.name, `tool should have name, got: ${t.id}`);
        assert.ok(t.command, `tool should have command, got: ${t.id}`);
        assert.equal(typeof t.available, "boolean", `${t.id}.available should be boolean`);
        // version is null until enrichToolVersions runs
        assert.equal(t.version, null, `${t.id}.version should be null before enrichment`);
      }
    });

    it("includes claude as a known tool", () => {
      const tools = detectTools();
      const claude = tools.find((t) => t.id === "claude");
      assert.ok(claude, "should include claude tool");
      assert.equal(claude.name, "Claude Code");
      assert.equal(claude.command, "claude");
      assert.equal(claude.permissionModes, true);
      assert.equal(claude.supportsSystemPrompt, true);
    });

    it("de-dupes command checks (aider appears twice)", () => {
      const tools = detectTools();
      const aiderTools = tools.filter((t) => t.command === "aider");
      assert.equal(aiderTools.length, 2, "aider command used by both aider and openrouter");
      // Both should have the same availability
      assert.equal(aiderTools[0].available, aiderTools[1].available);
    });
  });

  describe("getTool()", () => {
    it("returns tool config by id", () => {
      const claude = getTool("claude");
      assert.ok(claude);
      assert.equal(claude.id, "claude");
      assert.equal(claude.name, "Claude Code");
    });

    it("returns null for unknown id", () => {
      const unknown = getTool("nonexistent-tool");
      assert.equal(unknown, null);
    });
  });

  describe("getAvailableTools()", () => {
    it("returns only available tools", () => {
      const available = getAvailableTools();
      assert.ok(Array.isArray(available));
      for (const t of available) {
        assert.equal(t.available, true, `${t.id} should be available`);
      }
    });
  });
});
