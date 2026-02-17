import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

export function VerifyNode({ data }) {
  const { attempts, latest, passCount, failCount } = data;

  return (
    <div className={cn(
      "bg-crust border rounded-lg px-2.5 py-2 shadow-md min-w-[80px]",
      latest.passed ? "border-green/40" : "border-red/40",
    )}>
      <Handle type="target" position={Position.Left} className="!bg-surface1 !w-1.5 !h-1.5 !border-0" />

      <div className="text-[9px] text-subtext0 font-semibold mb-1">Verify</div>

      {/* Attempt dots */}
      <div className="flex gap-1 mb-1">
        {attempts.map((v, i) => (
          <div
            key={i}
            title={`#${v.attempt}: ${v.passed ? "PASS" : "FAIL"}`}
            className={cn(
              "w-3 h-3 rounded-full border-2 flex items-center justify-center text-[7px] font-bold",
              v.passed
                ? "bg-green/20 border-green text-green"
                : "bg-red/20 border-red text-red",
            )}
          >
            {v.passed ? "\u2713" : "\u2717"}
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="text-[8px] text-overlay0">
        {passCount > 0 && <span className="text-green">{passCount} pass</span>}
        {passCount > 0 && failCount > 0 && <span className="text-surface2"> / </span>}
        {failCount > 0 && <span className="text-red">{failCount} fail</span>}
      </div>

      <Handle type="source" position={Position.Right} className="!bg-surface1 !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}
