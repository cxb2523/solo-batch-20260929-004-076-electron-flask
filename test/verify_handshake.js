"use strict";

// Acceptance harness for the supervisor handshake split.
// Run with: npm run verify:handshake

const assert = require("assert");
const EventEmitter = require("events");
const http = require("http");
const net = require("net");
const { spawnSync } = require("child_process");

const {
  createHandshake,
  STATES,
  TRANSITIONS,
} = require("../server/handshake");
const { startSupervisor } = require("../server/supervisor");
const nodeConfig = require("../server/config");

let failures = 0;

async function test(name, body) {
  process.stdout.write("  - " + name + " ... ");
  try {
    await body();
    console.log("ok");
  } catch (err) {
    failures += 1;
    console.log("FAILED");
    console.log("    " + (err && err.stack ? err.stack : err));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function startHealthServer(port) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Bind the fake Flask health endpoint a moment after the handshake's own
// preflight has run, mirroring a real child which grabs the port during boot.
function startHealthServerSoon(port, delayMs = 60) {
  return new Promise((resolve) =>
    setTimeout(() => resolve(startHealthServer(port)), delayMs)
  );
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
  }
  kill() {
    this.killed = true;
  }
}

function waitFor(handshake, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let matched = false;
      try {
        matched = predicate(handshake.getState());
      } catch (_err) {}
      if (matched) return resolve(handshake.getState());
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

// Replay the recorded events against the published migration table. Anything
// not allowed by the table (including a state regression) fails the check.
function validateAgainstTable(timeline) {
  let current = null;
  let restarts = 0;
  timeline.forEach((event) => {
    if (current === null) {
      assert.strictEqual(event.from, null, "first event must come from null");
      assert.strictEqual(event.to, STATES.STARTING);
      assert.strictEqual(event.reason, "spawn");
      current = STATES.STARTING;
      return;
    }
    if (event.to === STATES.STARTING) {
      assert.strictEqual(event.reason, "restart");
      assert.strictEqual(event.from, STATES.FAILED);
      assert.strictEqual(current, STATES.FAILED);
      restarts += 1;
      assert.ok(restarts <= 1, "more than one restart");
    } else {
      const allowed = (TRANSITIONS[current] || {})[event.to] || [];
      assert.ok(
        allowed.includes(event.reason),
        "illegal transition " + current + " -> " + event.to +
          " (" + event.reason + ")"
      );
      assert.notStrictEqual(event.to, current, "state must not move backwards");
    }
    current = event.to;
  });
  return current;
}

function httpGet(options) {
  return new Promise((resolve, reject) => {
    const req = http.get(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

async function main() {
  console.log("handshake scenarios");

  await test("scenario 1: readiness only via /healthz polling", async () => {
    const port = await getFreePort();
    const child = new FakeChild();
    const handshake = createHandshake(() => child, {
      port,
      timeoutMs: 3000,
      pollIntervalMs: 40,
    });
    const health = await startHealthServerSoon(port);

    const snap = await waitFor(handshake, (s) => s.state === STATES.READY);
    assert.strictEqual(snap.state, "ready");
    assert.strictEqual(snap.failure, null);

    const reasons = handshake.getTimeline().map((e) => e.reason);
    assert.deepStrictEqual(reasons, ["spawn", "ready"]);
    assert.strictEqual(validateAgainstTable(handshake.getTimeline()), "ready");

    assert.throws(() => handshake.restart(), /cannot restart/);

    handshake.stop();
    await new Promise((resolve) => health.close(resolve));
  });

  await test("scenario 2: duplicate ready is idempotent", async () => {
    const port = await getFreePort();
    const child = new FakeChild();
    const handshake = createHandshake(() => child, {
      port,
      timeoutMs: 3000,
      pollIntervalMs: 40,
    });
    const health = await startHealthServerSoon(port);

    await waitFor(handshake, (s) => s.state === STATES.READY);
    const lengthAtReady = handshake.getTimeline().length;

    await sleep(300);
    assert.strictEqual(handshake.getTimeline().length, lengthAtReady);
    assert.strictEqual(handshake.getState().state, "ready");

    // Listeners were detached at readiness; a later exit cannot regress state.
    assert.strictEqual(child.listenerCount("exit"), 0);
    child.emit("exit", 1, null);
    assert.strictEqual(handshake.getState().state, "ready");

    handshake.stop();
    await new Promise((resolve) => health.close(resolve));
  });

  await test("scenario 3: readiness timeout -> failed with reason", async () => {
    const port = await getFreePort();
    const child = new FakeChild();
    const handshake = createHandshake(() => child, {
      port,
      timeoutMs: 250,
      pollIntervalMs: 60,
    });

    const snap = await waitFor(
      handshake,
      (s) => s.state === STATES.FAILED
    );
    assert.strictEqual(snap.failure.reason, "timeout");
    assert.strictEqual(snap.failure.afterMs, 250);
    assert.strictEqual(child.killed, true, "timed out child should be killed");

    const reasons = handshake.getTimeline().map((e) => e.reason);
    assert.deepStrictEqual(reasons, ["spawn", "timeout"]);
    assert.strictEqual(validateAgainstTable(handshake.getTimeline()), "failed");

    handshake.stop();
  });

  await test("scenario 4: non-zero early exit -> failed with exit code", async () => {
    const port = await getFreePort();
    const child = new FakeChild();
    const handshake = createHandshake(
      () => {
        setTimeout(() => child.emit("exit", 7, null), 80);
        return child;
      },
      { port, timeoutMs: 4000, pollIntervalMs: 50 }
    );

    const snap = await waitFor(
      handshake,
      (s) => s.state === STATES.FAILED
    );
    assert.strictEqual(snap.failure.reason, "nonzero-exit");
    assert.strictEqual(snap.failure.code, 7);

    const reasons = handshake.getTimeline().map((e) => e.reason);
    assert.deepStrictEqual(reasons, ["spawn", "nonzero-exit"]);
    validateAgainstTable(handshake.getTimeline());

    handshake.stop();
  });

  await test("scenario 5: exactly one restart after failure, old listeners off", async () => {
    const port = await getFreePort();
    const first = new FakeChild();
    const second = new FakeChild();
    let which = 0;
    let health = null;

    const handshake = createHandshake(
      () => {
        which += 1;
        if (which === 1) {
          setTimeout(() => first.emit("exit", 7, null), 80);
          return first;
        }
        return second;
      },
      { port, timeoutMs: 4000, pollIntervalMs: 50 }
    );

    await waitFor(handshake, (s) => s.state === STATES.FAILED);
    assert.strictEqual(handshake.getState().failure.code, 7);
    assert.strictEqual(first.listenerCount("exit"), 0);

    handshake.restart();
    health = await startHealthServerSoon(port);

    const snap = await waitFor(handshake, (s) => s.state === STATES.READY);
    assert.strictEqual(snap.attempt, 2);
    assert.strictEqual(snap.restartUsed, true);

    const reasons = handshake.getTimeline().map((e) => e.reason);
    assert.deepStrictEqual(reasons, [
      "spawn",
      "nonzero-exit",
      "restart",
      "ready",
    ]);
    validateAgainstTable(handshake.getTimeline());

    assert.throws(() => handshake.restart(), /already used/);
    assert.strictEqual(first.listenerCount("exit"), 0);
    assert.strictEqual(second.listenerCount("exit"), 0);
    assert.strictEqual(handshake.getState().state, "ready");

    handshake.stop();
    await new Promise((resolve) => health.close(resolve));
  });

  await test("extra: occupied port fails as port-busy", async () => {
    const port = await getFreePort();
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));

    const child = new FakeChild();
    const handshake = createHandshake(() => child, {
      port,
      timeoutMs: 3000,
      pollIntervalMs: 50,
    });
    const snap = await waitFor(
      handshake,
      (s) => s.state === STATES.FAILED
    );
    assert.strictEqual(snap.failure.reason, "port-busy");
    validateAgainstTable(handshake.getTimeline());

    handshake.stop();
    await new Promise((resolve) => blocker.close(resolve));
  });

  console.log("supervisor endpoints");

  await test("/state and /timeline SSE replay match the migration table", async () => {
    const port = await getFreePort();
    const child = new FakeChild();

    const service = await startSupervisor(() => child, {
      port,
      timeoutMs: 3000,
      pollIntervalMs: 40,
    });
    const health = await startHealthServerSoon(port);

    // Open the SSE stream before readiness; stream closes after replay once
    // the machine is terminal.
    const streamDone = new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: service.host,
          port: service.port,
          path: "/timeline",
          headers: { Accept: "text/event-stream" },
        },
        (res) => {
          assert.strictEqual(res.statusCode, 200);
          assert.ok(
            String(res.headers["content-type"]).includes("text/event-stream")
          );
          const events = [];
          let buffer = "";
          res.on("data", (chunk) => {
            buffer += chunk.toString();
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (!block.trim()) continue;
              const dataLine = block
                .split("\n")
                .find((line) => line.startsWith("data: "));
              if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
            }
          });
          res.on("end", () => resolve(events));
        }
      );
      req.on("error", reject);
    });

    const events = await streamDone;
    const reasons = events.map((e) => e.reason);
    assert.deepStrictEqual(reasons, ["spawn", "ready"]);
    assert.deepStrictEqual(
      events.map((e) => e.seq),
      [1, 2],
      "SSE events must replay in migration order"
    );
    assert.strictEqual(validateAgainstTable(events), "ready");

    const stateRes = await httpGet({
      host: service.host,
      port: service.port,
      path: "/state",
    });
    assert.strictEqual(stateRes.statusCode, 200);
    const state = JSON.parse(stateRes.body);
    assert.strictEqual(state.state, "ready");

    await service.close();
    await new Promise((resolve) => health.close(resolve));
  });

  await test("/timeline replay on a terminal failure matches the table", async () => {
    const port = await getFreePort();
    const child = new FakeChild();
    const service = await startSupervisor(
      () => {
        setImmediate(() => child.emit("exit", 3, null));
        return child;
      },
      { port, timeoutMs: 4000, pollIntervalMs: 50 }
    );

    await new Promise((resolve) => setTimeout(resolve, 250));

    const res = await httpGet({
      host: service.host,
      port: service.port,
      path: "/timeline",
    });
    assert.strictEqual(res.statusCode, 200);
    const events = res.body
      .split("\n\n")
      .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepStrictEqual(
      events.map((e) => e.reason),
      ["spawn", "nonzero-exit"]
    );
    assert.strictEqual(events[1].code, 3);
    assert.strictEqual(validateAgainstTable(events), "failed");

    await service.close();
  });

  console.log("single configuration source");

  await test("dev config: environment parsed through config.resolve_config", () => {
    const cfg = nodeConfig.loadConfig({
      packaged: false,
      env: Object.assign({}, process.env, {
        WEB_APP_PORT: "5555",
        WEB_APP_HOST: "127.0.0.1",
      }),
    });
    assert.strictEqual(cfg.port, 5555);
    assert.strictEqual(cfg.host, "127.0.0.1");
  });

  await test("packaged config: read-only snapshot wins, env is ignored", () => {
    const probe = [
      "import config, json, os, tempfile",
      "d = tempfile.mkdtemp()",
      "p = os.path.join(d, config.CONFIG_FILE_NAME)",
      "open(p, 'w', encoding='utf-8').write(json.dumps({'port': 6060, 'host': '10.0.0.2', 'secret_key': 'bundled', 'debug': False}))",
      "cfg = config.resolve_config(packaged=True, config_path=p)",
      "assert cfg['port'] == 6060 and cfg['host'] == '10.0.0.2', cfg",
      "print('snapshot-ok')",
    ].join("\n");
    const result = spawnSync("python", ["-c", probe], {
      encoding: "utf8",
      cwd: require("path").join(__dirname, "..", "web_app"),
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("snapshot-ok"));
  });

  await test("config parser never writes anything back", () => {
    const probe = [
      "import config, os, tempfile",
      "d = tempfile.mkdtemp()",
      "p = os.path.join(d, config.CONFIG_FILE_NAME)",
      "snapshot = '{\"port\": 7070}'",
      "open(p, 'w', encoding='utf-8').write(snapshot)",
      "before = os.path.getmtime(p)",
      "config.resolve_config(packaged=True, config_path=p)",
      "assert os.path.getmtime(p) == before",
      "print('readonly-ok')",
    ].join("\n");
    const result = spawnSync("python", ["-c", probe], {
      encoding: "utf8",
      cwd: require("path").join(__dirname, "..", "web_app"),
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("readonly-ok"));
  });

  console.log("");
  if (failures > 0) {
    console.log(failures + " check(s) failed");
    process.exit(1);
  }
  console.log("verify:handshake passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
