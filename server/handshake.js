"use strict";

// All lifecycle ownership of the backend child process lives in this module.
// The child handle never leaves `createHandshake`; callers only receive the
// state/timeline API described at the bottom of the file.
//
// Readiness is decided exclusively by polling the child's HTTP /healthz
// endpoint. stdout/stderr are never inspected.

const http = require("http");
const net = require("net");

// Default `kill()` only terminates the immediate child; on Windows the Flask
// app can survive it, leaking the process and the port. Force termination is
// used as the guaranteed cleanup path.
function terminateChild(childProcess) {
  if (!childProcess || childProcess.exitCode != null) return;
  if (process.platform === "win32" && childProcess.pid) {
    try {
      require("child_process").spawn(
        "taskkill",
        ["/pid", String(childProcess.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" }
      );
      return;
    } catch (_err) {
      // fall through to plain kill
    }
  }
  try {
    childProcess.kill();
  } catch (_err) {}
}

const STATES = Object.freeze({
  STARTING: "starting",
  READY: "ready",
  FAILED: "failed",
});

// The single state machine. Every transition must be listed here; anything
// not present in the table is a no-op, so a state can never move backwards
// (ready -> failed/starting and failed -> ready are intentionally absent).
const TRANSITIONS = Object.freeze({
  [STATES.STARTING]: Object.freeze({
    [STATES.READY]: Object.freeze(["ready"]),
    [STATES.FAILED]: Object.freeze([
      "early-exit",
      "nonzero-exit",
      "timeout",
      "port-busy",
      "spawn-error",
    ]),
  }),
  [STATES.READY]: Object.freeze({}),
  [STATES.FAILED]: Object.freeze({
    [STATES.STARTING]: Object.freeze(["restart"]),
  }),
});

const FAILURE_REASONS = TRANSITIONS[STATES.STARTING][STATES.FAILED];

function createHandshake(spawnChild, options = {}) {
  const host = options.host || "127.0.0.1";
  const port = options.port;
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : 30000;
  const pollIntervalMs =
    options.pollIntervalMs != null ? options.pollIntervalMs : 200;

  if (typeof spawnChild !== "function") {
    throw new TypeError("createHandshake: spawnChild must be a function");
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new TypeError("createHandshake: options.port is required");
  }

  let state = null;
  let attempt = 0;
  let restartUsed = false;
  let stopped = false;
  let lastFailure = null;
  let child = null;
  let bindings = null;
  const timeline = [];
  const subscribers = new Set();

  function publish(event) {
    const stored = Object.assign(
      { seq: timeline.length + 1, at: new Date().toISOString() },
      event
    );
    timeline.push(stored);
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber(stored);
      } catch (_err) {
        // a faulty subscriber must not break the state machine
      }
    }
    return stored;
  }

  // Apply a transition only if the table allows it. Returns the event when a
  // transition happened, otherwise null (e.g. a duplicate ready poll).
  function transition(to, detail = {}) {
    if (stopped) return null;
    const allowed = (TRANSITIONS[state] || {})[to];
    const reason = detail.reason || (to === STATES.READY ? "ready" : null);
    if (!allowed || (reason != null && !allowed.includes(reason))) {
      return null;
    }
    const from = state;
    state = to;
    if (to === STATES.FAILED) {
      lastFailure = {
        reason: detail.reason,
        code: detail.code,
        signal: detail.signal,
        afterMs: detail.afterMs,
      };
    }
    const event = publish(
      Object.assign(
        { type: reason, from, to },
        detail.reason != null ? { reason: detail.reason } : {},
        detail.code != null ? { code: detail.code } : {},
        detail.signal != null ? { signal: detail.signal } : {},
        detail.afterMs != null ? { afterMs: detail.afterMs } : {}
      )
    );
    return event;
  }

  function detachBindings() {
    if (!bindings) return;
    const current = bindings;
    bindings = null;
    if (current.deadlineTimer) clearTimeout(current.deadlineTimer);
    if (current.pollTimer) clearTimeout(current.pollTimer);
    if (current.request) {
      try {
        current.request.destroy();
      } catch (_err) {}
    }
    if (current.child && current.exitHandler) {
      current.child.removeListener("exit", current.exitHandler);
    }
  }

  function fail(detail) {
    // Detach first so the kill we trigger cannot re-enter the state machine.
    const currentChild = child;
    if (transition(STATES.FAILED, detail)) {
      detachBindings();
      terminateChild(currentChild);
    }
  }

  function probePort(listeningHandler, busyHandler) {
    const probe = net.createServer();
    probe.once("error", (err) => {
      if (err.code === "EADDRINUSE") busyHandler();
      else busyHandler();
    });
    probe.listen(port, host, () => {
      probe.close(() => listeningHandler());
    });
  }

  function healthProbe(done) {
    const req = http.get(
      {
        host,
        port,
        path: "/healthz",
        headers: { Connection: "close" },
        timeout: Math.max(50, pollIntervalMs),
      },
      (res) => {
        const status = res.statusCode;
        res.resume();
        res.on("end", () => done(status === 200));
      }
    );
    if (bindings) bindings.request = req;
    req.on("timeout", () => req.destroy(new Error("probe-timeout")));
    req.on("error", () => done(false));
  }

  function schedulePoll() {
    if (!bindings || state !== STATES.STARTING) return;
    bindings.pollTimer = setTimeout(() => {
      if (!bindings || state !== STATES.STARTING) return;
      healthProbe((healthy) => {
        if (!bindings || state !== STATES.STARTING) return;
        if (healthy) {
          markReady();
        } else {
          schedulePoll();
        }
      });
    }, pollIntervalMs);
  }

  function markReady() {
    if (transition(STATES.READY, { reason: "ready" })) {
      // Readiness is terminal for this attempt: release every listener and
      // timer so a later (duplicate) poll or child exit cannot change state.
      detachBindings();
    }
  }

  function beginAttempt() {
    attempt += 1;
    // Initial entry is the only place the machine leaves the implicit null
    // state; it is recorded explicitly (no table row for null).
    state = STATES.STARTING;
    publish({ type: "spawn", from: null, to: STATES.STARTING, reason: "spawn" });

    probePort(
      () => spawnAndWatch(),
      () => fail({ reason: "port-busy" })
    );
  }

  function spawnAndWatch() {
    if (stopped || state !== STATES.STARTING) return;
    let spawned;
    try {
      spawned = spawnChild();
    } catch (err) {
      fail({ reason: "spawn-error" });
      return;
    }
    if (!spawned || typeof spawned.on !== "function") {
      fail({ reason: "spawn-error" });
      return;
    }
    child = spawned;

    const exitHandler = (code, signal) => {
      if (!bindings || bindings.child !== child) return;
      if (state !== STATES.STARTING) return;
      if (code === 0 && signal == null) {
        fail({ reason: "early-exit", code: code == null ? null : code });
      } else {
        fail({
          reason: "nonzero-exit",
          code: code == null ? null : code,
          signal: signal == null ? null : signal,
        });
      }
    };
    child.on("exit", exitHandler);

    const deadlineTimer = setTimeout(() => {
      fail({ reason: "timeout", afterMs: timeoutMs });
    }, timeoutMs);

    bindings = {
      child,
      exitHandler,
      deadlineTimer,
      pollTimer: null,
      request: null,
    };
    schedulePoll();
  }

  function restart() {
    if (stopped) {
      throw new Error("handshake: cannot restart after stop");
    }
    if (restartUsed) {
      // Exactly one restart is permitted; state must not move.
      throw new Error("handshake: restart already used");
    }
    if (state !== STATES.FAILED) {
      throw new Error(`handshake: cannot restart from state "${state}"`);
    }
    restartUsed = true;
    // Old listeners/timers are released before anything else is spawned.
    detachBindings();
    terminateChild(child);
    child = null;
    transition(STATES.STARTING, { reason: "restart" });
    attempt += 1;
    probePort(
      () => spawnAndWatch(),
      () => fail({ reason: "port-busy" })
    );
  }

  function stop() {
    stopped = true;
    const currentChild = child;
    detachBindings();
    terminateChild(currentChild);
    child = null;
  }

  function getState() {
    return {
      state,
      attempt,
      restartUsed,
      host,
      port,
      failure: lastFailure,
    };
  }

  function getTimeline() {
    return timeline.map((event) => Object.assign({}, event));
  }

  function subscribe(handler) {
    subscribers.add(handler);
    return () => subscribers.delete(handler);
  }

  beginAttempt();

  return {
    STATES,
    restart,
    stop,
    getState,
    getTimeline,
    subscribe,
  };
}

module.exports = {
  createHandshake,
  STATES,
  TRANSITIONS,
  FAILURE_REASONS,
};
