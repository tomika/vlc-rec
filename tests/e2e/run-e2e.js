// End-to-end test of the real app window.
//   node tests/e2e/run-e2e.js --mode stub   no VLC or ffmpeg needed, uses tests/fixtures/libvlc-stub
//   node tests/e2e/run-e2e.js --mode real   needs VLC 3 and ffmpeg with SRT support
// On Linux run it through tests/e2e/run-linux.js, which provides the display.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { readPng, countPixels } = require("./png.js");

const repo = path.resolve(__dirname, "..", "..");
const modeArg = process.argv.indexOf("--mode");
const MODE = modeArg > 0 ? process.argv[modeArg + 1] : "real";
const WIN = process.platform === "win32";
const OUT = path.resolve(process.env.E2E_OUT || path.join(repo, "e2e-output"));
const SCENARIO_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 240000;
const ONLY = process.env.E2E_ONLY || "";
const PLAYER_NAME = WIN ? "vlc-rec-player-win_x64.exe" : "vlc-rec-player-linux_x64";
const FFMPEG = process.env.E2E_FFMPEG || "ffmpeg";
const FFPROBE = process.env.E2E_FFPROBE || "ffprobe";
// With an AppImage only the frontend comes from the test copy: the runtime, mount, WebKit,
// libVLC and player are the shipped ones.
const APPIMAGE = process.env.E2E_APPIMAGE || "";
const XWININFO = process.env.E2E_XWININFO || "xwininfo";

const failures = [];
const report = (scenario, name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`${scenario}: ${name}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function playerRunning() {
  if (WIN) {
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${PLAYER_NAME}`, "/NH"], { encoding: "utf8" });
    return out.stdout.includes(PLAYER_NAME);
  }
  return spawnSync("pgrep", ["-f", PLAYER_NAME]).status === 0;
}

function killPlayer() {
  if (WIN) spawnSync("taskkill", ["/F", "/IM", PLAYER_NAME], { stdio: "ignore" });
  else spawnSync("pkill", ["-9", "-f", PLAYER_NAME]);
}

function killProcess(pid) {
  if (WIN) spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  else {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function screenshot(file) {
  if (WIN) {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
      "Add-Type -Name Dpi -Namespace E2E -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'",
      "[void][E2E.Dpi]::SetProcessDPIAware()",
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen",
      "$i=New-Object System.Drawing.Bitmap($b.Width,$b.Height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)",
      "$g=[System.Drawing.Graphics]::FromImage($i)",
      "$g.CopyFromScreen($b.Left,$b.Top,0,0,$b.Size)",
      `$i.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`
    ].join("; ");
    return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  }
  if (process.env.WAYLAND_DISPLAY) return spawnSync("grim", [file], { encoding: "utf8" });
  return spawnSync("import", ["-window", "root", `png24:${file}`], { encoding: "utf8" });
}

let lastVideoBlack = 0;

function screenChecks(name, request) {
  const file = path.join(OUT, `${currentScenario}-${name}.png`);
  const result = screenshot(file);
  if (result.status !== 0 || !fs.existsSync(file)) {
    return [{ name: "screenshot taken", ok: false, detail: result.stderr || "no file" }];
  }
  const counts = countPixels(readPng(file));
  const area = request.rect.width * request.rect.height;
  const detail = `area=${area} saturated=${counts.saturated} black=${counts.black} magenta=${counts.magenta}`;
  const expect = request.expect;
  if (expect === "any") return [];
  if (MODE === "stub") {
    // The panel is magenta and the player's child window is black on top of it.
    if (expect === "video") {
      lastVideoBlack = counts.black;
      return [
        { name: "child window covers the whole panel", ok: counts.magenta === 0, detail },
        { name: "child window is visible", ok: counts.black >= area * 0.95, detail }
      ];
    }
    if (expect === "idle") {
      return [{ name: "panel visible, no child window", ok: counts.magenta >= area * 0.95, detail }];
    }
    // The desktop around the window may be black too, so compare with the last video shot.
    return [{
      name: "dialog covers the panel and video",
      ok: counts.magenta === 0 && counts.black <= lastVideoBlack - area * 0.9,
      detail: `${detail} blackBefore=${lastVideoBlack}`
    }];
  }
  if (expect === "video") {
    return [{ name: "video colors fill the panel", ok: counts.saturated >= area * 0.3, detail }];
  }
  return [{ name: "no video on screen", ok: counts.saturated < area * 0.02, detail }];
}

// The dialog is a separate program, so a broken environment shows up as no window at all.
async function checkDialog(name, request) {
  const started = Date.now();
  let seen = false;
  while (!seen && Date.now() - started < 15000) {
    seen = spawnSync(XWININFO, ["-root", "-tree"], { encoding: "utf8" }).stdout.includes(request.title);
    if (!seen) await sleep(250);
  }
  await sleep(1000);
  screenshot(path.join(OUT, `${currentScenario}-${name}.png`));
  spawnSync("pkill", ["-x", "zenity"]);
  return [{ name: "window opens", ok: seen, detail: `${Date.now() - started} ms` }];
}

function verifyFile(request) {
  const file = request.file;
  const checks = [];
  const exists = fs.existsSync(file);
  checks.push({ name: "file exists", ok: exists, detail: file });
  if (!exists) return checks;
  const size = fs.statSync(file).size;
  checks.push({ name: "file is not empty", ok: size > 0, detail: `${size} bytes` });
  if (MODE !== "real") return checks;
  const probe = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const duration = Number(probe.stdout.trim());
  checks.push({ name: "duration at least 2 s", ok: probe.status === 0 && duration >= 2, detail: `${duration} s ${probe.stderr || ""}` });
  const decode = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  checks.push({ name: "decodes", ok: decode.status === 0, detail: `exit ${decode.status}` });
  return checks;
}

let source = null;
let sourceWanted = false;
function startSource() {
  sourceWanted = true;
  source = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "25", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-f", "mpegts",
    "srt://127.0.0.1:5000?mode=listener&pkt_size=1316"
  ], { stdio: "ignore", windowsHide: true });
  // Like a hardware encoder, accept the next connection after a client leaves.
  source.on("exit", () => {
    if (sourceWanted) setTimeout(() => { if (sourceWanted) startSource(); }, 200);
  });
  source.on("error", (err) => report("source", "ffmpeg starts", false, err.message));
}
function stopSource() {
  sourceWanted = false;
  if (source) killProcess(source.pid);
}

let currentScenario = "";

function prepareApp(scenario) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), process.env.E2E_TEMP_NAME || "vlc rec e2e "));
  fs.cpSync(path.join(repo, "src", "frontend"), path.join(app, "src", "frontend"), { recursive: true });
  fs.cpSync(path.join(repo, "assets"), path.join(app, "assets"), { recursive: true });
  fs.cpSync(path.join(repo, "player"), path.join(app, "player"), { recursive: true });
  // The test window must stay on top and be resized; the shipped app does not need this.
  const config = JSON.parse(fs.readFileSync(path.join(repo, "neutralino.config.json"), "utf8"));
  config.nativeAllowList.push("window.*");
  fs.writeFileSync(path.join(app, "neutralino.config.json"), JSON.stringify(config, null, 2));
  const binaryName = WIN ? "neutralino-win_x64.exe" : "neutralino-linux_x64";
  fs.copyFileSync(path.join(repo, "bin", binaryName), path.join(app, binaryName));
  fs.mkdirSync(path.join(app, "e2e"));
  const frontend = path.join(app, "src", "frontend");
  const driver = fs.readFileSync(path.join(__dirname, "driver.js"), "utf8")
    .replace("__MODE__", MODE).replace("__SCENARIO__", scenario);
  fs.writeFileSync(path.join(frontend, "e2e-driver.js"), driver);
  const htmlPath = path.join(frontend, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  fs.writeFileSync(htmlPath, html.replace('<script src="/app.js"></script>',
    '<script src="/app.js"></script>\n  <script src="/e2e-driver.js"></script>'));
  if (!WIN) {
    fs.chmodSync(path.join(app, binaryName), 0o755);
    fs.chmodSync(path.join(app, "player", PLAYER_NAME), 0o755);
  }
  return { app, binary: path.join(app, binaryName) };
}

async function runScenario(scenario, env) {
  if (ONLY && ONLY !== scenario) return;
  currentScenario = scenario;
  console.log(`--- scenario: ${scenario}`);
  const { app, binary: plainBinary } = prepareApp(scenario);
  const binary = APPIMAGE || plainBinary;
  const dir = path.join(app, "e2e");
  const logFile = fs.openSync(path.join(OUT, `${scenario}-neutralino.log`), "w");
  // Forward slashes: Neutralino writes this value into a JS string without escaping it.
  const child = spawn(binary, ["--load-dir-res", `--path=${app.replace(/\\/g, "/")}`, "--enable-extensions=false"], {
    cwd: app, env: { ...process.env, ...env }, stdio: ["ignore", logFile, logFile]
  });
  let exited = false;
  child.on("exit", () => { exited = true; });

  const handled = new Set();
  const started = Date.now();
  let killedApp = false;
  while (!exited && Date.now() - started < SCENARIO_TIMEOUT_MS) {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".ready") || handled.has(entry)) continue;
      handled.add(entry);
      const name = entry.slice(0, -".ready".length);
      const request = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
      let reply = {};
      if (request.action === "screenshot") reply = { checks: screenChecks(name, request) };
      else if (request.action === "verify") reply = { checks: verifyFile(request) };
      else if (request.action === "dialog") reply = { checks: await checkDialog(name, request) };
      else if (name === "kill-player") killPlayer();
      else if (name === "kill-source") stopSource();
      else if (name === "start-source") startSource();
      else if (name === "kill-app") { killedApp = true; killProcess(Number(request.pid)); }
      fs.writeFileSync(path.join(dir, `${name}.done`), JSON.stringify(reply));
    }
    await sleep(100);
  }
  if (!exited) {
    report(scenario, "app finished in time", false, `${SCENARIO_TIMEOUT_MS} ms`);
    killProcess(child.pid);
  } else if (!killedApp) {
    report(scenario, "app exited by itself", true);
  }

  const resultFile = path.join(dir, "result.json");
  if (fs.existsSync(resultFile)) {
    for (const item of JSON.parse(fs.readFileSync(resultFile, "utf8"))) report(scenario, item.name, item.ok, item.detail);
  } else {
    report(scenario, "driver wrote a result", false, "see the neutralino log");
  }

  // The player must never outlive the app, and leaving must finalize the file.
  let waited = 0;
  while (playerRunning() && waited < 15000) {
    await sleep(250);
    waited += 250;
  }
  report(scenario, "no player left running", !playerRunning(), `${waited} ms after the app ended`);
  killPlayer();

  if (scenario === "closewhile" || scenario === "hardkill") {
    const folder = fs.readdirSync(dir).find((entry) => entry.startsWith("out ")) || "missing";
    for (const item of verifyFile({ file: path.join(dir, folder, `${scenario}.mkv`) })) {
      report(scenario, item.name, item.ok, item.detail);
    }
  }
  const neutralinoLog = path.join(app, "neutralinojs.log");
  // Not copyFileSync: it also copies permissions, which a mounted Windows folder refuses.
  if (fs.existsSync(neutralinoLog)) fs.writeFileSync(path.join(OUT, `${scenario}-app.log`), fs.readFileSync(neutralinoLog));
  fs.rmSync(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (playerRunning()) throw new Error(`${PLAYER_NAME} is already running; close it first.`);
  const baseEnv = {};
  if (!WIN) Object.assign(baseEnv, { GDK_BACKEND: "x11" });
  if (MODE === "stub") {
    baseEnv.VLC_REC_LIBVLC_DIR = path.join(repo, "tests", "fixtures", "stub", WIN ? "win" : "linux");
    await runScenario("main", baseEnv);
    await runScenario("closewhile", baseEnv);
    await runScenario("hardkill", baseEnv);
    await runScenario("wrongversion", { ...baseEnv, LIBVLC_STUB_VERSION: "4.0.0" });
    await runScenario("novlc", { ...baseEnv, VLC_REC_LIBVLC_DIR: path.join(repo, "does-not-exist") });
  } else {
    startSource();
    await sleep(1500);
    await runScenario("main", baseEnv);
    await runScenario("closewhile", baseEnv);
    await runScenario("hardkill", baseEnv);
    if (APPIMAGE) await runScenario("dialogs", baseEnv);
    stopSource();
  }
  console.log(failures.length ? `\nE2E FAILED: ${failures.length} check(s)\n${failures.join("\n")}` : "\nE2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  stopSource();
  console.error(err);
  process.exit(2);
});
