// Runs the built AppImage in clean distribution containers, without VLC, WebKit or GTK installed.
//   node tests/e2e/run-appimage.js [name ...]    default: every entry below
// Node, ffmpeg and the screenshot tool come from the e2e image, mounted at /tools, so their
// libraries cannot hide a dependency that the AppImage is missing. This needs podman.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const TOOLS_IMAGE = "localhost/vlc-rec-e2e:1";
const APT = "apt-get update && apt-get install -y --no-install-recommends";
const APT_BASE = "xvfb openbox dbus procps fuse3 fonts-dejavu-core libgl1 libegl1 libgbm1 libasound2 libfontconfig1 libharfbuzz0b";

const HOSTS = {
  debian12: { from: "docker.io/library/debian:12-slim", install: `${APT} ${APT_BASE}` },
  debian13: { from: "docker.io/library/debian:13-slim", install: `${APT} ${APT_BASE.replace("libasound2", "libasound2t64")}` },
  ubuntu24: { from: "docker.io/library/ubuntu:24.04", install: `${APT} ${APT_BASE.replace("libasound2", "libasound2t64")}` },
  // Without /dev/fuse the host script falls back to the runtime's extract-and-run mode.
  nofuse: { from: "docker.io/library/ubuntu:24.04", install: `${APT} ${APT_BASE.replace("libasound2", "libasound2t64")}`, noFuse: true },
  fedora: { from: "registry.fedoraproject.org/fedora:latest", install: "dnf install -y --setopt=install_weak_deps=False xorg-x11-server-Xvfb openbox dbus-daemon procps-ng fuse3 dejavu-sans-fonts mesa-libGL mesa-libEGL mesa-libgbm alsa-lib fontconfig harfbuzz shadow-utils" },
  arch: { from: "docker.io/library/archlinux:latest", install: "pacman -Sy --noconfirm archlinux-keyring && pacman -Su --noconfirm xorg-server-xvfb openbox dbus procps-ng fuse3 ttf-dejavu libglvnd mesa alsa-lib fontconfig harfbuzz" },
  // VLC, WebKit 4.0 and 4.1 are installed here too, and the bundled ones must still be used. Sway adds XWayland.
  systemlibs: { from: TOOLS_IMAGE, install: "true", systemLibs: true, session: "sway" },
  // Older than the build base: this host passes when the app refuses to start with a clear message.
  ubuntu22: { from: "docker.io/library/ubuntu:22.04", install: `${APT} ${APT_BASE}`, tooOld: true }
};

function run(args, options = {}) {
  return spawnSync("podman", args, { cwd: repo, stdio: "inherit", ...options });
}

const appImage = path.join(repo, "dist", "vlc-rec-x86_64.AppImage");
if (!fs.existsSync(appImage)) throw new Error("dist/vlc-rec-x86_64.AppImage is missing. Run npm run package:appimage first.");
if (run(["build", "-q", "-t", TOOLS_IMAGE, "-f", "tests/e2e/linux/Containerfile", "tests/e2e/linux"]).status !== 0) process.exit(2);

const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(HOSTS);
const outRoot = path.join(repo, "e2e-output", "appimage");
fs.mkdirSync(outRoot, { recursive: true });

const results = [];
for (const name of names) {
  const host = HOSTS[name];
  if (!host) throw new Error(`Unknown host: ${name}`);
  console.log(`=== AppImage on ${name}`);
  const image = `localhost/vlc-rec-appimage-host-${name}:1`;
  const containerfile = host.systemLibs
    ? `FROM ${host.from}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends fuse3\nUSER tester\n`
    : `FROM ${host.from}\nRUN ${host.install}\nRUN useradd -m tester\nUSER tester\nWORKDIR /home/tester\n`;
  if (run(["build", "-q", "-t", image, "-f", "-"], { input: containerfile, stdio: ["pipe", "inherit", "inherit"] }).status !== 0) {
    results.push(`${name}: image build FAILED`);
    continue;
  }
  const out = path.join(outRoot, name);
  fs.mkdirSync(out, { recursive: true });
  const status = run([
    "run", "--rm", "--name", `vlc-rec-appimage-${name}`, "--shm-size=256m",
    ...(host.noFuse ? [] : ["--device", "/dev/fuse", "--cap-add", "SYS_ADMIN", "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined"]),
    "--mount", `type=image,source=${TOOLS_IMAGE},destination=/tools`,
    "-v", `${repo}:/repo:ro`, "-v", `${out}:/out`, "-e", `E2E_TOO_OLD=${host.tooOld ? 1 : 0}`, "-e", `E2E_SYSTEM_LIBS=${host.systemLibs ? 1 : 0}`, "-e", `E2E_SESSION=${host.session || "x11"}`,
    image, "bash", "/repo/tests/e2e/linux/appimage-host.sh"
  ]).status;
  results.push(`${name}: ${status === 0 ? "PASSED" : "FAILED"}`);
}
console.log(`\n${results.join("\n")}`);
process.exit(results.every((line) => line.endsWith("PASSED")) ? 0 : 1);
