import { Handle, Position } from "@xyflow/react";
import { cn, STATUS_COLORS, ROLES, formatElapsed, getHomerAvatar } from "@/lib/utils";

const DIR_COLORS = {
  src: "#89b4fa",
  lib: "#f9e2af",
  test: "#a6e3a1",
  tests: "#a6e3a1",
  app: "#cba6f7",
  config: "#fab387",
  bin: "#89dceb",
  ".": "#6c7086",
};

function getDirColor(dir) {
  return DIR_COLORS[dir.split("/")[0]] || "#6c7086";
}

const ACCENT_BORDER = {
  working: "border-l-blue",
  verifying: "border-l-yellow",
  done: "border-l-green",
  failed: "border-l-red",
  blocked: "border-l-peach",
  rerouted: "border-l-overlay0",
  exited: "border-l-surface2",
  killed: "border-l-surface2",
};

export function AgentNode({ data }) {
  const { agent, dirGroups, verify: verifyAttempts, latestError } = data;
  const role = ROLES[agent.role] || ROLES.general;
  const sc = STATUS_COLORS[agent.status] || STATUS_COLORS.working;
  const isActive = agent.status === "working" || agent.status === "verifying";
  const isDone = agent.status === "done";
  const avatar = getHomerAvatar(parseInt(agent.id?.replace(/\D/g, "") || "0", 10));

  const hasFiles = dirGroups && dirGroups.size > 0;
  const hasVerify = verifyAttempts && verifyAttempts.length > 0;

  return (
    <div className={cn(
      "bg-mantle border border-surface0/60 rounded-lg min-w-[220px] max-w-[260px] shadow-lg transition-all",
      "border-l-[3px]",
      ACCENT_BORDER[agent.status] || "border-l-blue",
      isDone && "opacity-80",
    )}>
      <Handle type="target" position={Position.Left} className="!bg-surface1 !w-2 !h-2 !border-0" />

      {/* Status label bar */}
      <div className={cn(
        "px-3 py-0.5 text-[8px] uppercase tracking-wider font-semibold",
        sc.bg, sc.text,
        "rounded-tr-lg",
      )}>
        {agent.status}
      </div>

      {/* Header: avatar + ID + elapsed */}
      <div className="px-3 pt-1.5 pb-1">
        <div className="flex items-center gap-2">
          <img src={avatar.src} alt="" className="w-6 h-6 rounded shrink-0" />
          <span className="text-[10px] text-subtext0 font-mono truncate flex-1">{agent.id}</span>
          <span className="text-[9px] text-overlay0 font-mono shrink-0">
            {formatElapsed(Date.now() - (agent.startedAt || Date.now()))}
          </span>
        </div>
        <div className="text-[9px] text-overlay0 flex items-center gap-1 mt-0.5 ml-8">
          <span style={{ color: role.color }}>{role.icon}</span>
          <span>{role.name}</span>
          {agent.tool && (
            <>
              <span className="text-surface2">&middot;</span>
              <span className="text-subtext0">{agent.tool}</span>
            </>
          )}
        </div>
      </div>

      {/* Files section */}
      {hasFiles && (
        <div className="border-t border-surface0/40 px-3 py-1.5">
          {[...dirGroups.entries()].slice(0, 3).map(([dir, dirFiles]) => (
            <div key={dir} className="flex items-center gap-1.5 text-[8px] font-mono leading-relaxed">
              <span
                className="w-1.5 h-1.5 rounded-sm shrink-0"
                style={{ backgroundColor: getDirColor(dir) }}
              />
              <span className="text-subtext0 font-semibold shrink-0">{dir}/</span>
              <span className="text-overlay0 truncate">
                {dirFiles.slice(0, 2).map(f => f.name).join(", ")}
                {dirFiles.length > 2 && ` +${dirFiles.length - 2}`}
              </span>
            </div>
          ))}
          {dirGroups.size > 3 && (
            <div className="text-[7px] text-surface2 mt-0.5">
              +{dirGroups.size - 3} more dirs
            </div>
          )}
        </div>
      )}

      {/* Verify section */}
      {hasVerify && (
        <div className="border-t border-surface0/40 px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <div className="flex gap-0.5">
              {verifyAttempts.map((v, i) => (
                <span
                  key={i}
                  className={cn(
                    "w-2.5 h-2.5 rounded-full text-[6px] flex items-center justify-center font-bold",
                    v.passed ? "bg-green/30 text-green" : "bg-red/30 text-red",
                  )}
                  title={`#${v.attempt}: ${v.passed ? "PASS" : "FAIL"}`}
                >
                  {v.passed ? "\u2713" : "\u2717"}
                </span>
              ))}
            </div>
            <span className="text-[8px] text-overlay0 ml-auto">
              attempt {verifyAttempts.length}/5
            </span>
          </div>
          {latestError && (
            <div className="text-[7px] text-peach mt-1 truncate" title={latestError}>
              {"\u26A0"} {latestError}
            </div>
          )}
        </div>
      )}

      {/* Progress bar for active agents */}
      {isActive && (
        <div className="h-0.5 bg-surface0 rounded-b-lg overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-1000",
              agent.status === "working" ? "bg-blue animate-pulse" : "bg-yellow",
            )}
            style={{ width: agent.status === "verifying" ? "100%" : "60%" }}
          />
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-surface1 !w-2 !h-2 !border-0" />
    </div>
  );
}
