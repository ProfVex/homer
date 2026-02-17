import { Handle, Position } from "@xyflow/react";
import { cn, STATUS_COLORS, ROLES, formatElapsed, getHomerAvatar } from "@/lib/utils";

export function AgentNode({ data }) {
  const { agent, fileCount, verifyCount } = data;
  const role = ROLES[agent.role] || ROLES.general;
  const sc = STATUS_COLORS[agent.status] || STATUS_COLORS.working;
  const isActive = agent.status === "working" || agent.status === "verifying";
  const avatar = getHomerAvatar(parseInt(agent.id?.replace(/\D/g, "") || "0", 10));

  return (
    <div className={cn(
      "bg-mantle border rounded-lg px-3 py-2 min-w-[170px] max-w-[200px] shadow-lg transition-all",
      sc.border,
      isActive && "ring-1 ring-opacity-50",
      isActive && agent.status === "working" && "ring-blue",
      isActive && agent.status === "verifying" && "ring-yellow",
    )}>
      <Handle type="target" position={Position.Left} className="!bg-surface1 !w-2 !h-2 !border-0" />

      {/* Header row */}
      <div className="flex items-center gap-2 mb-1.5">
        <img src={avatar.src} alt="" className="w-7 h-7 rounded" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-subtext0 font-mono truncate">{agent.id}</span>
            <span className={cn(
              "text-[8px] uppercase tracking-wider px-1 py-0.5 rounded font-medium shrink-0",
              sc.bg, sc.text,
            )}>
              {agent.status}
            </span>
          </div>
          <div className="text-[9px] text-overlay0 flex items-center gap-1 mt-0.5">
            <span style={{ color: role.color }}>{role.icon}</span>
            <span>{role.name}</span>
          </div>
        </div>
      </div>

      {/* Status bar */}
      {isActive && (
        <div className="h-0.5 bg-surface0 rounded-full overflow-hidden mt-1">
          <div className={cn(
            "h-full rounded-full transition-all duration-1000",
            agent.status === "working" ? "bg-blue animate-pulse" : "bg-yellow",
          )} style={{ width: agent.status === "verifying" ? "100%" : "60%" }} />
        </div>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-2 mt-1.5 text-[9px] text-overlay0">
        <span>{formatElapsed(Date.now() - (agent.startedAt || Date.now()))}</span>
        {fileCount > 0 && (
          <>
            <span className="text-surface2">&middot;</span>
            <span>{fileCount} files</span>
          </>
        )}
        {verifyCount > 0 && (
          <>
            <span className="text-surface2">&middot;</span>
            <span>{verifyCount} verify</span>
          </>
        )}
        {agent.tool && (
          <>
            <span className="text-surface2">&middot;</span>
            <span className="text-subtext0">{agent.tool}</span>
          </>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="!bg-surface1 !w-2 !h-2 !border-0" />
    </div>
  );
}
