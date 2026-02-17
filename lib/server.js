/**
 * Homer Web Server — Bun.serve() with WebSocket + static files.
 *
 * API:
 *   GET  /api/state          Full state snapshot
 *   POST /api/agent/spawn    { tool?, issue? }
 *   POST /api/agent/:id/input  { data }
 *   POST /api/agent/:id/kill
 *   POST /api/tool           { id }
 *   POST /api/session/resume { resume: bool }
 *   WS   /ws                 Real-time event stream
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getLearningMetrics, memoryStats } from "./memory.js";

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

export function startServer(engine, opts = {}) {
  const port = opts.port || 3457;
  const distDir = join(import.meta.dir, "web", "dist");
  const webDir = existsSync(distDir) ? distDir : join(import.meta.dir, "web");
  const clients = new Set();

  // Relay all engine events to WebSocket clients
  const relay = (type, data) => {
    const msg = JSON.stringify({ type, ...data, ts: Date.now() });
    for (const ws of clients) {
      try { ws.send(msg); } catch {}
    }
  };

  for (const ev of [
    "agent:spawned", "agent:output", "agent:status", "agent:done",
    "agent:rerouted", "verify:start", "verify:result", "state",
    "session:found", "error",
  ]) {
    engine.on(ev, (data) => relay(ev, data || {}));
  }

  // API handler
  function handleAPI(url, req) {
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/state" && method === "GET") {
      return json(engine.getState());
    }

    if (path === "/api/agent/spawn" && method === "POST") {
      return readBody(req).then(body => {
        if (body.tool) engine.setTool(body.tool);
        const agent = engine.spawnAgent(body.issue || null);
        return json({ ok: !!agent, id: agent?.id });
      });
    }

    if (path.match(/^\/api\/agent\/[^/]+\/input$/) && method === "POST") {
      const id = path.split("/")[3];
      return readBody(req).then(body => {
        engine.sendInput(id, body.data || "");
        return json({ ok: true });
      });
    }

    if (path.match(/^\/api\/agent\/[^/]+\/output$/) && method === "GET") {
      const id = path.split("/")[3];
      const agent = engine.agents.find(a => a.id === id);
      const buf = agent?.outputBuffer || "";
      return new Response(buf, {
        headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (path.match(/^\/api\/agent\/[^/]+\/resize$/) && method === "POST") {
      const id = path.split("/")[3];
      return readBody(req).then(body => {
        const agent = engine.agents.find(a => a.id === id);
        if (agent?.pty?.resize) {
          agent.pty.resize(body.cols || 80, body.rows || 24);
        }
        return json({ ok: true });
      });
    }

    if (path.match(/^\/api\/agent\/[^/]+\/kill$/) && method === "POST") {
      const id = path.split("/")[3];
      engine.killAgent(id);
      return json({ ok: true });
    }

    if (path === "/api/tool" && method === "POST") {
      return readBody(req).then(body => {
        engine.setTool(body.id);
        return json({ ok: true });
      });
    }

    if (path === "/api/session/resume" && method === "POST") {
      return readBody(req).then(body => {
        engine.resumeFound(body.resume === true);
        return json({ ok: true });
      });
    }

    if (path === "/api/memory" && method === "GET") {
      const metrics = getLearningMetrics();
      const stats = memoryStats();
      return json({ ok: true, metrics, stats });
    }

    return json({ error: "Not found" }, 404);
  }

  // Static file handler
  function serveStatic(pathname) {
    if (pathname === "/") pathname = "/index.html";
    const filePath = join(webDir, pathname);

    if (!existsSync(filePath)) return null;

    try {
      const content = readFileSync(filePath);
      const ext = pathname.substring(pathname.lastIndexOf("."));
      return new Response(content, {
        headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
      });
    } catch {
      return null;
    }
  }

  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // API
      if (url.pathname.startsWith("/api/")) {
        return handleAPI(url, req);
      }

      // Static files
      const staticResp = serveStatic(url.pathname);
      if (staticResp) return staticResp;

      // SPA fallback — serve index.html for non-file paths
      const indexResp = serveStatic("/index.html");
      if (indexResp) return indexResp;

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        // Send initial state
        try { ws.send(JSON.stringify({ type: "state", ...engine.getState(), ts: Date.now() })); } catch {}
      },
      close(ws) { clients.delete(ws); },
      message(ws, msg) {
        // Handle WebSocket commands (optional — clients can use REST too)
        try {
          const cmd = JSON.parse(msg);
          if (cmd.type === "input" && cmd.id) engine.sendInput(cmd.id, cmd.data || "");
          if (cmd.type === "spawn") engine.spawnAgent(cmd.issue || null);
          if (cmd.type === "kill" && cmd.id) engine.killAgent(cmd.id);
        } catch {}
      },
    },
  });

  return { server, port, url: `http://localhost:${port}` };
}
