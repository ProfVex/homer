import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, File, Folder } from "lucide-react";

/**
 * Build a tree structure from flat file paths.
 * Input: Map<agentId, Map<filePath, count>>
 * Output: nested tree with agent ownership
 */
function buildTree(filesMap) {
  const tree = {};
  const fileAgents = new Map(); // path → Set<agentId>

  for (const [agentId, paths] of filesMap) {
    if (!paths) continue;
    for (const [fp] of paths) {
      if (!fileAgents.has(fp)) fileAgents.set(fp, new Set());
      fileAgents.get(fp).add(agentId);

      const parts = fp.split("/");
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          // File leaf
          if (!node[part]) node[part] = { _file: true, _path: fp, _agents: [] };
          if (node[part]._file) {
            node[part]._agents = [...(fileAgents.get(fp) || [])];
          }
        } else {
          // Directory
          if (!node[part]) node[part] = {};
          if (node[part]._file) node[part] = {}; // overwrite file with dir
          node = node[part];
        }
      }
    }
  }
  return tree;
}

function TreeNode({ name, node, depth = 0, conflicts }) {
  const [open, setOpen] = useState(depth < 2);

  if (node._file) {
    const isConflict = node._agents.length > 1;
    const agentColors = ["text-blue", "text-green", "text-yellow", "text-mauve", "text-peach"];
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 px-1 rounded text-[11px] hover:bg-surface0/30 transition-colors",
          isConflict && "bg-peach/5",
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <File size={12} className={cn("shrink-0", isConflict ? "text-peach" : "text-overlay0")} />
        <span className={cn("truncate", isConflict ? "text-peach font-medium" : "text-subtext0")}>
          {name}
        </span>
        {node._agents.length > 0 && (
          <div className="flex gap-0.5 ml-auto shrink-0">
            {node._agents.map((aid, i) => {
              const num = parseInt(aid.split("-")[1] || "0", 10);
              return (
                <span
                  key={aid}
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    agentColors[(num - 1) % agentColors.length],
                    "bg-current",
                  )}
                  title={aid}
                />
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Directory
  const entries = Object.entries(node).filter(([k]) => !k.startsWith("_")).sort(([a, av], [b, bv]) => {
    const aDir = !av._file;
    const bDir = !bv._file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.localeCompare(b);
  });

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 py-0.5 px-1 rounded text-[11px] text-subtext1 hover:bg-surface0/30 transition-colors w-full text-left cursor-pointer"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <ChevronRight
          size={10}
          className={cn("shrink-0 text-surface2 transition-transform", open && "rotate-90")}
        />
        <Folder size={12} className="shrink-0 text-lavender/60" />
        <span className="font-medium">{name}</span>
        <span className="text-surface2 text-[9px] ml-1">({entries.length})</span>
      </button>
      {open && entries.map(([childName, childNode]) => (
        <TreeNode
          key={childName}
          name={childName}
          node={childNode}
          depth={depth + 1}
          conflicts={conflicts}
        />
      ))}
    </div>
  );
}

export function RepoTree({ files, getConflicts }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const entries = Object.entries(tree).sort(([a, av], [b, bv]) => {
    const aDir = !av._file;
    const bDir = !bv._file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.localeCompare(b);
  });

  const totalFiles = useMemo(() => {
    let count = 0;
    for (const [, paths] of files) { count += paths?.size || 0; }
    return count;
  }, [files]);

  if (entries.length === 0) {
    return (
      <div className="text-center text-overlay0/50 text-[10px] py-4 italic">
        No files touched yet
      </div>
    );
  }

  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-3 py-1.5 mb-1">
        <span className="text-[10px] uppercase tracking-widest text-overlay0/70 font-medium">Files</span>
        <span className="text-[10px] text-surface2">{totalFiles} touched</span>
      </div>
      <div className="overflow-y-auto max-h-48 px-1">
        {entries.map(([name, node]) => (
          <TreeNode key={name} name={name} node={node} depth={0} />
        ))}
      </div>
    </div>
  );
}
