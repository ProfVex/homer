import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

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
  const first = dir.split("/")[0];
  return DIR_COLORS[first] || "#6c7086";
}

export function FileOpNode({ data }) {
  const { dir, files, hasConflict, totalOps } = data;
  const color = getDirColor(dir);

  return (
    <div className={cn(
      "bg-crust border rounded-lg px-2.5 py-2 min-w-[120px] max-w-[140px] shadow-md",
      hasConflict ? "border-peach/60 ring-1 ring-peach/20" : "border-surface0/60",
    )}>
      <Handle type="target" position={Position.Left} className="!bg-surface1 !w-1.5 !h-1.5 !border-0" />

      {/* Directory header */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />
        <span className="text-[9px] font-mono text-subtext0 truncate font-semibold">{dir}/</span>
        <span className="text-[8px] text-overlay0 ml-auto">{totalOps}x</span>
      </div>

      {/* File list */}
      <div className="space-y-0.5">
        {files.slice(0, 6).map(f => (
          <div key={f.path} className="flex items-center gap-1 text-[8px] font-mono" title={f.path}>
            <span className={cn(
              "w-1 h-1 rounded-full shrink-0",
              hasConflict ? "bg-peach" : "bg-surface2",
            )} />
            <span className="text-overlay0 truncate">{f.name}</span>
            {f.count > 1 && <span className="text-surface2 ml-auto">{f.count}</span>}
          </div>
        ))}
        {files.length > 6 && (
          <div className="text-[7px] text-surface2">+{files.length - 6} more</div>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="!bg-surface1 !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}
