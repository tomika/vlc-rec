// Runs the built AppImage in a container and shows its window on the Windows desktop through
// WSLg (the X server that WSL2 provides). For trying the Linux build from a Windows machine.
//
//   npm run run:appimage -- [--stream IP:PORT] [--camera IP]
//
// Without the options, the stream address and the camera address come from ip_address and
// camera_config.host in vlc_rec_params.json in the repository (the settings file of npm start).
// The container uses the host network, so a camera or an SRT source on the LAN is reachable.
// Settings go to a throwaway folder inside the container, so nothing on this computer changes.
// Needs podman (the podman machine is a WSL2 distribution with WSLg) and the image of the
// end-to-end tests, localhost/vlc-rec-e2e:1 (node tests/e2e/run-linux.js builds it).
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const IMAGE = "localhost/vlc-rec-e2e:1";
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
};
const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const ipv4Port = /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/;
let saved = {};
try {
  saved = JSON.parse(fs.readFileSync(path.join(root, "vlc_rec_params.json"), "utf8"));
} catch {
  // No settings file: only the options count.
}
const stream = option("--stream") || (ipv4Port.test(saved.ip_address || "") ? saved.ip_address : "");
const savedCamera = (saved.camera_config && saved.camera_config.host) || saved.camera_ip || "";
const camera = option("--camera") || (ipv4.test(savedCamera) ? savedCamera : "");
if ((stream && !ipv4Port.test(stream)) || (camera && !ipv4.test(camera))) {
  console.error("usage: npm run run:appimage -- [--stream IP:PORT] [--camera IP]");
  process.exit(2);
}
console.log(`stream ${stream || "127.0.0.1:5000"}, camera ${camera || "none"}`);
const appImage = path.join(root, "dist", "vlc-rec-x86_64.AppImage");
if (!fs.existsSync(appImage)) {
  console.error("dist/vlc-rec-x86_64.AppImage is missing; build it with node scripts/build-appimage.js");
  process.exit(2);
}

const settings = JSON.stringify({
  ip_address: stream || "127.0.0.1:5000",
  output_path: "/tmp/recordings",
  ...(camera ? { camera_plugin: "obsbot-tail2", camera_config: { host: camera } } : {})
});
// The settings go in as an environment variable, never into the shell text.
const script = [
  "set -e",
  "mkdir -p /tmp/cfg/vlc-rec /tmp/recordings",
  'printf "%s" "$VLC_REC_SETTINGS" > /tmp/cfg/vlc-rec/vlc_rec_params.json',
  // Not a mount: the mounted Windows folder carries no execute permission.
  "cat /dist/vlc-rec-x86_64.AppImage > /tmp/vlc-rec.AppImage",
  "chmod +x /tmp/vlc-rec.AppImage",
  "exec dbus-run-session -- /tmp/vlc-rec.AppImage"
].join("\n");

const tool = spawnSync("podman", ["--version"], { stdio: "ignore" }).error ? "docker" : "podman";
const result = spawnSync(tool, [
  "run", "--rm", "--network", "host",
  "-v", `${path.join(root, "dist")}:/dist:ro`,
  "-v", "/mnt/wslg/.X11-unix:/tmp/.X11-unix",
  "-e", "DISPLAY=:0", "-e", "GDK_BACKEND=x11", "-e", "NO_AT_BRIDGE=1",
  // No FUSE in the container: the AppImage unpacks itself and runs from there.
  "-e", "APPIMAGE_EXTRACT_AND_RUN=1",
  "-e", "XDG_CONFIG_HOME=/tmp/cfg",
  "-e", `VLC_REC_SETTINGS=${settings}`,
  IMAGE, "bash", "-c", script
], { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
process.exit(result.status === null ? 1 : result.status);
