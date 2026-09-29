"use strict";

// Throwaway end-to-end check: supervisor + real Flask child + /healthz.
process.env.WEB_APP_PORT = process.env.TEST_PORT;

const { startSupervisor } = require("../server/supervisor");
const { spawnFlaskChild } = require("../server/flask_child");
const http = require("http");

const port = Number(process.env.TEST_PORT);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

(async () => {
  const service = await startSupervisor(spawnFlaskChild, {
    port,
    timeoutMs: 20000,
    pollIntervalMs: 300,
  });
  for (let i = 0; i < 60; i += 1) {
    const state = JSON.parse(
      await getJson(
        `http://${service.host}:${service.port}/state`
      )
    );
    if (state.state === "ready" || state.state === "failed") {
      console.log(JSON.stringify(state));
      if (state.state !== "ready") process.exitCode = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await service.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
