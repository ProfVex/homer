import { useEffect, useRef } from "react";
import { cn, formatRelative } from "@/lib/utils";

const MILESTONE_STYLES = {
  started:       { icon: "\u25CF", color: "text-blue",    bg: "bg-blue" },
  file:          { icon: "\u25CF", color: "text-overlay0", bg: "bg-overlay0" },
  "verify-start":{ icon: "\u25CE", color: "text-yellow",  bg: "bg-yellow" },
  "verify-pass": { icon: "\u2713", color: "text-green",   bg: "bg-green" },
  "verify-fail": { icon: "\u2717", color: "text-red",     bg: "bg-red" },
  done:          { icon: "\u2713", color: "text-green",   bg: "bg-green" },
  rerouted:      { icon: "\u21BB", color: "text-overlay0", bg: "bg-overlay0" },
  blocked:       { icon: "\u26A0", color: "text-peach",   bg: "bg-peach" },
  failed:        { icon: "\u2717", color: "text-red",     bg: "bg-red" },
  exited:        { icon: "\u25CB", color: "text-surface2", bg: "bg-surface2" },
};

export function Timeline({ milestones, startedAt }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [milestones?.length]);

  if (!milestones || milestones.length === 0) {
    return <div className="text-overlay0 text-xs py-4 pl-6">Waiting for activity...</div>;
  }

  return (
    <div ref={scrollRef} className="relative pl-6 max-h-64 overflow-y-auto">
      {/* Timeline spine */}
      <div className="absolute left-[9px] top-0 bottom-0 w-px bg-surface1" />

      {milestones.map((m, i) => {
        const style = MILESTONE_STYLES[m.type] || MILESTONE_STYLES.file;
        const relative = startedAt ? formatRelative(m.ts - startedAt) : "";
        const isVerifyFail = m.type === "verify-fail";

        return (
          <div key={i} className="relative py-1 group">
            {/* Dot on the spine */}
            <div className={cn(
              "absolute -left-[15px] top-[7px] w-2.5 h-2.5 rounded-full border-2 border-base",
              style.bg
            )} />

            <div className="flex items-start justify-between gap-2">
              <span className={cn(
                "text-xs leading-relaxed",
                isVerifyFail ? "text-red" : m.type === "file" ? "text-subtext0" : "text-text"
              )}>
                {m.text}
              </span>
              <span className="text-[10px] text-overlay0 shrink-0 tabular-nums">{relative}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
