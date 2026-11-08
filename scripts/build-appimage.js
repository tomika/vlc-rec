const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const IMAGE = "localhost/vlc-rec-appimage-builder:1";
const NEEDED = ["dist/vlc-rec/vlc-rec-linux_x64", "player/vlc-rec-player-linux_x64"];

function run(tool, args) {
  const result = spawnSync(tool, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${tool} ${args[0]} failed with exit code ${result.status}`);
}

function containerTool() {
  for (const tool of ["podman", "docker"]) {
    if (!spawnSync(tool, ["--version"], { stdio: "ignore" }).error) return tool;
  }
  throw new Error("Building the AppImage needs podman or docker.");
}

for (const file of NEEDED) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`${file} is missing. Run npm run package first.`);
}
const tool = containerTool();
run(tool, ["build", "-q", "-t", IMAGE, "-f", "packaging/appimage/Containerfile", "packaging/appimage"]);
run(tool, ["run", "--rm", "-v", `${root}:/repo:ro`, "-v", `${path.join(root, "dist")}:/out`, IMAGE, "bash", "/repo/packaging/appimage/build-appimage.sh"]);
console.log("[build-appimage] Created dist/vlc-rec-x86_64.AppImage");
