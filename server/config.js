"use strict";

// Single configuration source for the Node side: web_app/config.py.
//
// * dev mode       - runs `python config.py` which emits the resolved config
//                     (defaults + environment variables) through
//                     resolve_config
// * packaged mode  - reads the read-only JSON snapshot shipped with the
//                     bundled Flask executable; the snapshot is produced at
//                     packaging time by the same resolve_config function
//
// This module never writes configuration anywhere.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const CONFIG_FILE_NAME = "web_app_config.json";
const PY_SOURCE_FOLDER = "web_app";
const PY_DIST_FOLDER = "dist-python";

function isPackaged() {
  return fs.existsSync(path.join(__dirname, "..", PY_DIST_FOLDER));
}

function packagedConfigPath() {
  // Written by package_python.js next to the bundled Flask executable.
  return path.join(__dirname, "..", PY_DIST_FOLDER, CONFIG_FILE_NAME);
}

function devConfigPath() {
  return path.join(__dirname, "..", PY_SOURCE_FOLDER, "config.py");
}

function readPackagedConfig() {
  const raw = fs.readFileSync(packagedConfigPath(), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("packaged configuration must be a JSON object");
  }
  return parsed;
}

function readDevConfig(env) {
  const python = process.env.PYTHON || "python";
  const result = spawnSync(python, [devConfigPath()], {
    encoding: "utf8",
    env: env || process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      "failed to resolve config via config.py: " + (result.stderr || result.error)
    );
  }
  return JSON.parse(result.stdout.trim());
}

function loadConfig(options = {}) {
  const packaged =
    options.packaged != null ? options.packaged : isPackaged();
  return packaged ? readPackagedConfig() : readDevConfig(options.env);
}

module.exports = {
  loadConfig,
  isPackaged,
  packagedConfigPath,
};
