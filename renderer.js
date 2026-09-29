"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("path");

// The backend lifecycle lives entirely in the resident supervisor service.
// The desktop main process never holds the Flask child process handle.
const { startSupervisor } = require("./server/supervisor");
const { spawnFlaskChild } = require("./server/flask_child");
const { loadConfig } = require("./server/config");

let mainWindow = null;
let service = null;
let backendConfig = null;

const startBackendSupervisor = () => {
  backendConfig = loadConfig();
  return startSupervisor(spawnFlaskChild, {
    host: "127.0.0.1",
    port: backendConfig.port,
    timeoutMs: 30000,
    pollIntervalMs: 300,
  }).then((started) => {
    service = started;
  });
};

const stopBackendSupervisor = () => {
  if (!service) return Promise.resolve();
  const current = service;
  service = null;
  return current.close();
};

const createMainWindow = () => {
  // Create the browser mainWindow
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    // transparent: true, // transparent header bar
    icon: __dirname + "/icon.png",
    // fullscreen: true,
    // opacity:0.8,
    // darkTheme: true,
    // frame: false,
    resizeable: true,
  });

  // Open the DevTools.
  //mainWindow.webContents.openDevTools();

  // Emitted when the mainWindow is closed.
  mainWindow.on("closed", function () {
    // Dereference the mainWindow object
    mainWindow = null;
  });

  const backendUrl =
    "http://127.0.0.1:" + (backendConfig ? backendConfig.port : 4040) + "/";
  mainWindow.loadURL(backendUrl);
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", function () {
  // Start the resident supervisor, which spawns and handshakes the backend.
  startBackendSupervisor().then(() => {
    createMainWindow();
  });
});

// disable menu
app.on("browser-window-created", function (e, window) {
  window.setMenu(null);
});

// Quit when all windows are closed.
app.on("window-all-closed", () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== "darwin") {
    stopBackendSupervisor().then(() => {
      app.quit();
    });
  }
});

app.on("activate", () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (service == null) {
    startBackendSupervisor();
  }
  if (mainWindow === null) {
    createMainWindow();
  }
});

app.on("quit", function () {
  // do some additional cleanup
});
