/**
 * Homer Engine — headless agent orchestrator.
 *
 * EventEmitter that manages agent lifecycle: spawn, verify, reroute, auto-assign.
 * No UI code. The web frontend subscribes to events and renders.
 *
 * Events:
 *   agent:spawned   { id, tool, task }
 *   agent:output    { id, data }
 *   agent:status    { id, status, prev }
 *   agent:done      { id, task }
 *   agent:rerouted  { oldId, newId, task, reason }
 *   verify:start    { id }
 *   verify:result   { id, passed, attempt, max, results }
 *   state           (full snapshot — debounced)
 *   error           { message }
 */

import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { detectTools, getTool } from "./tools.js";
import {
  loadPRD, nextStory, prdProgress, markStoryPassed, markStoryFailed,
  detectVerifyCommands, runVerification, buildVerificationFeedback,
  buildStoryPrompt, buildSubtaskPrompt, decomposeStory, appendProgress,
} from "./tasks.js";
import {
  initMemory, closeMemory, extractMemories, buildMemorySection,
  buildRerouteContext, buildRuleHints, memoryStats,
  recordVerification, recordSuccess, recordFailure,
  recordContextCompaction,
  getLastInjectedRuleIds,
  consolidate as consolidateMemory,
} from "./memory.js";
import {
  detectRepo, fetchIssues, fetchAllIssues, categorize,
  claimIssue, pickNextIssue,
} from "./github.js";
import {
  getProjectIndex, buildProjectIndex, buildSystemPrompt,
  buildTaskPrompt, buildAgentPrompt, buildResumePrompt,
  writeProjectContext, saveAgentNotes, saveSession, loadSession,
  clearSession, repoSlug, appendSharedContext, recordWorkflow,
} from "./context.js";

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_VERIFY = 5;
const MAX_REROUTES = 2;
const BUFFER_MAX_KB = 256;
const BUFFER_TRIM_KB = 300;
const BUFFER_KEEP_KB = 128;

// ── Roles (inlined — no separate file needed) ───────────────────────────────

const ROLES = {
  general:    { id: "general",    name: "General",     icon: "●", color: "#5fafff" },
  planner:    { id: "planner",    name: "Planner",     icon: "◆", color: "#87d787" },
  coder:      { id: "coder",      name: "Coder",       icon: "▲", color: "#ffd700" },
  data:       { id: "data",       name: "Data",        icon: "▣", color: "#d75f5f" },
  api:        { id: "api",        name: "API",         icon: "◈", color: "#af5faf" },
  researcher: { id: "researcher", name: "Researcher",  icon: "🔍", color: "#ffd700" },
  verifier:   { id: "verifier",   name: "Verifier",    icon: "✓", color: "#5fafff" },
};

const LABEL_ROLE_MAP = {
  "homer:data": "data", "homer:api": "api", "homer:research": "researcher",
  "homer:plan": "planner", "homer:verify": "verifier",
  data: "data", api: "api", research: "researcher",
};

function inferRole(labels = []) {
  for (const l of labels) {
    const name = typeof l === "string" ? l : l.name;
    if (LABEL_ROLE_MAP[name]) return LABEL_ROLE_MAP[name];
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function resolveCmd(cmd) {
  try {
    return execSync(`command -v ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return cmd; }
}

function taskKey(agent) {
  if (agent.story) return `story:${agent.story.id}`;
  if (agent.issue) return `issue:${agent.issue.number}`;
  return null;
}

function extractFilePaths(text) {
  const fps = [];
  const re = /(?:^|\s)((?:src|lib|app|pages|components|hooks|utils|test|tests|spec|config|public|assets|api|scripts|bin|deploy|docker|k8s|infra)\/[^\s,)]+\.[a-z]{1,5})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fp = m[1].replace(/[,.)]+$/, "");
    if (!fps.includes(fp)) fps.push(fp);
  }
  return fps;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class HomerEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      repo: opts.repo || "",
      tool: opts.tool || "",
      role: opts.role || "",
      prefix: opts.prefix || "homer",
      auto: opts.auto || false,
      maxAgents: opts.maxAgents || 5,
      permissionMode: opts.permissionMode || "bypassPermissions",
      model: opts.model || "",
      resume: opts.resume || false,
      fresh: opts.fresh || false,
    };

    this.agents = [];
    this.agentCounter = 0;
    this.taskRetryCounts = new Map();
    this.activeTool = null;
    this.prd = null;
    this.prdPath = null;
    this.verifyCmds = [];
    this.issues = [];
    this.allIssues = [];
    this.buckets = { inProgress: [], ready: [], blocked: [], done: [], failed: [] };

    // Sub-task tracking: parentStoryId → { subtasks: [], completed: Set }
    this.subtaskMap = new Map();

    this._stateTimer = null;
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  async init() {
    // Detect tools
    const allTools = detectTools();
    const available = allTools.filter(t => t.available);

    if (this.opts.tool) {
      this.activeTool = allTools.find(t => t.id === this.opts.tool || t.command === this.opts.tool);
      if (!this.activeTool) {
        try {
          execSync(`command -v ${this.opts.tool}`, { stdio: "ignore" });
          this.activeTool = {
            id: this.opts.tool, name: this.opts.tool, command: this.opts.tool,
            interactive: true, permissionModes: false, args: () => [], color: "#5fafff", icon: "●",
          };
        } catch {
          throw new Error(`Tool not found: ${this.opts.tool}. Available: ${available.map(t => t.id).join(", ")}`);
        }
      }
    } else if (available.length === 1) {
      this.activeTool = available[0];
    }

    // Repo detection
    if (!this.opts.repo) {
      try { this.opts.repo = detectRepo(); } catch {}
    }

    // Load PRD + verify commands
    const prdData = loadPRD(process.cwd());
    if (prdData) { this.prd = prdData.prd; this.prdPath = prdData.path; }
    this.verifyCmds = detectVerifyCommands(process.cwd());

    // Init memory
    try { initMemory(repoSlug(this.opts.repo)); } catch {}

    // Project index (background)
    try { getProjectIndex(process.cwd(), this.opts.repo); } catch {}
    try { writeProjectContext(process.cwd(), this.opts.repo); } catch {}

    // Issues
    if (this.opts.repo) {
      try { this.allIssues = fetchAllIssues(this.opts.repo); } catch {}
      if (this.opts.auto) {
        try {
          this.issues = fetchIssues(this.opts.repo, this.opts.prefix);
          this.buckets = categorize(this.issues, this.opts.prefix);
        } catch {}
      }
    }

    // Session resume
    if (!this.opts.fresh) {
      const prev = loadSession(this.opts.repo);
      if (prev && this.opts.resume) {
        this._resumeSession(prev);
        return;
      }
      if (prev) {
        // Emit so frontend can ask user
        this.emit("session:found", prev);
        return;
      }
    }

    this._startFresh(available);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  spawnAgent(issue = null) {
    this.agentCounter++;
    const id = `agent-${this.agentCounter}`;

    if (!issue && this.opts.auto) {
      issue = this._pickNextTask();
    }

    const agent = this._makeAgent(id, issue);
    if (!agent) return null;

    this.agents.push(agent);
    this._emitState();
    return agent;
  }

  killAgent(id) {
    const agent = this.agents.find(a => a.id === id);
    if (!agent) return;
    try { agent.pty.kill(); } catch {}
    agent.status = "killed";
    this._setStatus(agent, "killed");
  }

  sendInput(id, data) {
    const agent = this.agents.find(a => a.id === id);
    if (agent?.pty) agent.pty.write(data);
  }

  setTool(toolId) {
    const tool = getTool(toolId);
    if (tool) {
      this.activeTool = tool;
      this._emitState();
    }
  }

  resumeFound(doResume) {
    const prev = loadSession(this.opts.repo);
    if (doResume && prev) {
      this._resumeSession(prev);
    } else {
      clearSession(this.opts.repo);
      this._startFresh(detectTools().filter(t => t.available));
    }
  }

  getState() {
    return {
      agents: this.agents.map(a => ({
        id: a.id, status: a.status, tool: a.tool?.id,
        task: a.story ? { type: "story", key: a.story.id, title: a.story.title }
            : a.issue ? { type: "issue", key: a.issue.number, title: a.issue.title }
            : { type: "interactive" },
        role: a.role,
        verifyAttempts: a.verifyAttempts,
        startedAt: a.startedAt,
        elapsed: Date.now() - a.startedAt,
      })),
      activeTool: this.activeTool?.id || null,
      tools: detectTools().filter(t => t.available).map(t => ({ id: t.id, name: t.name, icon: t.icon })),
      prd: this.prd ? prdProgress(this.prd) : null,
      repo: this.opts.repo,
      auto: this.opts.auto,
      memory: memoryStats(),
      issues: this.allIssues.length,
    };
  }

  cleanup() {
    try { saveSession({ agents: this.agents, agentCounter: this.agentCounter, activeTool: this.activeTool?.id }, this.opts); } catch {}
    for (const a of this.agents) {
      if (this.opts.repo) { try { saveAgentNotes(this.opts.repo, a); } catch {} }
      try { a.pty?.kill(); } catch {}
    }
    try { closeMemory(); } catch {}
    if (this._refreshInterval) clearInterval(this._refreshInterval);
  }

  // ── Agent Factory ─────────────────────────────────────────────────────────

  _makeAgent(id, issue, resumeCtx = null) {
    if (!this.activeTool) return null;
    const tool = this.activeTool;

    // Build prompts
    let taskPrompt;
    if (resumeCtx) {
      taskPrompt = buildResumePrompt(process.cwd(), this.opts.repo, resumeCtx);
    } else if (issue?._story) {
      taskPrompt = buildStoryPrompt(issue._story, this.prd);
    } else {
      taskPrompt = buildTaskPrompt(issue);
    }

    const spawnOpts = { ...this.opts };
    if (tool.supportsSystemPrompt) {
      spawnOpts.systemPrompt = buildSystemPrompt(process.cwd(), this.opts.repo);
    }
    if (tool.supportsInitialPrompt && taskPrompt) {
      spawnOpts._initialPrompt = taskPrompt;
    }

    // AC5/AC6: Capture which rules were injected into this agent's prompt
    let injectedRuleIds = [];
    try { injectedRuleIds = getLastInjectedRuleIds(); } catch {}

    // Resolve role
    const roleId = this.opts.role || inferRole(issue?.labels) || "general";

    const agent = {
      id, pty: null, issue: issue || null,
      story: issue?._story || null,
      status: "working", outputBuffer: "",
      startedAt: Date.now(), tool,
      role: roleId, verifyAttempts: 0, verifyHistory: [],
      injectedRuleIds,
    };

    // Spawn PTY
    try {
      agent.pty = this._spawnPTY(tool, spawnOpts, 120, 30);
    } catch (e) {
      this.emit("error", { message: `Failed to spawn ${tool.name}: ${e.message}` });
      return null;
    }

    // Wire output
    agent.pty.onData(data => {
      agent.outputBuffer += data;
      this._trimBuffer(agent);
      this.emit("agent:output", { id, data });

      if (agent.status !== "working") return;
      const tail = stripAnsi(agent.outputBuffer).slice(-500);
      if (tail.includes("HOMER_DONE")) this._handleDone(agent);
      else if (tail.includes("HOMER_BLOCKED")) {
        const m = tail.match(/HOMER_BLOCKED[: ]*(.*)/);
        this._handleBlocked(agent, m ? m[1].trim() : "unknown");
      }
    });

    agent.pty.onExit(({ exitCode, signal }) => {
      if (agent.status === "working") {
        agent.status = "exited";
        this._setStatus(agent, "exited");
        this._persistAgent(agent);
        try { extractMemories(agent); } catch {}

        // Record crash in memory v2
        const filesTouched = extractFilePaths(stripAnsi(agent.outputBuffer || ""));
        try { recordFailure(agent.id, taskKey(agent), `Crashed (exit ${exitCode}, signal ${signal})`, "crashed", filesTouched, agent.injectedRuleIds || []); } catch {}

        if (this.opts.auto && taskKey(agent)) {
          this._reroute(agent, `Crashed (exit ${exitCode}, signal ${signal})`);
          setTimeout(() => this._autoSpawnNext(), 1000);
        }
      }
    });

    // For tools without prompt injection, send prompt after ready
    if (!tool.supportsSystemPrompt || !tool.supportsInitialPrompt) {
      const prompt = issue?._story
        ? buildStoryPrompt(issue._story, this.prd) + "\n\n" + buildSystemPrompt(process.cwd(), this.opts.repo)
        : buildAgentPrompt(process.cwd(), this.opts.repo, issue);
      if (prompt) this._waitForReady(agent, () => agent.pty.write(prompt + "\n"));
    }

    this.emit("agent:spawned", { id, tool: tool.id, task: taskKey(agent) });
    this._setStatus(agent, "working");
    return agent;
  }

  // ── PTY Spawn ─────────────────────────────────────────────────────────────

  _spawnPTY(tool, opts, cols, rows) {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const toolArgs = tool.args ? tool.args(opts) : [];
    if (tool.buildInitialPrompt && opts._initialPrompt) {
      toolArgs.push(...tool.buildInitialPrompt(opts._initialPrompt));
    }

    let dataHandler = null, exitHandler = null;
    const proc = Bun.spawn([resolveCmd(tool.command), ...toolArgs], {
      terminal: { cols, rows, name: "xterm-256color",
        data(_, d) { if (dataHandler) dataHandler(new TextDecoder().decode(d)); },
      },
      cwd: process.cwd(), env,
      onExit(_, exitCode, sig) { if (exitHandler) exitHandler({ exitCode: exitCode ?? 0, signal: sig ?? 0 }); },
    });

    return {
      onData(cb) { dataHandler = cb; },
      onExit(cb) { exitHandler = cb; },
      write(d) { proc.terminal.write(d); },
      kill() { proc.kill(); },
      resize(c, r) { proc.terminal.resize(c, r); },
      get pid() { return proc.pid; },
    };
  }

  // ── Verification ──────────────────────────────────────────────────────────

  _handleDone(agent) {
    agent.status = "verifying";
    agent.verifyAttempts++;
    this._setStatus(agent, "verifying");
    this.emit("verify:start", { id: agent.id });

    setTimeout(() => {
      const result = runVerification(process.cwd(), this.verifyCmds);

      // Write to memory after EVERY verification run (v2: real-time learning)
      const filesTouched = extractFilePaths(stripAnsi(agent.outputBuffer || ""));
      try {
        recordVerification(agent.id, taskKey(agent), result, filesTouched, agent.tool?.id, agent.verifyAttempts);
      } catch {}

      if (result.skipped || result.passed) {
        this._finalizeDone(agent, filesTouched);
        return;
      }

      const failed = result.results.filter(r => !r.passed);

      if (agent.verifyAttempts >= MAX_VERIFY) {
        const summary = failed.map(r => `${r.name}: ${r.output.slice(0, 200)}`).join("\n\n");
        this._persistAgent(agent);
        try { recordFailure(agent.id, taskKey(agent), summary, "failed", filesTouched, agent.injectedRuleIds || []); } catch {}
        this._reroute(agent, `Verification failed ${MAX_VERIFY}x:\n${summary}`);
        return;
      }

      // Record failure, re-inject
      agent.verifyHistory.push({
        attempt: agent.verifyAttempts,
        errors: failed.map(r => `${r.name}: ${r.output.slice(0, 150)}`).join("\n"),
        outputSnippet: stripAnsi(agent.outputBuffer).slice(-300),
      });

      agent.status = "working";
      const feedback = buildVerificationFeedback(result.results, agent.story);
      const history = agent.verifyAttempts > 1 ? this._buildRetryWarning(agent) : "";
      agent.pty.write("\n" + feedback + history + "\n");

      this._setStatus(agent, "working");
      this.emit("verify:result", {
        id: agent.id, passed: false,
        attempt: agent.verifyAttempts, max: MAX_VERIFY,
        results: failed.map(r => ({ name: r.name, output: r.output.slice(0, 300) })),
      });
    }, 100);
  }

  _finalizeDone(agent, filesTouched = []) {
    agent.status = "done";
    this._setStatus(agent, "done");

    if (agent.story && this.prd && this.prdPath) {
      if (agent.story._isSubtask && agent.story._parentId) {
        // Sub-task completed — track it and check if parent is done
        const entry = this.subtaskMap.get(agent.story._parentId);
        if (entry) {
          entry.completed.add(agent.story.id);
          const allDone = entry.subtasks.every(st => entry.completed.has(st.id));
          if (allDone) {
            markStoryPassed(this.prdPath, this.prd, agent.story._parentId,
              `All ${entry.subtasks.length} sub-tasks completed`);
            try { appendProgress(process.cwd(), agent.story._parentId,
              agent.story.title.split(":")[0], "PASSED",
              `All ${entry.subtasks.length} sub-tasks verified`); } catch {}
          }
        }
      } else {
        markStoryPassed(this.prdPath, this.prd, agent.story.id, `Completed by ${agent.id}`);
        try { appendProgress(process.cwd(), agent.story.id, agent.story.title, "PASSED", `Verified after ${agent.verifyAttempts} attempt(s)`); } catch {}
      }
    }

    this._persistAgent(agent);
    try { extractMemories(agent); } catch {}

    // Record success in memory v2 (structured) — AC5: pass injected rules to strengthen
    try { recordSuccess(agent.id, taskKey(agent), filesTouched, agent.verifyAttempts, agent.injectedRuleIds || []); } catch {}

    // Consolidate every 10 completions
    const doneCount = this.agents.filter(a => a.status === "done").length;
    if (doneCount > 0 && doneCount % 10 === 0) { try { consolidateMemory(); } catch {} }

    this.emit("agent:done", { id: agent.id, task: taskKey(agent) });
    this.emit("verify:result", { id: agent.id, passed: true, attempt: agent.verifyAttempts, max: MAX_VERIFY });

    if (this.opts.auto) setTimeout(() => this._autoSpawnNext(), 500);
  }

  _handleBlocked(agent, reason) {
    agent.status = "blocked";
    agent.blockReason = reason;
    this._setStatus(agent, "blocked");
    this._persistAgent(agent);
    try { extractMemories(agent); } catch {}

    // Record blocked in memory v2
    const filesTouched = extractFilePaths(stripAnsi(agent.outputBuffer || ""));
    try { recordFailure(agent.id, taskKey(agent), reason, "blocked", filesTouched, agent.injectedRuleIds || []); } catch {}

    if (this.opts.auto && taskKey(agent)) {
      this._reroute(agent, `Blocked: ${reason}`);
      setTimeout(() => this._autoSpawnNext(), 500);
    }
  }

  // ── Rerouting ─────────────────────────────────────────────────────────────

  _reroute(agent, reason) {
    const key = taskKey(agent);
    if (!key) return false;

    const retries = this.taskRetryCounts.get(key) || 0;
    if (retries >= MAX_REROUTES) {
      agent.status = "failed";
      if (agent.story && this.prd && this.prdPath) {
        markStoryFailed(this.prdPath, this.prd, agent.story.id, `Failed after ${retries + 1} agents`);
      }
      this._setStatus(agent, "failed");
      return false;
    }

    this.taskRetryCounts.set(key, retries + 1);
    try { agent.pty.kill(); } catch {}
    agent.status = "rerouted";
    this._setStatus(agent, "rerouted");

    // Build context for new agent
    const cleanOutput = stripAnsi(agent.outputBuffer || "");
    const files = extractFilePaths(cleanOutput);
    const ctx = [
      "═".repeat(60),
      "HOMER REROUTE — PREVIOUS AGENT FAILED THIS TASK",
      "═".repeat(60), "",
      `Attempt ${retries + 2} of ${MAX_REROUTES + 1}. Failure: ${reason.slice(0, 500)}`, "",
    ];
    if (agent.verifyHistory.length) {
      ctx.push("Previous failures:");
      for (const h of agent.verifyHistory) ctx.push(`  Attempt ${h.attempt}: ${h.errors.slice(0, 200)}`);
      ctx.push("");
    }
    try { const mc = buildRerouteContext(key, files); if (mc) { ctx.push(mc, ""); } } catch {}
    ctx.push("RULES:", "- Do NOT repeat failed approaches.", "- Think about the ROOT CAUSE.", "═".repeat(60), "");
    const rerouteCtx = ctx.join("\n");

    // Spawn replacement after brief delay
    setTimeout(() => {
      const issue = agent.story
        ? { number: agent.story.id, title: agent.story.title, body: agent.story.description, _story: agent.story }
        : agent.issue;

      this.agentCounter++;
      const newId = `agent-${this.agentCounter}`;
      const newAgent = this._makeAgent(newId, issue);
      if (!newAgent) return;

      this.agents.push(newAgent);
      this._waitForReady(newAgent, () => newAgent.pty.write(rerouteCtx));
      this.emit("agent:rerouted", { oldId: agent.id, newId, task: key, reason });
      this._emitState();
    }, 1500);

    return true;
  }

  // ── Auto-Spawn ────────────────────────────────────────────────────────────

  _autoSpawnNext() {
    if (!this.opts.auto || !this.activeTool) return;

    const active = this.agents.filter(a => a.status === "working" || a.status === "verifying");
    if (active.length >= this.opts.maxAgents) return;

    const toSpawn = this.opts.maxAgents - active.length;
    for (let i = 0; i < toSpawn; i++) {
      const task = this._pickNextTask();
      if (!task) break;
      this.spawnAgent(task);
    }
  }

  _pickNextTask() {
    // Check for pending sub-tasks first
    for (const [parentId, entry] of this.subtaskMap) {
      const next = entry.subtasks.find(st => !st.passes && !entry.completed.has(st.id));
      if (next) {
        const parentStory = this.prd?.userStories?.find(s => s.id === parentId);
        if (!parentStory) continue;
        const siblingNotes = entry.subtasks
          .filter(st => entry.completed.has(st.id))
          .map(st => st.criterion);
        const prompt = buildSubtaskPrompt(next, parentStory, this.prd, siblingNotes);
        return {
          number: next.id, title: next.title, body: prompt,
          _story: { ...next, _isSubtask: true, _parentId: parentId },
        };
      }
    }

    if (this.prd) {
      const story = nextStory(this.prd);
      if (story) {
        // Auto-decompose stories with >2 acceptance criteria
        const subtasks = decomposeStory(story);
        if (subtasks) {
          this.subtaskMap.set(story.id, { subtasks, completed: new Set() });
          // Return first sub-task
          const first = subtasks[0];
          const prompt = buildSubtaskPrompt(first, story, this.prd, []);
          return {
            number: first.id, title: first.title, body: prompt,
            _story: { ...first, _isSubtask: true, _parentId: story.id },
          };
        }
        return { number: story.id, title: story.title, body: story.description, _story: story };
      }
    }
    if (this.opts.repo && this.issues.length) {
      const issue = pickNextIssue(this.issues, this.opts.prefix, this.opts.repo);
      if (issue) {
        claimIssue(issue.number, this.opts.repo, this.opts.prefix, `agent-${this.agentCounter + 1}`);
        return issue;
      }
    }
    return null;
  }

  // ── Retry Warning ─────────────────────────────────────────────────────────

  _buildRetryWarning(agent) {
    const parts = ["", "═".repeat(60), "HOMER ERROR CONTEXT", "═".repeat(60), "",
      `Attempt ${agent.verifyAttempts} of ${MAX_VERIFY}. ${MAX_VERIFY - agent.verifyAttempts} remaining.`, "",
      "PREVIOUS FAILURES:", ""];
    for (const h of agent.verifyHistory) {
      parts.push(`── Attempt ${h.attempt} ──`, `Errors: ${h.errors.slice(0, 300)}`, "");
    }
    // Inject memory rule hints
    try {
      const clean = stripAnsi(agent.outputBuffer || "");
      const fps = extractFilePaths(clean);
      const errKeys = [];
      for (const h of agent.verifyHistory) {
        const matches = (h.errors || "").match(/TS\d{4,5}|Error:\s*.{10,50}/g) || [];
        for (const ek of matches) if (!errKeys.includes(ek)) errKeys.push(ek);
      }
      const hints = buildRuleHints(fps, errKeys);
      if (hints) { parts.push(hints, ""); }
    } catch {}
    parts.push("RULES:", "- Do NOT repeat failed approaches.",
      "- If the same fix fails twice, the root cause is different.",
      "- Read error messages carefully.", "═".repeat(60), "");
    return parts.join("\n");
  }

  // ── Session ───────────────────────────────────────────────────────────────

  _resumeSession(session) {
    this.agentCounter = session.agentCounter || 0;
    const toolForResume = this.activeTool || getTool(session.activeTool);
    if (toolForResume) this.activeTool = toolForResume;

    for (const prev of (session.agents || [])) {
      if (prev.status === "done") continue;
      const agentTool = prev.tool ? getTool(prev.tool) : this.activeTool;
      if (!agentTool) continue;

      const saved = this.activeTool;
      this.activeTool = agentTool;
      this.agentCounter++;
      const id = prev.id || `agent-${this.agentCounter}`;
      const issue = prev.issueNumber ? { number: prev.issueNumber, title: prev.issueTitle || "" } : null;
      const agent = this._makeAgent(id, issue, prev);
      if (agent) this.agents.push(agent);
      this.activeTool = saved;
    }

    if (this.opts.repo) {
      try { appendSharedContext(this.opts.repo, `Session resumed with ${this.agents.length} agent(s)`); } catch {}
    }
    clearSession(this.opts.repo);
    this._emitState();
  }

  _startFresh(available) {
    if (this.activeTool) {
      if (this.opts.auto) {
        setTimeout(() => this._autoSpawnNext(), 100);
      } else {
        this.spawnAgent(null);
      }
    } else if (available.length === 0) {
      this.emit("error", { message: "No AI tools found. Install: claude, codex, or aider" });
    }
    // If multiple tools available but none selected, frontend shows picker
    this._emitState();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _setStatus(agent, status) {
    const prev = agent.status === status ? null : agent.status;
    this.emit("agent:status", { id: agent.id, status, prev });
    this._emitState();
  }

  _emitState() {
    // Debounce state emissions to 50ms
    if (this._stateTimer) return;
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      this.emit("state", this.getState());
    }, 50);
  }

  _trimBuffer(agent) {
    if (agent.outputBuffer.length / 1024 > BUFFER_TRIM_KB) {
      // Extract learnings before discarding output
      try { this._extractAndStoreContext(agent); } catch {}

      const keep = BUFFER_KEEP_KB * 1024;
      const tail = agent.outputBuffer.slice(-keep);
      const hist = agent.verifyHistory.map(h => h.outputSnippet).join("\n");
      agent.outputBuffer = hist + "\n" + tail;
    }
  }

  _extractAndStoreContext(agent) {
    const clean = stripAnsi(agent.outputBuffer);
    const filePaths = extractFilePaths(clean);

    // Extract mid-work error patterns
    const errors = [];
    const errorPatterns = [
      /Error:\s*(.{10,100})/g,
      /error\[E\d+\]:\s*(.{10,100})/g,
      /TS\d{4,5}:\s*(.{10,80})/g,
      /FAIL\s+(.{10,80})/g,
    ];
    for (const pat of errorPatterns) {
      let m;
      while ((m = pat.exec(clean)) !== null) {
        const errText = m[1].trim();
        if (!errors.includes(errText) && errors.length < 5) {
          errors.push(errText);
        }
      }
    }

    // Extract approach note from the last ~2KB of output being discarded
    const discardZone = clean.slice(0, clean.length - BUFFER_KEEP_KB * 1024);
    let approachNote = null;
    if (discardZone.length > 100) {
      // Look for agent reasoning / approach indicators
      const lines = discardZone.split("\n").filter(l => l.trim().length > 20);
      const approachLines = lines.filter(l =>
        /(?:approach|strategy|plan|trying|attempt|will |going to|let me)/i.test(l)
      );
      if (approachLines.length > 0) {
        approachNote = approachLines.slice(-3).map(l => l.trim().slice(0, 80)).join("; ");
      }
    }

    recordContextCompaction(agent.id, taskKey(agent), {
      filePaths,
      errors,
      approachNote,
    });
  }

  _waitForReady(agent, cb) {
    let fired = false;
    const timer = setTimeout(() => { if (!fired) { fired = true; cb(); } }, 8000);
    setTimeout(() => {
      const check = setInterval(() => {
        if (fired) { clearInterval(check); return; }
        const last = (agent.outputBuffer.split("\n").pop() || "");
        if (last.match(/[>$?❯›]\s*$/) || last.includes("claude") || last.includes("aider")) {
          fired = true; clearTimeout(timer); clearInterval(check); cb();
        }
      }, 200);
    }, 1500);
  }

  _persistAgent(agent) {
    if (this.opts.repo) {
      try { saveAgentNotes(this.opts.repo, agent); } catch {}
      try { recordWorkflow(this.opts.repo, agent); } catch {}
    }
    try { writeProjectContext(process.cwd(), this.opts.repo); } catch {}
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────

export { ROLES, taskKey, stripAnsi };
