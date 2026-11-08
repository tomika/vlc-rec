// Starts the AppImage exactly as a user does, with no test code inside, from an unrelated folder.
//   node tests/e2e/appimage-smoke.js <AppImage>    needs DISPLAY and the "import" tool
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { readPng, countPixels } = require("./png.js");

const appImage = process.argv[2];
const WINDOW_PIXELS = 1100 * 460; // neutralino.config.json
const PANEL_PIXELS = 150000;
const dataDir = path.join(os.homedir(), ".config", "vlc-rec");
const logFile = path.join(os.tmpdir(), "appimage-smoke.log");
let failed = false;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} [smoke] ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function blackPixels() {
  const file = path.join(os.tmpdir(), "appimage-smoke.png");
  if (process.env.WAYLAND_DISPLAY) spawnSync("grim", [file]);
  else spawnSync("import", ["-window", "root", `png24:${file}`]);
  if (fs.existsSync("/out")) fs.writeFileSync("/out/smoke.png", fs.readFileSync(file));
  return countPixels(readPng(file)).black;
}

function findAppPid() {
  const out = spawnSync("pgrep", ["-x", "vlc-rec"], { encoding: "utf8" });
  return Number(out.stdout.trim().split("\n")[0]) || 0;
}

(async () => {
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const before = blackPixels();
  const log = fs.openSync(logFile, "w");
  const started = Date.now();
  const child = spawn(appImage, [], { cwd: "/", stdio: ["ignore", log, log] });
  let exitCode = null;
  child.on("exit", (code, signal) => { exitCode = code === null ? signal : code; });

  let pid = 0;
  while (!pid && Date.now() - started < 30000 && exitCode === null) {
    pid = findAppPid();
    await sleep(200);
  }
  report("app process starts", pid > 0, exitCode === null ? `${Date.now() - started} ms` : `exit ${exitCode}`);
  await sleep(10000);
  const alive = exitCode === null && findAppPid() === pid && pid > 0;
  report("app keeps running", alive, exitCode === null ? "" : `exit ${exitCode}`);

  if (alive) {
    const mapped = fs.readFileSync(`/proc/${pid}/maps`, "utf8");
    const webkit = mapped.split("\n").find((line) => line.includes("libwebkit2gtk")) || "";
    report("WebKit comes from the image", /\.mount_|squashfs-root|appimage_extracted/.test(webkit), webkit.trim().split(/\s+/).pop());
    const exe = fs.readlinkSync(`/proc/${pid}/exe`);
    const children = spawnSync("pgrep", ["-f", "WebKitWebProcess"]);
    report("WebKit helper process runs", children.status === 0, exe);
    const during = blackPixels();
    // Black pixels inside the window, on a desktop that is either black or has another color.
    const insideWindow = during - Math.max(0, before - WINDOW_PIXELS);
    report("window and video panel are shown", insideWindow > PANEL_PIXELS && insideWindow < WINDOW_PIXELS - 50000, `black before=${before} during=${during}`);
    report("log file is in the settings folder", fs.existsSync(path.join(dataDir, "neutralinojs.log")), dataDir);
    process.kill(pid, "SIGTERM");
  }

  const stopped = Date.now();
  while (exitCode === null && Date.now() - stopped < 20000) await sleep(200);
  report("AppImage ends with the app", exitCode !== null, `exit ${exitCode}`);
  if (exitCode === null) child.kill("SIGKILL");
  await sleep(1500); // The runtime unmounts just after the app has ended.
  const mounts = fs.readFileSync("/proc/mounts", "utf8").split("\n").filter((line) => line.includes(".mount_"));
  report("no mount is left behind", mounts.length === 0, mounts.join("; "));

  const text = fs.readFileSync(logFile, "utf8");
  if (text.trim()) console.log(`--- app output\n${text.split("\n").slice(0, 25).join("\n")}\n---`);
  process.exit(failed ? 1 : 0);
})();
