import { useState, useRef, useEffect } from "react";
import { cn, ROLES, STATUS_COLORS, formatElapsed, ansiToHtml, getHomerAvatar } from "@/lib/utils";
import { Timeline } from "./Timeline";
import { ChevronRight, ChevronDown, AlertTriangle, X } from "lucide-react";

function FilesTouched({ files, conflicts }) {
  if (!files || files.size === 0) {
    return <div className="text-overlay0 text-xs py-1">No files detected yet</div>;
  }

  const sorted = [...files.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-0.5">
      {sorted.map(([fp, count]) => (
        <div key={fp} className="flex items-center gap-2 text-xs py-0.5 group">
          <span className="text-subtext1 font-mono truncate flex-1">{fp}</span>
          <span className="text-overlay0 text-[10px]">({count})</span>
          {conflicts.has(fp) && (
            <AlertTriangle size={12} className="text-peach shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
}

function VerifyHistory({ history }) {
  const [expanded, setExpanded] = useState(null);

  if (!history || history.length === 0) return null;

  return (
    <div className="space-y-1">
      {history.map((v, i) => (
        <div key={i}>
          <button
            onClick={() => setExpanded(expanded === i ? null : i)}
            className={cn(
              "flex items-center gap-2 text-xs w-full text-left py-1 cursor-pointer rounded px-1",
              "hover:bg-surface0/50 transition-colors"
            )}
          >
            <span className={cn(
              "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium",
              v.passed ? "bg-green/15 text-green" : "bg-red/15 text-red"
            )}>
              #{v.attempt} {v.passed ? "PASS" : "FAIL"}
            </span>
            {!v.passed && v.results?.length > 0 && (
              <span className="text-overlay0 truncate flex-1">
                {v.results.map(r => r.name).join(", ")}
              </span>
            )}
            {!v.passed && v.results?.length > 0 && (
              expanded === i
                ? <ChevronDown size={12} className="text-overlay0 shrink-0" />
                : <ChevronRight size={12} className="text-overlay0 shrink-0" />
            )}
          </button>

          {/* Expanded error details */}
          {expanded === i && !v.passed && (
            <div className="ml-4 mt-1 space-y-1">
              {v.results.map((r, j) => (
                <div key={j} className="bg-crust rounded p-2">
                  <div className="text-[10px] text-red uppercase tracking-wider mb-1">{r.name}</div>
                  <pre className="text-[11px] text-subtext0 whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto leading-relaxed">
                    {(r.output || "").slice(0, 500)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function OutputDrawer({ output, onSendInput, agentId, isWorking }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const preRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-expand when agent is working
  useEffect(() => {
    if (isWorking && !open) setOpen(true);
  }, [isWorking]);

  useEffect(() => {
    if (open && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [output, open]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && agentId) {
      onSendInput(agentId, input + "\n");
      setInput("");
    }
  };

  return (
    <div className="border-t border-surface0 mt-2 flex flex-col min-h-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs text-overlay0 hover:text-subtext1 py-2 w-full cursor-pointer transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Raw Output</span>
        {output && <span className="text-[10px]">({Math.round(output.length / 1024)}KB)</span>}
      </button>

      {open && (
        <div className="animate-in slide-in-from-top-1 flex flex-col min-h-0 flex-1">
          <pre
            ref={preRef}
            className="bg-crust rounded-t p-2 text-[11px] leading-relaxed flex-1 min-h-[20vh] max-h-[60vh] overflow-auto whitespace-pre-wrap"
            dangerouslySetInnerHTML={{ __html: output ? ansiToHtml(output) : "" }}
          />
          <form onSubmit={handleSubmit} className="flex gap-1 mt-0">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type here to send input to agent..."
              className="flex-1 bg-surface0 border border-surface1 rounded-b px-3 py-2 text-sm text-text outline-none focus:border-lavender font-mono"
              autoFocus={isWorking}
            />
          </form>
        </div>
      )}
    </div>
  );
}

export function DetailPanel({ agent, agentIndex, milestones, files, verify, output, conflicts, onSendInput, onKill }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  if (!agent) {
    return (
      <main className="flex-1 flex items-center justify-center bg-base overflow-hidden">
        <div className="text-overlay0 text-sm">Select an agent or spawn one to begin</div>
      </main>
    );
  }

  const role = ROLES[agent.role] || ROLES.general;
  const sc = STATUS_COLORS[agent.status] || STATUS_COLORS.working;
  const elapsed = formatElapsed(now - (agent.startedAt || now));
  const avatar = getHomerAvatar(agentIndex >= 0 ? agentIndex : 0);
  const agentMilestones = milestones.get(agent.id) || [];
  const agentFiles = files.get(agent.id) || new Map();
  const agentVerify = verify.get(agent.id) || [];
  const agentOutput = output.get(agent.id) || "";
  const hasVerify = agentVerify.length > 0;

  return (
    <main className="flex-1 flex flex-col bg-base overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Task header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              {agent.task?.key && (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface0 text-subtext0">
                  {agent.task.type === "story" ? `S${agent.task.key}` : `#${agent.task.key}`}
                </span>
              )}
              <span className={cn("text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded", sc.bg, sc.text)}>
                {agent.status}
              </span>
            </div>
            <h2 className="text-base font-medium text-text">
              {agent.task?.title || "Interactive session"}
            </h2>
            <div className="flex items-center gap-2 mt-1 text-xs text-subtext0">
              <img src={avatar.src} alt={avatar.name} title={avatar.name} className="w-10 h-10 shrink-0 rounded" />
              <span>{role.name}</span>
              <span className="text-surface2">&middot;</span>
              <span>{agent.id}</span>
              <span className="text-surface2">&middot;</span>
              <span>{elapsed}</span>
              {agent.tool && (
                <>
                  <span className="text-surface2">&middot;</span>
                  <span>{agent.tool}</span>
                </>
              )}
            </div>
          </div>

          {(agent.status === "working" || agent.status === "verifying") && (
            <button
              onClick={() => onKill(agent.id)}
              className="text-overlay0 hover:text-red p-1 rounded hover:bg-red/10 transition-colors cursor-pointer"
              title="Kill agent"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Activity timeline */}
        <section>
          <h3 className="text-xs uppercase tracking-wider text-overlay0 mb-2">Activity</h3>
          <Timeline milestones={agentMilestones} startedAt={agent.startedAt} />
        </section>

        {/* Files touched */}
        <section>
          <h3 className="text-xs uppercase tracking-wider text-overlay0 mb-2">
            Files Touched
            {agentFiles.size > 0 && <span className="text-subtext0 ml-1 normal-case">({agentFiles.size})</span>}
          </h3>
          <FilesTouched files={agentFiles} conflicts={conflicts} />
        </section>

        {/* Verify history */}
        {hasVerify && (
          <section>
            <h3 className="text-xs uppercase tracking-wider text-overlay0 mb-2">Verification</h3>
            <VerifyHistory history={agentVerify} />
          </section>
        )}

        {/* Raw output drawer */}
        <OutputDrawer
          output={agentOutput}
          onSendInput={onSendInput}
          agentId={agent.id}
          isWorking={agent.status === "working" || agent.status === "verifying"}
        />
      </div>
    </main>
  );
}
