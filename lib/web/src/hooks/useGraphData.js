import { useMemo, useRef, useCallback } from "react";
import dagre from "@dagrejs/dagre";

// ── Node dimensions for dagre layout ──
const NODE_W = { task: 180, agent: 200, fileop: 140, verify: 90, outcome: 80 };
const NODE_H = { task: 60, agent: 100, fileop: 50, verify: 50, outcome: 40 };
const RANK_SEP = 60;
const NODE_SEP = 20;

function layoutGraph(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", ranksep: RANK_SEP, nodesep: NODE_SEP, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    const w = NODE_W[n.type] || 140;
    const h = NODE_H[n.type] || 50;
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map(n => {
    const pos = g.node(n.id);
    const w = NODE_W[n.type] || 140;
    const h = NODE_H[n.type] || 50;
    return {
      ...n,
      position: { x: (pos?.x || 0) - w / 2, y: (pos?.y || 0) - h / 2 },
    };
  });
}

// Group files by directory for blast radius visualization
function groupByDir(fileMap) {
  const dirs = new Map(); // dir → [{ path, count }]
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
    const taskMap = new Map();

    for (const agent of agents) {
      const taskKey = agent.task?.key;
      const taskId = taskKey ? `task-${taskKey}` : `task-${agent.id}`;

      // ── Task node ──
      if (!taskMap.has(taskId)) {
        taskMap.set(taskId, true);
        nodes.push({
          id: taskId,
          type: "task",
          data: {
            label: agent.task?.title || "Interactive",
            taskKey,
            taskType: agent.task?.type,
          },
        });
      }

      // ── Agent node ──
      const agentNodeId = `agent-${agent.id}`;
      const agentFiles = files.get(agent.id);
      const agentVerify = verify.get(agent.id) || [];
      const agentMilestones = milestones.get(agent.id) || [];
      const conflicts = getConflicts(agent.id);

      nodes.push({
        id: agentNodeId,
        type: "agent",
        data: {
          agent,
          fileCount: agentFiles?.size || 0,
          verifyCount: agentVerify.length,
        },
      });
      edges.push({
        id: `e-${taskId}-${agentNodeId}`,
        source: taskId,
        target: agentNodeId,
        type: "smoothstep",
        animated: agent.status === "working",
        style: { stroke: "#585b70", strokeWidth: 1.5 },
      });

      // ── File operation nodes — group by directory for blast radius ──
      let lastNodeId = agentNodeId;

      if (agentFiles && agentFiles.size > 0) {
        const dirGroups = groupByDir(agentFiles);

        for (const [dir, dirFiles] of dirGroups) {
          const dirNodeId = `fileop-${agent.id}-${dir}`;
          const hasConflict = dirFiles.some(f => conflicts.has(f.path));
          nodes.push({
            id: dirNodeId,
            type: "fileop",
            data: {
              dir,
              files: dirFiles,
              hasConflict,
              totalOps: dirFiles.reduce((s, f) => s + f.count, 0),
            },
          });
          edges.push({
            id: `e-${lastNodeId}-${dirNodeId}`,
            source: agentNodeId, // all file groups connect from agent
            target: dirNodeId,
            type: "smoothstep",
            animated: agent.status === "working",
            style: {
              stroke: hasConflict ? "#fab387" : "#585b70",
              strokeWidth: hasConflict ? 2 : 1.5,
              ...(hasConflict ? { strokeDasharray: "4 2" } : {}),
            },
          });
          lastNodeId = dirNodeId;
        }
      }

      // ── Verify nodes — show each attempt ──
      if (agentVerify.length > 0) {
        const verifyNodeId = `verify-${agent.id}`;
        const latest = agentVerify[agentVerify.length - 1];
        const passCount = agentVerify.filter(v => v.passed).length;
        const failCount = agentVerify.length - passCount;

        nodes.push({
          id: verifyNodeId,
          type: "verify",
          data: {
            attempts: agentVerify,
            latest,
            passCount,
            failCount,
          },
        });

        // Connect from last file group (or agent if no files)
        const verifySource = agentFiles?.size > 0
          ? `fileop-${agent.id}-${[...groupByDir(agentFiles).keys()].pop()}`
          : agentNodeId;
        edges.push({
          id: `e-${verifySource}-${verifyNodeId}`,
          source: verifySource,
          target: verifyNodeId,
          type: "smoothstep",
          style: {
            stroke: latest.passed ? "#a6e3a1" : "#f38ba8",
            strokeWidth: 2,
          },
        });
        lastNodeId = verifyNodeId;
      }

      // ── Outcome node ──
      if (agent.status === "done" || agent.status === "failed") {
        const outcomeId = `outcome-${agent.id}`;
        nodes.push({
          id: outcomeId,
          type: "outcome",
          data: { status: agent.status },
        });
        edges.push({
          id: `e-${lastNodeId}-${outcomeId}`,
          source: lastNodeId,
          target: outcomeId,
          type: "smoothstep",
          style: {
            stroke: agent.status === "done" ? "#a6e3a1" : "#f38ba8",
            strokeWidth: 2,
          },
        });
      }
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

    // ── Conflict edges between file groups across agents ──
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
            if (!conflictPairs.has(pair)) {
              conflictPairs.add(pair);
              // Find which dir group this file belongs to
              const dir1 = fp.split("/").slice(0, -1).join("/") || ".";
              const dir2 = dir1;
              edges.push({
                id: `e-conflict-${pair}-${fp}`,
                source: `fileop-${agent.id}-${dir1}`,
                target: `fileop-${other.id}-${dir2}`,
                type: "smoothstep",
                style: { stroke: "#fab387", strokeWidth: 3, strokeDasharray: "4 2" },
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
