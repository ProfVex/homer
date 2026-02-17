export function ResumeModal({ data, onResume }) {
  if (!data) return null;

  const agentCount = data.agents?.length || 0;

  return (
    <div className="fixed inset-0 bg-crust/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-mantle border border-surface0 rounded-lg p-6 max-w-sm w-full mx-4 shadow-2xl">
        <h3 className="text-lavender font-medium mb-3">&#9670; Resume Session?</h3>
        <p className="text-subtext0 text-xs mb-4">
          Found a previous session with {agentCount} agent{agentCount !== 1 ? "s" : ""}.
          Resume where you left off?
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => onResume(true)}
            className="flex-1 bg-lavender/15 text-lavender border border-lavender/30 rounded px-3 py-2 text-xs hover:bg-lavender/25 transition-colors cursor-pointer"
          >
            Resume
          </button>
          <button
            onClick={() => onResume(false)}
            className="flex-1 bg-surface0 text-subtext0 border border-surface1 rounded px-3 py-2 text-xs hover:bg-surface1 transition-colors cursor-pointer"
          >
            Start Fresh
          </button>
        </div>
      </div>
    </div>
  );
}
