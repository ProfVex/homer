/**
 * Tool detection — find which AI CLIs are installed.
 *
 * Each tool has: name, command, args for interactive mode, version check,
 * and whether it supports permission modes.
 */

import { execSync, spawn as spawnProc } from "node:child_process";

/** Known AI CLI tools and how to invoke them. */
const KNOWN_TOOLS = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    versionFlag: "--version",
    interactive: true,
    permissionModes: true,
    supportsSystemPrompt: true,   // --append-system-prompt
    supportsInitialPrompt: true,  // positional [prompt] arg
    args: (opts) => {
      const a = [];
      if (opts.permissionMode) a.push("--permission-mode", opts.permissionMode);
      // System prompt for DRY context — injected as authoritative instruction
      if (opts.systemPrompt) a.push("--append-system-prompt", opts.systemPrompt);
      // Initial prompt (issue/task) — passed as positional arg after --
      return a;
    },
    buildInitialPrompt: (prompt) => [prompt],  // positional arg
    color: "#5fafff",  // blue
    icon: "\u2B22", // ⬢
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    versionFlag: "--version",
    interactive: true,
    permissionModes: false,
    args: () => [],
    color: "#87d787", // green
    icon: "\u25C6", // ◆
  },
  {
    id: "aider",
    name: "Aider",
    command: "aider",
    versionFlag: "--version",
    interactive: true,
    permissionModes: false,
    args: (opts) => {
      const a = [];
      if (opts.model) a.push("--model", opts.model);
      return a;
    },
    color: "#ffd700", // amber
    icon: "\u25B2", // ▲
  },
  {
    id: "cline",
    name: "Cline",
    command: "cline",
    versionFlag: "--version",
    interactive: true,
    permissionModes: false,
    args: () => [],
    color: "#af5faf", // magenta
    icon: "\u25CF", // ●
  },
  {
    id: "openrouter",
    name: "OpenRouter (via aider)",
    command: "aider",
    versionFlag: "--version",
    interactive: true,
    permissionModes: false,
    args: (opts) => {
      const a = ["--openrouter"];
      if (opts.model) a.push("--model", opts.model);
      return a;
    },
    requiresEnv: "OPENROUTER_API_KEY",
    color: "#d75f5f", // red
    icon: "\u25C8", // ◈
  },
];

/**
 * Detect which tools are installed (FAST — no --version calls).
 * Only runs `command -v` for each tool (~3ms each).
 * Returns array of { ...tool, version: null, available }.
 */
export function detectTools() {
  // De-dupe command checks — e.g. "aider" appears twice (aider + openrouter)
  const checked = new Map();
  const results = [];

  for (const tool of KNOWN_TOOLS) {
    const info = { ...tool, version: null, available: false };

    // Check if command exists (cache by command name)
    if (!checked.has(tool.command)) {
      try {
        execSync(`command -v ${tool.command}`, { stdio: "ignore" });
        checked.set(tool.command, true);
      } catch {
        checked.set(tool.command, false);
      }
    }

    if (!checked.get(tool.command)) {
      results.push(info);
      continue;
    }

    info.available = true;

    // Check env requirement
    if (tool.requiresEnv && !process.env[tool.requiresEnv]) {
      info.available = false;
      info.reason = `${tool.requiresEnv} not set`;
    }

    results.push(info);
  }

  return results;
}

/**
 * Fetch version strings for available tools (slow — runs --version).
 * Call this AFTER UI is rendered to avoid blocking startup.
 * Mutates the tool objects in-place.
 */
export function enrichToolVersions(tools, callback) {
  // De-dupe version checks by command name
  const pending = new Map();
  for (const t of tools) {
    if (t.available && !pending.has(t.command)) {
      pending.set(t.command, []);
    }
    if (t.available) pending.get(t.command).push(t);
  }

  let remaining = pending.size;
  if (remaining === 0) { if (callback) callback(); return; }

  for (const [cmd, toolRefs] of pending) {
    const vFlag = toolRefs[0].versionFlag;
    const proc = spawnProc(cmd, [vFlag], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("close", () => {
      const version = out.trim().split("\n")[0].slice(0, 40) || "?";
      for (const t of toolRefs) t.version = version;
      remaining--;
      if (remaining === 0 && callback) callback();
    });
    proc.on("error", () => {
      for (const t of toolRefs) t.version = "?";
      remaining--;
      if (remaining === 0 && callback) callback();
    });
  }
}

/**
 * Get a tool config by id.
 */
export function getTool(id) {
  return KNOWN_TOOLS.find((t) => t.id === id) || null;
}

/**
 * Get only available tools.
 */
export function getAvailableTools() {
  return detectTools().filter((t) => t.available);
}
