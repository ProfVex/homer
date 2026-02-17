import { useMemo, useCallback } from "react";
import dagre from "@dagrejs/dagre";

// ── Node dimensions for dagre layout ──
const NODE_W = { task: 180, agent: 260 };
const NODE_H = { task: 70, agent: 120 };
const RANK_SEP = 70;
const NODE_SEP = 25;

// Status → edge style
const EDGE_STYLES = {
  working:   { stroke: "#89b4fa", strokeWidth: 2 },
  verifying: { stroke: "#f9e2af", strokeWidth: 2 },
  done:      { stroke: "#a6e3a1", strokeWidth: 2 },
  failed:    { stroke: "#f38ba8", strokeWidth: 2 },
  blocked:   { stroke: "#fab387", strokeWidth: 1.5 },
  rerouted:  { stroke: "#585b70", strokeWidth: 1.5 },
  exited:    { stroke: "#585b70", strokeWidth: 1.5 },
  killed:    { stroke: "#585b70", strokeWidth: 1.5 },
};

function layoutGraph(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", ranksep: RANK_SEP, nodesep: NODE_SEP, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    const w = NODE_W[n.type] || 180;
    const h = n._h || NODE_H[n.type] || 60;
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map(n => {
    const pos = g.node(n.id);
    const w = NODE_W[n.type] || 180;
    const h = n._h || NODE_H[n.type] || 60;
    return {
      ...n,
      position: { x: (pos?.x || 0) - w / 2, y: (pos?.y || 0) - h / 2 },
    };
  });
}

// Group files by directory
function groupByDir(fileMap) {
  const dirs = new Map();
  for (const [fp, count] of fileMap.entries()) {
    const parts = fp.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push({ path: fp, name: parts[parts.length - 1], count });
  }
  return dirs;
}

// ── Build React Flow nodes & edges from Homer state ──
export function useGraphData({ agents, files, verify, milestones, getConflicts, reroutes }) {
  const build = useCallback(() => {
    const nodes = [];
    const edges = [];
    const taskStats = new Map(); // taskId → { agentCount, doneCount, key, title, type }

    // First pass: gather per-task agent stats
    for (const agent of agents) {
      const taskKey = agent.task?.key;
      const taskId = taskKey ? `task-${taskKey}` : `task-${agent.id}`;
      if (!taskStats.has(taskId)) {
        taskStats.set(taskId, {
          agentCount: 0, doneCount: 0,
          key: taskKey, title: agent.task?.title, type: agent.task?.type,
        });
      }
      const t = taskStats.get(taskId);
      t.agentCount++;
      if (agent.status === "done") t.doneCount++;
    }

    // Second pass: create nodes & edges
    const createdTasks = new Set();

    for (const agent of agents) {
      const taskKey = agent.task?.key;
      const taskId = taskKey ? `task-${taskKey}` : `task-${agent.id}`;

      // ── Task node ──
      if (!createdTasks.has(taskId)) {
        createdTasks.add(taskId);
        const t = taskStats.get(taskId);
        nodes.push({
          id: taskId,
          type: "task",
          data: {
            label: t.title || "Interactive",
            taskKey: t.key,
            taskType: t.type,
            agentCount: t.agentCount,
            doneCount: t.doneCount,
          },
        });
      }

      // ── Agent node (consolidated) ──
      const agentNodeId = `agent-${agent.id}`;
      const agentFiles = files.get(agent.id);
      const agentVerify = verify.get(agent.id) || [];
      const conflicts = getConflicts(agent.id);

      // Group files by directory
      const dirGroups = agentFiles && agentFiles.size > 0 ? groupByDir(agentFiles) : new Map();

      // Extract latest error from failed verify results
      const latestVerify = agentVerify.length > 0 ? agentVerify[agentVerify.length - 1] : null;
      let latestError = null;
      if (latestVerify && !latestVerify.passed && latestVerify.results?.length > 0) {
        const failedNames = latestVerify.results.map(r => r.name).join(", ");
        const firstOutput = latestVerify.results[0]?.output?.split("\n")[0] || "";
        latestError = firstOutput || failedNames;
      }

      // Calculate dynamic height for dagre layout
      const isActive = agent.status === "working" || agent.status === "verifying";
      let h = 68; // base: status bar + header + role line
      if (dirGroups.size > 0) {
        h += 8 + Math.min(dirGroups.size, 3) * 18;
        if (dirGroups.size > 3) h += 14;
      }
      if (agentVerify.length > 0) {
        h += 8 + 22;
        if (latestError) h += 16;
      }
      if (isActive) h += 4;

      nodes.push({
        id: agentNodeId,
        type: "agent",
        _h: h,
        data: {
          agent,
          dirGroups,
          verify: agentVerify,
          conflicts,
          latestError,
          fileCount: agentFiles?.size || 0,
        },
      });

      // ── Edge: Task → Agent (status-colored) ──
      const style = EDGE_STYLES[agent.status] || EDGE_STYLES.working;
      const isAnimated = agent.status === "working" || agent.status === "verifying";
      edges.push({
        id: `e-${taskId}-${agentNodeId}`,
        source: taskId,
        target: agentNodeId,
        type: "smoothstep",
        animated: isAnimated,
        style: {
          ...style,
          ...(agent.status === "blocked" ? { strokeDasharray: "6 3" } : {}),
        },
      });
    }

    // ── Reroute edges ──
    for (const r of reroutes) {
      edges.push({
        id: `e-reroute-${r.oldId}-${r.newId}`,
        source: `agent-${r.oldId}`,
        target: `agent-${r.newId}`,
        type: "smoothstep",
        animated: true,
        style: { stroke: "#f38ba8", strokeWidth: 2, strokeDasharray: "6 3" },
        label: "rerouted",
        labelStyle: { fill: "#f38ba8", fontSize: 10 },
      });
    }

    // ── Conflict edges between agent nodes ──
    const conflictPairs = new Set();
    for (const agent of agents) {
      const myConflicts = getConflicts(agent.id);
      if (myConflicts.size === 0) continue;
      for (const other of agents) {
        if (other.id === agent.id) continue;
        const otherFiles = files.get(other.id);
        if (!otherFiles) continue;
        for (const fp of myConflicts) {
          if (otherFiles.has(fp)) {
            const pair = [agent.id, other.id].sort().join("-");
            const pairKey = `${pair}-${fp}`;
            if (!conflictPairs.has(pairKey)) {
              conflictPairs.add(pairKey);
              edges.push({
                id: `e-conflict-${pairKey}`,
                source: `agent-${agent.id}`,
                target: `agent-${other.id}`,
                type: "smoothstep",
                style: { stroke: "#fab387", strokeWidth: 2, strokeDasharray: "4 2" },
                label: fp.split("/").pop(),
                labelStyle: { fill: "#fab387", fontSize: 9 },
              });
            }
          }
        }
      }
    }

    const positioned = layoutGraph(nodes, edges);
    return { nodes: positioned, edges };
  }, [agents, files, verify, milestones, getConflicts, reroutes]);

  return useMemo(() => build(), [build]);
}
