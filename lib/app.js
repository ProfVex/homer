/**
 * Homer App — TUI wrapping AI CLI tools.
 *
 * Default: detects available AI tools, spawns one interactively in a dashboard.
 * With --auto: also auto-claims homer-labeled GitHub issues.
 * With --tool: skip detection, use specified tool directly.
 */

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pty = require("node-pty");
const blessed = require("blessed");

import { createUI } from "./ui.js";
import { renderDAG } from "./dag.js";
import { detectTools, enrichToolVersions, getAvailableTools, getTool } from "./tools.js";
import {
  detectRepo,
  fetchIssues,
  fetchAllIssues,
  categorize,
  syncBlocked,
  claimIssue,
  pickNextIssue,
} from "./github.js";
import {
  getProjectIndex,
  buildProjectIndex,
  buildSystemPrompt,
  buildTaskPrompt,
  buildAgentPrompt,
  buildResumePrompt,
  writeProjectContext,
  saveAgentNotes,
  saveSession,
  loadSession,
  clearSession,
  indexStats,
  appendSharedContext,
  recordWorkflow,
  loadWorkflowHistory,
} from "./context.js";
import {
  loadPRD,
  savePRD,
  nextStory,
  prdProgress,
  markStoryPassed,
  markStoryFailed,
  detectVerifyCommands,
  runVerification,
  buildVerificationFeedback,
  buildStoryPrompt,
  appendProgress,
  issuesToPRD,
} from "./tasks.js";

// ── CLI arg parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    repo: "",
    tool: "",              // empty = auto-detect, show picker
    prefix: "homer",
    auto: false,
    maxAgents: 5,
    permissionMode: "bypassPermissions",
    model: "",             // for tools that support model selection
    resume: false,         // --resume: auto-resume previous session
    fresh: false,          // --fresh: skip session resume prompt
    init: false,           // --init: project setup wizard
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--repo" || a === "-r") && argv[i + 1]) opts.repo = argv[++i];
    else if (a.startsWith("--repo=")) opts.repo = a.split("=").slice(1).join("=");
    else if (a === "--tool" && argv[i + 1]) opts.tool = argv[++i];
    else if (a === "--model" && argv[i + 1]) opts.model = argv[++i];
    else if (a === "--auto") opts.auto = true;
    else if (a === "--agents" && argv[i + 1]) opts.maxAgents = parseInt(argv[++i], 10) || 1;
    else if (a === "--label" && argv[i + 1]) opts.prefix = argv[++i];
    else if (a === "--permission-mode" && argv[i + 1]) opts.permissionMode = argv[++i];
    else if (a === "--resume") opts.resume = true;
    else if (a === "--fresh") opts.fresh = true;
    else if (a === "--init") opts.init = true;
    else if (a === "-h" || a === "--help") {
      console.log(`Homer \u25C6 AI Agent Orchestrator

USAGE:
  homer                         Open with tool picker
  homer --tool claude           Open Claude Code directly
  homer --auto                  Auto-work through issues/stories
  homer --init                  Setup project for first use

OPTIONS:
  --tool NAME               AI CLI to use (claude, codex, aider, openrouter)
  --model MODEL             Model for tools that support it (aider, openrouter)
  --repo, -r OWNER/REPO     Target repo (default: auto-detect from git)
  --auto                    Auto-claim issues & stories (verification loop)
  --agents N                Max concurrent agents (default: 5)
  --label PREFIX            Label prefix for issues (default: homer)
  --permission-mode MODE    Claude permission mode (default: bypassPermissions)
  --resume                  Auto-resume previous session (skip prompt)
  --fresh                   Start clean (ignore any previous session)
  --init                    Project setup wizard (scans, creates .homer/)
  -h, --help                This help

TASK SOURCES:
  1. prd.json                 User stories (Ralph-compatible)
  2. GitHub Issues             From --repo or auto-detected
  3. Interactive               Manual agent interaction

VERIFICATION LOOP:
  When an agent signals HOMER_DONE, Homer runs typecheck/tests.
  If checks fail, errors are re-injected into the agent to fix.
  Only passes when all checks green. (Like Ralph, but multi-agent.)

KEYS:
  i            Pick task (stories + issues)
  1-9          Switch agent
  Enter        Focus terminal (type into AI)
  Ctrl+A       Toggle nav mode / terminal focus
  Tab          Cycle between agent panes
  t            Change AI tool
  +            Spawn another agent
  c            Rebuild project index
  w            Workflow history (completed tasks)
  r            Refresh sidebar
  q, Ctrl+C    Quit`);
      process.exit(0);
    }
  }

  return opts;
}

// ── Resolve full path for a tool command ──────────────────────────────────────

function resolveCommand(cmd) {
  try {
    return execSync(`command -v ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cmd; // fallback to bare name
  }
}

// ── Spawn an AI CLI in PTY ───────────────────────────────────────────────────

function spawnTool(toolConfig, opts, cols, rows) {
  const env = { ...process.env };
  delete env.CLAUDECODE; // avoid Claude Code nesting guard

  const toolArgs = toolConfig.args ? toolConfig.args(opts) : [];

  // For tools that support initial prompt as positional arg (Claude Code)
  if (toolConfig.buildInitialPrompt && opts._initialPrompt) {
    toolArgs.push(...toolConfig.buildInitialPrompt(opts._initialPrompt));
  }

  const fullPath = resolveCommand(toolConfig.command);

  return pty.spawn(fullPath, toolArgs, {
    name: "xterm-256color",
    cols: Math.max(cols, 40),
    rows: Math.max(rows, 10),
    cwd: process.cwd(),
    env,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function start(argv) {
  const opts = parseArgs(argv);

  // ── Fast sync init (< 20ms) ─────────────────────────────────────────────
  // Only do instant work before UI: parse args, detect tool availability (no --version),
  // load local files (prd.json, package.json). Everything else defers to after paint.

  // Detect available tools — FAST: only `command -v`, no --version calls
  const allTools = detectTools();
  const available = allTools.filter((t) => t.available);

  // If --tool specified, validate it (instant — just checks allTools array)
  let activeTool = null;
  if (opts.tool) {
    activeTool = allTools.find((t) => t.id === opts.tool || t.command === opts.tool);
    if (!activeTool) {
      // Try as bare command
      try {
        execSync(`command -v ${opts.tool}`, { stdio: "ignore" });
        activeTool = {
          id: opts.tool,
          name: opts.tool,
          command: opts.tool,
          interactive: true,
          permissionModes: false,
          args: () => [],
          color: 75,
          icon: "\u25CF",
        };
      } catch {
        console.error(`Tool not found: ${opts.tool}`);
        console.error(`Available: ${available.map((t) => t.id).join(", ") || "none"}`);
        process.exit(1);
      }
    }
  } else if (available.length === 1) {
    activeTool = available[0];
  }

  // Load local files — instant (file reads, no shell)
  const prdData = loadPRD(process.cwd());
  const verifyCmds = detectVerifyCommands(process.cwd());

  const state = {
    issues: [],
    allIssues: [],
    buckets: { inProgress: [], ready: [], blocked: [], done: [], failed: [] },
    agents: [],
    selectedAgent: 0,
    agentCounter: 0,
    termFocused: false,
    activeTool,
    prd: prdData ? prdData.prd : null,
    prdPath: prdData ? prdData.path : null,
    verifyCmds,
  };

  // ── UI (instant — just creates blessed widgets) ─────────────────────────

  const ui = createUI();
  const { screen, sidebar, main, statusBar, toolSelector, issuePicker, P, c, truncate, SIDEBAR_W, panes } = ui;

  // Content width for sidebar text (accounts for padding + scrollbar)
  const CONTENT_W = SIDEBAR_W - 4;

  // ── Agent management ───────────────────────────────────────────────────────

  function makeAgent(id, issue, resumeCtx) {
    if (!state.activeTool) return null;

    const tool = state.activeTool;

    // Build the task prompt — story mode, issue mode, or resume
    let taskPrompt;
    if (resumeCtx) {
      taskPrompt = buildResumePrompt(process.cwd(), opts.repo, resumeCtx);
    } else if (issue && issue._story) {
      taskPrompt = buildStoryPrompt(issue._story, state.prd);
    } else {
      taskPrompt = buildTaskPrompt(issue);
    }

    // Build spawn options — inject system prompt + initial prompt for supporting tools
    const spawnOpts = { ...opts };
    if (tool.supportsSystemPrompt) {
      spawnOpts.systemPrompt = buildSystemPrompt(process.cwd(), opts.repo);
    }
    if (tool.supportsInitialPrompt && taskPrompt) {
      spawnOpts._initialPrompt = taskPrompt;
    }

    const agent = {
      id,
      pty: null,
      pane: null,              // blessed.terminal pane reference
      issue: issue || null,
      story: (issue && issue._story) || null,
      status: "working",
      outputBuffer: "",
      startedAt: Date.now(),
      tool,
      verifyAttempts: 0,
    };

    // Create a terminal pane for this agent — PTY input is wired via handler
    const pane = panes.create(id, (data) => {
      if (agent.pty) agent.pty.write(data);
    });
    agent.pane = pane;

    // Get pane dimensions for PTY — subtract borders (2) explicitly
    // blessed.terminal.iwidth can be unreliable, so we calculate from the
    // actual main panel size minus borders
    screen.render(); // force layout calculation before reading dimensions
    const borderW = 2; // left + right border
    const borderH = 2; // top + bottom border
    const cols = Math.max((pane.terminal.width || 80) - borderW, 40);
    const rows = Math.max((pane.terminal.height || 24) - borderH, 10);

    let proc;
    try {
      proc = spawnTool(tool, spawnOpts, cols, rows);
    } catch (e) {
      panes.remove(id);
      statusBar.setContent(` {${P.failed}-fg}\u2718 Failed to spawn ${tool.name}: ${e.message}{/}`);
      screen.render();
      return null;
    }
    agent.pty = proc;

    // Update pane label with task info
    const label = agent.story ? `${id} \u00B7 ${agent.story.id}`
      : agent.issue ? `${id} \u00B7 #${agent.issue.number}`
      : `${id} \u00B7 interactive`;
    panes.updateLabel(id, label);

    // Wire PTY output directly to the pane's terminal (no buffer swapping!)
    proc.onData((data) => {
      agent.outputBuffer += data;
      pane.terminal.write(data);

      // ── Signal Detection (HOMER_DONE / HOMER_BLOCKED) ──────────────────
      if (agent.status !== "working") return;
      const tail = stripAnsi(agent.outputBuffer).slice(-500);

      if (tail.includes("HOMER_DONE")) {
        handleAgentDone(agent);
      } else if (tail.includes("HOMER_BLOCKED")) {
        const match = tail.match(/HOMER_BLOCKED[: ]*(.*)/);
        handleAgentBlocked(agent, match ? match[1].trim() : "unknown reason");
      }
    });

    proc.onExit(() => {
      if (agent.status === "working") {
        agent.status = "exited";
      }
      // Update pane label to show exited status
      panes.updateLabel(id, `${id} \u00B7 ${agent.status}`);

      if (opts.repo) {
        try { saveAgentNotes(opts.repo, agent); } catch {}
        try { recordWorkflow(opts.repo, agent); } catch {}
      }
      try { writeProjectContext(process.cwd(), opts.repo); } catch {}
      renderAll();
    });

    // For tools that DON'T support --append-system-prompt or positional prompt:
    if (!tool.supportsSystemPrompt || !tool.supportsInitialPrompt) {
      const prompt = issue && issue._story
        ? buildStoryPrompt(issue._story, state.prd) + "\n\n" + buildSystemPrompt(process.cwd(), opts.repo)
        : buildAgentPrompt(process.cwd(), opts.repo, issue);
      if (prompt) {
        waitForReady(agent, () => {
          proc.write(prompt + "\n");
        });
      }
    }

    // Handle terminal resize for this pane — use explicit border sizes
    pane.terminal.on("resize", () => {
      const w = Math.max((pane.terminal.width || 80) - 2, 40);
      const h = Math.max((pane.terminal.height || 24) - 2, 10);
      try { proc.resize(w, h); } catch {}
    });

    return agent;
  }

  // ── Verification Loop (Ralph-style tight feedback) ─────────────────────────

  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  }

  /**
   * Agent signaled HOMER_DONE → run verification before accepting.
   */
  function handleAgentDone(agent) {
    agent.status = "verifying";
    agent.verifyAttempts++;
    renderAll();

    statusBar.setContent(` ${c(P.working, "\u25CF")} Running verification for ${agent.id}...`);
    screen.render();

    // Run verification in next tick to not block UI
    setTimeout(() => {
      const result = runVerification(process.cwd(), state.verifyCmds);

      if (result.skipped) {
        // No verify commands detected — trust the agent
        finalizeAgentDone(agent);
        return;
      }

      if (result.passed) {
        // ✅ All checks pass — mark story as done
        finalizeAgentDone(agent);
      } else {
        // ❌ Verification failed — re-inject errors (the tight loop!)
        agent.status = "working"; // back to working
        const feedback = buildVerificationFeedback(result.results, agent.story);

        statusBar.setContent(
          ` {${P.failed}-fg}\u2718{/} Verification failed (attempt ${agent.verifyAttempts}) — re-injecting errors to ${agent.id}`,
        );
        screen.render();

        // Write failure feedback directly to agent's stdin
        agent.pty.write("\n" + feedback + "\n");
        renderAll();
      }
    }, 100);
  }

  /**
   * Agent passed verification (or no verification configured).
   * Mark story as passed, record workflow, maybe spawn next story.
   */
  function finalizeAgentDone(agent) {
    agent.status = "done";

    // Update PRD if this was a story
    if (agent.story && state.prd && state.prdPath) {
      markStoryPassed(state.prdPath, state.prd, agent.story.id, `Completed by ${agent.id}`);
      try { appendProgress(process.cwd(), agent.story.id, agent.story.title, "PASSED", `Verified after ${agent.verifyAttempts} attempt(s)`); } catch {}
    }

    if (opts.repo) {
      try { saveAgentNotes(opts.repo, agent); } catch {}
      try { recordWorkflow(opts.repo, agent); } catch {}
    }
    try { writeProjectContext(process.cwd(), opts.repo); } catch {}

    const progress = state.prd ? prdProgress(state.prd) : null;
    if (progress && progress.allDone) {
      statusBar.setContent(` {${P.ready}-fg}\u2714 ALL STORIES COMPLETE!{/} ${c(P.dim, `${progress.total} stories passed`)}`);
    } else if (progress) {
      statusBar.setContent(
        ` {${P.ready}-fg}\u2714{/} ${agent.id} completed ${agent.story ? agent.story.id : "task"} ` +
        `${c(P.dim, `(${progress.passed}/${progress.total} stories done)`)}`,
      );
    } else {
      statusBar.setContent(` {${P.ready}-fg}\u2714{/} ${agent.id} completed`);
    }

    screen.render();
    updatePaneLabels();
    renderAll();
  }

  /**
   * Agent signaled HOMER_BLOCKED.
   */
  function handleAgentBlocked(agent, reason) {
    agent.status = "blocked";
    agent.blockReason = reason;

    if (agent.story && state.prd && state.prdPath) {
      markStoryFailed(state.prdPath, state.prd, agent.story.id, `Blocked: ${reason}`);
      try { appendProgress(process.cwd(), agent.story.id, agent.story.title, "BLOCKED", reason); } catch {}
    }

    statusBar.setContent(` {${P.failed}-fg}\u2718{/} ${agent.id} blocked: ${reason.slice(0, 60)}`);
    screen.render();
    renderAll();
  }

  /**
   * Wait for the AI CLI to be ready before sending input.
   * Watches output for common readiness signals instead of blind timeout.
   */
  function waitForReady(agent, callback) {
    let fired = false;
    const maxWait = 8000; // 8s max
    const minWait = 1500; // 1.5s min (let CLI print welcome)

    const timer = setTimeout(() => {
      if (!fired) { fired = true; callback(); }
    }, maxWait);

    // After minWait, check every 200ms if output has settled
    setTimeout(() => {
      const check = setInterval(() => {
        if (fired) { clearInterval(check); return; }
        const lines = agent.outputBuffer.split("\n");
        const lastLine = lines[lines.length - 1] || "";
        // Look for prompt indicators: >, $, ?, or the output has stopped growing
        if (lastLine.match(/[>$?❯›]\s*$/) || lastLine.includes("claude") || lastLine.includes("aider")) {
          fired = true;
          clearTimeout(timer);
          clearInterval(check);
          callback();
        }
      }, 200);
    }, minWait);
  }

  function spawnNewAgent(issue) {
    state.agentCounter++;
    const id = `agent-${state.agentCounter}`;

    // In auto mode, try to claim a story from PRD first, then a GitHub issue
    if (!issue && opts.auto) {
      // PRD stories take priority over GitHub issues
      if (state.prd) {
        const story = nextStory(state.prd);
        if (story) {
          issue = { number: story.id, title: story.title, body: story.description, _story: story };
        }
      }
      // Fall back to GitHub issues
      if (!issue && opts.repo) {
        issue = pickNextIssue(state.issues, opts.prefix, opts.repo);
        if (issue) claimIssue(issue.number, opts.repo, opts.prefix, id);
      }
    }

    const agent = makeAgent(id, issue);
    if (!agent) return;

    state.agents.push(agent);
    state.selectedAgent = state.agents.length - 1;

    // Focus this agent's pane
    panes.focus(agent.id);
    state.termFocused = true;
    renderAll();
  }

  // ── Tool picker ────────────────────────────────────────────────────────────

  function showToolPicker() {
    const tools = detectTools();
    const items = [];
    const toolMap = [];

    for (const t of tools) {
      if (t.available) {
        const ver = t.version ? ` (${t.version})` : "";
        items.push(` ${t.icon} ${t.name}${ver}`);
        toolMap.push(t);
      }
    }

    if (items.length === 0) {
      statusBar.setContent(` {${P.failed}-fg}\u2718 No AI tools found. Install claude, codex, or aider.{/}`);
      screen.render();
      return;
    }

    // Also add "Custom command..." option
    items.push(` \u2726 Custom command...`);

    toolSelector.setItems(items);
    toolSelector.select(0);
    toolSelector.show();
    toolSelector.focus();
    screen.render();

    // Handle selection
    toolSelector.once("select", (item, idx) => {
      toolSelector.hide();
      screen.render();

      if (idx < toolMap.length) {
        state.activeTool = toolMap[idx];
        renderToolBadge();

        // Spawn first agent if none exist
        if (state.agents.length === 0) {
          spawnNewAgent(null);
        }
      }
      // Custom command: for now just spawn claude
      // TODO: show text input for custom command
    });

    toolSelector.once("cancel", () => {
      toolSelector.hide();
      screen.render();
      // If no tool selected and no agents, show message
      if (!state.activeTool && state.agents.length === 0) {
        renderAll();
      }
    });
  }

  // ── Issue picker ──────────────────────────────────────────────────────────

  function showIssuePicker() {
    // Show both PRD stories AND GitHub issues in a unified picker
    const items = [];
    const pickMap = []; // { type: "story" | "issue", data }

    // PRD stories first (if loaded)
    if (state.prd && state.prd.userStories.length > 0) {
      items.push(` ${c(P.magenta, "\u2500\u2500 PRD Stories \u2500\u2500")}`);
      pickMap.push(null); // separator — not selectable

      for (const story of state.prd.userStories) {
        const icon = story.passes ? `{${P.ready}-fg}\u2713{/}` : `{${P.dim}-fg}\u25CB{/}`;
        const label = story.passes ? c(P.done, `${story.id} ${story.title}`) : `${c(P.accent, story.id)} ${story.title}`;
        items.push(` ${icon} ${label}`);
        pickMap.push({ type: "story", data: story });
      }
    }

    // GitHub issues
    if (opts.repo) {
      statusBar.setContent(` ${c(P.dim, "Fetching issues...")}`);
      screen.render();

      try {
        state.allIssues = fetchAllIssues(opts.repo);
      } catch {
        if (items.length === 0) {
          statusBar.setContent(` {${P.failed}-fg}\u2718 Failed to fetch issues{/}`);
          screen.render();
          return;
        }
      }

      if (state.allIssues.length > 0) {
        if (items.length > 0) {
          items.push(` ${c(P.magenta, "\u2500\u2500 GitHub Issues \u2500\u2500")}`);
          pickMap.push(null); // separator
        }

        for (const issue of state.allIssues) {
          const labels = (issue.labels || []).map((l) => l.name).join(", ");
          const labelStr = labels ? ` ${c(P.dim, `[${labels}]`)}` : "";
          items.push(` {${P.accent}-fg}#${issue.number}{/} ${issue.title}${labelStr}`);
          pickMap.push({ type: "issue", data: issue });
        }
      }
    }

    if (items.length === 0) {
      statusBar.setContent(
        opts.repo
          ? ` ${c(P.dim, "No tasks found. Add a prd.json or create GitHub issues.")}`
          : ` ${c(P.dim, "No tasks found. Add a prd.json to this project or use --repo.")}`,
      );
      screen.render();
      return;
    }

    issuePicker.setItems(items);
    issuePicker.select(pickMap[0] === null ? 1 : 0); // skip separator
    issuePicker.show();
    issuePicker.focus();
    screen.render();

    issuePicker.once("select", (item, idx) => {
      issuePicker.hide();
      screen.render();

      const pick = pickMap[idx];
      if (!pick) return; // separator row

      if (pick.type === "story") {
        if (pick.data.passes) {
          statusBar.setContent(` ${c(P.dim, `${pick.data.id} already passed — pick another`)}`);
          screen.render();
          return;
        }
        // Wrap story as an issue-like object for makeAgent
        const storyIssue = {
          number: pick.data.id,
          title: pick.data.title,
          body: pick.data.description,
          _story: pick.data,
        };
        sendIssueToAgent(storyIssue);
      } else {
        sendIssueToAgent(pick.data);
      }
    });

    issuePicker.once("cancel", () => {
      issuePicker.hide();
      screen.render();
    });
  }

  function sendIssueToAgent(issue) {
    const agent = state.agents[state.selectedAgent];
    if (!agent || agent.status !== "working") {
      // No active agent — spawn one with this issue
      if (state.activeTool) {
        spawnNewAgent(issue);
      } else {
        statusBar.setContent(` {${P.failed}-fg}\u2718 Select a tool first (press t){/}`);
        screen.render();
      }
      return;
    }

    // Agent is running — inject the issue WITH project context
    agent.issue = issue;
    if (issue._story) agent.story = issue._story;

    const taskPrompt = issue._story
      ? buildStoryPrompt(issue._story, state.prd)
      : buildTaskPrompt(issue);
    agent.pty.write(taskPrompt + "\n");
    renderAll();

    statusBar.setContent(` ${c(P.ready, "\u2714")} Sent issue #${issue.number} to ${agent.id}`);
    screen.render();
  }

  // ── Screen resize → re-layout panes for responsive behavior ────────────────
  screen.on("resize", () => {
    panes.layout();
    renderAll();
  });

  // ── Pane focus tracking ────────────────────────────────────────────────────
  // Each pane's terminal emits "focus" when clicked or tab-switched.
  // We hook into this via screen's "element focus" event.
  screen.on("element focus", (el) => {
    const focusedId = panes.getFocusedAgentId();
    if (focusedId) {
      const idx = state.agents.findIndex((a) => a.id === focusedId);
      if (idx >= 0) {
        state.selectedAgent = idx;
        state.termFocused = true;
        renderAll();
      }
    }
  });

  // ── Render functions ───────────────────────────────────────────────────────

  function renderBrandHeader() {
    const workingCount = state.agents.filter((a) => a.status === "working").length;
    const verifyCount = state.agents.filter((a) => a.status === "verifying").length;
    const totalAgents = state.agents.length;

    let statusText, statusColor;
    if (totalAgents === 0) {
      statusText = "idle";
      statusColor = P.dim;
    } else if (verifyCount > 0) {
      statusText = `verifying (${verifyCount})`;
      statusColor = P.cyan;
    } else if (workingCount > 0) {
      statusText = `active (${workingCount})`;
      statusColor = P.working;
    } else {
      statusText = "done";
      statusColor = P.ready;
    }

    const modeBadge = state.termFocused
      ? `{${P.working}-fg}\u25CF{/}`
      : `{${P.dim}-fg}\u25CB{/}`;

    sidebar.brandHeader.setContent(
      `${c(P.magenta, "\u25C6")} ${c(P.title, "HOMER")} {${statusColor}-fg}${statusText}{/} ${modeBadge}`,
    );
  }

  function renderToolBadge() {
    if (state.activeTool) {
      const t = state.activeTool;
      sidebar.toolBadge.setContent(
        ` ${c(t.color, t.icon)} ${c(P.fg, t.name)}\n ${c(P.dim, t.version || "")}`,
      );
    } else {
      sidebar.toolBadge.setContent(
        ` ${c(P.dim, "\u25CB")} ${c(P.dim, "No tool selected")}`,
      );
    }
  }

  function renderSidebar() {
    renderToolBadge();

    // Repo / cwd header + index stats
    const stats = indexStats(opts.repo);
    if (opts.repo) {
      const repoParts = opts.repo.split("/");
      const repoName = repoParts[1] || "";
      const owner = repoParts[0].length > CONTENT_W - 2
        ? repoParts[0].slice(0, CONTENT_W - 5) + "..."
        : repoParts[0];
      const statsLine = stats
        ? ` ${c(P.dimmer, `${stats.exportCount} exports \u00B7 ${stats.fileCount} files`)}`
        : "";
      sidebar.repoHeader.setContent(
        `${c(P.dim, " REPO")}\n ${c(P.accent, owner)}${c(P.dimmer, "/")}${c(P.title, repoName)}\n${statsLine}`,
      );
    } else {
      let cwdName = process.cwd().split("/").pop();
      if (cwdName.length > CONTENT_W - 2) cwdName = cwdName.slice(0, CONTENT_W - 5) + "...";
      const statsLine = stats
        ? ` ${c(P.dimmer, `${stats.exportCount} exports`)}`
        : "";
      sidebar.repoHeader.setContent(
        `${c(P.dim, " DIR")}\n ${c(P.accent, cwdName)}\n${statsLine}`,
      );
    }

    // ── Task/Story Progress (PRD + GitHub Issues) ───────────────────────────
    const lines = [];

    // PRD progress bar
    if (state.prd) {
      const progress = prdProgress(state.prd);
      const barW = SIDEBAR_W - 6;
      const filled = Math.round((progress.passed / progress.total) * barW);
      const bar = `{${P.ready}-fg}${"█".repeat(filled)}{/}${c(P.dimmer, "░".repeat(barW - filled))}`;
      lines.push(`${c(P.dim, " STORIES")} {${P.ready}-fg}${progress.passed}{/}${c(P.dimmer, "/")}${c(P.fg, String(progress.total))}`);
      lines.push(` ${bar}`);

      // List stories with status
      const assignedStoryIds = new Set(
        state.agents.filter((a) => a.story).map((a) => a.story.id),
      );
      for (const story of state.prd.userStories.slice(0, 10)) {
        let icon, titleColor;
        if (story.passes) {
          icon = `{${P.ready}-fg}\u2713{/}`;
          titleColor = P.done;
        } else if (assignedStoryIds.has(story.id)) {
          const ag = state.agents.find((a) => a.story && a.story.id === story.id);
          if (ag && ag.status === "verifying") {
            icon = `{${P.cyan}-fg}\u25CF{/}`;
            titleColor = P.cyan;
          } else {
            icon = `{${P.working}-fg}\u25CF{/}`;
            titleColor = P.fg;
          }
        } else {
          icon = c(P.dimmer, "\u25CB");
          titleColor = P.dim;
        }
        // Truncate: icon(2) + space(1) + storyId(~6) + space(1) = ~10 chars prefix
        const maxTitle = CONTENT_W - story.id.length - 4;
        const title = story.title.length > maxTitle
          ? story.title.slice(0, maxTitle - 3) + "..."
          : story.title;
        lines.push(` ${icon} ${c(P.accent, story.id)} ${c(titleColor, title)}`);
      }
      if (state.prd.userStories.length > 10) {
        lines.push(` ${c(P.dimmer, `  +${state.prd.userStories.length - 10} more`)}`);
      }
      lines.push("");
    }

    // GitHub issues
    const issuesToShow = state.allIssues.length > 0 ? state.allIssues : state.issues;
    if (issuesToShow.length > 0) {
      const maxIssues = state.prd ? 5 : 15; // fewer if PRD is showing
      lines.push(`${c(P.dim, " ISSUES")} ${c(P.dimmer, `(${issuesToShow.length})`)}`);
      const assignedNums = new Set(state.agents.filter((a) => a.issue).map((a) => a.issue.number));
      for (const issue of issuesToShow.slice(0, maxIssues)) {
        const num = `#${issue.number}`;
        // Truncate: icon(2) + space(1) + #num(~4) + space(1) = ~8 chars prefix
        const maxTitle = CONTENT_W - num.length - 4;
        const title = issue.title.length > maxTitle
          ? issue.title.slice(0, maxTitle - 3) + "..."
          : issue.title;
        if (assignedNums.has(issue.number)) {
          lines.push(` {${P.working}-fg}\u25CF{/} ${c(P.accent, num)} ${c(P.fg, title)}`);
        } else {
          lines.push(` ${c(P.dimmer, "\u25CB")} ${c(P.dim, num)} ${c(P.fg, title)}`);
        }
      }
      if (issuesToShow.length > maxIssues) {
        lines.push(` ${c(P.dimmer, `  +${issuesToShow.length - maxIssues} more`)}`);
      }
    } else if (!state.prd) {
      lines.push(`${c(P.dim, " TASKS")}`);
      lines.push(opts.repo ? ` ${c(P.dimmer, "press [i] to load")}` : ` ${c(P.dimmer, "no tasks found")}`);
    }

    lines.push(` ${c(P.dimmer, "[i] pick task")}`);
    sidebar.dagBox.setContent(lines.join("\n"));

    // Agent list
    const agentLines = [`${c(P.dim, " AGENTS")}`];
    if (state.agents.length === 0) {
      agentLines.push(` ${c(P.dimmer, "Press [+] to spawn")}`);
    }
    for (let i = 0; i < state.agents.length; i++) {
      const a = state.agents[i];
      const sel = i === state.selectedAgent ? c(P.accent, "\u25B8") : " ";
      let statusColor, dot;
      switch (a.status) {
        case "working":   statusColor = P.working; dot = "\u25CF"; break;
        case "verifying": statusColor = P.cyan;    dot = "\u25D4"; break; // ◔ half-circle
        case "done":      statusColor = P.ready;   dot = "\u2713"; break;
        case "blocked":   statusColor = P.blocked; dot = "\u2718"; break;
        default:          statusColor = P.done;    dot = "\u25CB"; break;
      }
      const label = a.story ? a.story.id : a.issue ? `#${a.issue.number}` : "interactive";
      const toolIcon = a.tool ? c(a.tool.color, a.tool.icon) : "";
      const attempts = a.verifyAttempts > 0 ? c(P.dimmer, ` v${a.verifyAttempts}`) : "";
      const agentLine = `${sel} {${statusColor}-fg}${dot}{/} ${c(P.fg, a.id)} ${c(P.dim, label)} ${toolIcon}${attempts}`;
      agentLines.push(truncate(agentLine, CONTENT_W));
    }

    // Verify commands detected
    if (state.verifyCmds.length > 0) {
      agentLines.push("");
      agentLines.push(`${c(P.dim, " VERIFY")}`);
      for (const v of state.verifyCmds) {
        agentLines.push(` ${c(P.dimmer, "\u25CB")} ${c(P.dim, v.name)}`);
      }
    }

    sidebar.agentList.setContent(agentLines.join("\n"));
  }

  /**
   * Update pane labels for all agents to reflect current status.
   * Each pane has its own bordered label — no shared header needed.
   */
  function updatePaneLabels() {
    for (const agent of state.agents) {
      let statusDot;
      switch (agent.status) {
        case "working":   statusDot = `{${P.working}-fg}\u25CF{/}`; break;
        case "verifying": statusDot = `{${P.cyan}-fg}\u25D4{/}`; break;
        case "done":      statusDot = `{${P.ready}-fg}\u2713{/}`; break;
        case "blocked":   statusDot = `{${P.blocked}-fg}\u2718{/}`; break;
        default:          statusDot = `{${P.done}-fg}\u25CB{/}`; break;
      }

      const taskLabel = agent.story ? agent.story.id
        : agent.issue ? `#${agent.issue.number}`
        : "interactive";

      const toolIcon = agent.tool ? `{${agent.tool.color}-fg}${agent.tool.icon}{/}` : "";
      panes.updateLabel(agent.id, `${toolIcon} ${agent.id} \u00B7 ${taskLabel} ${statusDot} ${agent.status}`);
    }
  }

  function renderStatus() {
    const agent = state.agents[state.selectedAgent];

    if (!agent) {
      const hints = [];
      if (state.activeTool) {
        hints.push(`${c(P.accent, "+")} ${c(P.dim, "spawn agent")}`);
        hints.push(`${c(P.accent, "i")} ${c(P.dim, "pick task")}`);
      } else {
        hints.push(`${c(P.accent, "t")} ${c(P.dim, "select tool")}`);
      }
      main.statusLine.setContent(` ${hints.join("  ")}`);
      return;
    }

    const s = Math.floor((Date.now() - agent.startedAt) / 1000);
    const min = String(Math.floor(s / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    const time = `${min}:${sec}`;

    const parts = [c(P.dim, time)];

    // Verification attempt counter
    if (agent.verifyAttempts > 0) {
      parts.push(`${c(P.dimmer, "\u2502")} ${c(P.cyan, `verify \u00D7${agent.verifyAttempts}`)}`);
    }

    // Focus indicator
    if (state.termFocused) {
      parts.push(`${c(P.dimmer, "\u2502")} {${P.working}-fg}\u25CF TYPING{/} ${c(P.dim, "^A=nav  ^N=agent  ^G=join")}`);
    } else {
      parts.push(`${c(P.dimmer, "\u2502")} ${c(P.dim, "Enter=type  j=join  +=agent")}`);
    }

    // PRD overall progress
    if (state.prd) {
      const progress = prdProgress(state.prd);
      parts.push(`${c(P.dimmer, "\u2502")} {${P.ready}-fg}${progress.passed}{/}${c(P.dimmer, "/")}${c(P.fg, String(progress.total))} ${c(P.dim, "stories")}`);
    }

    main.statusLine.setContent(` ${parts.join("  ")}`);
  }

  function renderBar() {
    const parts = [];

    // Issue counts
    if (state.issues.length > 0) {
      const b = state.buckets;
      parts.push(`{${P.ready}-fg}\u25CB ${b.ready.length}{/}`);
      parts.push(`{${P.working}-fg}\u25CF ${b.inProgress.length}{/}`);
      parts.push(`{${P.done}-fg}\u2713 ${b.done.length}{/}`);
      parts.push(c(P.dimmer, "\u2502"));
    }

    // Key hints
    const hints = [];
    if (opts.repo) hints.push(`${c(P.accent, "i")}${c(P.dim, " task")}`);
    hints.push(`${c(P.accent, "+")}${c(P.dim, " agent")}`);
    if (state.agents.length > 0) {
      hints.push(`${c(P.accent, "j")}${c(P.dim, " join")}`);
    }
    hints.push(`${c(P.accent, "t")}${c(P.dim, " tool")}`);
    if (state.agents.length > 1) {
      hints.push(`${c(P.accent, "1-" + state.agents.length)}${c(P.dim, " switch")}`);
    }
    hints.push(`${c(P.accent, "q")}${c(P.dim, " quit")}`);
    parts.push(hints.join("  "));

    statusBar.setContent(` ${parts.join("  ")}`);
  }

  function renderAll() {
    renderBrandHeader();
    renderSidebar();
    updatePaneLabels();
    renderStatus();
    renderBar();
    screen.render();
  }

  // ── Agent switching ────────────────────────────────────────────────────────

  function selectAgent(idx) {
    if (idx < 0 || idx >= state.agents.length) return;
    state.selectedAgent = idx;
    panes.focusByIndex(idx);
    state.termFocused = true;
    renderAll();
  }

  // ── Keybindings ────────────────────────────────────────────────────────────

  // Number keys: switch agent (only when not focused on terminal)
  for (let n = 1; n <= 9; n++) {
    screen.key([String(n)], () => { if (!state.termFocused) selectAgent(n - 1); });
  }

  // Enter: focus the selected agent's pane
  screen.key(["enter"], () => {
    if (!state.termFocused && state.agents.length > 0) {
      state.termFocused = true;
      panes.focusByIndex(state.selectedAgent);
      renderAll();
    } else if (!state.termFocused && state.agents.length === 0) {
      if (state.activeTool) {
        spawnNewAgent(null);
      } else {
        showToolPicker();
      }
    }
  });

  // Ctrl+A: toggle between nav mode and terminal focus
  // Ctrl combos work reliably even when blessed.terminal captures input
  screen.program.key("C-a", () => {
    if (state.termFocused) {
      state.termFocused = false;
      screen.rewindFocus();
      renderAll();
    } else if (state.agents.length > 0) {
      state.termFocused = true;
      panes.focusByIndex(state.selectedAgent);
      renderAll();
    }
  });

  // Tab: cycle between panes (only in nav mode)
  screen.key(["tab"], () => {
    if (!state.termFocused && panes.list.length > 1) {
      const nextIdx = (state.selectedAgent + 1) % state.agents.length;
      selectAgent(nextIdx);
    }
  });

  // t: show tool picker
  screen.key(["t"], () => {
    if (state.termFocused) return;
    showToolPicker();
  });

  // i: show issue picker
  screen.key(["i"], () => {
    if (state.termFocused) return;
    showIssuePicker();
  });

  // +/=: spawn another agent (nav mode only)
  screen.key(["+", "="], () => {
    if (state.termFocused) return;
    doSpawnAgent();
  });

  // Ctrl+N: spawn agent (works even in terminal focus mode)
  screen.program.key("C-n", () => {
    doSpawnAgent();
  });

  function doSpawnAgent() {
    if (!state.activeTool) {
      showToolPicker();
      return;
    }

    if (state.agents.length >= opts.maxAgents) {
      statusBar.setContent(` {${P.failed}-fg}\u2718 Max agents (${opts.maxAgents}). Use --agents N.{/}`);
      screen.render();
      return;
    }

    spawnNewAgent(null);
  }

  // j: join/switch to an agent (shows agent picker)
  screen.key(["j"], () => {
    if (state.termFocused) return;
    showJoinPicker();
  });

  // Ctrl+G: join/switch agent (works even in terminal focus mode)
  screen.program.key("C-g", () => {
    // Exit terminal focus first
    state.termFocused = false;
    showJoinPicker();
  });

  function showJoinPicker() {
    if (state.agents.length === 0) {
      statusBar.setContent(` ${c(P.dim, "No agents running. Press + or Ctrl+N to spawn one.")}`);
      screen.render();
      return;
    }

    const items = [];
    const agentMap = [];

    for (const a of state.agents) {
      let statusDot;
      switch (a.status) {
        case "working":   statusDot = `{${P.working}-fg}\u25CF{/}`; break;
        case "verifying": statusDot = `{${P.cyan}-fg}\u25D4{/}`; break;
        case "done":      statusDot = `{${P.ready}-fg}\u2713{/}`; break;
        case "blocked":   statusDot = `{${P.blocked}-fg}\u2718{/}`; break;
        default:          statusDot = `{${P.done}-fg}\u25CB{/}`; break;
      }
      const task = a.story ? `${a.story.id} — ${a.story.title}`
        : a.issue ? `#${a.issue.number} — ${a.issue.title}`
        : "interactive session";
      const toolName = a.tool ? c(a.tool.color, a.tool.name) : "";
      items.push(` ${statusDot} ${c(P.fg, a.id)} ${c(P.dim, task)} ${toolName}`);
      agentMap.push(a);
    }

    // Add option to spawn new agent
    items.push(` ${c(P.accent, "+")} ${c(P.fg, "Spawn new agent")}`);

    const joinPicker = blessed.list({
      parent: screen,
      top: "center",
      left: "center",
      width: "60%",
      height: Math.min(items.length + 4, 20),
      border: { type: "line" },
      style: {
        bg: P.cardBg,
        border: { fg: P.accent },
        selected: { bg: P.selectedBg, fg: P.white, bold: true },
        item: { fg: P.fg, bg: P.cardBg },
      },
      label: ` ${c(P.accent, "\u25C6")} ${c(P.title, "Join Agent")} `,
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      items,
      padding: { left: 1 },
    });

    joinPicker.select(state.selectedAgent);
    joinPicker.show();
    joinPicker.focus();
    screen.render();

    joinPicker.once("select", (item, idx) => {
      joinPicker.hide();
      joinPicker.destroy();

      if (idx < agentMap.length) {
        // Join existing agent
        selectAgent(idx);
        state.termFocused = true;
        panes.focusByIndex(idx);
        statusBar.setContent(` ${c(P.ready, "\u2714")} Joined ${agentMap[idx].id} — typing mode`);
      } else {
        // Spawn new
        doSpawnAgent();
      }
      screen.render();
    });

    joinPicker.once("cancel", () => {
      joinPicker.hide();
      joinPicker.destroy();
      screen.render();
    });
  }

  // r: refresh sidebar + issues
  screen.key(["r"], () => {
    if (state.termFocused) return;
    if (opts.repo) {
      try { state.allIssues = fetchAllIssues(opts.repo); } catch {}
      if (opts.auto) {
        try {
          state.issues = fetchIssues(opts.repo, opts.prefix);
          state.buckets = categorize(state.issues, opts.prefix);
        } catch {}
      }
    }
    renderAll();
  });

  // c: rebuild project index + refresh .homer/context.md + reload PRD
  screen.key(["c"], () => {
    if (state.termFocused) return;
    statusBar.setContent(` ${c(P.dim, "Rebuilding project index...")}`);
    screen.render();
    try {
      buildProjectIndex(process.cwd(), opts.repo);
      writeProjectContext(process.cwd(), opts.repo);
      // Reload PRD in case it was updated
      const freshPRD = loadPRD(process.cwd());
      if (freshPRD) {
        state.prd = freshPRD.prd;
        state.prdPath = freshPRD.path;
      }
      // Re-detect verify commands
      state.verifyCmds = detectVerifyCommands(process.cwd());

      const stats = indexStats(opts.repo);
      const prdInfo = state.prd ? `, ${prdProgress(state.prd).total} stories` : "";
      const verifyInfo = state.verifyCmds.length > 0 ? `, ${state.verifyCmds.length} checks` : "";
      if (stats) {
        statusBar.setContent(` ${c(P.ready, "\u2714")} Index: ${stats.exportCount} exports, ${stats.fileCount} files${prdInfo}${verifyInfo}`);
      }
    } catch (e) {
      statusBar.setContent(` {${P.failed}-fg}\u2718 Index build failed: ${e.message}{/}`);
    }
    renderAll();
  });

  // w: show workflow history (product evolution)
  screen.key(["w"], () => {
    if (state.termFocused) return;
    if (!opts.repo) {
      statusBar.setContent(` {${P.failed}-fg}\u2718 No repo — workflow history requires a repo{/}`);
      screen.render();
      return;
    }

    const history = loadWorkflowHistory(opts.repo, 20);
    if (history.length === 0) {
      statusBar.setContent(` ${c(P.dim, "No completed workflows yet")}`);
      screen.render();
      return;
    }

    const items = history.map((h) => {
      const date = h.date.split("T")[0];
      const statusIcon = h.status === "done" ? `{${P.ready}-fg}\u2713{/}` : `{${P.failed}-fg}\u2715{/}`;
      return ` ${statusIcon} ${c(P.dim, date)} ${c(P.accent, h.task)} ${c(P.dimmer, h.duration)}`;
    });

    const historyDialog = blessed.list({
      parent: screen,
      top: "center",
      left: "center",
      width: "80%",
      height: Math.min(items.length + 4, 24),
      border: { type: "line" },
      style: {
        bg: P.cardBg,
        border: { fg: P.magenta },
        selected: { bg: P.selectedBg, fg: P.white, bold: true },
        item: { fg: P.fg, bg: P.cardBg },
      },
      label: ` ${c(P.magenta, "◆")} ${c(P.title, "Workflow History")} ${c(P.dim, `(${history.length} entries)`)} `,
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      items,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: "▐",
        track: { ch: " ", style: { bg: P.cardBg } },
        style: { fg: P.dimmer },
      },
      padding: { left: 1 },
    });

    historyDialog.show();
    historyDialog.focus();
    screen.render();

    historyDialog.key(["escape", "q", "w"], () => {
      historyDialog.hide();
      historyDialog.destroy();
      screen.render();
    });

    historyDialog.once("select", () => {
      historyDialog.hide();
      historyDialog.destroy();
      screen.render();
    });
  });

  // q, Ctrl+C: quit
  screen.key(["q", "C-c"], () => { cleanup(); process.exit(0); });

  // ── Cleanup ────────────────────────────────────────────────────────────────

  function cleanup() {
    // Save session before exiting
    try { saveSession(state, opts); } catch {}
    // Save notes for any working agents + kill PTYs
    for (const a of state.agents) {
      if (opts.repo) { try { saveAgentNotes(opts.repo, a); } catch {} }
      try { a.pty.kill(); } catch {}
    }
    // Destroy all panes
    for (const p of [...panes.list]) {
      try { p.terminal.destroy(); } catch {}
    }
    screen.destroy();
  }

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  // ── Session Resume ──────────────────────────────────────────────────────────

  function resumeSession(session) {
    state.agentCounter = session.agentCounter || 0;

    const toolForResume = state.activeTool || getTool(session.activeTool);
    if (toolForResume) state.activeTool = toolForResume;

    for (const prev of (session.agents || [])) {
      if (prev.status === "done") continue;

      const agentTool = prev.tool ? getTool(prev.tool) : state.activeTool;
      if (!agentTool) continue;

      const savedTool = state.activeTool;
      state.activeTool = agentTool;

      state.agentCounter++;
      const id = prev.id || `agent-${state.agentCounter}`;
      const issue = prev.issueNumber ? { number: prev.issueNumber, title: prev.issueTitle || "" } : null;

      // Use makeAgent with resume context — gets proper system prompt injection
      const agent = makeAgent(id, issue, prev);
      if (agent) {
        state.agents.push(agent);
      }

      state.activeTool = savedTool;
    }

    if (state.agents.length > 0) {
      selectAgent(0);
      state.termFocused = true;
      panes.focusByIndex(0);
    }

    if (opts.repo) {
      try { appendSharedContext(opts.repo, `Session resumed with ${state.agents.length} agent(s)`); } catch {}
    }

    clearSession(opts.repo);
    renderAll();
  }

  function showResumePrompt(session) {
    const activeAgents = (session.agents || []).filter((a) => a.status !== "done");

    if (activeAgents.length === 0) {
      clearSession(opts.repo);
      return false;
    }

    const summaries = activeAgents.map((a) => {
      const label = a.issueNumber ? `#${a.issueNumber} ${a.issueTitle || ""}` : "interactive";
      return `  ${a.id}: ${label} (${a.status})`;
    });

    const resumeDialog = blessed.list({
      parent: screen,
      top: "center",
      left: "center",
      width: 60,
      height: 6 + summaries.length,
      border: { type: "line" },
      style: {
        bg: P.cardBg,
        border: { fg: P.cyan },
        selected: { bg: P.selectedBg, fg: P.white, bold: true },
        item: { fg: P.fg, bg: P.cardBg },
      },
      label: ` ${c(P.cyan, "◆")} ${c(P.title, "Resume Session?")} `,
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      items: [
        ` ${c(P.ready, "Yes")} \u2014 resume ${activeAgents.length} agent(s)`,
        ` ${c(P.failed, "No")} \u2014 start fresh`,
      ],
      padding: { left: 1 },
    });

    resumeDialog.select(0);
    resumeDialog.show();
    resumeDialog.focus();
    screen.render();

    resumeDialog.once("select", (item, idx) => {
      resumeDialog.hide();
      resumeDialog.destroy();
      screen.render();

      if (idx === 0) {
        resumeSession(session);
      } else {
        clearSession(opts.repo);
        startFresh();
      }
    });

    resumeDialog.once("cancel", () => {
      resumeDialog.hide();
      resumeDialog.destroy();
      screen.render();
      clearSession(opts.repo);
      startFresh();
    });

    return true;
  }

  function startFresh() {
    if (state.activeTool) {
      setTimeout(() => spawnNewAgent(null), 100);
    } else if (available.length > 1) {
      setTimeout(() => showToolPicker(), 100);
    } else if (available.length === 0) {
      statusBar.setContent(
        ` {${P.failed}-fg}\u2718 No AI tools found.{/} ${c(P.dim, "Install: claude, codex, or aider")}`,
      );
      screen.render();
    }
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  // FAST PATH: Render UI immediately with what we have, then do heavy work async.

  // 1. Instant first paint (no network, no shell, no I/O)
  renderAll();

  // 2. Kick off deferred init — runs after first paint
  setTimeout(() => {
    // ── Repo detection (~100ms — gh API call) ──────────────────────────────
    if (!opts.repo) {
      try { opts.repo = detectRepo(); } catch { /* no repo */ }
      if (opts.repo) renderAll(); // re-render sidebar with repo info
    }

    // ── Tool version enrichment (~250ms — runs --version in parallel) ─────
    enrichToolVersions(allTools, () => {
      renderAll(); // update sidebar with version strings
    });

    // ── Session resume check (instant — file read) ──────────────────────────
    let sessionResumed = false;
    if (!opts.fresh) {
      const prevSession = loadSession(opts.repo);
      if (prevSession) {
        if (opts.resume) {
          resumeSession(prevSession);
          sessionResumed = true;
        } else {
          sessionResumed = showResumePrompt(prevSession);
        }
      }
    }

    if (!sessionResumed) {
      startFresh();
    }

    // ── Project index + context (may run tree/grep — ~20ms if cached) ──────
    setTimeout(() => {
      try {
        getProjectIndex(process.cwd(), opts.repo);
        writeProjectContext(process.cwd(), opts.repo);
      } catch {}
      renderAll();
    }, 50);

    // ── GitHub issues (network — ~400ms) ────────────────────────────────────
    if (opts.repo) {
      setTimeout(() => {
        try { state.allIssues = fetchAllIssues(opts.repo); } catch {}
        if (opts.auto) {
          try {
            state.issues = fetchIssues(opts.repo, opts.prefix);
            state.buckets = categorize(state.issues, opts.prefix);
          } catch {}
        }
        renderAll();
      }, 10);
    }
  }, 0);

  // Refresh sidebar periodically (issues, if repo is set)
  // Checks opts.repo on each tick — repo may be detected after startup
  setInterval(() => {
    if (!opts.repo) return;
    try { state.allIssues = fetchAllIssues(opts.repo); } catch {}
    if (opts.auto) {
      try {
        state.issues = fetchIssues(opts.repo, opts.prefix);
        state.buckets = categorize(state.issues, opts.prefix);
      } catch {}
    }
    renderSidebar();
    renderBar();
    screen.render();
  }, 30000);

  // Update elapsed time every second
  setInterval(() => { renderStatus(); screen.render(); }, 1000);
}
