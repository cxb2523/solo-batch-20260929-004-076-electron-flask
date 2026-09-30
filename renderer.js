"use strict";

const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");

const { createSupervisor } = require("./server/supervisor");

let mainWindow = null;
let supervisor = null;

function createMainWindow(backend) {
  const host = backend.host === "0.0.0.0" ? "127.0.0.1" : backend.host;
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    icon: path.join(__dirname, "icon.png"),
    resizeable: true,
  });
  mainWindow.loadURL(`http://${host}:${backend.port}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", async () => {
  supervisor = await createSupervisor({ root: __dirname });
  const initial = supervisor.handshake.getState();
  if (initial.state === "ready") {
    createMainWindow(supervisor.backend);
    return;
  }
  if (initial.state === "failed") {
    dialog.showErrorBox(
      "Backend failed to start",
      `reason: ${initial.reason || "unknown"}`
    );
    return;
  }
  supervisor.handshake.subscribe((entry, snapshotState) => {
    if (mainWindow && snapshotState.state === "ready") return;
    if (snapshotState.state === "ready" && !mainWindow) {
      createMainWindow(supervisor.backend);
    } else if (snapshotState.state === "failed" && !mainWindow) {
      dialog.showErrorBox(
        "Backend failed to start",
        `reason: ${snapshotState.reason || "unknown"}`
      );
    }
  });
});

app.on("browser-window-created", (event, window) => {
  window.setMenu(null);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    const done = supervisor ? supervisor.close() : Promise.resolve();
    done.finally(() => app.quit());
  }
});

app.on("activate", () => {
  if (mainWindow === null && supervisor) {
    const current = supervisor.handshake.getState();
    if (current.state === "ready") createMainWindow(supervisor.backend);
  }
});

app.on("before-quit", () => {
  if (supervisor) supervisor.close();
});
