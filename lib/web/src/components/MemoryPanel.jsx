import { useState, useEffect, useCallback, useMemo } from "react";

/**
 * MemoryPanel — Learning dashboard showing Homer's accumulated knowledge.
 * Displays rules, metrics, verification episodes, and error→file relations.
 */
export function MemoryPanel({ memory, onRefresh }) {
  const [tab, setTab] = useState("overview");

  if (!memory?.metrics) {
    return (
      <div className="p-4 text-subtext0 text-sm">
        No memory data yet. Complete some tasks to see learning metrics.
      </div>
    );
  }

  const { metrics, stats } = memory;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-surface0/15">
        {["overview", "rules", "episodes", "errors"].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 text-xs rounded-lg transition-colors capitalize ${
              tab === t
                ? "bg-blue/15 text-blue"
                : "text-subtext0 hover:text-text hover:bg-surface0/10"
            }`}
          >
            {t}
          </button>
        ))}
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="ml-auto px-2 py-1 text-xs text-subtext0 hover:text-text"
            title="Refresh memory data"
          >
            Refresh
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {tab === "overview" && <OverviewTab metrics={metrics} stats={stats} />}
        {tab === "rules" && <RulesTab rules={metrics.topRules} />}
        {tab === "episodes" && <EpisodesTab episodes={metrics.recentEpisodes} />}
        {tab === "errors" && <ErrorsTab errorFiles={metrics.topErrorFiles} />}
      </div>
    </div>
  );
}

function OverviewTab({ metrics, stats }) {
  const outcomeEntries = useMemo(() =>
    Object.entries(metrics.outcomes || {}), [metrics.outcomes]
  );

  return (
    <>
      {/* Key metrics grid */}
      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          label="Avg Verify Attempts"
          value={metrics.avgVerifyAttempts ?? "—"}
          sub={`${metrics.totalTasksPassed} tasks passed`}
          good={metrics.avgVerifyAttempts != null && metrics.avgVerifyAttempts <= 2}
        />
        <MetricCard
          label="Error Resolution"
          value={`${metrics.solutions.resolutionRate}%`}
          sub={`${metrics.solutions.resolved}/${metrics.solutions.total} solved`}
          good={metrics.solutions.resolutionRate > 50}
        />
        <MetricCard
          label="Effective Rules"
          value={`${metrics.rules.effective}/${metrics.rules.total}`}
          sub={`${metrics.rules.avgConfidence}% avg confidence`}
          good={metrics.rules.effective > metrics.rules.total / 2}
        />
        <MetricCard
          label="Learning Velocity"
          value={metrics.learningVelocity}
          sub="new rules (7 days)"
          good={metrics.learningVelocity > 0}
        />
      </div>

      {/* Memory stats */}
      {stats && (
        <div className="mt-3 rounded-lg bg-surface0/8 p-3">
          <div className="text-xs font-medium text-subtext1 mb-2">Memory Database</div>
          <div className="grid grid-cols-3 gap-2 text-xs text-subtext0">
            <div>Files: <span className="text-text">{stats.files}</span></div>
            <div>Solutions: <span className="text-text">{stats.solutions}</span></div>
            <div>Rules: <span className="text-text">{stats.rules}</span></div>
            <div>Task Runs: <span className="text-text">{stats.taskRuns}</span></div>
            <div>Episodes: <span className="text-text">{stats.verificationEpisodes}</span></div>
            <div>Relations: <span className="text-text">{stats.errorFileRelations}</span></div>
          </div>
        </div>
      )}

      {/* Outcome distribution */}
      {outcomeEntries.length > 0 && (
        <div className="mt-3 rounded-lg bg-surface0/8 p-3">
          <div className="text-xs font-medium text-subtext1 mb-2">Task Outcomes</div>
          <div className="space-y-1">
            {outcomeEntries.map(([outcome, count]) => (
              <div key={outcome} className="flex items-center gap-2 text-xs">
                <span className={`w-2 h-2 rounded-full ${
                  outcome === "passed" ? "bg-green" :
                  outcome === "failed" ? "bg-red" :
                  outcome === "blocked" ? "bg-yellow" :
                  outcome === "crashed" ? "bg-maroon" : "bg-overlay0"
                }`} />
                <span className="text-subtext0 capitalize">{outcome}</span>
                <span className="text-text ml-auto">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function MetricCard({ label, value, sub, good }) {
  return (
    <div className="rounded-lg bg-surface0/8 p-3">
      <div className="text-xs text-subtext0">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 ${good ? "text-green" : "text-text"}`}>
        {value}
      </div>
      <div className="text-xs text-overlay0 mt-0.5">{sub}</div>
    </div>
  );
}

function RulesTab({ rules }) {
  if (!rules || rules.length === 0) {
    return <div className="text-sm text-subtext0">No rules learned yet.</div>;
  }

  return (
    <div className="space-y-2">
      {rules.map(r => (
        <div key={r.id} className="rounded-lg bg-surface0/8 p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface0/20 text-subtext0 font-mono">
              {r.scope}
            </span>
            <span className="text-xs text-overlay0 ml-auto">
              {r.hits}/{r.hits + r.misses} hits
            </span>
          </div>
          <div className="text-sm text-text leading-snug">{r.rule}</div>
          {/* Confidence bar */}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-surface0/20 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  r.confidence > 0.7 ? "bg-green" :
                  r.confidence > 0.4 ? "bg-yellow" : "bg-red"
                }`}
                style={{ width: `${Math.round(r.confidence * 100)}%` }}
              />
            </div>
            <span className="text-xs text-subtext0 w-10 text-right">
              {Math.round(r.confidence * 100)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EpisodesTab({ episodes }) {
  if (!episodes || episodes.length === 0) {
    return <div className="text-sm text-subtext0">No verification episodes yet.</div>;
  }

  return (
    <div className="space-y-1">
      {episodes.map((ep, i) => (
        <div key={i} className="rounded-lg bg-surface0/8 p-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${ep.passed ? "bg-green" : "bg-red"}`} />
            <span className="text-subtext0 font-mono">{ep.agent_id}</span>
            <span className="text-overlay0">{ep.task_key}</span>
            <span className="text-overlay0 ml-auto">#{ep.attempt}</span>
          </div>
          {ep.checks && ep.checks.length > 0 && (
            <div className="mt-1.5 pl-4 space-y-0.5">
              {ep.checks.map((c, j) => (
                <div key={j} className="flex items-center gap-1.5">
                  <span className={c.passed ? "text-green" : "text-red"}>
                    {c.passed ? "+" : "x"}
                  </span>
                  <span className="text-subtext0">{c.name}</span>
                  {c.output && (
                    <span className="text-overlay0 truncate max-w-[200px]" title={c.output}>
                      {c.output.slice(0, 60)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ErrorsTab({ errorFiles }) {
  if (!errorFiles || errorFiles.length === 0) {
    return <div className="text-sm text-subtext0">No error→file relations yet.</div>;
  }

  // Group by error_key
  const grouped = useMemo(() => {
    const map = new Map();
    for (const ef of errorFiles) {
      if (!map.has(ef.error_key)) map.set(ef.error_key, []);
      map.get(ef.error_key).push(ef);
    }
    return [...map.entries()];
  }, [errorFiles]);

  return (
    <div className="space-y-2">
      {grouped.map(([errorKey, files]) => (
        <div key={errorKey} className="rounded-lg bg-surface0/8 p-3">
          <div className="text-xs font-mono text-red mb-1.5">{errorKey}</div>
          <div className="space-y-0.5 pl-2">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="text-subtext0 font-mono">{f.file_path}</span>
                <span className="text-overlay0 ml-auto">{f.occurrences}x</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
