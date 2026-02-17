import { useState, useEffect } from "react";
import { cn, ROLES, STATUS_COLORS, formatElapsed, getHomerAvatar } from "@/lib/utils";

function VerifyDots({ verify, maxVerify = 5 }) {
  if (!verify || verify.length === 0) return null;
  return (
    <div className="flex gap-0.5 ml-auto">
      {verify.map((v, i) => (
        <div
          key={i}
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            v.passed ? "bg-green" : "bg-red"
          )}
        />
      ))}
      {Array.from({ length: Math.max(0, maxVerify - verify.length) }, (_, i) => (
        <div key={`empty-${i}`} className="w-1.5 h-1.5 rounded-full bg-surface1" />
      ))}
    </div>
  );
}

function StatusDot({ status }) {
  const colors = {
    working: "bg-blue",
    verifying: "bg-yellow",
    done: "bg-green",
    failed: "bg-red",
    blocked: "bg-peach",
    rerouted: "bg-overlay0",
    exited: "bg-surface2",
    killed: "bg-surface2",
  };
  const isActive = status === "working" || status === "verifying";
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {isActive && (
        <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-50", colors[status] || "bg-surface2")} />
      )}
      <span className={cn("relative inline-flex rounded-full h-2 w-2", colors[status] || "bg-surface2")} />
    </span>
  );
}

export function Roster({ agents, selectedId, onSelect, onSpawn, files, verify }) {
  const [filter, setFilter] = useState("all");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const filtered = agents.filter(a => {
    if (filter === "active") return a.status === "working" || a.status === "verifying";
    if (filter === "done") return a.status === "done" || a.status === "failed";
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const aActive = a.status === "working" || a.status === "verifying";
    const bActive = b.status === "working" || b.status === "verifying";
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return (b.startedAt || 0) - (a.startedAt || 0);
  });

  const activeCount = agents.filter(a => a.status === "working" || a.status === "verifying").length;

  return (
    <aside className="flex flex-col overflow-hidden">
      {/* Team header */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[10px] uppercase tracking-widest text-overlay0 font-medium">Team</h2>
          <span className="text-[10px] text-surface2">
            {activeCount > 0 && <span className="text-green">{activeCount} active</span>}
            {activeCount > 0 && agents.length > activeCount && <span className="text-surface2"> / </span>}
            {agents.length > 0 && <span>{agents.length} total</span>}
          </span>
        </div>

        {/* Filter pills */}
        <div className="flex gap-1">
          {["all", "active", "done"].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-2 py-0.5 rounded-full text-[10px] capitalize cursor-pointer transition-colors",
                filter === f
                  ? "bg-lavender/15 text-lavender"
                  : "text-overlay0 hover:text-subtext1 hover:bg-surface0/50"
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {sorted.length === 0 && (
          <div className="text-center text-overlay0 text-xs py-8">No agents</div>
        )}
        {sorted.map(agent => {
          const role = ROLES[agent.role] || ROLES.general;
          const sc = STATUS_COLORS[agent.status] || STATUS_COLORS.working;
          const fileCount = files.get(agent.id)?.size || 0;
          const elapsed = formatElapsed(now - (agent.startedAt || now));
          const agentVerify = verify.get(agent.id) || [];
          const agentIndex = agents.indexOf(agent);
          const avatar = getHomerAvatar(agentIndex >= 0 ? agentIndex : 0);
          const isSelected = selectedId === agent.id;

          return (
            <button
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              className={cn(
                "w-full text-left rounded-lg p-2 transition-all cursor-pointer group",
                isSelected
                  ? "bg-surface0/80 ring-1 ring-lavender/30"
                  : "hover:bg-surface0/40"
              )}
            >
              <div className="flex items-center gap-2">
                <img src={avatar.src} alt={avatar.name} title={avatar.name} className="w-8 h-8 shrink-0 rounded" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <StatusDot status={agent.status} />
                    <span className="text-[11px] text-text font-medium truncate">
                      {agent.task?.title || "Interactive"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-overlay0">
                    <span className="font-mono">{agent.id}</span>
                    <span className="text-surface2">&middot;</span>
                    <span style={{ color: role.color }}>{role.name}</span>
                    <span className="text-surface2">&middot;</span>
                    <span>{elapsed}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  {fileCount > 0 && (
                    <span className="text-[9px] text-surface2">{fileCount} files</span>
                  )}
                  <VerifyDots verify={agentVerify} />
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* New Agent button */}
      {onSpawn && (
        <div className="px-3 py-2 border-t border-surface0/50">
          <button
            onClick={onSpawn}
            className="w-full text-left px-2 py-1.5 rounded-lg text-xs text-overlay0 hover:text-lavender hover:bg-surface0/40 transition-colors cursor-pointer"
          >
            + New Agent
          </button>
        </div>
      )}
    </aside>
  );
}
