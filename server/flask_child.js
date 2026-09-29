"use strict";

// Owns construction of the Flask child process. The returned ChildProcess is
// handed straight to createHandshake and never stored elsewhere, so the
// desktop main process cannot reach the handle.

const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

const PY_DIST_FOLDER = "dist-python";
const PY_SRC_FOLDER = "web_app";
const PY_MODULE = "run_app.py";

function isRunningInBundle() {
  return fs.existsSync(path.join(__dirname, "..", PY_DIST_FOLDER));
}

function getPythonScriptPath() {
  if (!isRunningInBundle()) {
    return path.join(__dirname, "..", PY_SRC_FOLDER, PY_MODULE);
  }
  if (process.platform === "win32") {
    return path.join(
      __dirname,
      "..",
      PY_DIST_FOLDER,
      PY_MODULE.slice(0, -3) + ".exe"
    );
  }
  return path.join(__dirname, "..", PY_DIST_FOLDER, PY_MODULE);
}

// A factory, not a handle: createHandshake calls this for both the initial
// spawn and the single permitted restart.
function spawnFlaskChild() {
  const script = getPythonScriptPath();
  if (isRunningInBundle()) {
    return execFile(script, [], {
      env: Object.assign({}, process.env),
      windowsHide: true,
    });
  }
  const python = process.env.PYTHON || "python";
  return spawn(python, [script], {
    env: Object.assign({}, process.env),
    windowsHide: true,
  });
}

module.exports = {
  spawnFlaskChild,
  getPythonScriptPath,
  isRunningInBundle,
};
