"use strict";

// Long-lived supervisor process. It owns the handshake state machine for one
// backend child and exposes:
//
//   GET /state    - current snapshot
//   GET /timeline - text/event-stream; replays every transition that already
//                   happened and then keeps streaming new ones
//
// The child process handle never escapes handshake.js; this layer only speaks
// HTTP/JSON to the outside.

const http = require("http");

const { createHandshake, STATES } = require("./handshake");

function startSupervisor(spawnChild, options = {}) {
  const stateListeners = new Set();

  const handshake = createHandshake(spawnChild, options);

  handshake.subscribe((event) => {
    for (const listener of Array.from(stateListeners)) {
      try {
        listener(event);
      } catch (_err) {
        // ignore faulty SSE connections
      }
    }
  });

  function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function handleState(res) {
    sendJson(res, 200, handshake.getState());
  }

  function handleTimeline(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 0\n\n");

    const writeEvent = (event) => {
      res.write(`id: ${event.seq}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay the migration history first, in table order.
    for (const event of handshake.getTimeline()) {
      writeEvent(event);
    }

    // Terminal states (ready/failed) never produce more transitions, so the
    // stream can be closed after replay rather than hanging forever.
    const current = handshake.getState().state;
    if (current === STATES.READY || current === STATES.FAILED) {
      res.end();
      return;
    }

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      stateListeners.delete(writeEvent);
    };
    stateListeners.add((event) => {
      writeEvent(event);
      // Terminal states never produce further transitions; close the stream
      // once the last migration event has been delivered.
      if (event.to === STATES.READY || event.to === STATES.FAILED) {
        cleanup();
        res.end();
      }
    });
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    if (url === "/state") {
      handleState(res);
      return;
    }
    if (url === "/timeline") {
      handleTimeline(req, res);
      return;
    }
    sendJson(res, 404, { error: "not-found" });
  });

  let resolveListening;
  const listening = new Promise((resolve) => {
    resolveListening = resolve;
  });

  server.listen(options.supervisorPort || 0, options.supervisorHost || "127.0.0.1", () => {
    const address = server.address();
    resolveListening({
      host: address.address,
      port: address.port,
      close: () =>
        new Promise((resolve) => {
          handshake.stop();
          server.close(() => resolve());
        }),
      handshake,
    });
  });

  return listening;
}

module.exports = { startSupervisor };
