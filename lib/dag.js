/**
 * DAG builder + ASCII renderer for issue dependency graphs.
 *
 * Renders a vertical flow diagram using Unicode box-drawing characters:
 *   ✓ #1 DB Schema
 *   │
 *   ● #3 Auth Backend ◀ agent-1
 *   ├───┐
 *   ○ #5 ○ #6
 */

import { getDeps } from "./github.js";

const SYM = {
  done: "\u2713",      // ✓
  working: "\u25CF",   // ●
  ready: "\u25CB",     // ○
  failed: "\u2715",    // ✕
  blocked: "\u25CC",   // ◌
};

/**
 * Build adjacency list from issues.
 * Returns { nodes: Map<number, issue>, edges: Map<number, number[]> }
 * where edges[parent] = [child1, child2] means child depends on parent.
 */
export function buildGraph(issues) {
  const nodes = new Map();
  const children = new Map(); // parent → [children that depend on it]

  for (const issue of issues) {
    nodes.set(issue.number, issue);
    children.set(issue.number, []);
  }

  for (const issue of issues) {
    const deps = getDeps(issue);
    for (const dep of deps) {
      if (children.has(dep)) {
        children.get(dep).push(issue.number);
      }
    }
  }

  return { nodes, children };
}

/**
 * Topological sort (Kahn's algorithm).
 * Returns layers: [[root issues], [next level], ...]
 */
export function topoLayers(issues) {
  const { nodes, children } = buildGraph(issues);
  const inDegree = new Map();

  for (const issue of issues) {
    const deps = getDeps(issue);
    inDegree.set(issue.number, deps.filter((d) => nodes.has(d)).length);
  }

  const layers = [];
  const visited = new Set();

  while (visited.size < nodes.size) {
    // Find all nodes with in-degree 0 (not yet visited)
    const layer = [];
    for (const [num, deg] of inDegree) {
      if (!visited.has(num) && deg === 0) layer.push(num);
    }

    if (layer.length === 0) {
      // Circular deps — add remaining
      for (const num of nodes.keys()) {
        if (!visited.has(num)) layer.push(num);
      }
    }

    layer.sort((a, b) => a - b);
    layers.push(layer);

    for (const num of layer) {
      visited.add(num);
      for (const child of children.get(num) || []) {
        inDegree.set(child, (inDegree.get(child) || 1) - 1);
      }
    }
  }

  return { layers, nodes, children };
}

/**
 * Get the status symbol and color code for an issue.
 * Returns { sym, color } where color is a 256-color code.
 */
function issueStyle(issue, prefix, agentIssues) {
  const names = (issue.labels || []).map((l) => l.name);
  if (names.includes(`${prefix}:in-progress`)) {
    const agentId = agentIssues.get(issue.number);
    return { sym: SYM.working, color: 220, agentId }; // amber
  }
  if (names.includes(`${prefix}:failed`)) return { sym: SYM.failed, color: 167 };
  if (names.includes(`${prefix}:done`) || issue.state === "CLOSED")
    return { sym: SYM.done, color: 242 };
  if (names.includes(`${prefix}:blocked`)) return { sym: SYM.blocked, color: 167 };
  if (names.includes(`${prefix}:ready`)) return { sym: SYM.ready, color: 114 };
  return { sym: SYM.ready, color: 244 };
}

function c(code, text) {
  return `{${code}-fg}${text}{/}`;
}

/**
 * Render the DAG as a string for a blessed box.
 *
 * @param {Array} issues - All issues
 * @param {string} prefix - Label prefix
 * @param {Map<number,string>} agentIssues - Map of issue number → agent name
 * @param {number} width - Available width in characters
 * @returns {string} Rendered DAG
 */
export function renderDAG(issues, prefix = "homer", agentIssues = new Map(), width = 28) {
  if (issues.length === 0) return "  {245-fg}No issues{/}";

  const { layers, nodes, children } = topoLayers(issues);
  const lines = [];
  const maxTitle = Math.max(6, width - 12); // leave room for sym + #num + padding

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];

    // Draw connector lines from previous layer
    if (li > 0) {
      if (layer.length === 1) {
        lines.push("  {237-fg}\u2502{/}"); // │
      } else {
        // Multiple nodes: fan-out
        let connector = "  {237-fg}\u251C";  // ├
        for (let i = 1; i < layer.length; i++) {
          connector += "\u2500\u2500\u2500";   // ───
          connector += i < layer.length - 1 ? "\u252C" : "\u2510"; // ┬ or ┐
        }
        connector += "{/}";
        lines.push(connector);
      }
    }

    // Draw nodes in this layer
    const nodeParts = [];
    for (const num of layer) {
      const issue = nodes.get(num);
      const { sym, color, agentId } = issueStyle(issue, prefix, agentIssues);
      let title = (issue.title || "").slice(0, maxTitle);
      let node = `  ${c(color, sym)} ${c(color, `#${num}`)} {245-fg}${title}{/}`;
      if (agentId) node += ` {237-fg}\u25C0 ${agentId}{/}`; // ◀ agent
      nodeParts.push(node);
    }

    // If multiple nodes in layer, show them side-by-side or stacked
    if (nodeParts.length <= 2 && width < 40) {
      // Stack vertically for narrow sidebar
      for (const part of nodeParts) lines.push(part);
    } else {
      for (const part of nodeParts) lines.push(part);
    }
  }

  return lines.join("\n");
}
