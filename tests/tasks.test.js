import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPRD,
  nextStory,
  prdProgress,
  detectVerifyCommands,
  buildStoryPrompt,
} from "../lib/tasks.js";

// Test fixture
const TEST_PRD = {
  project: "TestApp",
  branchName: "homer/test",
  description: "Test PRD",
  userStories: [
    {
      id: "US-001",
      title: "First story",
      description: "First story description",
      acceptanceCriteria: ["Criterion 1", "Typecheck passes"],
      priority: 1,
      passes: false,
      notes: "",
    },
    {
      id: "US-002",
      title: "Second story",
      description: "Second story description",
      acceptanceCriteria: ["Criterion A", "Criterion B"],
      priority: 2,
      passes: true,
      notes: "Already done",
    },
    {
      id: "US-003",
      title: "Third story",
      description: "Third story description",
      acceptanceCriteria: ["Criterion X"],
      priority: 3,
      passes: false,
      notes: "",
    },
  ],
};

describe("tasks.js", () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `homer-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe("loadPRD()", () => {
    it("loads prd.json from project root", () => {
      writeFileSync(join(tmpDir, "prd.json"), JSON.stringify(TEST_PRD));
      const result = loadPRD(tmpDir);
      assert.ok(result, "should find prd.json");
      assert.equal(result.prd.project, "TestApp");
      assert.equal(result.prd.userStories.length, 3);
    });

    it("returns null if no prd.json exists", () => {
      const emptyDir = join(tmpDir, "empty");
      mkdirSync(emptyDir, { recursive: true });
      const result = loadPRD(emptyDir);
      assert.equal(result, null);
    });

    it("returns null for malformed JSON", () => {
      const badDir = join(tmpDir, "bad");
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "prd.json"), "not valid json{{{");
      const result = loadPRD(badDir);
      assert.equal(result, null);
    });

    it("returns null for JSON without userStories array", () => {
      const noStoriesDir = join(tmpDir, "no-stories");
      mkdirSync(noStoriesDir, { recursive: true });
      writeFileSync(join(noStoriesDir, "prd.json"), JSON.stringify({ project: "x" }));
      const result = loadPRD(noStoriesDir);
      assert.equal(result, null);
    });
  });

  describe("nextStory()", () => {
    it("returns first incomplete story by priority", () => {
      const story = nextStory(TEST_PRD);
      assert.ok(story);
      assert.equal(story.id, "US-001");
      assert.equal(story.passes, false);
    });

    it("skips already-passed stories", () => {
      const story = nextStory(TEST_PRD);
      assert.notEqual(story.id, "US-002", "should skip US-002 which is passes=true");
    });

    it("returns null when all stories are done", () => {
      const allDone = {
        userStories: [
          { id: "US-001", passes: true, priority: 1 },
          { id: "US-002", passes: true, priority: 2 },
        ],
      };
      const story = nextStory(allDone);
      assert.equal(story, null);
    });
  });

  describe("prdProgress()", () => {
    it("returns correct progress counts", () => {
      const progress = prdProgress(TEST_PRD);
      assert.equal(progress.total, 3);
      assert.equal(progress.passed, 1);
      assert.equal(progress.remaining, 2);
      assert.equal(progress.allDone, false);
    });

    it("detects when all stories are done", () => {
      const allDone = {
        userStories: [
          { id: "US-001", passes: true, priority: 1 },
        ],
      };
      const progress = prdProgress(allDone);
      assert.equal(progress.allDone, true);
      assert.equal(progress.remaining, 0);
    });
  });

  describe("detectVerifyCommands()", () => {
    it("detects typecheck from tsconfig.json", () => {
      const dir = join(tmpDir, "ts-project");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      const cmds = detectVerifyCommands(dir);
      assert.ok(cmds.some((c) => c.name === "typecheck"), "should detect typecheck");
    });

    it("detects npm run lint", () => {
      const dir = join(tmpDir, "lint-project");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
      const cmds = detectVerifyCommands(dir);
      assert.ok(cmds.some((c) => c.name === "lint"), "should detect lint");
    });

    it("returns empty array for project with no scripts", () => {
      const dir = join(tmpDir, "empty-project");
      mkdirSync(dir, { recursive: true });
      const cmds = detectVerifyCommands(dir);
      assert.equal(cmds.length, 0);
    });
  });

  describe("buildStoryPrompt()", () => {
    it("includes story title and acceptance criteria", () => {
      const story = TEST_PRD.userStories[0];
      const prompt = buildStoryPrompt(story, TEST_PRD);
      assert.ok(prompt.includes("US-001"), "should include story id");
      assert.ok(prompt.includes("First story"), "should include title");
      assert.ok(prompt.includes("Criterion 1"), "should include criteria");
      assert.ok(prompt.includes("HOMER_DONE"), "should include done signal");
      assert.ok(prompt.includes("HOMER_BLOCKED"), "should include blocked signal");
    });
  });
});
