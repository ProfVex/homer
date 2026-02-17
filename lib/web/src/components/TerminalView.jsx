import { useRef, useEffect } from "react";
import { cn, formatElapsed, STATUS_COLORS, ROLES, getHomerAvatar } from "@/lib/utils";
import { X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const THEME = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#585b7066",
  selectionForeground: "#cdd6f4",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

export function TerminalView({ agent, onOutput, onSendInput, onKill }) {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);
  const agentIdRef = useRef(null);
  const unsubRef = useRef(null);
  const sendInputRef = useRef(onSendInput);
  sendInputRef.current = onSendInput;

  // Initialize xterm ONCE on mount — never unmount
  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      theme: THEME,
      fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      convertEol: false,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(termRef.current);

    xtermRef.current = term;
    fitRef.current = fit;

    // Initial fit after DOM settles
    requestAnimationFrame(() => { try { fit.fit(); } catch {} });

    // Keyboard input → PTY
    const disposable = term.onData((data) => {
      if (agentIdRef.current && sendInputRef.current) {
        sendInputRef.current(agentIdRef.current, data);
      }
    });

    // When xterm resizes, tell server PTY so Claude Code redraws correctly
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (agentIdRef.current) {
        fetch(`/api/agent/${agentIdRef.current}/resize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols, rows }),
        }).catch(() => {});
      }
    });

    // Auto-resize on container change
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => { try { fit.fit(); } catch {} });
    });
    ro.observe(termRef.current);

    // Show initial message
    term.write("\x1b[2m  Waiting for agent...\x1b[0m\r\n");

    return () => {
      disposable.dispose();
      resizeDisposable.dispose();
      ro.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // When selected agent changes: clear, fetch buffer, subscribe to live stream
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    const newId = agent?.id || null;

    // Cleanup old subscription
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }

    agentIdRef.current = newId;
    term.clear();
    term.reset();

    if (!newId) {
      term.write("\x1b[2m  No agent selected\x1b[0m\r\n");
      return;
    }

    // Fetch full output buffer from server, THEN subscribe to live chunks
    let cancelled = false;
    fetch(`/api/agent/${newId}/output`)
      .then(r => r.text())
      .then(buf => {
        if (cancelled) return;
        if (buf.length > 0) term.write(buf);
        // Subscribe to live stream after replay
        if (onOutput) {
          unsubRef.current = onOutput(newId, (chunk) => {
            term.write(chunk);
          });
        }
        // Fit and sync PTY dimensions so Claude Code redraws properly
        requestAnimationFrame(() => {
          try {
            fitRef.current?.fit();
            fetch(`/api/agent/${newId}/resize`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cols: term.cols, rows: term.rows }),
            }).catch(() => {});
          } catch {}
        });
      })
      .catch(() => {
        if (cancelled) return;
        if (onOutput) {
          unsubRef.current = onOutput(newId, (chunk) => {
            term.write(chunk);
          });
        }
      });

    return () => { cancelled = true; };
  }, [agent?.id, onOutput]);

  // Derive header info (safe even when agent is null)
  const sc = agent ? (STATUS_COLORS[agent.status] || STATUS_COLORS.working) : null;
  const role = agent ? (ROLES[agent.role] || ROLES.general) : null;
  const isActive = agent && (agent.status === "working" || agent.status === "verifying");
  const agentIndex = agent ? parseInt(agent.id?.split("-")[1] || "0", 10) - 1 : 0;
  const avatar = agent ? getHomerAvatar(agentIndex >= 0 ? agentIndex : 0) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Agent header — only shown when agent selected */}
      {agent && (
        <div className="flex items-center gap-2.5 px-4 py-2 shrink-0 border-b border-surface0/20">
          <img src={avatar.src} alt={avatar.name} className="w-6 h-6 rounded-lg" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-text font-semibold truncate">
              {agent.task?.title || "Interactive"}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-overlay0">
              <span className="font-mono">{agent.id}</span>
              <span className="text-surface2">&middot;</span>
              <span style={{ color: role.color }}>{role.name}</span>
              <span className="text-surface2">&middot;</span>
              <span>{formatElapsed(Date.now() - (agent.startedAt || Date.now()))}</span>
            </div>
          </div>
          <span className={cn(
            "text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold",
            sc.bg, sc.text,
          )}>
            {agent.status}
          </span>
          {isActive && (
            <button
              onClick={() => onKill(agent.id)}
              className="text-overlay0 hover:text-red p-1 rounded-lg hover:bg-red/10 transition-colors cursor-pointer"
              title="Kill agent"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* xterm.js — ALWAYS mounted, never conditionally removed */}
      <div ref={termRef} className="flex-1 min-h-0" />
    </div>
  );
}
