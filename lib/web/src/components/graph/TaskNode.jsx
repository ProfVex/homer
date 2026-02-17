import { Handle, Position } from "@xyflow/react";

export function TaskNode({ data }) {
  const badge = data.taskType === "story"
    ? `S${data.taskKey}`
    : data.taskKey ? `#${data.taskKey}` : null;

  const { agentCount, doneCount } = data;
  const hasSummary = agentCount > 0;

  return (
    <div className="bg-surface0 border border-surface1 rounded-lg px-3 py-2 min-w-[140px] max-w-[180px] shadow-lg">
      {badge && (
        <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-lavender/15 text-lavender font-medium">
          {badge}
        </span>
      )}
      <div className="text-xs text-text mt-1 leading-snug line-clamp-2">{data.label}</div>
      {hasSummary && (
        <div className="text-[9px] text-overlay0 mt-1">
          {agentCount} agent{agentCount !== 1 ? "s" : ""}
          {doneCount > 0 && (
            <span className="text-green"> &middot; {doneCount} done</span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!bg-lavender !w-2 !h-2 !border-0" />
    </div>
  );
}
