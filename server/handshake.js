"use strict";

const http = require("http");
const net = require("net");

const STATE = Object.freeze({
  STARTING: "starting",
  READY: "ready",
  FAILED: "failed",
});

// The only legal moves. `healthy` while already ready is listed as an allowed
// self-loop, but the engine dedupes it so repeated ready signals are idempotent.
const TRANSITIONS = Object.freeze({
  starting: { healthy: STATE.READY, fail: STATE.FAILED },
  ready: { healthy: STATE.READY, fail: STATE.FAILED },
  failed: { restart: STATE.STARTING },
});

const REASON = Object.freeze({
  EARLY_EXIT: "early-exit",
  NONZERO_EXIT: "nonzero-exit",
  POST_READY_EXIT: "post-ready-exit",
  PORT_IN_USE: "port-in-use",
  PORT_UNAVAILABLE: "port-unavailable",
  STARTUP_TIMEOUT: "startup-timeout",
  SPAWN_ERROR: "spawn-error",
});

const defaultConfig = {
  host: "127.0.0.1",
  port: 4040,
  startupTimeoutMs: 30000,
  pollIntervalMs: 250,
};

function httpHealthProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/healthz", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function defaultPortCheck(host, port) {
  return new Promise((resolve) => {
    const socket = net.createServer();
    socket.once("error", (err) => {
      if (err.code === "EADDRINUSE") return resolve(REASON.PORT_IN_USE);
      return resolve(REASON.PORT_UNAVAILABLE);
    });
    socket.listen(port, host, () => socket.close(() => resolve(null)));
  });
}

function createHandshake(options) {
  const opts = options || {};
  if (typeof opts.spawn !== "function") {
    throw new Error("createHandshake requires a spawn factory");
  }
  const spawnChild = opts.spawn;
  const cfg = Object.assign({}, defaultConfig, opts.config || {});
  const probeHealth =
    typeof opts.probeHealth === "function"
      ? () => opts.probeHealth(cfg)
      : () => httpHealthProbe(cfg.host, cfg.port, Math.max(50, cfg.pollIntervalMs - 50));
  const checkPortFree =
    opts.checkPort === null
      ? null
      : typeof opts.checkPort === "function"
      ? opts.checkPort
      : defaultPortCheck;
  const killChildFn =
    typeof opts.killChild === "function" ? opts.killChild : (child) => child.kill();

  let state = STATE.STARTING;
  let closed = false;
  let initializing = false;
  let child = null;
  let attempt = 0;
  let restarts = 0;
  let failure = null;
  let pollTimer = null;
  let deadlineTimer = null;
  let childToken = 0;
  let seq = 0;
  const timeline = [];
  const listeners = new Set();
  const bound = {
    exit: null,
    error: null,
  };

  function append(event, extra) {
    const target = TRANSITIONS[state] ? TRANSITIONS[state][event] : undefined;
    if (target === undefined) return false;
    if (target === state) return false; // idempotent self-loop, no state regression
    const entry = Object.assign(
      {
        seq: (seq += 1),
        event,
        from: state,
        to: target,
        attempt,
        at: Date.now(),
      },
      extra || {}
    );
    state = target;
    timeline.push(entry);
    listeners.forEach((fn) => {
      try {
        fn(entry, snapshot());
      } catch (err) {
        /* listeners never break the state machine */
      }
    });
    return true;
  }

  function snapshot() {
    return {
      state,
      attempt,
      restarts,
      host: cfg.host,
      port: cfg.port,
      reason: failure ? failure.reason : null,
      exitCode: failure ? failure.exitCode : null,
      signal: failure ? failure.signal : null,
      pid: child && typeof child.pid === "number" ? child.pid : null,
      closed,
    };
  }

  function clearTimers() {
    if (pollTimer) clearInterval(pollTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    pollTimer = null;
    deadlineTimer = null;
  }

  function detachChildListeners() {
    if (child && bound.exit) child.removeListener("exit", bound.exit);
    if (child && bound.error) child.removeListener("error", bound.error);
    bound.exit = null;
    bound.error = null;
  }

  function fail(reason, extra) {
    if (state === STATE.FAILED || closed) return false;
    failure = Object.assign({ reason }, extra || {});
    clearTimers();
    const moved = append("fail", { reason, ...(extra || {}) });
    detachChildListeners();
    if (child && (reason === REASON.STARTUP_TIMEOUT || reason === REASON.SPAWN_ERROR)) {
      try {
        killChildFn(child);
      } catch (err) {
        /* best effort */
      }
    }
    return moved;
  }

  async function becomeReady() {
    if (state !== STATE.STARTING || closed) return state === STATE.READY;
    const healthy = await probeHealth();
    if (state !== STATE.STARTING || closed) return state === STATE.READY;
    if (!healthy) return false;
    clearTimers();
    append("healthy");
    return true;
  }

  function onChildExit(token, code, signal) {
    if (token !== childToken) return;
    if (state === STATE.FAILED || closed) return;
    if (state === STATE.READY) {
      fail(REASON.POST_READY_EXIT, { exitCode: code, signal });
      return;
    }
    fail(code === 0 ? REASON.EARLY_EXIT : REASON.NONZERO_EXIT, {
      exitCode: code,
      signal,
    });
  }

  function launch() {
    const spawnEntry = {
      seq: (seq += 1),
      event: "spawn",
      from: timeline.length ? state : null,
      to: STATE.STARTING,
      attempt,
      at: Date.now(),
    };
    timeline.push(spawnEntry);

    try {
      child = spawnChild();
    } catch (err) {
      fail(REASON.SPAWN_ERROR, { message: err && err.message ? err.message : String(err) });
      return;
    }
    if (!child || typeof child.on !== "function") {
      fail(REASON.SPAWN_ERROR, { message: "factory did not return a child process" });
      return;
    }

    const token = ++childToken;
    bound.exit = (code, signal) => onChildExit(token, code, signal);
    bound.error = () => {
      if (token === childToken) fail(REASON.SPAWN_ERROR);
    };
    child.on("exit", bound.exit);
    child.on("error", bound.error);

    deadlineTimer = setTimeout(() => {
      fail(REASON.STARTUP_TIMEOUT, { timeoutMs: cfg.startupTimeoutMs });
    }, cfg.startupTimeoutMs);
    pollTimer = setInterval(() => {
      if (state === STATE.STARTING) becomeReady();
    }, cfg.pollIntervalMs);
    becomeReady();
  }

  async function start() {
    if (closed || initializing || timeline.length > 0 || state !== STATE.STARTING) {
      return snapshot();
    }
    initializing = true;
    attempt = 1;
    if (checkPortFree) {
      try {
        const blocked = await checkPortFree(cfg.host, cfg.port);
        if (blocked && state === STATE.STARTING && !closed) {
          fail(blocked);
          return snapshot();
        }
      } catch (err) {
        if (state === STATE.STARTING && !closed) {
          fail(REASON.PORT_UNAVAILABLE, {
            message: err && err.message ? err.message : String(err),
          });
          return snapshot();
        }
      }
    }
    if (state === STATE.STARTING && !closed) launch();
    return snapshot();
  }

  async function restart() {
    if (state !== STATE.FAILED || restarts >= 1) return false;
    detachChildListeners(); // old listeners must be unbound before anything else
    if (child) {
      try {
        killChildFn(child);
      } catch (err) {
        /* best effort */
      }
    }
    restarts += 1;
    attempt += 1;
    childToken += 1; // invalidate any listeners that remain on the old child
    failure = null;
    append("restart");
    if (checkPortFree) {
      try {
        const blocked = await checkPortFree(cfg.host, cfg.port);
        if (blocked && state === STATE.STARTING && !closed) {
          fail(blocked);
          return true;
        }
      } catch (err) {
        if (state === STATE.STARTING && !closed) {
          fail(REASON.PORT_UNAVAILABLE, {
            message: err && err.message ? err.message : String(err),
          });
          return true;
        }
      }
    }
    if (state === STATE.STARTING && !closed) launch();
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimers();
    detachChildListeners();
    if (child) {
      try {
        killChildFn(child);
      } catch (err) {
        /* best effort */
      }
    }
  }

  start();

  return {
    STATE,
    start: () => start(),
    restart,
    probe: becomeReady,
    getState: snapshot,
    getTimeline: () => timeline.slice(),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close,
  };
}

module.exports = {
  createHandshake,
  TRANSITIONS,
  STATE,
  REASON,
};
