import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categorize,
  getDeps,
  getPriority,
  shellEsc,
} from "../lib/github.js";

describe("github.js", () => {
  describe("shellEsc()", () => {
    it("wraps simple strings in single quotes", () => {
      assert.equal(shellEsc("hello"), "'hello'");
    });

    it("escapes internal single quotes", () => {
      assert.equal(shellEsc("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEsc(""), "''");
    });

    it("handles null and undefined", () => {
      assert.equal(shellEsc(null), "''");
      assert.equal(shellEsc(undefined), "''");
    });

    it("prevents shell injection with semicolons", () => {
      const malicious = 'foo"; rm -rf /; echo "';
      const escaped = shellEsc(malicious);
      // Single-quoted strings in shell treat all chars as literal
      // The entire string should be wrapped in single quotes
      assert.ok(escaped.startsWith("'"), "should start with single quote");
      assert.ok(escaped.endsWith("'"), "should end with single quote");
      // The result is one single-quoted token — shell won't interpret ; or "
      assert.equal(escaped, "'foo\"; rm -rf /; echo \"'");
    });

    it("prevents shell injection with backticks", () => {
      const malicious = "foo`whoami`bar";
      const escaped = shellEsc(malicious);
      assert.ok(escaped.startsWith("'"));
      // Backticks inside single quotes are literal
      assert.equal(escaped, "'foo`whoami`bar'");
    });

    it("prevents shell injection with dollar signs", () => {
      const malicious = "foo$(cat /etc/passwd)bar";
      const escaped = shellEsc(malicious);
      assert.ok(escaped.startsWith("'"));
      // $() inside single quotes is literal
      assert.equal(escaped, "'foo$(cat /etc/passwd)bar'");
    });
  });

  describe("categorize()", () => {
    it("sorts issues into correct buckets", () => {
      const issues = [
        { number: 1, labels: [{ name: "homer:ready" }], state: "OPEN" },
        { number: 2, labels: [{ name: "homer:in-progress" }], state: "OPEN" },
        { number: 3, labels: [{ name: "homer:done" }], state: "CLOSED" },
        { number: 4, labels: [{ name: "homer:blocked" }], state: "OPEN" },
        { number: 5, labels: [{ name: "homer:failed" }], state: "OPEN" },
        { number: 6, labels: [], state: "CLOSED" },
      ];
      const b = categorize(issues);
      assert.equal(b.ready.length, 1);
      assert.equal(b.ready[0].number, 1);
      assert.equal(b.inProgress.length, 1);
      assert.equal(b.inProgress[0].number, 2);
      assert.equal(b.done.length, 2); // #3 (labeled) + #6 (closed)
      assert.equal(b.blocked.length, 1);
      assert.equal(b.failed.length, 1);
    });

    it("uses custom prefix", () => {
      const issues = [
        { number: 1, labels: [{ name: "myprefix:ready" }], state: "OPEN" },
      ];
      const b = categorize(issues, "myprefix");
      assert.equal(b.ready.length, 1);
    });

    it("handles issues with no labels", () => {
      const issues = [
        { number: 1, state: "OPEN" },
      ];
      const b = categorize(issues);
      assert.equal(b.ready.length, 0);
      assert.equal(b.inProgress.length, 0);
    });
  });

  describe("getDeps()", () => {
    it("extracts dependency issue numbers", () => {
      const issue = { body: "Some text\n\nDepends on: #1, #3, #7\n\nMore text" };
      const deps = getDeps(issue);
      assert.deepEqual(deps, [1, 3, 7]);
    });

    it("returns empty array when no deps", () => {
      const issue = { body: "No dependencies here" };
      assert.deepEqual(getDeps(issue), []);
    });

    it("returns empty array for empty body", () => {
      assert.deepEqual(getDeps({ body: "" }), []);
      assert.deepEqual(getDeps({}), []);
    });

    it("is case-insensitive", () => {
      const issue = { body: "depends on: #5" };
      assert.deepEqual(getDeps(issue), [5]);
    });
  });

  describe("getPriority()", () => {
    it("extracts priority from labels", () => {
      const issue = { labels: [{ name: "priority:1" }, { name: "homer" }] };
      assert.equal(getPriority(issue), 1);
    });

    it("returns 99 when no priority label", () => {
      const issue = { labels: [{ name: "homer" }] };
      assert.equal(getPriority(issue), 99);
    });

    it("handles missing labels", () => {
      assert.equal(getPriority({}), 99);
      assert.equal(getPriority({ labels: [] }), 99);
    });
  });
});
