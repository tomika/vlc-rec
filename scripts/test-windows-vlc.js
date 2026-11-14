// Exercises the production DLL loader against the real portable runtime. No camera or window.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { assertWindowsRuntime } = require("./bundle-windows-vlc");
const root = path.resolve(__dirname, "..");
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.error || result.stderr || result.status}`);
  return result;
}
if (process.platform !== "win32") throw new Error("This integration test runs on Windows. Unit tests are platform independent.");
assertWindowsRuntime(path.join(root, "vlc"));
const tool = ["podman", "docker"].find(name => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0);
if (!tool) throw new Error("This test needs podman or docker");
const output = path.join(root, "e2e-output", "windows-vlc");
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, "runtime test "));
try {
  fs.mkdirSync(path.join(directory, "player"));
  fs.cpSync(path.join(root, "vlc"), path.join(directory, "vlc"), { recursive: true });
  run(tool, ["build", "-q", "-t", "localhost/vlc-rec-player-builder:1", "-f", "native/Containerfile", "native"], { stdio: "inherit" });
  run(tool, ["run", "--rm", "--network", "none", "-v", `${root}:/repo:ro`, "-v", `${directory}:/out`, "localhost/vlc-rec-player-builder:1",
    "x86_64-w64-mingw32-gcc", "-std=gnu11", "-O2", "-static", "-o", "/out/player/probe.exe", "/repo/tests/fixtures/windows-vlc-probe.c", "-ladvapi32", "-lgdi32"], { stdio: "inherit" });
  run(tool, ["build", "-q", "-t", "localhost/vlc-rec-e2e:1", "-f", "tests/e2e/linux/Containerfile", "tests/e2e/linux"], { stdio: "inherit" });
  run(tool, ["run", "--rm", "--network", "none", "-v", `${directory}:/out`, "localhost/vlc-rec-e2e:1", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "2", "-an", "-c:v", "mpeg2video", "-f", "mpegts", "/out/test.ts"], { stdio: "inherit" });
  const env = { ...process.env };
  delete env.VLC_REC_LIBVLC_DIR;
  delete env.VLC_PLUGIN_PATH;
  const executable = path.join(directory, "player", "probe.exe");
  const result = run(executable, [pathToFileURL(path.join(directory, "test.ts")).href], { env, cwd: process.env.TEMP, encoding: "utf8", timeout: 120000 });
  const info = JSON.parse(result.stdout.trim());
  if (!path.resolve(info.dll).toLowerCase().startsWith(path.join(directory, "vlc").toLowerCase() + path.sep) || info.decoded < 1) throw new Error("Bundled runtime was not used for decoding");
  const override = spawnSync(executable, [], { env: { ...env, VLC_REC_LIBVLC_DIR: path.join(directory, "missing") }, encoding: "utf8", timeout: 30000, windowsHide: true });
  if (override.status !== 3) throw new Error("Explicit VLC_REC_LIBVLC_DIR was ignored");
  console.log(JSON.stringify(info));
  console.log("PASS: bundled DLL, codec plugins, paths with spaces, software decoding and explicit override");
} finally {
  if (!directory.startsWith(output + path.sep)) throw new Error("Unsafe test cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
}
