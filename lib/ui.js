/**
 * Homer TUI — Polished terminal interface.
 *
 * Design philosophy:
 *   - Use 256-color backgrounds to create visual depth (sidebar vs main)
 *   - Colored section headers, progress bars, status badges
 *   - Mouse-enabled: click panes, scroll output, click sidebar items
 *   - Clean spacing — let content breathe
 *   - Each agent gets its own real terminal widget
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │▓▓▓▓▓▓▓▓▓▓▓▓▓▓│                                         │
 *   │▓ ◆ HOMER     ▓│  ┌──────────────────────────────────┐   │
 *   │▓              ▓│  │ ⬢ agent-1 · #42 ● working       │   │
 *   │▓ ⬢ Claude    ▓│  │                                  │   │
 *   │▓   v2.1.15   ▓│  │                                  │   │
 *   │▓              ▓│  │   [terminal output scrollable]   │   │
 *   │▓ REPO         ▓│  │                                  │   │
 *   │▓ owner/repo   ▓│  │                                  │   │
 *   │▓ 12 exports   ▓│  │                                  │   │
 *   │▓              ▓│  │                                  │   │
 *   │▓ STORIES 2/5  ▓│  │                                  │   │
 *   │▓ ████████░░░  ▓│  └──────────────────────────────────┘   │
 *   │▓ ✓ Auth       ▓│                                         │
 *   │▓ ● Dashboard  ▓│                                         │
 *   │▓              ▓│                                         │
 *   │▓ TEAM         ▓│                                         │
 *   │▓ ▸● agent-1   ▓│                                         │
 *   │▓  ○ agent-2   ▓│                                         │
 *   │▓▓▓▓▓▓▓▓▓▓▓▓▓▓│─────────────────────────────────────────│
 *   │ 01:23 │ ● TYPING ^A=nav │ 2/5 stories                   │
 *   │ [i] task  [t] tool  [+] agent  [q] quit                 │
 *   └──────────────────────────────────────────────────────────┘
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const blessed = require("blessed");

// ── Palette ──────────────────────────────────────────────────────────────────
// 256-color palette with depth — darker sidebar creates visual separation

const P = {
  // Backgrounds (key to the polished look)
  bg: -1,             // terminal default for main area
  sidebarBg: 234,     // #1c1c1c — slightly lighter than pure black
  panelBg: -1,        // terminal default for terminal panes
  cardBg: 236,        // #303030 — raised card sections in sidebar
  selectedBg: 61,     // muted purple — selected/active items (like screenshot)
  headerBg: 235,      // #262626 — section header background

  // Foreground
  fg: 252,            // #d0d0d0 — primary text
  dim: 245,           // #8a8a8a — secondary text
  dimmer: 240,        // #585858 — tertiary
  muted: 236,         // #303030 — very subtle borders

  // Accents
  accent: 75,         // #5fafff — blue accent (links, highlights)
  working: 214,       // #ffaf00 — amber/orange (in progress)
  ready: 114,         // #87d787 — green (success)
  blocked: 167,       // #d75f5f — red (error/blocked)
  done: 243,          // #767676 — grey (completed, subdued)
  failed: 175,        // #d787af — pink (failed)
  magenta: 133,       // #af5faf — branding
  cyan: 81,           // #5fd7ff — info/verifying
  title: 255,         // #eeeeee — bright headings
  white: 231,         // #ffffff — pure white for emphasis
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function c(code, text) {
  return `{${code}-fg}${text}{/}`;
}

// ── Create all UI widgets ────────────────────────────────────────────────────

export function createUI() {
  const SIDEBAR_W = 32;

  const screen = blessed.screen({
    smartCSR: true,
    title: "Homer",
    fullUnicode: true,
    dockBorders: true,
    ignoreDockContrast: true,
    mouse: true,
    forceUnicode: true,
  });

  // ── Sidebar (darker background creates depth) ──────────────────────────────

  const sidebarBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: SIDEBAR_W,
    height: "100%-2",
    style: { bg: P.sidebarBg },
  });

  // Brand header — prominent, centered
  const brandHeader = blessed.box({
    parent: sidebarBox,
    top: 0,
    left: 0,
    width: "100%",
    height: 2,
    tags: true,
    style: { bg: P.headerBg },
    padding: { left: 1 },
    content: `${c(P.magenta, "◆")} ${c(P.title, "HOMER")}`,
  });

  // Tool badge — card-like with bg
  const toolBadge = blessed.box({
    parent: sidebarBox,
    top: 2,
    left: 1,
    width: SIDEBAR_W - 2,
    height: 2,
    tags: true,
    style: { bg: P.sidebarBg },
    padding: { left: 1 },
  });

  // Repo header
  const repoHeader = blessed.box({
    parent: sidebarBox,
    top: 4,
    left: 1,
    width: SIDEBAR_W - 2,
    height: 3,
    tags: true,
    style: { bg: P.sidebarBg },
    padding: { left: 1 },
  });

  // Thin separator
  blessed.box({
    parent: sidebarBox,
    top: 7,
    left: 2,
    width: SIDEBAR_W - 4,
    height: 1,
    tags: true,
    style: { bg: P.sidebarBg },
    content: c(P.muted, "─".repeat(SIDEBAR_W - 4)),
  });

  // Task/Story view — scrollable, with sidebar bg
  const dagBox = blessed.box({
    parent: sidebarBox,
    top: 8,
    left: 0,
    width: "100%",
    height: "50%-6",
    tags: true,
    scrollable: true,
    mouse: true,
    alwaysScroll: true,
    scrollbar: {
      ch: "▐",
      track: { ch: " ", style: { bg: P.sidebarBg } },
      style: { fg: P.dimmer, bg: P.sidebarBg },
    },
    style: { bg: P.sidebarBg },
    padding: { left: 1 },
  });

  // Thin separator
  blessed.box({
    parent: sidebarBox,
    top: "50%+2",
    left: 2,
    width: SIDEBAR_W - 4,
    height: 1,
    tags: true,
    style: { bg: P.sidebarBg },
    content: c(P.muted, "─".repeat(SIDEBAR_W - 4)),
  });

  // Agent/Team list — bottom section
  const agentList = blessed.box({
    parent: sidebarBox,
    top: "50%+3",
    left: 0,
    width: "100%",
    bottom: 0,
    tags: true,
    scrollable: true,
    mouse: true,
    alwaysScroll: true,
    style: { bg: P.sidebarBg },
    padding: { left: 1 },
  });

  // ── Sidebar edge (1px divider) ─────────────────────────────────────────────

  blessed.box({
    parent: screen,
    top: 0,
    left: SIDEBAR_W,
    width: 1,
    height: "100%-2",
    ch: "│",
    style: { bg: P.sidebarBg, fg: P.muted },
  });

  // ── Main panel (terminal container — default bg) ───────────────────────────

  const mainPanel = blessed.box({
    parent: screen,
    top: 0,
    left: SIDEBAR_W + 1,
    width: `100%-${SIDEBAR_W + 1}`,
    height: "100%-3",   // leave room for status bars + separator
    style: { bg: P.bg },
  });

  // ── Bottom bar area ────────────────────────────────────────────────────────

  // Separator line
  blessed.box({
    parent: screen,
    bottom: 2,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { bg: P.headerBg },
    content: "",
  });

  // Status line (time, focus, progress)
  const statusLine = blessed.box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { bg: P.bg },
    padding: { left: 1 },
  });

  // Status bar (key hints, messages)
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { bg: P.bg },
    padding: { left: 1 },
  });

  // ── Tool selector overlay ──────────────────────────────────────────────────

  const toolSelector = blessed.list({
    parent: screen,
    top: "center",
    left: "center",
    width: 50,
    height: 14,
    border: { type: "line" },
    style: {
      bg: P.cardBg,
      border: { fg: P.accent },
      selected: { bg: P.accent, fg: 232, bold: true },
      item: { fg: P.fg, bg: P.cardBg },
    },
    label: ` ${c(P.accent, "◆")} ${c(P.title, "Select Tool")} `,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    items: [],
    padding: { left: 1 },
  });

  // ── Issue picker overlay ───────────────────────────────────────────────────

  const issuePicker = blessed.list({
    parent: screen,
    top: "center",
    left: "center",
    width: "70%",
    height: "60%",
    border: { type: "line" },
    style: {
      bg: P.cardBg,
      border: { fg: P.accent },
      selected: { bg: P.selectedBg, fg: P.white, bold: true },
      item: { fg: P.fg, bg: P.cardBg },
    },
    label: ` ${c(P.accent, "◆")} ${c(P.title, "Select Task")} `,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    items: [],
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: "▐",
      track: { ch: " ", style: { bg: P.cardBg } },
      style: { fg: P.dimmer },
    },
    padding: { left: 1 },
  });

  // ── Terminal Pane Management ────────────────────────────────────────────────

  const panes = [];

  function createPane(agentId, handler) {
    const term = blessed.terminal({
      parent: mainPanel,
      cursor: "block",
      cursorBlink: true,
      screenKeys: false,
      scrollback: 10000,
      label: ` ${c(P.dim, agentId)} `,
      border: { type: "line" },
      style: {
        bg: P.panelBg,
        fg: "default",
        border: { fg: P.muted },
        focus: {
          border: { fg: P.accent },
        },
        label: { fg: P.dim },
      },
      scrollbar: {
        ch: "▐",
        track: { ch: " " },
        style: { fg: P.dimmer },
      },
      handler: (data) => handler(data),
    });

    // Click to focus
    term.on("click", () => {
      term.focus();
      screen.render();
    });

    // Mouse wheel scroll through scrollback
    term.on("wheeldown", () => {
      term.scroll(3);
      screen.render();
    });
    term.on("wheelup", () => {
      term.scroll(-3);
      screen.render();
    });

    const pane = { terminal: term, agentId };
    panes.push(pane);
    layoutPanes();
    return pane;
  }

  function removePane(agentId) {
    const idx = panes.findIndex((p) => p.agentId === agentId);
    if (idx === -1) return;
    panes[idx].terminal.destroy();
    panes.splice(idx, 1);
    layoutPanes();
  }

  function updatePaneLabel(agentId, label) {
    const pane = panes.find((p) => p.agentId === agentId);
    if (pane) {
      pane.terminal.setLabel(` ${label} `);
    }
  }

  function layoutPanes() {
    const n = panes.length;
    if (n === 0) return;

    if (n === 1) {
      const t = panes[0].terminal;
      t.top = 0;
      t.left = 0;
      t.width = "100%";
      t.height = "100%";
    } else if (n === 2) {
      panes[0].terminal.top = 0;
      panes[0].terminal.left = 0;
      panes[0].terminal.width = "50%";
      panes[0].terminal.height = "100%";
      panes[1].terminal.top = 0;
      panes[1].terminal.left = "50%";
      panes[1].terminal.width = "50%";
      panes[1].terminal.height = "100%";
    } else if (n === 3) {
      panes[0].terminal.top = 0;
      panes[0].terminal.left = 0;
      panes[0].terminal.width = "50%";
      panes[0].terminal.height = "50%";
      panes[1].terminal.top = 0;
      panes[1].terminal.left = "50%";
      panes[1].terminal.width = "50%";
      panes[1].terminal.height = "50%";
      panes[2].terminal.top = "50%";
      panes[2].terminal.left = 0;
      panes[2].terminal.width = "100%";
      panes[2].terminal.height = "50%";
    } else {
      const cols = n <= 4 ? 2 : 3;
      const rows = Math.ceil(n / cols);
      const cellW = Math.floor(100 / cols);
      const cellH = Math.floor(100 / rows);
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const t = panes[i].terminal;
        t.top = `${row * cellH}%`;
        t.left = `${col * cellW}%`;
        t.width = col === cols - 1 ? `${100 - col * cellW}%` : `${cellW}%`;
        t.height = row === rows - 1 ? `${100 - row * cellH}%` : `${cellH}%`;
      }
    }
    screen.render();
  }

  function focusPane(agentId) {
    const pane = panes.find((p) => p.agentId === agentId);
    if (pane) { pane.terminal.focus(); screen.render(); }
  }

  function focusPaneByIndex(idx) {
    if (idx >= 0 && idx < panes.length) {
      panes[idx].terminal.focus();
      screen.render();
    }
  }

  function getFocusedAgentId() {
    const focused = panes.find((p) => screen.focused === p.terminal);
    return focused ? focused.agentId : null;
  }

  function getPane(agentId) {
    const pane = panes.find((p) => p.agentId === agentId);
    return pane ? pane.terminal : null;
  }

  // ── Welcome state ──────────────────────────────────────────────────────────

  const welcomeBox = blessed.box({
    parent: mainPanel,
    top: "center",
    left: "center",
    width: 56,
    height: 15,
    tags: true,
    border: { type: "line" },
    style: { bg: P.cardBg, fg: P.dim, border: { fg: P.muted } },
    padding: { left: 2, right: 2, top: 1 },
    content: [
      `  ${c(P.magenta, "◆")} ${c(P.title, "Homer")} ${c(P.dim, "— Agent Orchestrator")}`,
      "",
      `  ${c(P.dimmer, "─".repeat(44))}`,
      "",
      `  ${c(P.accent, "Enter")}  ${c(P.fg, "spawn agent")}       ${c(P.accent, "t")}  ${c(P.fg, "pick tool")}`,
      `  ${c(P.accent, "i")}      ${c(P.fg, "pick task")}        ${c(P.accent, "+")}  ${c(P.fg, "add agent")}`,
      `  ${c(P.accent, "^A")}     ${c(P.fg, "toggle focus")}     ${c(P.accent, "q")}  ${c(P.fg, "quit")}`,
      "",
      `  ${c(P.dimmer, "─".repeat(44))}`,
      `  ${c(P.dimmer, "Powered by Claude Code · Codex · Aider")}`,
    ].join("\n"),
  });

  // Hide welcome box when first pane is created
  const origCreate = createPane;
  const wrappedCreatePane = (agentId, handler) => {
    welcomeBox.hide();
    return origCreate(agentId, handler);
  };

  return {
    screen,
    sidebar: { toolBadge, repoHeader, dagBox, agentList },
    main: { panel: mainPanel, statusLine },
    statusBar,
    toolSelector,
    issuePicker,
    P,
    c,
    SIDEBAR_W,
    panes: {
      create: wrappedCreatePane,
      remove: removePane,
      updateLabel: updatePaneLabel,
      layout: layoutPanes,
      focus: focusPane,
      focusByIndex: focusPaneByIndex,
      getFocusedAgentId,
      get: getPane,
      list: panes,
    },
  };
}
