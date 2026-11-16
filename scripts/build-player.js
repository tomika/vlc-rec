const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { findMsvc, compileMsvc } = require("./windows-compiler");

const root = path.resolve(__dirname, "..");
const IMAGE = "localhost/vlc-rec-player-builder:1";
const testStubs = process.argv.includes("--test-stubs");

function run(tool, args) {
  const result = spawnSync(tool, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${tool} ${args[0]} failed with exit code ${result.status}`);
}

function containerTool() {
  for (const tool of ["podman", "docker"]) {
    if (!spawnSync(tool, ["--version"], { stdio: "ignore" }).error) return tool;
  }
  throw new Error("Building the player needs podman or docker.");
}

const msvc = findMsvc();
console.log(`[build-player] Windows compiler: ${msvc ? "MSVC x64" : "MinGW-w64 (container)"}`);
const tool = containerTool();
run(tool, ["build", "-q", "-t", IMAGE, "-f", "native/Containerfile", "native"]);
run(tool, ["run", "--rm", "-e", `VLC_REC_NATIVE_TARGET=${msvc ? "linux" : "all"}`, "-v", `${root}:/src`, "-w", "/src", IMAGE, "sh", testStubs ? "native/build-test-stubs.sh" : "native/build.sh"]);
if (msvc) {
  if (testStubs) {
    compileMsvc(msvc, { sources: [path.join(root, "tests/fixtures/libvlc-stub.c")],
      output: path.join(root, "tests/fixtures/stub/win/libvlc.dll"), shared: true });
  } else {
    compileMsvc(msvc, { sources: [path.join(root, "native/vlc-rec-player.c")],
      output: path.join(root, "player/vlc-rec-player-win_x64.exe"), libraries: ["advapi32.lib", "gdi32.lib", "user32.lib"] });
    for (const id of fs.readFileSync(path.join(root, "packaging/public-plugins.txt"), "utf8").split(/\r?\n/).filter(Boolean)) {
      if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`Invalid public plugin id: ${id}`);
      compileMsvc(msvc, { sources: [path.join(root, `plugins/${id}/${id}.c`)],
        output: path.join(root, `player/plugins/${id}/${id}-win_x64.exe`), libraries: ["ws2_32.lib"] });
    }
  }
}
console.log(testStubs ? "[build-player] Created the Windows and Linux libVLC test stubs" :
  "[build-player] Created player/vlc-rec-player-linux_x64 and player/vlc-rec-player-win_x64.exe");
