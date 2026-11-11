const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const IMAGE = "localhost/vlc-rec-player-builder:1";
const testStubs = process.argv.includes("--test-stubs");

function run(tool, args) {
  const result = spawnSync(tool, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${tool} ${args[0]} failed with exit code ${result.status}`);
}

function containerTool() {
  for (const tool of ["podman", "docker"]) {
    if (!spawnSync(tool, ["--version"], { stdio: "ignore" }).error) return tool;
  }
  throw new Error("Building the player needs podman or docker.");
}

const tool = containerTool();
run(tool, ["build", "-q", "-t", IMAGE, "-f", "native/Containerfile", "native"]);
run(tool, ["run", "--rm", "-v", `${root}:/src`, "-w", "/src", IMAGE, "sh", testStubs ? "native/build-test-stubs.sh" : "native/build.sh"]);
console.log(testStubs ? "[build-player] Created the Windows and Linux libVLC test stubs" :
  "[build-player] Created player/vlc-rec-player-linux_x64 and player/vlc-rec-player-win_x64.exe");
