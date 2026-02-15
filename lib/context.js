/**
 * Context management — project index, agent notes, session persistence.
 *
 * All data stored under ~/.homer/:
 *   sessions/{repo-slug}-{ts}.json   Session snapshots
 *   context/{repo-slug}/
 *     index.json                     Project index (tree, exports, conventions)
 *     agent-notes/{agent-id}.md      Per-agent work summaries
 *     shared.md                      Shared decisions & findings
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const HOMER_DIR = join(homedir(), ".homer");
const SESSIONS_DIR = join(HOMER_DIR, "sessions");
const CONTEXT_DIR = join(HOMER_DIR, "context");
const INDEX_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function repoSlug(repo) {
  // "ProfVex/sigmaterminal" → "profvex-sigmaterminal"
  // No repo? Use cwd hash to prevent cross-directory context bleed
  if (!repo) {
    const cwd = process.cwd();
    const cwdHash = cwd.split("/").slice(-2).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "");
    return `local-${cwdHash}`;
  }
  return repo.replace(/\//g, "-").toLowerCase();
}

function run(cmd, cwd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 15000, cwd, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeJSON(path, data) {
  ensureDir(join(path, ".."));
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

// ── Project Index ────────────────────────────────────────────────────────────

/**
 * Build a project index by scanning the working directory.
 * Captures: file tree, key exports, CLAUDE.md conventions, dependencies.
 */
export function buildProjectIndex(cwd, repo) {
  const slug = repoSlug(repo);
  const indexDir = join(CONTEXT_DIR, slug);
  ensureDir(indexDir);

  const index = {
    repo: repo || basename(cwd),
    cwd,
    indexedAt: new Date().toISOString(),
    tree: "",
    keyFiles: [],
    claudeMd: "",
    dependencies: [],
    patterns: [],
    conventions: [],
  };

  // 1. File tree (3 levels, skip noise)
  index.tree = run(
    "tree -L 3 --dirsfirst -I 'node_modules|.git|__pycache__|.venv|dist|build|.next|coverage' --noreport",
    cwd,
  );
  // Fallback if tree not installed
  if (!index.tree) {
    index.tree = run("find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' | head -100 | sort", cwd);
  }

  // 2. Key exports (TypeScript / JavaScript)
  const tsExports = run(
    'grep -rn "export\\s\\+\\(function\\|class\\|const\\|default\\|type\\|interface\\)" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build -l | head -50',
    cwd,
  );
  if (tsExports) {
    for (const file of tsExports.split("\n").filter(Boolean)) {
      const exports = run(
        `grep -oP "export\\s+(function|class|const|type|interface|default)\\s+\\K[a-zA-Z_][a-zA-Z0-9_]*" "${file}" | head -10`,
        cwd,
      );
      // Fallback for macOS grep (no -P flag)
      const exportsAlt = exports || run(
        `grep -o "export [a-z]* [A-Za-z_][A-Za-z0-9_]*" "${file}" | sed 's/export [a-z]* //' | head -10`,
        cwd,
      );
      if (exportsAlt) {
        index.keyFiles.push({
          path: file,
          exports: exportsAlt.split("\n").filter(Boolean),
        });
      }
    }
  }

  // 3. Key exports (Python)
  const pyExports = run(
    'grep -rn "^def \\|^class " --include="*.py" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.venv --exclude-dir=__pycache__ -l | head -30',
    cwd,
  );
  if (pyExports) {
    for (const file of pyExports.split("\n").filter(Boolean)) {
      const defs = run(
        `grep -o "^def [a-zA-Z_][a-zA-Z0-9_]*\\|^class [a-zA-Z_][a-zA-Z0-9_]*" "${file}" | sed 's/^def //;s/^class //' | head -10`,
        cwd,
      );
      if (defs) {
        index.keyFiles.push({
          path: file,
          exports: defs.split("\n").filter(Boolean),
        });
      }
    }
  }

  // 4. CLAUDE.md conventions
  const claudePaths = [
    join(cwd, "CLAUDE.md"),
    join(cwd, ".claude", "CLAUDE.md"),
  ];
  for (const p of claudePaths) {
    const content = readText(p);
    if (content) {
      // Take first 3000 chars to avoid blowing up context
      index.claudeMd = content.slice(0, 3000);
      break;
    }
  }

  // 5. Dependencies from package.json
  const pkgPath = join(cwd, "package.json");
  const pkg = readJSON(pkgPath);
  if (pkg) {
    const deps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    index.dependencies = [
      ...deps.map((d) => `${d} (dep)`),
      ...devDeps.slice(0, 10).map((d) => `${d} (dev)`),
    ];
  }

  // 6. Dependencies from pyproject.toml / requirements.txt
  const pyprojectPath = join(cwd, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    const pyDeps = run('grep -A 50 "\\[project\\]" pyproject.toml | grep -oP \'"[a-zA-Z0-9_-]+"\' | tr -d \'"\' | head -20', cwd);
    const pyDepsFallback = pyDeps || run('grep -A 50 "dependencies" pyproject.toml | grep -o "[a-zA-Z0-9_-]*" | head -20', cwd);
    if (pyDepsFallback) {
      index.dependencies.push(...pyDepsFallback.split("\n").filter(Boolean).map((d) => `${d} (py)`));
    }
  }
  const reqPath = join(cwd, "requirements.txt");
  if (existsSync(reqPath)) {
    const reqs = readText(reqPath).split("\n").filter((l) => l && !l.startsWith("#")).slice(0, 20);
    index.dependencies.push(...reqs.map((r) => r.split("=")[0].split(">")[0].split("<")[0].trim() + " (py)"));
  }

  // Save index
  const indexPath = join(indexDir, "index.json");
  writeJSON(indexPath, index);

  return index;
}

/**
 * Load cached project index. Returns null if stale or missing.
 */
export function loadProjectIndex(repo) {
  const slug = repoSlug(repo);
  const indexPath = join(CONTEXT_DIR, slug, "index.json");
  const index = readJSON(indexPath);
  if (!index) return null;

  // Check staleness
  const age = Date.now() - new Date(index.indexedAt).getTime();
  if (age > INDEX_MAX_AGE_MS) return null;

  return index;
}

/**
 * Get or build project index.
 */
export function getProjectIndex(cwd, repo) {
  return loadProjectIndex(repo) || buildProjectIndex(cwd, repo);
}

// ── Agent Notes ──────────────────────────────────────────────────────────────

/**
 * Save an agent's work summary after completion.
 * Keeps it COMPACT — only file paths touched and status. No output dumps.
 */
export function saveAgentNotes(repo, agent) {
  const slug = repoSlug(repo);
  const notesDir = join(CONTEXT_DIR, slug, "agent-notes");
  ensureDir(notesDir);

  const clean = stripAnsi(agent.outputBuffer || "");
  const lines = clean.split("\n");

  // Extract file paths mentioned in output (deduped)
  const filePaths = new Set();
  for (const line of lines) {
    const matches = line.match(/(?:src|lib|app|pages|components|hooks|api|utils|services|models)\/[^\s:'"`)]+/g);
    if (matches) matches.forEach((m) => filePaths.add(m.replace(/[,;.]+$/, "")));
  }

  const issueLabel = agent.issue ? `#${agent.issue.number} ${agent.issue.title}` : "interactive";
  const now = new Date().toISOString().split("T")[0];

  // Compact format — just the facts, no dumps
  const notes = [
    `${agent.id} | ${issueLabel} | ${agent.status} | ${now}`,
    `files: ${[...filePaths].slice(0, 15).join(", ") || "none detected"}`,
  ].join("\n");

  const notePath = join(notesDir, `${agent.id}.md`);
  writeFileSync(notePath, notes, "utf8");
}

/**
 * Load all agent notes for a repo, sorted by recency.
 */
export function loadAgentNotes(repo) {
  const slug = repoSlug(repo);
  const notesDir = join(CONTEXT_DIR, slug, "agent-notes");
  if (!existsSync(notesDir)) return [];

  const files = readdirSync(notesDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, 5); // Last 5 agent notes

  return files.map((f) => ({
    agent: f.replace(".md", ""),
    content: readText(join(notesDir, f)).slice(0, 500), // compact — each note is ~2 lines
  }));
}

// ── Shared Context ───────────────────────────────────────────────────────────

/**
 * Load shared context file.
 */
export function loadSharedContext(repo) {
  const slug = repoSlug(repo);
  const sharedPath = join(CONTEXT_DIR, slug, "shared.md");
  return readText(sharedPath).slice(0, 500);
}

/**
 * Append an entry to the shared context.
 */
export function appendSharedContext(repo, entry) {
  const slug = repoSlug(repo);
  const dir = join(CONTEXT_DIR, slug);
  ensureDir(dir);
  const sharedPath = join(dir, "shared.md");

  let content = readText(sharedPath);
  if (!content) {
    content = `# Shared Context — ${repo || "local"}\n\n`;
  }

  const timestamp = new Date().toISOString().split("T")[0];
  content += `\n- ${timestamp}: ${entry}`;

  writeFileSync(sharedPath, content, "utf8");
}

// ── Build Agent Prompts ──────────────────────────────────────────────────────
//
// Split into TWO prompts:
//   1. System prompt  → injected via --append-system-prompt (authoritative)
//   2. Task prompt    → passed as positional arg or written to stdin (user-level)
//
// For tools that don't support system prompt injection, both are combined
// and written to stdin as a single message.
//
// Additionally, a .homer/context.md file is written to the project directory
// so any tool can discover it on disk (read it like CLAUDE.md).

/**
 * Build the SYSTEM prompt — DRY enforcement, codebase awareness.
 * This goes into --append-system-prompt for Claude Code.
 * Target: < 400 tokens.
 */
export function buildSystemPrompt(cwd, repo) {
  const parts = [];
  const index = getProjectIndex(cwd, repo);

  parts.push("You are managed by Homer, a multi-agent orchestrator.");
  parts.push("RULES:");
  parts.push("- ALWAYS check .homer/context.md in the project root for existing code before creating new files.");
  parts.push("- Do NOT re-scan the entire codebase — the index below already has key exports.");
  parts.push("- When your task is fully complete and code compiles, output HOMER_DONE on its own line.");
  parts.push("- If stuck or going in circles, output HOMER_BLOCKED followed by the reason.");
  parts.push("- Homer runs verification (typecheck/tests) after HOMER_DONE. If checks fail, you'll receive errors — fix them and signal HOMER_DONE again.");
  parts.push("- Commit your changes BEFORE signaling HOMER_DONE.");

  // Key exports — the DRY core. One line per file, max 15 files.
  if (index && index.keyFiles.length > 0) {
    parts.push("\nEXISTING EXPORTS (reuse, do NOT recreate):");
    for (const f of index.keyFiles.slice(0, 15)) {
      parts.push(`  ${f.path}: ${f.exports.slice(0, 5).join(", ")}`);
    }
  }

  // Recent agent work — just first lines, max 5
  const notes = loadAgentNotes(repo);
  if (notes.length > 0) {
    parts.push("\nRECENT AGENT WORK (check before duplicating):");
    for (const n of notes) {
      parts.push(`  ${n.content.split("\n")[0]}`);
    }
  }

  // Circular work guard
  if (notes.length >= 2) {
    const allFiles = notes.map((n) => {
      const filesLine = n.content.split("\n").find((l) => l.startsWith("files:"));
      return filesLine ? filesLine.replace("files: ", "").split(", ") : [];
    }).flat().filter(Boolean);
    const freq = {};
    for (const f of allFiles) { freq[f] = (freq[f] || 0) + 1; }
    const repeated = Object.entries(freq).filter(([, count]) => count >= 2).map(([f]) => f);
    if (repeated.length > 0) {
      parts.push(`\nWARNING: Files modified by multiple agents: ${repeated.slice(0, 5).join(", ")}`);
      parts.push("Verify previous work before touching these files.");
    }
  }

  // Shared context
  const shared = loadSharedContext(repo);
  if (shared && shared.length < 300) {
    parts.push("\nTEAM NOTES:");
    parts.push(shared);
  }

  return parts.join("\n");
}

/**
 * Build the TASK prompt — the actual issue/work to do.
 * This goes as positional arg for Claude Code, or written to stdin for other tools.
 */
export function buildTaskPrompt(issue) {
  if (!issue) return "";

  const parts = [];
  parts.push(`Work on Issue #${issue.number}: ${issue.title}`);
  if (issue.body) parts.push(issue.body.slice(0, 1000));
  parts.push("\nRead .homer/context.md first for existing code you must reuse.");
  parts.push("Signal HOMER_DONE when complete, HOMER_BLOCKED if stuck.");
  return parts.join("\n");
}

/**
 * Build a combined prompt for tools that don't support --append-system-prompt.
 * Falls back to the old single-prompt approach via stdin.
 */
export function buildAgentPrompt(cwd, repo, issue) {
  const system = buildSystemPrompt(cwd, repo);
  const task = buildTaskPrompt(issue);
  return [system, task].filter(Boolean).join("\n\n");
}

/**
 * Build a resume task prompt for continuing from a previous session.
 */
export function buildResumePrompt(cwd, repo, prevAgent) {
  const parts = [];

  parts.push(`Continue previous work as ${prevAgent.id}.`);
  if (prevAgent.issueNumber) {
    parts.push(`Task: Issue #${prevAgent.issueNumber} — ${prevAgent.issueTitle || "unknown"}`);
  }

  // Last 15 lines of previous output for context
  if (prevAgent.outputTail) {
    const lastLines = prevAgent.outputTail.split("\n").slice(-15).join("\n");
    if (lastLines.trim()) {
      parts.push("\nLast output before session ended:");
      parts.push(lastLines);
    }
  }

  parts.push("\nCheck git status for uncommitted changes, then continue.");
  parts.push("Signal HOMER_DONE when complete, HOMER_BLOCKED if stuck.");

  return parts.join("\n");
}

/**
 * Write .homer/context.md to the project directory.
 * This file persists on disk and is discoverable by any AI tool.
 * Called on startup and when index is rebuilt.
 */
export function writeProjectContext(cwd, repo) {
  const dir = join(cwd, ".homer");
  ensureDir(dir);
  const contextPath = join(dir, "context.md");

  const index = getProjectIndex(cwd, repo);
  const notes = loadAgentNotes(repo);
  const shared = loadSharedContext(repo);

  const lines = [];
  lines.push("# Homer Project Context");
  lines.push(`# Auto-generated — do not edit manually`);
  lines.push(`# Updated: ${new Date().toISOString()}`);
  lines.push("");

  if (index && index.keyFiles.length > 0) {
    lines.push("## Key Exports (reuse these, do NOT recreate)");
    lines.push("");
    for (const f of index.keyFiles.slice(0, 20)) {
      lines.push(`- **${f.path}**: ${f.exports.slice(0, 8).join(", ")}`);
    }
    lines.push("");
  }

  if (index && index.dependencies.length > 0) {
    lines.push("## Installed Dependencies");
    lines.push("");
    lines.push(index.dependencies.slice(0, 20).join(", "));
    lines.push("");
  }

  if (notes.length > 0) {
    lines.push("## Recent Agent Work");
    lines.push("");
    for (const n of notes) {
      lines.push(`- ${n.content.split("\n")[0]}`);
      const filesLine = n.content.split("\n").find((l) => l.startsWith("files:"));
      if (filesLine) lines.push(`  ${filesLine}`);
    }
    lines.push("");
  }

  if (shared) {
    lines.push("## Team Notes");
    lines.push("");
    lines.push(shared);
    lines.push("");
  }

  writeFileSync(contextPath, lines.join("\n"), "utf8");

  // Add .homer to .gitignore if not already there
  const gitignorePath = join(cwd, ".gitignore");
  try {
    const gitignore = readText(gitignorePath);
    if (gitignore && !gitignore.includes(".homer")) {
      writeFileSync(gitignorePath, gitignore.trimEnd() + "\n\n# Added by Homer — agent working directory\n.homer/\n", "utf8");
    }
  } catch {
    // No .gitignore exists — only add .homer entry (don't create a whole file)
    // Users should manage their own .gitignore
  }

  return contextPath;
}

// ── Session Persistence ──────────────────────────────────────────────────────

/**
 * Save current session state to disk.
 */
export function saveSession(state, opts) {
  ensureDir(SESSIONS_DIR);

  const slug = repoSlug(opts.repo);
  const session = {
    sessionId: `homer-${Date.now()}`,
    repo: opts.repo,
    cwd: process.cwd(),
    savedAt: new Date().toISOString(),
    activeTool: state.activeTool ? state.activeTool.id : null,
    opts: {
      permissionMode: opts.permissionMode,
      maxAgents: opts.maxAgents,
      prefix: opts.prefix,
      auto: opts.auto,
    },
    agents: state.agents.map((a) => ({
      id: a.id,
      issueNumber: a.issue ? a.issue.number : null,
      issueTitle: a.issue ? a.issue.title : null,
      tool: a.tool ? a.tool.id : null,
      status: a.status,
      startedAt: new Date(a.startedAt).toISOString(),
      outputTail: stripAnsi(a.outputBuffer || "").split("\n").slice(-100).join("\n"),
    })),
    agentCounter: state.agentCounter,
    selectedAgent: state.selectedAgent,
  };

  const sessionPath = join(SESSIONS_DIR, `${slug}.json`);
  writeJSON(sessionPath, session);
}

/**
 * Load most recent session for a repo.
 */
export function loadSession(repo) {
  const slug = repoSlug(repo);
  const sessionPath = join(SESSIONS_DIR, `${slug}.json`);
  const session = readJSON(sessionPath);
  if (!session) return null;

  // Check if session is too old (> 24h)
  const age = Date.now() - new Date(session.savedAt).getTime();
  if (age > 24 * 60 * 60 * 1000) return null;

  return session;
}

/**
 * Delete session for a repo.
 */
export function clearSession(repo) {
  const slug = repoSlug(repo);
  const sessionPath = join(SESSIONS_DIR, `${slug}.json`);
  try { unlinkSync(sessionPath); } catch {}
}

// ── Index Stats (for sidebar display) ────────────────────────────────────────

/**
 * Get a short summary of the index for sidebar display.
 */
export function indexStats(repo) {
  const index = loadProjectIndex(repo);
  if (!index) return null;

  const exportCount = index.keyFiles.reduce((sum, f) => sum + f.exports.length, 0);
  const depCount = index.dependencies.length;
  const hasClaudeMd = !!index.claudeMd;
  const age = Math.floor((Date.now() - new Date(index.indexedAt).getTime()) / 60000);

  return { exportCount, depCount, hasClaudeMd, ageMinutes: age, fileCount: index.keyFiles.length };
}

// ── Workflow History (product evolution tracking) ────────────────────────────

/**
 * Record a completed workflow — agent finished an issue or interactive task.
 * Stored as a compact append-only log: one line per completion.
 */
export function recordWorkflow(repo, agent) {
  const slug = repoSlug(repo);
  const dir = join(CONTEXT_DIR, slug);
  ensureDir(dir);
  const logPath = join(dir, "workflows.log");

  const now = new Date().toISOString();
  const issueLabel = agent.issue ? `#${agent.issue.number} ${agent.issue.title}` : "interactive";
  const duration = agent.startedAt
    ? Math.floor((Date.now() - agent.startedAt) / 60000) + "m"
    : "?";

  // Extract files touched from output
  const clean = stripAnsi(agent.outputBuffer || "");
  const filePaths = new Set();
  for (const line of clean.split("\n")) {
    const matches = line.match(/(?:src|lib|app|pages|components|hooks|api|utils|services|models)\/[^\s:'"`)]+/g);
    if (matches) matches.forEach((m) => filePaths.add(m.replace(/[,;.]+$/, "")));
  }

  const entry = `${now} | ${agent.id} | ${agent.status} | ${issueLabel} | ${duration} | ${[...filePaths].slice(0, 8).join(", ") || "none"}\n`;

  try {
    const existing = readText(logPath);
    writeFileSync(logPath, existing + entry, "utf8");
  } catch {
    writeFileSync(logPath, entry, "utf8");
  }
}

/**
 * Load workflow history for display. Returns last N entries.
 */
export function loadWorkflowHistory(repo, limit = 20) {
  const slug = repoSlug(repo);
  const logPath = join(CONTEXT_DIR, slug, "workflows.log");
  const content = readText(logPath);
  if (!content) return [];

  return content.trim().split("\n").slice(-limit).reverse().map((line) => {
    const parts = line.split(" | ");
    return {
      date: parts[0] || "",
      agent: parts[1] || "",
      status: parts[2] || "",
      task: parts[3] || "",
      duration: parts[4] || "",
      files: parts[5] || "",
    };
  });
}
