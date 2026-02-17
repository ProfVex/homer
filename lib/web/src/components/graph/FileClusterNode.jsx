import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

// Color files by directory prefix
const DIR_COLORS = {
  src: "#89b4fa",    // blue
  lib: "#f9e2af",    // yellow
  test: "#a6e3a1",   // green
  tests: "#a6e3a1",
  app: "#cba6f7",    // mauve
  config: "#fab387",  // peach
  bin: "#89dceb",    // sky
};

function getDirColor(fp) {
  const dir = fp.split("/")[0];
  return DIR_COLORS[dir] || "#6c7086";
}

export function FileClusterNode({ data }) {
  const { files, conflicts } = data;
  const entries = [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const overflow = files.size - entries.length;
  const hasConflicts = conflicts && conflicts.size > 0;

  return (
    <div className={cn(
      "bg-crust border rounded-md px-2 py-1.5 min-w-[120px] max-w-[160px] shadow-md",
      hasConflicts ? "border-peach/60" : "border-surface0",
    )}>
      <Handle type="target" position={Position.Left} className="!bg-surface1 !w-1.5 !h-1.5 !border-0" />

      <div className="flex flex-wrap gap-1">
        {entries.map(([fp, count]) => {
          const isConflict = conflicts?.has(fp);
          const color = getDirColor(fp);
          const name = fp.split("/").pop();
          return (
            <div
              key={fp}
              title={`${fp} (${count}x)`}
              className={cn(
                "group relative flex items-center gap-0.5 text-[8px] font-mono rounded px-1 py-0.5",
                isConflict ? "bg-peach/15 text-peach" : "bg-surface0/60 text-subtext0",
              )}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="truncate max-w-[80px]">{name}</span>
              {count > 1 && <span className="text-overlay0">{count}</span>}
            </div>
          );
        })}
      </div>
      {overflow > 0 && (
        <div className="text-[8px] text-overlay0 mt-0.5">+{overflow} more</div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-surface1 !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}
