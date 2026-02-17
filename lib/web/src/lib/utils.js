import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// ── ANSI → HTML converter (virtual screen buffer) ────────────────
const ANSI_COLORS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
];

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Convert raw PTY output (with ANSI sequences) to clean HTML.
 * Uses a virtual screen buffer to handle cursor movement, carriage returns,
 * line erasing, etc. — then renders lines with color spans.
 */
export function ansiToHtml(raw) {
  // Pre-clean orphaned sequences
  raw = raw
    .replace(/\x9b[0-9;?]*[A-Za-z@`]/g, "")
    .replace(/(?<!\x1b)\[[\d;?]*[A-HJKSTfhlmnsu`]/g, "");

  // Virtual screen: array of lines, each line is array of {char, style}
  const lines = [[]];
  let row = 0;
  let col = 0;
  let currentStyle = null; // CSS class string or null

  function ensureRow(r) {
    while (lines.length <= r) lines.push([]);
  }
  function ensureCol(r, c) {
    ensureRow(r);
    while (lines[r].length <= c) lines[r].push({ char: " ", style: null });
  }
  function putChar(ch) {
    ensureCol(row, col);
    lines[row][col] = { char: ch, style: currentStyle };
    col++;
  }

  let i = 0;
  while (i < raw.length) {
    // ESC [ ... <letter> — CSI sequence
    if (raw[i] === "\x1b" && raw[i + 1] === "[") {
      let j = i + 2;
      while (j < raw.length && !(/[A-Za-z@`]/.test(raw[j]))) j++;
      if (j >= raw.length) { i++; continue; }

      const finalChar = raw[j];
      const params = raw.slice(i + 2, j);
      const nums = params.split(";").map(s => parseInt(s, 10) || 0);
      const n = nums[0] || 1;

      switch (finalChar) {
        case "m": { // SGR — colors/styles
          const codes = params ? params.split(";").map(Number) : [0];
          const classes = [];
          for (const code of codes) {
            if (code === 0) { currentStyle = null; break; }
            else if (code === 1) classes.push("ansi-bold");
            else if (code === 2) classes.push("ansi-dim");
            else if (code === 3) classes.push("ansi-italic");
            else if (code === 4) classes.push("ansi-underline");
            else if (code >= 30 && code <= 37) classes.push(`ansi-fg-${ANSI_COLORS[code - 30]}`);
            else if (code >= 40 && code <= 47) classes.push(`ansi-bg-${ANSI_COLORS[code - 40]}`);
            else if (code >= 90 && code <= 97) classes.push(`ansi-fg-bright-${ANSI_COLORS[code - 90]}`);
          }
          if (classes.length > 0) currentStyle = classes.join(" ");
          break;
        }
        case "A": row = Math.max(0, row - n); break; // Cursor up
        case "B": row += n; ensureRow(row); break;    // Cursor down
        case "C": col += n; break;                     // Cursor forward
        case "D": col = Math.max(0, col - n); break;  // Cursor back
        case "G": col = Math.max(0, (nums[0] || 1) - 1); break; // Cursor to column
        case "H": case "f": { // Cursor position
          row = Math.max(0, (nums[0] || 1) - 1);
          col = Math.max(0, (nums[1] || 1) - 1);
          ensureRow(row);
          break;
        }
        case "J": { // Erase display
          const mode = nums[0] || 0;
          if (mode === 2 || mode === 3) {
            // Clear entire screen — just add spacing, don't nuke history
            row = lines.length;
            col = 0;
            lines.push([]);
          }
          break;
        }
        case "K": { // Erase line
          const mode = nums[0] || 0;
          ensureRow(row);
          if (mode === 0) { // Erase to end of line
            lines[row].length = col;
          } else if (mode === 1) { // Erase to start of line
            for (let c = 0; c <= col && c < lines[row].length; c++) {
              lines[row][c] = { char: " ", style: null };
            }
          } else if (mode === 2) { // Erase entire line
            lines[row] = [];
          }
          break;
        }
        // l, h, s, u, n, etc. — mode set/reset, save/restore, query — ignore
        default: break;
      }
      i = j + 1;
      continue;
    }

    // OSC sequence
    if (raw[i] === "\x1b" && raw[i + 1] === "]") {
      const bell = raw.indexOf("\x07", i);
      const st = raw.indexOf("\x1b\\", i);
      if (bell !== -1 && (st === -1 || bell < st)) { i = bell + 1; }
      else if (st !== -1) { i = st + 2; }
      else { i += 2; }
      continue;
    }

    // Other escape sequences
    if (raw[i] === "\x1b") { i += 2; continue; }

    // Newline
    if (raw[i] === "\n") {
      row++;
      col = 0;
      ensureRow(row);
      i++;
      continue;
    }

    // Carriage return
    if (raw[i] === "\r") {
      col = 0;
      i++;
      continue;
    }

    // Tab
    if (raw[i] === "\t") {
      const nextTab = (Math.floor(col / 8) + 1) * 8;
      while (col < nextTab) putChar(" ");
      i++;
      continue;
    }

    // Control characters — skip
    if (raw.charCodeAt(i) < 32) { i++; continue; }

    // Normal character
    putChar(raw[i]);
    i++;
  }

  // Render lines to HTML — merge consecutive cells with same style into spans
  const htmlLines = [];
  for (const line of lines) {
    let html = "";
    let runStyle = null;
    let runChars = "";

    function flushRun() {
      if (!runChars) return;
      const escaped = runChars
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      if (runStyle) {
        html += `<span class="${runStyle}">${escaped}</span>`;
      } else {
        html += escaped;
      }
      runChars = "";
    }

    for (const cell of line) {
      if (cell.style !== runStyle) {
        flushRun();
        runStyle = cell.style;
      }
      runChars += cell.char;
    }
    flushRun();

    // Trim trailing spaces
    htmlLines.push(html.replace(/\s+$/, ""));
  }

  // Remove trailing empty lines
  while (htmlLines.length > 0 && htmlLines[htmlLines.length - 1] === "") {
    htmlLines.pop();
  }

  return htmlLines.join("\n");
}

// ── File path extraction ────────────────────────────────────────
const FILE_RE = /(?:src|lib|app|pages|components|hooks|utils|test|tests|spec|config|public|assets|api|scripts|bin|deploy|docker|k8s|infra)\/[^\s,)"']+\.[a-z]{1,5}/gi;

export function extractFilePaths(text) {
  const fps = [];
  FILE_RE.lastIndex = 0;
  let m;
  while ((m = FILE_RE.exec(text)) !== null) {
    const fp = m[0].replace(/[,.)]+$/, "");
    if (!fps.includes(fp)) fps.push(fp);
  }
  return fps;
}

// ── Time formatting ─────────────────────────────────────────────
export function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

export function formatRelative(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

// ── NotHomer™ avatars ────────────────────────────────────────────
export const NOT_HOMER_AVATARS = [
  { src: "/avatars/homer-donut.svg",     name: "Donut Enthusiast" },
  { src: "/avatars/homer-beer.svg",      name: "Tavern Regular" },
  { src: "/avatars/homer-sleep.svg",     name: "Napping on the Job" },
  { src: "/avatars/homer-doh.svg",       name: "D'oh!" },
  { src: "/avatars/homer-nuke.svg",      name: "Safety Inspector" },
  { src: "/avatars/homer-brain.svg",     name: "Big Brain Mode" },
  { src: "/avatars/homer-rage.svg",      name: "WHY YOU LITTLE" },
  { src: "/avatars/homer-thinking.svg",  name: "Rare Thinking" },
  { src: "/avatars/homer-happy.svg",     name: "Pure Bliss" },
  { src: "/avatars/homer-scared.svg",    name: "Maximum Fear" },
  { src: "/avatars/homer-cool.svg",      name: "Mr. Plow" },
  { src: "/avatars/homer-fat.svg",       name: "Muumuu Mode" },
  { src: "/avatars/homer-hurt.svg",      name: "Everything Hurts" },
  { src: "/avatars/homer-detective.svg", name: "Detective Mode" },
  { src: "/avatars/homer-angel.svg",     name: "Wasn't Me" },
  { src: "/avatars/homer-chef.svg",      name: "Cooking Disaster" },
  { src: "/avatars/homer-builder.svg",   name: "DIY Disaster" },
  { src: "/avatars/homer-rich.svg",      name: "Stonks" },
];

export function getHomerAvatar(index) {
  return NOT_HOMER_AVATARS[index % NOT_HOMER_AVATARS.length];
}

// ── Roles ───────────────────────────────────────────────────────
export const ROLES = {
  general:    { icon: "\u25CF", color: "#89b4fa", name: "General" },
  planner:    { icon: "\u25C6", color: "#a6e3a1", name: "Planner" },
  coder:      { icon: "\u25B2", color: "#f9e2af", name: "Coder" },
  data:       { icon: "\u25A3", color: "#f38ba8", name: "Data" },
  api:        { icon: "\u25C8", color: "#cba6f7", name: "API" },
  researcher: { icon: "\uD83D\uDD0D", color: "#f9e2af", name: "Researcher" },
  verifier:   { icon: "\u2713", color: "#89b4fa", name: "Verifier" },
};

// ── Status colors ───────────────────────────────────────────────
export const STATUS_COLORS = {
  working:   { bg: "bg-blue/15", text: "text-blue", border: "border-blue/40" },
  verifying: { bg: "bg-yellow/15", text: "text-yellow", border: "border-yellow/40" },
  done:      { bg: "bg-green/15", text: "text-green", border: "border-green/40" },
  failed:    { bg: "bg-red/15", text: "text-red", border: "border-red/40" },
  blocked:   { bg: "bg-peach/15", text: "text-peach", border: "border-peach/40" },
  rerouted:  { bg: "bg-overlay0/15", text: "text-overlay0", border: "border-overlay0/40" },
  exited:    { bg: "bg-surface2/15", text: "text-surface2", border: "border-surface2/40" },
  killed:    { bg: "bg-surface2/15", text: "text-surface2", border: "border-surface2/40" },
};
