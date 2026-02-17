import { cn } from "@/lib/utils";

export function Header({ state, onSpawn, onSetTool }) {
  const { agents, tools, activeTool, prd, memory, repo } = state;
  const active = agents.filter(a => a.status === "working" || a.status === "verifying").length;

  return (
    <header className="flex items-center gap-4 px-4 h-12 bg-mantle/80 shrink-0 backdrop-blur-sm">
      {/* Brand */}
      <div className="flex items-center gap-2">
        <span className="text-lavender text-lg font-black tracking-tight">Homer</span>
        {repo && <span className="text-overlay0/50 text-[10px] font-mono">{repo.split("/").pop()}</span>}
      </div>

      {/* PRD Progress */}
      {prd && (
        <div className="flex items-center gap-2">
          <span className="text-subtext0 text-xs font-medium">{prd.passed}/{prd.total}</span>
          <div className="flex h-1 w-20 rounded-full overflow-hidden bg-surface0/50">
            {prd.passed > 0 && (
              <div className="bg-green/80 rounded-full" style={{ width: `${(prd.passed / prd.total) * 100}%` }} />
            )}
            {prd.current && (
              <div className="bg-yellow/60 rounded-full" style={{ width: `${(1 / prd.total) * 100}%` }} />
            )}
          </div>
        </div>
      )}

      {/* Agent count pill */}
      <div className={cn(
        "text-[11px] font-medium px-2.5 py-0.5 rounded-full",
        active > 0 ? "bg-green/10 text-green" : "bg-surface0/50 text-subtext0"
      )}>
        {active} active
      </div>

      <div className="flex-1" />

      {/* Controls */}
      <div className="flex items-center gap-2">
        <select
          className="bg-surface0/40 border border-surface0/60 rounded-lg px-2.5 py-1 text-xs text-text outline-none focus:border-lavender/50 transition-colors"
          value={activeTool || ""}
          onChange={(e) => onSetTool(e.target.value)}
        >
          <option value="">Tool...</option>
          {tools.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        <button
          onClick={() => onSpawn()}
          className="bg-lavender/10 text-lavender border border-lavender/20 rounded-full px-3.5 py-1 text-xs font-semibold hover:bg-lavender/20 transition-all cursor-pointer active:scale-95"
        >
          + Agent
        </button>
      </div>
    </header>
  );
}
