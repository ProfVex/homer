import { useState, useRef, useEffect } from "react";
import { cn, ansiToHtml, formatElapsed, STATUS_COLORS, ROLES, getHomerAvatar } from "@/lib/utils";
import { ChevronDown, X } from "lucide-react";

export function TerminalDrawer({ agent, output, onSendInput, onKill, onClose }) {
  const [input, setInput] = useState("");
  const preRef = useRef(null);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [output]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && agent?.id) {
      onSendInput(agent.id, input + "\n");
      setInput("");
    }
  };

  if (!agent) return null;

  const sc = STATUS_COLORS[agent.status] || STATUS_COLORS.working;
  const role = ROLES[agent.role] || ROLES.general;
  const isActive = agent.status === "working" || agent.status === "verifying";

  return (
    <div className="border-t border-surface0 bg-mantle flex flex-col max-h-[50vh] animate-in slide-in-from-bottom-2 duration-200">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-surface0/50">
        <span className={cn(
          "text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium",
          sc.bg, sc.text,
        )}>
          {agent.status}
        </span>
        <span className="text-xs text-subtext0 font-mono">{agent.id}</span>
        <span className="text-[10px] text-overlay0">{role.name}</span>
        <span className="text-[10px] text-surface2">&middot;</span>
        <span className="text-[10px] text-overlay0">
          {formatElapsed(Date.now() - (agent.startedAt || Date.now()))}
        </span>
        {output && (
          <span className="text-[9px] text-surface2 ml-1">
            ({Math.round((output?.length || 0) / 1024)}KB)
          </span>
        )}

        <div className="flex-1" />

        {isActive && (
          <button
            onClick={() => onKill(agent.id)}
            className="text-overlay0 hover:text-red p-0.5 rounded hover:bg-red/10 transition-colors cursor-pointer"
            title="Kill agent"
          >
            <X size={12} />
          </button>
        )}
        <button
          onClick={onClose}
          className="text-overlay0 hover:text-subtext1 p-0.5 rounded hover:bg-surface0 transition-colors cursor-pointer"
          title="Close terminal"
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {/* Terminal output */}
      <pre
        ref={preRef}
        className="flex-1 overflow-auto px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap bg-crust min-h-[100px]"
        dangerouslySetInnerHTML={{ __html: output ? ansiToHtml(output) : '<span class="text-overlay0">Waiting for output...</span>' }}
      />

      {/* Input */}
      {isActive && (
        <form onSubmit={handleSubmit} className="shrink-0">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Send input to agent..."
            className="w-full bg-surface0 border-t border-surface1 px-3 py-2 text-xs text-text outline-none focus:border-lavender font-mono"
          />
        </form>
      )}
    </div>
  );
}
