import { useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useGraphData } from "@/hooks/useGraphData";
import { TaskNode } from "./TaskNode";
import { AgentNode } from "./AgentNode";
import { FileOpNode } from "./FileOpNode";
import { VerifyNode } from "./VerifyNode";
import { OutcomeNode } from "./OutcomeNode";

const nodeTypes = {
  task: TaskNode,
  agent: AgentNode,
  fileop: FileOpNode,
  verify: VerifyNode,
  outcome: OutcomeNode,
};

const defaultEdgeOptions = {
  type: "smoothstep",
  style: { stroke: "#585b70", strokeWidth: 1.5 },
};

const proOptions = { hideAttribution: true };

function DAGGraphInner({ agents, files, verify, milestones, getConflicts, reroutes, onSelectAgent }) {
  const { nodes: graphNodes, edges: graphEdges } = useGraphData({
    agents, files, verify, milestones, getConflicts, reroutes,
  });

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { fitView } = useReactFlow();

  // Update nodes/edges when graph data changes
  useEffect(() => {
    setNodes(graphNodes);
    setEdges(graphEdges);
    // Fit view after a short delay to let layout settle
    const timer = setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 100);
    return () => clearTimeout(timer);
  }, [graphNodes, graphEdges, setNodes, setEdges, fitView]);

  const onNodeClick = useCallback((_, node) => {
    if (node.type === "agent" && node.data?.agent?.id) {
      onSelectAgent(node.data.agent.id);
    }
  }, [onSelectAgent]);

  const isEmpty = agents.length === 0;

  if (isEmpty) {
    return (
      <div className="flex-1 flex items-center justify-center bg-base">
        <div className="text-center">
          <div className="text-3xl mb-2 opacity-30">&#9672;</div>
          <div className="text-overlay0 text-sm">No agents running</div>
          <div className="text-surface2 text-xs mt-1">Spawn an agent to see the pipeline graph</div>
        </div>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      nodeTypes={nodeTypes}
      defaultEdgeOptions={defaultEdgeOptions}
      proOptions={proOptions}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.3}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      className="bg-base"
    >
      <Background color="#313244" gap={24} size={1} />
      <Controls
        showInteractive={false}
        className="!bg-mantle !border-surface0 !shadow-lg [&>button]:!bg-mantle [&>button]:!border-surface0 [&>button]:!text-subtext0 [&>button:hover]:!bg-surface0"
      />
      <MiniMap
        nodeColor={(n) => {
          if (n.type === "task") return "#b4befe";
          if (n.type === "agent") {
            const s = n.data?.agent?.status;
            if (s === "done") return "#a6e3a1";
            if (s === "failed" || s === "blocked") return "#f38ba8";
            if (s === "verifying") return "#f9e2af";
            return "#89b4fa";
          }
          if (n.type === "outcome") return n.data?.status === "done" ? "#a6e3a1" : "#f38ba8";
          return "#585b70";
        }}
        maskColor="rgba(17, 17, 27, 0.8)"
        className="!bg-mantle !border-surface0"
        pannable
        zoomable
      />
    </ReactFlow>
  );
}

// Wrapper to provide ReactFlowProvider context
import { ReactFlowProvider } from "@xyflow/react";

export function DAGGraph(props) {
  return (
    <ReactFlowProvider>
      <DAGGraphInner {...props} />
    </ReactFlowProvider>
  );
}
