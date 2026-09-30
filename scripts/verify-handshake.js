"use strict";

const assert = require("assert");
const http = require("http");
const { EventEmitter } = require("events");

const { createSupervisor } = require("../server/supervisor");
const { TRANSITIONS } = require("../server/handshake");

let scenarioIndex = 0;

class FakeChild extends EventEmitter {
  constructor(behavior) {
    super();
    this.behavior = behavior;
    this.pid = 10000 + scenarioIndex * 100;
    this.killed = false;
    this.exitScheduled = null;
    if (behavior.exitAfterMs !== undefined) {
      this.exitScheduled = setTimeout(() => {
        if (!this.killed) {
          this.emit("exit", behavior.exitCode === undefined ? 1 : behavior.exitCode, null);
        }
      }, behavior.exitAfterMs);
    }
  }

  kill(signal) {
    this.killed = true;
    if (this.exitScheduled) clearTimeout(this.exitScheduled);
    if (this.behavior.killExits) {
      this.emit("exit", this.behavior.killExitCode === undefined ? null : this.behavior.killExitCode, signal || "SIGTERM");
    }
  }
}

function fakeHealthServer(initiallyHealthy) {
  let healthy = Boolean(initiallyHealthy);
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" && healthy) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.destroy();
    }
  });
  server.setHealthy = (value) => {
    healthy = Boolean(value);
  };
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function waitForPort(port, state) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const tick = () => {
      http
        .get(`http://127.0.0.1:${port}/state`, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            const parsed = JSON.parse(body);
            if (parsed.state === state || parsed.state === "failed") return resolve(parsed);
            if (Date.now() > deadline) return reject(new Error("state timeout"));
            setTimeout(tick, 20);
          });
        })
        .on("error", () => {
          if (Date.now() > deadline) return reject(new Error("supervisor unreachable"));
          setTimeout(tick, 20);
        });
    };
    tick();
  });
}

function collectSSE(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/timeline`, (res) => {
      let buffer = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("event: state")) {
          req.destroy();
          resolve(buffer);
        }
      });
    });
    req.on("error", () => resolve(buffer));
  });
}

function parseTransitions(raw) {
  return raw
    .split("\n\n")
    .filter((block) => block.startsWith("id:"))
    .map((block) => {
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(dataLine.slice(6));
    });
}

function assertTableOrder(events) {
  for (const entry of events.filter((event) => event.event !== "spawn")) {
    const allowed = TRANSITIONS[entry.from] ? TRANSITIONS[entry.from][entry.event] : undefined;
    assert.strictEqual(
      allowed,
      entry.to,
      `illegal transition ${entry.from} --${entry.event}--> ${entry.to}`
    );
  }
  events.reduce((previous, entry) => {
    if (previous) assert.strictEqual(entry.from, previous.to, "timeline chain broken");
    return entry;
  }, null);
}

async function runScenario(name, fn) {
  scenarioIndex += 1;
  process.stdout.write(`  ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  console.log("verify:handshake");
  const health = await fakeHealthServer(false);
  const healthPort = health.address().port;

  await runScenario("ready via /healthz polling", async () => {
    health.setHealthy(false);
    setTimeout(() => health.setHealthy(true), 150);
    const supervisor = await createSupervisor({
      supervisorPort: 0,
      spawn: () => new FakeChild({}),
      checkPort: null,
      probeHealth: () => probeOnce(healthPort),
      config: { host: "127.0.0.1", port: healthPort, startupTimeoutMs: 4000, pollIntervalMs: 30 },
    });
    const state = await waitForPort(supervisor.supervisorPort, "ready");
    assert.strictEqual(state.state, "ready");
    const events = parseTransitions(await collectSSE(supervisor.supervisorPort));
    assert.deepStrictEqual(events.map((event) => event.event), ["spawn", "healthy"]);
    assertTableOrder(events);
    await supervisor.close();
  });

  await runScenario("duplicate ready is idempotent", async () => {
    health.setHealthy(true);
    const supervisor = await createSupervisor({
      supervisorPort: 0,
      spawn: () => new FakeChild({}),
      checkPort: null,
      probeHealth: async () => true,
      config: { host: "127.0.0.1", port: healthPort, startupTimeoutMs: 4000, pollIntervalMs: 200 },
    });
    await waitForPort(supervisor.supervisorPort, "ready");
    await supervisor.handshake.probe();
    await supervisor.handshake.probe();
    const state = supervisor.handshake.getState();
    assert.strictEqual(state.state, "ready");
    const events = supervisor.handshake.getTimeline();
    assert.strictEqual(events.filter((event) => event.event === "healthy").length, 1);
    const replayed = parseTransitions(await collectSSE(supervisor.supervisorPort));
    assert.strictEqual(replayed.filter((event) => event.event === "healthy").length, 1);
    await supervisor.close();
  });

  await runScenario("startup timeout fails with reason and kills child", async () => {
    health.setHealthy(false);
    let fake = null;
    const supervisor = await createSupervisor({
      supervisorPort: 0,
      spawn: () => (fake = new FakeChild({})),
      checkPort: null,
      probeHealth: () => false,
      config: { host: "127.0.0.1", port: healthPort, startupTimeoutMs: 120, pollIntervalMs: 30 },
    });
    const state = await waitForPort(supervisor.supervisorPort, "failed");
    assert.strictEqual(state.state, "failed");
    assert.strictEqual(state.reason, "startup-timeout");
    assert.ok(fake.killed, "child must be killed on timeout");
    const events = parseTransitions(await collectSSE(supervisor.supervisorPort));
    assert.deepStrictEqual(events.map((event) => event.event), ["spawn", "fail"]);
    assertTableOrder(events);
    await supervisor.close();
  });

  await runScenario("non-zero early exit fails with exit code", async () => {
    health.setHealthy(false);
    const supervisor = await createSupervisor({
      supervisorPort: 0,
      spawn: () => new FakeChild({ exitAfterMs: 40, exitCode: 7 }),
      checkPort: null,
      probeHealth: () => false,
      config: { host: "127.0.0.1", port: healthPort, startupTimeoutMs: 4000, pollIntervalMs: 30 },
    });
    const state = await waitForPort(supervisor.supervisorPort, "failed");
    assert.strictEqual(state.state, "failed");
    assert.strictEqual(state.reason, "nonzero-exit");
    assert.strictEqual(state.exitCode, 7);
    const events = parseTransitions(await collectSSE(supervisor.supervisorPort));
    assert.deepStrictEqual(events.map((event) => event.event), ["spawn", "fail"]);
    assertTableOrder(events);
    await supervisor.close();
  });

  await runScenario("restart allowed exactly once after failure", async () => {
    let attempt = 0;
    let lastChild = null;
    const supervisor = await createSupervisor({
      supervisorPort: 0,
      spawn: () => {
        attempt += 1;
        if (attempt === 1) return (lastChild = new FakeChild({ exitAfterMs: 40, exitCode: 3 }));
        return (lastChild = new FakeChild({}));
      },
      checkPort: null,
      probeHealth: () => attempt >= 2,
      config: { host: "127.0.0.1", port: healthPort, startupTimeoutMs: 4000, pollIntervalMs: 30 },
    });
    await waitForPort(supervisor.supervisorPort, "failed");
    assert.strictEqual(supervisor.handshake.getState().exitCode, 3);
    assert.strictEqual(await supervisor.handshake.restart(), true);
    await waitForPort(supervisor.supervisorPort, "ready");
    assert.strictEqual(supervisor.handshake.getState().state, "ready");
    assert.strictEqual(await supervisor.handshake.restart(), false, "second restart must be rejected");
    const events = parseTransitions(await collectSSE(supervisor.supervisorPort));
    assert.deepStrictEqual(
      events.map((event) => event.event),
      ["spawn", "fail", "restart", "spawn", "healthy"]
    );
    assertTableOrder(events);
    assert.ok(lastChild, "restart must spawn a fresh child");
    await supervisor.close();
  });

  await runScenario("occupied port fails before spawn", async () => {
    health.setHealthy(false);
    const holder = http.createServer();
    await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const blockedPort = holder.address().port;
    const supervisor = await createSupervisor({
      supervisorPort: 0,
      spawn: () => new FakeChild({}),
      probeHealth: () => false,
      config: { host: "127.0.0.1", port: blockedPort, startupTimeoutMs: 4000, pollIntervalMs: 30 },
    });
    const state = await waitForPort(supervisor.supervisorPort, "failed");
    assert.strictEqual(state.reason, "port-in-use");
    const events = parseTransitions(await collectSSE(supervisor.supervisorPort));
    assert.deepStrictEqual(events.map((event) => event.event), ["fail"]);
    assertTableOrder(events);
    await supervisor.close();
    await new Promise((resolve) => holder.close(resolve));
  });
  await new Promise((resolve) => health.close(resolve));
  console.log("all scenarios passed");
}

function probeOnce(port) {
  return new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      })
      .on("error", () => resolve(false));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
