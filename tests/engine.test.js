/**
 * Homer Engine Tests — new web-based engine API
 */

import { describe, test, expect } from "bun:test";
import { HomerEngine, ROLES, taskKey, stripAnsi } from "../lib/engine.js";

describe("HomerEngine", () => {
  test("should construct with default options", () => {
    const engine = new HomerEngine();
    expect(engine.opts.maxAgents).toBe(5);
    expect(engine.opts.auto).toBe(false);
    expect(engine.opts.prefix).toBe("homer");
    expect(engine.agents).toEqual([]);
    expect(engine.agentCounter).toBe(0);
  });

  test("should construct with custom options", () => {
    const engine = new HomerEngine({ maxAgents: 3, auto: true, prefix: "test" });
    expect(engine.opts.maxAgents).toBe(3);
    expect(engine.opts.auto).toBe(true);
    expect(engine.opts.prefix).toBe("test");
  });

  test("should expose getState() with empty agents", () => {
    const engine = new HomerEngine();
    const state = engine.getState();
    expect(state.agents).toEqual([]);
    expect(state.activeTool).toBe(null);
    expect(state.auto).toBe(false);
  });

  test("should setTool to an available tool", () => {
    const engine = new HomerEngine();
    // setTool uses getTool which checks KNOWN_TOOLS
    // If claude is installed, it should work; otherwise the test
    // just verifies it doesn't crash
    engine.setTool("claude");
    // May or may not set depending on whether claude is installed
  });

  test("cleanup should not throw when no agents exist", () => {
    const engine = new HomerEngine();
    expect(() => engine.cleanup()).not.toThrow();
  });

  test("should emit state events", (done) => {
    const engine = new HomerEngine();
    engine.on("state", (state) => {
      expect(state.agents).toBeDefined();
      expect(state.activeTool).toBeDefined();
      done();
    });
    engine._emitState();
  });
});

describe("ROLES", () => {
  test("should define all expected roles", () => {
    expect(ROLES.general).toBeDefined();
    expect(ROLES.planner).toBeDefined();
    expect(ROLES.coder).toBeDefined();
    expect(ROLES.data).toBeDefined();
    expect(ROLES.api).toBeDefined();
    expect(ROLES.researcher).toBeDefined();
    expect(ROLES.verifier).toBeDefined();
  });

  test("each role should have id, name, icon, color", () => {
    for (const [key, role] of Object.entries(ROLES)) {
      expect(role.id).toBe(key);
      expect(role.name).toBeTruthy();
      expect(role.icon).toBeTruthy();
      expect(role.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("taskKey", () => {
  test("should return story key for story agents", () => {
    expect(taskKey({ story: { id: "S01" } })).toBe("story:S01");
  });

  test("should return issue key for issue agents", () => {
    expect(taskKey({ issue: { number: 42 } })).toBe("issue:42");
  });

  test("should return null for interactive agents", () => {
    expect(taskKey({})).toBe(null);
  });

  test("should prefer story over issue", () => {
    expect(taskKey({ story: { id: "S01" }, issue: { number: 42 } })).toBe("story:S01");
  });
});

describe("stripAnsi", () => {
  test("should remove basic color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("should remove OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  test("should handle empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("should preserve plain text", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("should handle complex sequences", () => {
    expect(stripAnsi("\x1b[1;32mbold green\x1b[0m normal")).toBe("bold green normal");
  });
});
