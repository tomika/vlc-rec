const fs = require("node:fs/promises");
const path = require("node:path");

const DIST_DIR = path.join(process.cwd(), "dist", "vlc-rec");
const ICON_SRC = path.join(process.cwd(), "assets", "vlc-rec.png");
const LINUX_BINARY_PREFIX = "vlc-rec-linux_";

function desktopFileText() {
  return [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    "Name=VLC Stream Recorder",
    "Comment=Preview and record SRT streams",
    "Exec=./run-vlc-rec.sh",
    "Icon=./vlc-rec.png",
    "Terminal=false",
    "Categories=AudioVideo;Recorder;",
    "StartupNotify=true",
    ""
  ].join("\n");
}

function launcherScriptText() {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "SCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "exec \"$SCRIPT_DIR/vlc-rec\" \"$@\"",
    ""
  ].join("\n");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildLinuxLauncherBundles() {
  if (!await pathExists(DIST_DIR)) {
    console.warn(`[linux-launchers] Dist directory not found: ${DIST_DIR}`);
    return;
  }

  if (!await pathExists(ICON_SRC)) {
    throw new Error(`Icon file is missing: ${ICON_SRC}`);
  }

  const entries = await fs.readdir(DIST_DIR, { withFileTypes: true });
  const linuxTargets = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(LINUX_BINARY_PREFIX))
    .map((entry) => entry.name);

  if (linuxTargets.length === 0) {
    console.warn("[linux-launchers] No Linux binaries found to bundle.");
    return;
  }

  for (const binaryName of linuxTargets) {
    const arch = binaryName.slice(LINUX_BINARY_PREFIX.length);
    const bundleDir = path.join(DIST_DIR, `linux-${arch}`);
    const binarySrc = path.join(DIST_DIR, binaryName);
    const binaryDst = path.join(bundleDir, "vlc-rec");
    const launcherDst = path.join(bundleDir, "run-vlc-rec.sh");
    const iconDst = path.join(bundleDir, "vlc-rec.png");
    const desktopDst = path.join(bundleDir, "vlc-rec.desktop");

    await fs.mkdir(bundleDir, { recursive: true });
    await fs.copyFile(binarySrc, binaryDst);
    await fs.copyFile(ICON_SRC, iconDst);
    await fs.writeFile(launcherDst, launcherScriptText(), "utf8");
    await fs.writeFile(desktopDst, desktopFileText(), "utf8");

    await fs.chmod(binaryDst, 0o755);
    await fs.chmod(launcherDst, 0o755);
    await fs.chmod(desktopDst, 0o755);

    console.log(`[linux-launchers] Created ${path.relative(process.cwd(), bundleDir)}`);
  }
}

buildLinuxLauncherBundles().catch((err) => {
  console.error("[linux-launchers] Failed:", err && err.message ? err.message : err);
  process.exitCode = 1;
});
