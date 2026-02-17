import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

export function OutcomeNode({ data }) {
  const done = data.status === "done";

  return (
    <div className="flex flex-col items-center">
      <Handle type="target" position={Position.Left} className="!bg-surface1 !w-1.5 !h-1.5 !border-0" />
      <div className={cn(
        "w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2 shadow-lg",
        done
          ? "bg-green/15 border-green text-green"
          : "bg-red/15 border-red text-red",
      )}>
        {done ? "\u2713" : "\u2717"}
      </div>
      <span className={cn(
        "text-[9px] font-medium mt-0.5",
        done ? "text-green" : "text-red",
      )}>
        {done ? "DONE" : "FAILED"}
      </span>
    </div>
  );
}
