"use strict";

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_DIST_FOLDER = "dist-python";
const PY_SRC_FOLDER = "web_app";
const PY_MODULE = "run_app.py";

function projectRoot() {
  return path.resolve(__dirname, "..");
}

function isRunningInBundle(root) {
  const base = root || projectRoot();
  return fs.existsSync(path.join(base, PY_DIST_FOLDER));
}

function getPythonTarget(root) {
  const base = root || projectRoot();
  if (!isRunningInBundle(base)) {
    return { script: path.join(base, PY_SRC_FOLDER, PY_MODULE), bundled: false };
  }
  if (process.platform === "win32") {
    return {
      script: path.join(base, PY_DIST_FOLDER, PY_MODULE.slice(0, -3) + ".exe"),
      bundled: true,
    };
  }
  return { script: path.join(base, PY_DIST_FOLDER, PY_MODULE), bundled: true };
}

function spawnPython(root) {
  const target = getPythonTarget(root);
  if (target.bundled) {
    return execFile(target.script, [], { stdio: ["ignore", "pipe", "pipe"] });
  }
  const command = process.platform === "win32" ? "python" : "python3";
  return spawn(command, [target.script], {
    cwd: path.dirname(target.script),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function killPythonTree(child) {
  if (!child || child.killed || typeof child.pid !== "number") return;
  try {
    require("ps-tree")(child.pid, (err, children) => {
      if (children) {
        children.forEach((entry) => {
          try {
            process.kill(entry.PID);
          } catch (killErr) {
            /* already gone */
          }
        });
      }
      try {
        child.kill();
      } catch (killErr) {
        /* already gone */
      }
    });
  } catch (err) {
    try {
      child.kill();
    } catch (killErr) {
      /* already gone */
    }
  }
}

module.exports = {
  spawnPython,
  killPythonTree,
  getPythonTarget,
  isRunningInBundle,
};
