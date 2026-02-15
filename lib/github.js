/**
 * GitHub operations via `gh` CLI.
 * All functions are synchronous (execSync) — fine for a TUI that refreshes periodically.
 *
 * SECURITY: All user-controlled strings are escaped via shellEsc() before
 * interpolation into shell commands to prevent injection attacks.
 */

import { execSync } from "node:child_process";

/**
 * Escape a string for safe inclusion in a single-quoted shell argument.
 * Wraps in single quotes after escaping any internal single quotes.
 * e.g. "foo'bar" → "'foo'\''bar'"
 */
function shellEsc(str) {
  if (str === undefined || str === null) return "''";
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

function gh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 30000 });
  } catch {
    return "";
  }
}

function ghJSON(cmd) {
  const raw = gh(cmd);
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Detect repo from gh or git remote. */
export function detectRepo() {
  const fromGH = gh(
    'gh repo view --json nameWithOwner -q ".nameWithOwner"',
  ).trim();
  if (fromGH) return fromGH;

  const url = gh("git remote get-url origin").trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (m) return m[1];

  return "";
}

/** Fetch all homer-labeled issues. */
export function fetchIssues(repo, prefix = "homer") {
  return ghJSON(
    `gh issue list --repo ${shellEsc(repo)} --label ${shellEsc(prefix)} --state all ` +
      `--json number,title,labels,state,body,updatedAt,comments --limit 200`,
  );
}

/** Fetch ALL open issues from a repo (not just homer-labeled). */
export function fetchAllIssues(repo) {
  return ghJSON(
    `gh issue list --repo ${shellEsc(repo)} --state open ` +
      `--json number,title,labels,state,body,updatedAt --limit 100`,
  );
}

/** Sort issues into buckets by label. */
export function categorize(issues, prefix = "homer") {
  const b = { inProgress: [], ready: [], blocked: [], done: [], failed: [] };
  for (const issue of issues) {
    const names = (issue.labels || []).map((l) => l.name);
    if (names.includes(`${prefix}:in-progress`)) b.inProgress.push(issue);
    else if (names.includes(`${prefix}:failed`)) b.failed.push(issue);
    else if (names.includes(`${prefix}:ready`)) b.ready.push(issue);
    else if (names.includes(`${prefix}:blocked`)) b.blocked.push(issue);
    else if (names.includes(`${prefix}:done`) || issue.state === "CLOSED")
      b.done.push(issue);
  }
  return b;
}

/** Get dependency issue numbers from "Depends on: #X, #Y" in issue body. */
export function getDeps(issue) {
  const body = issue.body || "";
  const line = body.match(/depends on:.*$/im);
  if (!line) return [];
  return [...line[0].matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10));
}

/** Get priority from labels (lower = higher priority). */
export function getPriority(issue) {
  for (const l of issue.labels || []) {
    const m = l.name.match(/^priority:(\d+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return 99;
}

/** Check if all deps are closed. */
export function depsMet(issue, repo) {
  const deps = getDeps(issue);
  if (deps.length === 0) return true;
  for (const num of deps) {
    const state = gh(
      `gh issue view ${parseInt(num, 10)} --repo ${shellEsc(repo)} --json state -q ".state"`,
    ).trim();
    if (state !== "CLOSED") return false;
  }
  return true;
}

/** Claim an issue: ready → in-progress. */
export function claimIssue(num, repo, prefix, sessionId) {
  const n = parseInt(num, 10);
  gh(
    `gh issue edit ${n} --repo ${shellEsc(repo)} ` +
      `--add-label ${shellEsc(prefix + ":in-progress")} --remove-label ${shellEsc(prefix + ":ready")}`,
  );
  gh(
    `gh issue comment ${n} --repo ${shellEsc(repo)} ` +
      `--body ${shellEsc("Homer agent `" + sessionId + "` started at " + new Date().toISOString())}`,
  );
}

/** Mark issue done: in-progress → done + close. */
export function completeIssue(num, repo, prefix, sessionId, summary) {
  const n = parseInt(num, 10);
  const body = `Homer agent \`${sessionId}\` completed.\n\n<details><summary>Output</summary>\n\n\`\`\`\n${(summary || "").slice(0, 2000)}\n\`\`\`\n\n</details>`;
  gh(`gh issue comment ${n} --repo ${shellEsc(repo)} --body ${shellEsc(body)}`);
  gh(
    `gh issue edit ${n} --repo ${shellEsc(repo)} ` +
      `--add-label ${shellEsc(prefix + ":done")} --remove-label ${shellEsc(prefix + ":in-progress")}`,
  );
  gh(`gh issue close ${n} --repo ${shellEsc(repo)}`);
}

/** Mark issue failed: in-progress → failed. */
export function failIssue(num, repo, prefix, sessionId, reason) {
  const n = parseInt(num, 10);
  gh(
    `gh issue comment ${n} --repo ${shellEsc(repo)} ` +
      `--body ${shellEsc("Homer agent `" + sessionId + "` failed: " + (reason || "unknown"))}`,
  );
  gh(
    `gh issue edit ${n} --repo ${shellEsc(repo)} ` +
      `--add-label ${shellEsc(prefix + ":failed")} --remove-label ${shellEsc(prefix + ":in-progress")}`,
  );
}

/** Unblock issues whose deps are now met. */
export function syncBlocked(repo, prefix = "homer") {
  const issues = fetchIssues(repo, prefix);
  let count = 0;
  for (const issue of issues) {
    const names = (issue.labels || []).map((l) => l.name);
    if (!names.includes(`${prefix}:blocked`)) continue;
    if (depsMet(issue, repo)) {
      gh(
        `gh issue edit ${parseInt(issue.number, 10)} --repo ${shellEsc(repo)} ` +
          `--add-label ${shellEsc(prefix + ":ready")} --remove-label ${shellEsc(prefix + ":blocked")}`,
      );
      count++;
    }
  }
  return count;
}

/** Create labels if they don't exist. */
export function ensureLabels(repo, prefix = "homer") {
  const labels = [
    [prefix, "Homer managed issue", "0969da"],
    [`${prefix}:ready`, "", "0e8a16"],
    [`${prefix}:in-progress`, "", "fbca04"],
    [`${prefix}:blocked`, "", "d93f0b"],
    [`${prefix}:done`, "", "1d7a28"],
    [`${prefix}:failed`, "", "b60205"],
    ["priority:1", "", "ff0000"],
    ["priority:2", "", "ff6600"],
    ["priority:3", "", "ffcc00"],
    ["priority:4", "", "66cc00"],
    ["priority:5", "", "00cc00"],
  ];
  for (const [name, desc, color] of labels) {
    const descFlag = desc ? `--description ${shellEsc(desc)}` : "";
    gh(
      `gh label create ${shellEsc(name)} --repo ${shellEsc(repo)} --color ${shellEsc(color)} ${descFlag} --force`,
    );
  }
}

/** Pick next ready issue sorted by priority, checking deps. */
export function pickNextIssue(issues, prefix, repo) {
  const ready = issues.filter((i) =>
    (i.labels || []).some((l) => l.name === `${prefix}:ready`),
  );
  ready.sort((a, b) => getPriority(a) - getPriority(b) || a.number - b.number);
  for (const issue of ready) {
    if (depsMet(issue, repo)) return issue;
  }
  return null;
}

// Export shellEsc for testing
export { shellEsc };
