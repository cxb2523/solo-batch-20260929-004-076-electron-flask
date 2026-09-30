"use strict";

const http = require("http");

const { createHandshake } = require("./handshake");
const { loadConfig } = require("./load-config");
const { killPythonTree, spawnPython } = require("./spawn-python");

function createSupervisor(options) {
  const opts = options || {};
  const config = opts.config || loadConfig(opts.root);
  const supervisorPort =
    typeof opts.supervisorPort === "number" ? opts.supervisorPort : 0;
  const spawn = opts.spawn || spawnPython;
  const killChild = opts.killChild || killPythonTree;
  const handshake = createHandshake({
    spawn,
    killChild,
    config,
    checkPort: opts.checkPort,
    probeHealth: opts.probeHealth,
  });

  const clients = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/state" || req.url.startsWith("/state?")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(handshake.getState()));
      return;
    }
    if (req.url === "/timeline" || req.url.startsWith("/timeline?")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (entry) => {
        res.write(`id: ${entry.seq}\nevent: transition\ndata: ${JSON.stringify(entry)}\n\n`);
      };
      handshake.getTimeline().forEach(send); // replay first, in table order
      res.write(`event: state\ndata: ${JSON.stringify(handshake.getState())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not-found" }));
  });

  handshake.subscribe((entry, stateSnapshot) => {
    clients.forEach((client) => {
      client.write(
        `id: ${entry.seq}\nevent: transition\ndata: ${JSON.stringify(entry)}\n\n`
      );
      client.write(`event: state\ndata: ${JSON.stringify(stateSnapshot)}\n\n`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(supervisorPort, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        supervisorPort: address.port,
        backend: { host: config.host, port: config.port },
        handshake,
        close() {
          return new Promise((closeResolve) => {
            clients.forEach((client) => client.end());
            handshake.close();
            server.close(closeResolve);
          });
        },
      });
    });
  });
}

module.exports = { createSupervisor };
