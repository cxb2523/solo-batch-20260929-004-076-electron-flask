"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const { getPythonTarget, isRunningInBundle } = require("./spawn-python");

const FALLBACK = Object.freeze({
  host: "127.0.0.1",
  port: 4040,
  secret_key: "REPLACE ME",
  startup_timeout_ms: 30000,
  poll_interval_ms: 250,
});

function normalize(raw) {
  return {
    host: String(raw.host),
    port: Number(raw.port),
    secret_key: String(raw.secret_key),
    startupTimeoutMs: Number(raw.startup_timeout_ms),
    pollIntervalMs: Number(raw.poll_interval_ms),
  };
}

function loadConfig(root, env) {
  const environment = env || process.env;
  // Both dev and packaged builds obtain configuration from the exact same
  // Python-side resolve_config(): dev resolves environment variables, the
  // packaged executable reads its read-only bundled config.json.
  const target = getPythonTarget(root);
  const command = target.bundled
    ? target.script
    : process.platform === "win32"
    ? "python"
    : "python3";
  const args = target.bundled ? ["--print-config"] : [target.script, "--print-config"];
  try {
    const output = execFileSync(command, args, {
      cwd: path.dirname(target.script),
      env: environment,
      encoding: "utf-8",
    });
    const parsed = JSON.parse(output.trim().split(/\r?\n/).pop());
    return normalize(Object.assign({}, FALLBACK, parsed));
  } catch (err) {
    return normalize(FALLBACK);
  }
}

module.exports = { loadConfig, normalize, isRunningInBundle };
