/**
 * Local task management — load stories from prd.json, run verification.
 *
 * This lets Homer manage Ralph-style user stories WITHOUT requiring GitHub.
 * Users can drop a prd.json in their project root and Homer picks it up.
 *
 * Lookup order for PRD:
 *   1. ./prd.json (project root)
 *   2. ./ralph/prd.json (ralph directory in project)
 *   3. ~/.homer/context/{repo-slug}/prd.json (homer's context dir)
 *
 * Verification flow (the "tight feedback loop"):
 *   Agent signals HOMER_DONE → Homer runs verify commands →
 *   If pass: mark story passes=true, commit, next story
 *   If fail: re-inject errors into agent to fix
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Load PRD ──────────────────────────────────────────────────────────────────

/**
 * Find and load a prd.json from the project.
 * Returns { path, prd } or null if not found.
 */
export function loadPRD(cwd) {
  const candidates = [
    join(cwd, "prd.json"),
    join(cwd, "ralph", "prd.json"),
    join(cwd, ".homer", "prd.json"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const prd = JSON.parse(readFileSync(p, "utf8"));
        if (prd && Array.isArray(prd.userStories)) {
          return { path: p, prd };
        }
      } catch {
        // Malformed JSON — skip
      }
    }
  }

  return null;
}

/**
 * Save updated PRD back to disk.
 */
export function savePRD(prdPath, prd) {
  writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n", "utf8");
}

/**
 * Get the next incomplete story from a PRD (highest priority with passes=false).
 */
export function nextStory(prd) {
  const incomplete = prd.userStories
    .filter((s) => !s.passes)
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));
  return incomplete[0] || null;
}

/**
 * Get PRD progress summary.
 */
export function prdProgress(prd) {
  const total = prd.userStories.length;
  const passed = prd.userStories.filter((s) => s.passes).length;
  const remaining = total - passed;
  const current = nextStory(prd);
  return { total, passed, remaining, current, allDone: remaining === 0 };
}

/**
 * Mark a story as passed in the PRD. Saves to disk.
 */
export function markStoryPassed(prdPath, prd, storyId, notes) {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.passes = true;
    if (notes) story.notes = notes;
  }
  savePRD(prdPath, prd);
}

/**
 * Mark a story as failed (keeps passes=false, adds notes).
 */
export function markStoryFailed(prdPath, prd, storyId, notes) {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story && notes) {
    story.notes = notes;
  }
  savePRD(prdPath, prd);
}

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * Detect which verification commands to run based on project setup.
 * Returns array of { name, cmd } objects.
 */
export function detectVerifyCommands(cwd) {
  const cmds = [];

  // Check package.json for scripts
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const scripts = pkg.scripts || {};

      // Typecheck
      if (scripts.typecheck) {
        cmds.push({ name: "typecheck", cmd: "npm run typecheck" });
      } else if (scripts["type-check"]) {
        cmds.push({ name: "typecheck", cmd: "npm run type-check" });
      } else if (existsSync(join(cwd, "tsconfig.json"))) {
        cmds.push({ name: "typecheck", cmd: "npx tsc --noEmit" });
      }

      // Lint
      if (scripts.lint) {
        cmds.push({ name: "lint", cmd: "npm run lint" });
      }

      // Test
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        cmds.push({ name: "test", cmd: "npm test" });
      }

      // Build (lighter check — only if no typecheck available)
      if (cmds.length === 0 && scripts.build) {
        cmds.push({ name: "build", cmd: "npm run build" });
      }
    } catch {}
  }

  // Python projects
  const pyprojectPath = join(cwd, "pyproject.toml");
  if (existsSync(pyprojectPath) || existsSync(join(cwd, "setup.py"))) {
    // Check for mypy
    if (existsSync(join(cwd, ".mypy.ini")) || existsSync(join(cwd, "mypy.ini"))) {
      cmds.push({ name: "typecheck", cmd: "mypy ." });
    }

    // Check for pytest
    if (existsSync(join(cwd, "tests")) || existsSync(join(cwd, "test"))) {
      cmds.push({ name: "test", cmd: "pytest" });
    }

    // Check for ruff
    if (existsSync(join(cwd, "ruff.toml")) || existsSync(join(cwd, ".ruff.toml"))) {
      cmds.push({ name: "lint", cmd: "ruff check ." });
    }
  }

  // Makefile targets
  if (existsSync(join(cwd, "Makefile"))) {
    try {
      const makefile = readFileSync(join(cwd, "Makefile"), "utf8");
      if (makefile.includes("check:") && cmds.length === 0) {
        cmds.push({ name: "check", cmd: "make check" });
      }
    } catch {}
  }

  return cmds;
}

/**
 * Run verification commands and return results.
 * Returns { passed, results: [{ name, cmd, passed, output }] }
 */
export function runVerification(cwd, commands) {
  if (!commands || commands.length === 0) {
    commands = detectVerifyCommands(cwd);
  }

  if (commands.length === 0) {
    return { passed: true, results: [], skipped: true };
  }

  const results = [];
  let allPassed = true;

  for (const { name, cmd } of commands) {
    try {
      const output = execSync(cmd, {
        encoding: "utf8",
        timeout: 120000, // 2 min max per command
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      results.push({ name, cmd, passed: true, output: output.slice(-500), errorKey: null });
    } catch (e) {
      allPassed = false;
      const stderr = (e.stderr || "").slice(-500);
      const stdout = (e.stdout || "").slice(-500);
      const output = (stderr || stdout || e.message || "unknown error").slice(-800);
      results.push({
        name,
        cmd,
        passed: false,
        output,
        errorKey: _extractErrorKey(name, output),
      });
    }
  }

  return { passed: allPassed, results };
}

/**
 * Extract a normalized error key from verification output.
 * Used by memory v2 to match errors across runs deterministically.
 *
 * Examples:
 *   "typecheck:TS2322:lib/auth.js"
 *   "test:auth.test.js:should_validate"
 *   "lint:no-unused-vars:lib/utils.js"
 *
 * @param {string} checkName — "typecheck", "test", "lint", etc.
 * @param {string} output — raw error output
 * @returns {string} — normalized error key
 * @private
 */
function _extractErrorKey(checkName, output) {
  // Try to extract TypeScript error codes
  const tsMatch = output.match(/TS(\d{4,5})/);
  if (tsMatch) {
    const fileMatch = output.match(/((?:src|lib|app|test|tests|config)\/[^\s:(]+)/);
    return `${checkName}:TS${tsMatch[1]}${fileMatch ? ":" + fileMatch[1] : ""}`;
  }

  // Try to extract test file + test name
  const testFileMatch = output.match(/([\w.-]+\.(?:test|spec)\.[jt]sx?)/);
  if (testFileMatch) {
    const testNameMatch = output.match(/(?:✗|✕|FAIL|×|failing)\s*(.{10,60})/i);
    const testName = testNameMatch ? ":" + testNameMatch[1].trim().slice(0, 40).replace(/\s+/g, "_") : "";
    return `${checkName}:${testFileMatch[1]}${testName}`;
  }

  // Try to extract lint rule
  const lintMatch = output.match(/(?:error|warning)\s+([a-z@/-]+(?:\/[a-z-]+)?)\s/);
  if (lintMatch) {
    const lintFileMatch = output.match(/((?:src|lib|app|test|tests)\/[^\s:(]+)/);
    return `${checkName}:${lintMatch[1]}${lintFileMatch ? ":" + lintFileMatch[1] : ""}`;
  }

  // Try to extract a file path at minimum
  const fileMatch = output.match(/((?:src|lib|app|test|tests|config)\/[^\s:(]+)/);
  if (fileMatch) {
    return `${checkName}:${fileMatch[1]}`;
  }

  // Fallback: just the check name
  return `${checkName}:unknown`;
}

/**
 * Build a verification failure message to re-inject into the agent.
 * This is the "tight feedback loop" — agent sees exactly what failed.
 */
export function buildVerificationFeedback(results, story) {
  const parts = [];
  parts.push("HOMER VERIFICATION FAILED. Fix the following errors before signaling HOMER_DONE again:\n");

  for (const r of results.filter((r) => !r.passed)) {
    parts.push(`❌ ${r.name} (${r.cmd}):`);
    parts.push(r.output);
    parts.push("");
  }

  if (story) {
    parts.push("Acceptance criteria for reference:");
    for (const c of story.acceptanceCriteria || []) {
      parts.push(`  - ${c}`);
    }
  }

  parts.push("\nFix these issues, then signal HOMER_DONE again.");
  return parts.join("\n");
}

/**
 * Build a task prompt for a specific user story (Ralph-style).
 * Includes acceptance criteria + verification expectations.
 */
export function buildStoryPrompt(story, prd) {
  const parts = [];

  parts.push(`Work on Story ${story.id}: ${story.title}`);
  parts.push("");
  parts.push(story.description);
  parts.push("");
  parts.push("ACCEPTANCE CRITERIA (ALL must pass):");
  for (const c of story.acceptanceCriteria || []) {
    parts.push(`  ✓ ${c}`);
  }

  if (story.notes) {
    parts.push(`\nPrevious notes: ${story.notes}`);
  }

  parts.push("\nWhen ALL criteria are met and code compiles/passes:");
  parts.push("  1. Commit your changes: git add + git commit");
  parts.push(`  2. Signal HOMER_DONE`);
  parts.push("If stuck: signal HOMER_BLOCKED with reason.");
  parts.push("\nRead .homer/context.md first for existing code you must reuse.");

  return parts.join("\n");
}

// ── Story Decomposition ───────────────────────────────────────────────────────

/**
 * Decompose a story with multiple acceptance criteria into focused sub-tasks.
 * Each sub-task gets one criterion — small enough for a single agent's context.
 *
 * Returns null if the story doesn't need decomposition (≤2 criteria).
 *
 * @param {object} story — { id, title, description, acceptanceCriteria, priority }
 * @returns {object[]|null} — array of sub-task objects, or null
 */
export function decomposeStory(story) {
  if (!story.acceptanceCriteria || story.acceptanceCriteria.length <= 2) return null;

  return story.acceptanceCriteria.map((ac, i) => ({
    id: `${story.id}-${i + 1}`,
    parentId: story.id,
    title: `${story.title}: ${ac.slice(0, 60)}`,
    description: story.description,
    criterion: ac,
    priority: story.priority,
    passes: false,
  }));
}

/**
 * Build a focused prompt for a single sub-task.
 * Includes only the ONE criterion being worked on, plus parent context.
 *
 * @param {object} subtask — from decomposeStory()
 * @param {object} parentStory — the original story
 * @param {object} [prd] — the full PRD (for context)
 * @param {string[]} [siblingNotes] — notes from completed sibling sub-tasks
 * @returns {string}
 */
export function buildSubtaskPrompt(subtask, parentStory, prd, siblingNotes = []) {
  const parts = [];

  parts.push(`Work on Sub-task ${subtask.id}: ${subtask.title}`);
  parts.push(`(Part of Story ${parentStory.id}: ${parentStory.title})`);
  parts.push("");
  parts.push("CONTEXT:");
  parts.push(parentStory.description);
  parts.push("");
  parts.push("YOUR CRITERION (focus on THIS only):");
  parts.push(`  ✓ ${subtask.criterion}`);
  parts.push("");

  // Show what siblings have already done
  if (siblingNotes.length > 0) {
    parts.push("ALREADY COMPLETED BY OTHER AGENTS:");
    for (const note of siblingNotes) {
      parts.push(`  ✓ ${note}`);
    }
    parts.push("");
  }

  // Show remaining criteria for awareness (not responsibility)
  const remaining = parentStory.acceptanceCriteria.filter(ac => ac !== subtask.criterion);
  if (remaining.length > 0) {
    parts.push("OTHER CRITERIA (for awareness, not your responsibility):");
    for (const ac of remaining) {
      parts.push(`  - ${ac}`);
    }
    parts.push("");
  }

  parts.push("When your criterion is met and code compiles/passes:");
  parts.push("  1. Commit your changes: git add + git commit");
  parts.push("  2. Signal HOMER_DONE");
  parts.push("If stuck: signal HOMER_BLOCKED with reason.");
  parts.push("\nRead .homer/context.md first for existing code you must reuse.");

  return parts.join("\n");
}

// ── Progress File ─────────────────────────────────────────────────────────────

/**
 * Append a progress entry (Ralph-style progress.txt compatible).
 */
export function appendProgress(cwd, storyId, storyTitle, status, details) {
  const progressPath = join(cwd, ".homer", "progress.txt");
  const now = new Date().toISOString();

  let content = "";
  try { content = readFileSync(progressPath, "utf8"); } catch {}

  if (!content) {
    content = "# Homer Progress Log\n";
    content += `Started: ${now}\n`;
    content += "---\n";
  }

  content += `\n## ${now.split("T")[0]} - ${storyId}\n`;
  content += `- **${storyTitle}**: ${status}\n`;
  if (details) content += `- ${details}\n`;
  content += "---\n";

  try {
    const dir = join(cwd, ".homer");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {}
  writeFileSync(progressPath, content, "utf8");
}

/**
 * Convert GitHub issues to a lightweight PRD format.
 * This lets users without a prd.json still benefit from the verification loop
 * by converting their GitHub issues into the same format.
 */
export function issuesToPRD(issues, repo) {
  return {
    project: repo || "local",
    branchName: `homer/work-${Date.now()}`,
    description: `Auto-generated from ${issues.length} GitHub issues`,
    userStories: issues.map((issue, idx) => ({
      id: `GH-${issue.number}`,
      title: issue.title,
      description: issue.body || issue.title,
      acceptanceCriteria: extractCriteria(issue),
      priority: idx + 1,
      passes: false,
      notes: "",
      _issueNumber: issue.number, // preserve for GitHub updates
    })),
  };
}

/**
 * Extract acceptance criteria from an issue body.
 * Looks for checkbox lists, "Acceptance Criteria" section, or numbered lists.
 */
function extractCriteria(issue) {
  const body = issue.body || "";
  const criteria = [];

  // Check for markdown checkboxes: - [ ] or - [x]
  const checkboxes = body.match(/- \[[ x]\] .+/g);
  if (checkboxes && checkboxes.length > 0) {
    for (const cb of checkboxes) {
      criteria.push(cb.replace(/- \[[ x]\] /, "").trim());
    }
  }

  // Check for "Acceptance Criteria" section
  if (criteria.length === 0) {
    const acMatch = body.match(/(?:acceptance criteria|requirements|tasks)[\s:]*\n([\s\S]*?)(?:\n##|\n---|\n\n\n|$)/i);
    if (acMatch) {
      const lines = acMatch[1].split("\n").filter((l) => l.trim().match(/^[-*•\d]/));
      for (const line of lines) {
        criteria.push(line.replace(/^[-*•\d.)\s]+/, "").trim());
      }
    }
  }

  // Always add typecheck as a fallback criterion
  if (criteria.length === 0) {
    criteria.push(issue.title);
  }
  if (!criteria.some((c) => c.toLowerCase().includes("typecheck"))) {
    criteria.push("Typecheck passes (if applicable)");
  }

  return criteria;
}
