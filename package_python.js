const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const spawn = require("child_process").spawn,
  ls = spawn(
    "pyinstaller",
    [
      "-w",
      "--onefile",
      `--add-data web_app/app/templates${path.delimiter}templates`,
      `--add-data web_app/app/static${path.delimiter}static`,
      "--distpath dist-python",
      "web_app/run_app.py",
    ],
    {
      shell: true,
    }
  );

ls.stdout.on("data", function (data) {
  // stream output of build process
  console.log(data.toString());
});

ls.stderr.on("data", function (data) {
  console.log("Packaging error: " + data.toString());
});
ls.on("exit", function (code) {
  console.log("child process exited with code " + code.toString());
  if (code.toString() === "0") {
    // Emit the read-only configuration snapshot using the single parser in
    // web_app/config.py (resolve_config). The packaged Node supervisor reads
    // this file; it is shipped as a build artifact and never written at
    // runtime.
    const resolved = spawnSync("python", [path.join("web_app", "config.py")], {
      encoding: "utf8",
    });
    if (resolved.status !== 0) {
      throw new Error("failed to resolve packaged config: " + resolved.stderr);
    }
    fs.writeFileSync(
      path.join("dist-python", "web_app_config.json"),
      resolved.stdout.trim(),
      { mode: 0o444 }
    );
  }
});
