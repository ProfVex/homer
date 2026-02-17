import { useState, useMemo, useCallback, useEffect } from "react";
import { useHomer } from "@/hooks/useHomer";
import { Header } from "@/components/Header";
import { Roster } from "@/components/Roster";
import { RepoTree } from "@/components/RepoTree";
import { DAGGraph } from "@/components/graph/DAGGraph";
import { TerminalView } from "@/components/TerminalView";
import { MemoryPanel } from "@/components/MemoryPanel";
import { ResumeModal } from "@/components/ResumeModal";

export default function App() {
  const homer = useHomer();
  const [selectedId, setSelectedId] = useState(null);

  // Auto-select latest working agent
  const effectiveSelected = useMemo(() => {
    if (selectedId && homer.state.agents.some(a => a.id === selectedId)) return selectedId;
    if (homer.state.agents.length > 0) return homer.state.agents[homer.state.agents.length - 1].id;
    return null;
  }, [selectedId, homer.state.agents]);

  // Auto-select newly spawned
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

  const handleSelect = useCallback((id) => setSelectedId(id), []);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-base">
      <Header
        state={homer.state}
        onSpawn={() => homer.spawnAgent()}
        onSetTool={(id) => homer.setTool(id)}
      />

      <div className="flex flex-1 overflow-hidden p-2 gap-2">
        {/* Left sidebar — Team + Repo tree */}
        <div className="flex flex-col w-64 shrink-0 gap-2 overflow-hidden">
          <div className="flex-1 overflow-hidden rounded-2xl bg-mantle/60 border border-surface0/15">
            <Roster
              agents={homer.state.agents}
              selectedId={effectiveSelected}
              onSelect={handleSelect}
              onSpawn={() => homer.spawnAgent()}
              files={homer.files}
              verify={homer.verify}
            />
          </div>
          <div className="rounded-2xl bg-mantle/60 border border-surface0/15 overflow-hidden shrink-0">
            <RepoTree files={homer.files} getConflicts={homer.getConflicts} />
          </div>
          {homer.memoryData && (
            <div className="rounded-2xl bg-mantle/60 border border-surface0/15 overflow-hidden shrink-0 max-h-[300px]">
              <MemoryPanel memory={homer.memoryData} onRefresh={homer.fetchMemory} />
            </div>
          )}
        </div>

        {/* Center — DAG Graph (hero) */}
        <div className="flex-1 overflow-hidden rounded-2xl bg-crust/40 border border-surface0/15">
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

        {/* Right — Terminal output for selected agent */}
        <div className="flex-1 min-w-[500px] flex flex-col overflow-hidden rounded-2xl bg-crust/40 border border-surface0/15">
          <TerminalView
            agent={selectedAgent}
            onOutput={homer.onOutput}
            onSendInput={homer.sendInput}
            onKill={homer.killAgent}
          />
        </div>
      </div>

      {/* Connection pill */}
      {!homer.connected && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red/10 text-red border border-red/20 rounded-full px-4 py-1.5 text-xs backdrop-blur-sm shadow-lg">
          Disconnected - reconnecting...
        </div>
      )}

      <ResumeModal data={homer.resumeData} onResume={homer.resumeSession} />
    </div>
  );
}
