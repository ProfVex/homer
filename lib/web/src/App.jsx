import { useState, useMemo, useCallback, useEffect } from "react";
import { useHomer } from "@/hooks/useHomer";
import { Header } from "@/components/Header";
import { Roster } from "@/components/Roster";
import { TerminalView } from "@/components/TerminalView";
import { DAGGraph } from "@/components/graph/DAGGraph";
import { ResumeModal } from "@/components/ResumeModal";

export default function App() {
  const homer = useHomer();
  const [selectedId, setSelectedId] = useState(null);
  const [showGraph, setShowGraph] = useState(true);

  // Auto-select first agent, or latest spawned
  const effectiveSelected = useMemo(() => {
    if (selectedId && homer.state.agents.some(a => a.id === selectedId)) return selectedId;
    if (homer.state.agents.length > 0) return homer.state.agents[homer.state.agents.length - 1].id;
    return null;
  }, [selectedId, homer.state.agents]);

  // Auto-select newly spawned agents
  useEffect(() => {
    if (homer.state.agents.length > 0) {
      const latest = homer.state.agents[homer.state.agents.length - 1];
      if (latest.status === "working") setSelectedId(latest.id);
    }
  }, [homer.state.agents.length]);

  const selectedAgent = useMemo(
    () => homer.state.agents.find(a => a.id === effectiveSelected) || null,
    [homer.state.agents, effectiveSelected]
  );

  const handleSelect = useCallback((id) => {
    setSelectedId(id);
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header
        state={homer.state}
        onSpawn={() => homer.spawnAgent()}
        onSetTool={(id) => homer.setTool(id)}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — Team roster */}
        <Roster
          agents={homer.state.agents}
          selectedId={effectiveSelected}
          onSelect={handleSelect}
          onSpawn={() => homer.spawnAgent()}
          files={homer.files}
          verify={homer.verify}
        />

        {/* Main area — Graph + Terminal vertical split */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Graph toggle */}
          <button
            onClick={() => setShowGraph(g => !g)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs text-overlay0 hover:text-text bg-mantle border-b border-surface0 shrink-0 cursor-pointer transition-colors"
          >
            <span className={`transition-transform ${showGraph ? "rotate-90" : ""}`}>&#9656;</span>
            Pipeline Graph
          </button>

          {/* DAG Graph pane */}
          {showGraph && (
            <div className="h-[40%] min-h-[160px] border-b border-surface0 shrink-0">
              <DAGGraph
                agents={homer.state.agents}
                files={homer.files}
                verify={homer.verify}
                milestones={homer.milestones}
                getConflicts={homer.getConflicts}
                reroutes={homer.reroutes}
                onSelectAgent={handleSelect}
              />
            </div>
          )}

          {/* Terminal view */}
          <TerminalView
            agent={selectedAgent}
            output={homer.output.get(effectiveSelected) || ""}
            onOutput={homer.onOutput}
            onSendInput={homer.sendInput}
            onKill={homer.killAgent}
          />
        </div>
      </div>

      {/* Connection indicator */}
      {!homer.connected && (
        <div className="fixed bottom-4 right-4 bg-red/15 text-red border border-red/30 rounded px-3 py-1.5 text-xs">
          Disconnected - reconnecting...
        </div>
      )}

      <ResumeModal data={homer.resumeData} onResume={homer.resumeSession} />
    </div>
  );
}
