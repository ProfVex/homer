import { useState, useEffect, useRef, useCallback } from "react";
import { stripAnsi, extractFilePaths } from "@/lib/utils";

const BUFFER_MAX = 256 * 1024;

// ── WebSocket hook — single source of truth for all Homer state ──
export function useHomer() {
  const [state, setState] = useState({
    agents: [], tools: [], activeTool: null,
    repo: "", prd: null, memory: null, auto: false, issues: 0,
  });
  const [connected, setConnected] = useState(false);
  const [resumeData, setResumeData] = useState(null);

  // Derived state — survives across state events
  const milestonesRef = useRef(new Map());    // id → [{type, text, ts}]
  const filesRef = useRef(new Map());         // id → Map<path, count>
  const filesSeenRef = useRef(new Map());     // id → Set<path>
  const verifyRef = useRef(new Map());        // id → [{attempt, passed, results}]
  const outputRef = useRef(new Map());        // id → string (kept for file extraction)
  const reroutesRef = useRef([]);             // [{oldId, newId, task, reason}]
  const [tick, setTick] = useState(0);        // force re-render on derived state change

  // Raw output subscribers — for xterm.js to receive chunks as they arrive
  const outputListenersRef = useRef(new Map()); // id → Set<callback>

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);

  const bump = useCallback(() => setTick(t => t + 1), []);

  const pushMilestone = useCallback((id, type, text) => {
    const ms = milestonesRef.current;
    if (!ms.has(id)) ms.set(id, []);
    ms.get(id).push({ type, text, ts: Date.now() });
    bump();
  }, [bump]);

  // Subscribe to raw output chunks for an agent
  const onOutput = useCallback((id, callback) => {
    const listeners = outputListenersRef.current;
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(callback);
    return () => { listeners.get(id)?.delete(callback); };
  }, []);

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectRef.current = setTimeout(connect, 2000);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case "state":
          setState({
            agents: msg.agents || [],
            tools: msg.tools || [],
            activeTool: msg.activeTool || null,
            repo: msg.repo || "",
            prd: msg.prd || null,
            memory: msg.memory || null,
            auto: msg.auto || false,
            issues: msg.issues || 0,
          });
          break;

        case "agent:spawned": {
          const id = msg.id;
          milestonesRef.current.set(id, [{ type: "started", text: "Started working", ts: Date.now() }]);
          filesRef.current.set(id, new Map());
          filesSeenRef.current.set(id, new Set());
          verifyRef.current.set(id, []);
          outputRef.current.set(id, "");
          bump();
          break;
        }

        case "agent:output": {
          const id = msg.id;
          const data = msg.data || "";

          // Buffer for file extraction (keep existing behavior)
          const buf = outputRef.current;
          let current = (buf.get(id) || "") + data;
          if (current.length > BUFFER_MAX) current = current.slice(-BUFFER_MAX * 0.5);
          buf.set(id, current);

          // Notify raw output subscribers (xterm.js)
          const listeners = outputListenersRef.current.get(id);
          if (listeners) {
            for (const cb of listeners) {
              try { cb(data); } catch {}
            }
          }

          // Extract file paths
          const clean = stripAnsi(data);
          const fps = extractFilePaths(clean);
          const seen = filesSeenRef.current.get(id);
          const fileMap = filesRef.current.get(id);
          if (seen && fileMap) {
            for (const fp of fps) {
              fileMap.set(fp, (fileMap.get(fp) || 0) + 1);
              if (!seen.has(fp)) {
                seen.add(fp);
                pushMilestone(id, "file", `Touched ${fp}`);
              }
            }
          }
          bump();
          break;
        }

        case "verify:start":
          pushMilestone(msg.id, "verify-start", `Verification #${(verifyRef.current.get(msg.id)?.length || 0) + 1} started`);
          break;

        case "verify:result": {
          const v = verifyRef.current;
          if (!v.has(msg.id)) v.set(msg.id, []);
          v.get(msg.id).push({
            attempt: msg.attempt,
            passed: msg.passed,
            results: msg.results || [],
          });
          const label = msg.passed ? "PASSED" : "FAILED";
          const failNames = msg.passed ? "" : `: ${(msg.results || []).map(r => r.name).join(", ")}`;
          pushMilestone(msg.id, msg.passed ? "verify-pass" : "verify-fail",
            `Verification #${msg.attempt} ${label}${failNames}`);
          break;
        }

        case "agent:done":
          pushMilestone(msg.id, "done", "Completed");
          break;

        case "agent:rerouted":
          pushMilestone(msg.oldId, "rerouted", `Rerouted to ${msg.newId}`);
          reroutesRef.current.push({ oldId: msg.oldId, newId: msg.newId, task: msg.task, reason: msg.reason });
          bump();
          break;

        case "agent:status":
          if (["blocked", "failed", "exited"].includes(msg.status)) {
            pushMilestone(msg.id, msg.status, `Status: ${msg.status}`);
          }
          break;

        case "session:found":
          setResumeData(msg);
          break;

        case "error":
          console.error("[Homer]", msg.message);
          break;
      }
    };
  }, [bump, pushMilestone]);

  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); };
  }, [connect]);

  // ── API calls ──
  const api = useCallback(async (path, body) => {
    const opts = body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {};
    const res = await fetch(`/api${path}`, opts);
    return res.json();
  }, []);

  const spawnAgent = useCallback((issue) => api("/agent/spawn", { issue }), [api]);
  const killAgent = useCallback((id) => api(`/agent/${id}/kill`, {}), [api]);
  const sendInput = useCallback((id, data) => api(`/agent/${id}/input`, { data }), [api]);
  const setTool = useCallback((id) => api("/tool", { id }), [api]);
  const resumeSession = useCallback((resume) => {
    setResumeData(null);
    return api("/session/resume", { resume });
  }, [api]);

  // ── Memory metrics ──
  const [memoryData, setMemoryData] = useState(null);

  const fetchMemory = useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      const data = await res.json();
      if (data.ok) setMemoryData(data);
    } catch {}
  }, []);

  // Fetch memory on connect and periodically
  useEffect(() => {
    if (!connected) return;
    fetchMemory();
    const interval = setInterval(fetchMemory, 30000);
    return () => clearInterval(interval);
  }, [connected, fetchMemory]);

  // ── Conflict detection ──
  const getConflicts = useCallback((agentId) => {
    const myFiles = filesRef.current.get(agentId);
    if (!myFiles) return new Set();
    const conflicts = new Set();
    const active = state.agents.filter(a =>
      a.id !== agentId && (a.status === "working" || a.status === "verifying")
    );
    for (const other of active) {
      const otherFiles = filesRef.current.get(other.id);
      if (!otherFiles) continue;
      for (const fp of myFiles.keys()) {
        if (otherFiles.has(fp)) conflicts.add(fp);
      }
    }
    return conflicts;
  }, [state.agents]);

  return {
    state, connected, resumeData, tick,
    milestones: milestonesRef.current,
    files: filesRef.current,
    verify: verifyRef.current,
    output: outputRef.current,
    reroutes: reroutesRef.current,
    memoryData,
    onOutput,
    spawnAgent, killAgent, sendInput, setTool, resumeSession, getConflicts, fetchMemory,
  };
}
