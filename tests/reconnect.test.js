const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createContext, runInContext } = require("node:vm");
const { test } = require("node:test");
const { createServer } = require("node:net");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const source = readFileSync(resolve(__dirname, "../src/frontend/app.js"), "utf8");

function harness() {
  let now = 100000;
  let nextId = 1;
  const files = new Map();
  const live = new Map();
  const launches = [];
  const actions = [];
  const elements = new Map();
  const events = new Map();
  const timeouts = [];
  const stdin = [];
  const opened = [];
  const logs = [];
  const env = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, hidden: true, style: {}, dataset: {}, attributes: {},
      classList: { names: new Set(), add(name) { this.names.add(name); }, remove(name) { this.names.delete(name); } },
      addEventListener(name, handler) { this[name] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; }, focus() {},
      replaceChildren(...children) { this.children = children; },
      blur() {},
      getBoundingClientRect() { return { left: 10, top: 20, width: 640, height: 360 }; }
    });
    return elements.get(id);
  };
  const os = {
    async getEnv(name) { return env.get(name) || ""; },
    async spawnProcess(command) {
      // A second connection may open only after the previous VLC has exited.
      // The camera helper runs alongside and does not count.
      const camera = command.includes("vlc-rec-camera");
      if (!camera) assert.equal([...live.values()].filter((p) => !p.camera).length, 0);
      const proc = { id: nextId++, pid: nextId + 1000, camera };
      live.set(proc.id, proc);
      launches.push(command);
      return proc;
    },
    async execCommand(command) {
      if (command.includes("EncodedCommand")) return { exitCode: 0, stdOut: "| input bytes read : 100 KiB\n+----[ end of statistical info ]\n" };
      actions.push("soft-stop");
      live.clear();
      return { exitCode: 0, stdOut: "" };
    },
    async getSpawnedProcesses() { return [...live.values()]; },
    async open(url) { if (os.openFails) throw new Error("no browser"); opened.push(url); },
    async updateSpawnedProcess(id, action, data) {
      actions.push(action);
      if (action === "stdIn") stdin.push(data);
      if (action === "exit" || action === "stdInEnd") live.delete(id);
    },
    async showMessageBox() { assert.fail("Recovery must not open modal dialogs"); }
  };
  const filesystem = {
    async getStats(path) {
      if (!files.has(path)) throw new Error("missing file");
      return { size: files.get(path) };
    },
    async getJoinedPath(...parts) { return parts.join("/"); },
    async writeFile(path, data) { files.set(path, data); },
    async readFile(path) { return files.get(path); }
  };
  const context = createContext({
    document: { getElementById: element, activeElement: null, createElement: () => ({}) },
    window: { addEventListener() {} },
    NL_PATH: "/app", NL_OS: "Windows", NL_ARCH: "x64", NL_PID: "4242",
    TextEncoder,
    Date: class extends Date { static now() { return now; } },
    Neutralino: {
      os, filesystem, init() {}, debug: { async log(message) { logs.push(String(message)); } },
      events: { on(name, fn) { events.set(name, fn); } },
      app: { async exit() { actions.push("app-exit"); } }
    },
    btoa: (text) => Buffer.from(text, "binary").toString("base64"),
    setTimeout(fn, delay) {
      if (delay === 200) { now += delay; queueMicrotask(fn); }
      else timeouts.push(fn);
    },
    clearTimeout() {}, setInterval() {}
  });
  // Load production handlers and functions, leaving initialization explicit.
  runInContext(source.slice(0, source.lastIndexOf("\ninit().catch")), context);
  const run = (code) => runInContext(code, context);
  run("parameters.auto_reconnect = true");
  return {
    files, live, launches, actions, os, elements, events, timeouts, run, stdin, env, opened, logs,
    advance(ms) { now += ms; },
    enablePlayer() { files.set("/app/player/vlc-rec-player-win_x64.exe", 1); },
    async playerOutput(data) {
      context.outputEvent = { detail: { id: run("currentProcess.id"), action: "stdOut", data } };
      await run("handleSpawnedProcessEvent(outputEvent)");
    },
    async grow(ms, size) {
      now += ms;
      files.set(run("outputFile"), size);
      await run("monitorStream()");
    },
    start(record = true, name = "service", ext = "mkv") {
      context.request = { record, ipAddress: "192.168.1.2:5000", outputPathValue: "C:/video captures", filenameBase: name, ext };
      return run("startOperation(request)");
    },
    async exit() {
      const id = run("currentProcess.id");
      live.delete(id);
      context.exitEvent = { detail: { id, action: "exit" } };
      await run("handleSpawnedProcessEvent(exitEvent)");
    }
  };
}

test("recording growth resets timeout; a stalled file restarts with unused sequential names", async () => {
  const h = harness();
  assert.equal((await h.start()).ok, true);
  h.files.set("C:/video captures/service.mkv", 1024);
  await h.run("monitorStream()");
  h.advance(14000);
  h.files.set("C:/video captures/service.mkv", 1025); // Even one byte is progress.
  await h.run("monitorStream()");
  h.advance(14000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  h.files.set("C:/video captures/service_001.mkv", 999);
  h.advance(1000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 2);
  assert.equal(h.run("outputFile"), "C:/video captures/service_002.mkv");
  assert.equal(h.run("mode"), "recording");
  assert.equal(h.files.get("C:/video captures/service_001.mkv"), 999);
  assert.ok(h.actions.includes("soft-stop"));
  assert.match(h.launches[1], /--no-one-instance/);
  h.advance(15000);
  await h.run("monitorStream()");
  assert.equal(h.run("outputFile"), "C:/video captures/service_003.mkv");
  assert.equal((await h.run("currentState()")).elapsed, "00:00:00");
});

test("missing and zero-byte startup outputs also trigger recovery", async (t) => {
  for (const size of [undefined, 0]) await t.test(String(size), async () => {
    const h = harness();
    await h.start(true, "service_007.mp4", "mp4");
    if (size !== undefined) h.files.set("C:/video captures/service_007.mp4", size);
    h.advance(15000);
    await h.run("monitorStream()");
    assert.equal(h.run("outputFile"), "C:/video captures/service_008.mp4");
    assert.match(h.launches[1], /mux=mp4/);
  });
});

test("adaptive recording timeout learns the write cadence and restarts after three missed intervals", async (t) => {
  for (const cadence of [1000, 2000, 4000, 6000]) await t.test(`${cadence} ms writes`, async () => {
    const h = harness();
    await h.start();
    // A delayed first write must not become a normal write-interval sample.
    await h.grow(8000, 1);
    for (let sample = 1; sample <= 3; sample++) {
      await h.grow(cadence, sample + 1);
      if (sample < 3) assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 15000);
    }
    const timeout = Math.min(15000, cadence * 3);
    assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), timeout);
    h.advance(timeout - 1);
    await h.run("monitorStream()");
    assert.equal(h.launches.length, 1);
    h.advance(1);
    await h.run("monitorStream()");
    assert.equal(h.launches.length, 2);
    assert.equal(h.run("outputFile"), "C:/video captures/service_001.mkv");
    // Each new segment starts with a fresh startup grace period.
    assert.equal(h.run("activeSession.growthIntervalsMs.length"), 0);
    assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 15000);
    h.advance(3000);
    await h.run("monitorStream()");
    assert.equal(h.launches.length, 2);
  });
});

test("an early interruption uses the startup fallback before enough write samples exist", async () => {
  const h = harness();
  await h.start();
  await h.grow(1000, 1);
  await h.grow(1000, 2);
  await h.grow(1000, 3);
  h.advance(14999);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  h.advance(1);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 2);
});

test("bursty growth uses the longest recent interval and continues adapting", async () => {
  const h = harness();
  await h.start();
  await h.grow(1000, 1);
  await h.grow(4000, 2);
  await h.grow(1000, 3);
  await h.grow(1000, 4);
  assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 12000);
  h.advance(3000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1); // A short burst must not set a 3s timeout.
  await h.grow(1000, 5);
  for (let sample = 6; sample <= 13; sample++) await h.grow(1000, sample);
  assert.equal(h.run("activeSession.growthIntervalsMs.length"), 8);
  assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 3000);
  // Slow writes that arrive within the current timeout extend it immediately.
  await h.grow(2000, 14);
  assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 6000);
  assert.equal(h.launches.length, 1);
});

test("the adaptive timeout has a 3s floor and respects the configured ceiling", async () => {
  const h = harness();
  h.run("parameters.stall_timeout_sec = 10");
  await h.start();
  await h.grow(100, 1);
  for (let sample = 2; sample <= 4; sample++) await h.grow(100, sample);
  assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 3000);
  await h.grow(2000, 5);
  assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 6000);
  await h.grow(4000, 6);
  assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 10000);
});

test("checkbox changes discard learned recording intervals", async () => {
  const h = harness();
  await h.start();
  for (let sample = 1; sample <= 4; sample++) await h.grow(1000, sample);
  assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 3000);
  const checkbox = h.elements.get("autoReconnect");
  checkbox.checked = false;
  checkbox.change();
  checkbox.checked = true;
  checkbox.change();
  assert.equal(h.run("recordingStallTimeoutMs(activeSession)"), 15000);
  h.advance(3000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
});

test("recovery preserves the active stream settings despite edited GUI fields", async () => {
  const h = harness();
  await h.start();
  h.run("parameters.ip_address = 'other:1234'; parameters.output_path = 'elsewhere'; parameters.output_filename = 'other.mp4'");
  h.advance(15000);
  await h.run("monitorStream()");
  assert.match(h.launches[1], /192\.168\.1\.2:5000/);
  assert.match(h.launches[1], /C:\/video captures\/service_001\.mkv/);
});

test("failed launches retry with backoff, and Stop cancels pending recovery", async () => {
  const h = harness();
  await h.start();
  const spawn = h.os.spawnProcess;
  let attempts = 0;
  h.os.spawnProcess = async () => { attempts++; throw new Error("temporarily unavailable"); };
  h.advance(15000);
  await h.run("monitorStream()");
  assert.match(h.run("statusText"), /Retrying in 5 seconds/);
  assert.equal(h.run("mode"), "recording");
  h.advance(4999);
  await h.run("monitorStream()");
  assert.equal(attempts, 1);
  h.os.spawnProcess = spawn;
  h.advance(1);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 2);
  await h.exit();
  await h.run("stopOperation()");
  h.advance(10000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 2);
  assert.equal(h.run("activeSession"), null);
});

test("unexpected exits reconnect in recording and preview modes; old events are ignored", async (t) => {
  for (const record of [true, false]) await t.test(String(record), async () => {
    const h = harness();
    await h.start(record);
    await h.exit();
    assert.equal(h.run("mode"), record ? "recording" : "preview");
    h.advance(5000);
    await h.run("monitorStream()");
    assert.equal(h.launches.length, 2);
    await h.run("handleSpawnedProcessEvent(exitEvent)");
    assert.equal(h.run("activeSession.nextRetryAt"), 0);
    assert.equal(h.run("currentProcess.exited"), undefined);
  });
});

test("disabled reconnect retains ordinary stop-on-exit behavior", async () => {
  const h = harness();
  h.run("parameters.auto_reconnect = false");
  await h.start();
  h.advance(60000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  await h.exit();
  assert.equal(h.run("mode"), "idle");
});

test("checkbox persists, resets the grace period, and cancels pending retries", async () => {
  const h = harness();
  await h.start();
  h.advance(14000);
  const checkbox = h.elements.get("autoReconnect");
  checkbox.checked = true;
  checkbox.change();
  h.advance(1000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  assert.equal(JSON.parse(h.files.get("/app/vlc_rec_params.json")).auto_reconnect, true);
  await h.exit();
  checkbox.checked = false;
  checkbox.change();
  h.advance(6000);
  await h.run("monitorStream()");
  assert.equal(h.run("mode"), "idle");
  assert.equal(h.launches.length, 1);
  assert.equal(JSON.parse(h.files.get("/app/vlc_rec_params.json")).auto_reconnect, false);
});

test("preview uses input traffic, tolerates unavailable statistics, and retries a frozen counter", async () => {
  const h = harness();
  await h.start(false);
  h.os.execCommand = async () => ({ exitCode: 0, stdOut: "" });
  h.advance(15000);
  await h.run("monitorStream()");
  assert.match(h.run("statusText"), /monitoring unavailable/);
  assert.equal(h.launches.length, 1);
  const exec = async (command) => {
    if (!command.includes("EncodedCommand")) h.live.clear();
    return { exitCode: 0, stdOut: "| input bytes read : 100 KiB\n" };
  };
  h.os.execCommand = exec;
  h.advance(5000);
  await h.run("monitorStream()");
  assert.equal(h.run("activeSession.previewUnavailable"), false);
  h.advance(15000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 2);
  assert.equal(h.run("mode"), "preview");
  assert.doesNotMatch(h.launches[1], /--sout/);
});

test("parallel monitor ticks and a Stop during an async stats read cannot resurrect VLC", async () => {
  const h = harness();
  await h.start();
  h.advance(15000);
  let finishRead;
  h.run("Neutralino.filesystem.getStats = () => new Promise(resolve => { globalThis.finishRead = resolve; })");
  const first = h.run("monitorStream()");
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  // Restore stats for Stop's UI refresh; finish the old read afterward.
  finishRead = h.run("finishRead");
  h.run("Neutralino.filesystem.getStats = async () => ({ size: 0 })");
  await h.run("stopOperation()");
  finishRead({ size: 0 });
  await first;
  assert.equal(h.launches.length, 1);
  assert.equal(h.run("mode"), "idle");
});

test("a hung VLC is forced to exit before a replacement is launched, without a modal warning", async () => {
  const h = harness();
  await h.start();
  h.os.execCommand = async () => ({ exitCode: 0 }); // Soft stop is ignored.
  h.advance(15000);
  await h.run("monitorStream()");
  assert.ok(h.actions.includes("exit"));
  assert.equal(h.launches.length, 2);
});

test("a process that cannot be terminated prevents another SRT connection", async () => {
  const h = harness();
  await h.start();
  h.os.execCommand = async () => ({ exitCode: 0 });
  h.os.updateSpawnedProcess = async () => {}; // Native termination fails too.
  h.advance(15000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  assert.equal(h.live.size, 1);
  assert.match(h.run("statusText"), /VLC has not stopped yet.*Retrying/);
});

test("preview traffic keeps the stream alive even when the displayed picture is static", async () => {
  const h = harness();
  await h.start(false);
  let bytes = 0;
  h.os.execCommand = async () => ({ exitCode: 0, stdOut: `| input bytes read : ${++bytes} KiB\n` });
  for (let count = 0; count < 6; count++) {
    h.advance(10000);
    await h.run("monitorStream()");
  }
  assert.equal(h.launches.length, 1);
});

test("custom timeout and filenames containing another extension are respected", async () => {
  const h = harness();
  h.run("parameters.stall_timeout_sec = 30");
  await h.start(true, "service.mp4", "mkv");
  h.advance(15000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  h.advance(15000);
  await h.run("monitorStream()");
  assert.equal(h.run("outputFile"), "C:/video captures/service.mp4_001.mkv");
});

test("simulation does not trigger the real-stream watchdog", async () => {
  const h = harness();
  await h.start();
  h.run("parameters.srt_mode = 'simulation'");
  h.advance(60000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
});

test("closing during recovery prevents a replacement and exits the app", async () => {
  const h = harness();
  await h.start();
  h.os.execCommand = async () => {
    h.live.clear();
    h.run("closeRequested = true");
    return { exitCode: 0 };
  };
  h.advance(15000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  assert.ok(h.actions.includes("app-exit"));
});

const hex = (text) => Buffer.from(text, "utf8").toString("hex");

test("the player receives hex encoded settings instead of a VLC command line", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start(true, "árvíz's, {1}", "mp4");
  const command = h.launches[0];
  assert.match(command, /^"\/app\/player\/vlc-rec-player-win_x64\.exe"/);
  assert.match(command, /"--parent-pid" "4242"/);
  assert.ok(command.includes(`"--url-hex" "${hex("srt://@192.168.1.2:5000")}"`));
  assert.ok(command.includes(`"--record-hex" "${hex("C:/video captures/árvíz's, {1}.mp4")}"`));
  assert.match(command, /"--mux" "mp4"/);
  assert.match(command, /"--rect" "10,20,640,360"/);
  assert.doesNotMatch(command, /--sout|--extraintf/);
});

test("the player folder from the environment replaces the one next to the app", async () => {
  const h = harness();
  h.env.set("VLC_REC_PLAYER_DIR", "/mount/usr/player");
  h.files.set("/mount/usr/player/vlc-rec-player-win_x64.exe", 1);
  await h.start();
  assert.match(h.launches[0], /^"\/mount\/usr\/player\/vlc-rec-player-win_x64\.exe"/);
});

test("a preview player gets no recording arguments", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start(false);
  assert.doesNotMatch(h.launches[0], /--record-hex|--mux/);
});

test("without a player binary the app starts external VLC", async () => {
  const h = harness();
  await h.start();
  assert.match(h.launches[0], /^"vlc"/);
  assert.match(h.launches[0], /--sout/);
});

test("preview progress comes from stats lines split across chunks; a frozen counter reconnects", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start(false);
  await h.playerOutput('{"event":"stats","state":3,');
  assert.equal(h.run("currentProcess.readBytes"), null);
  await h.playerOutput('"readBytes":-5}\nnot json\n');
  assert.equal(h.run("currentProcess.readBytes"), -5); // The 32-bit counter can wrap.
  h.advance(5000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  await h.playerOutput('{"event":"stats","state":3,"readBytes":7}\n');
  h.advance(5000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 1);
  h.advance(15000);
  await h.run("monitorStream()");
  assert.equal(h.launches.length, 2);
  assert.match(h.launches[1], /vlc-rec-player/);
  assert.equal(h.run("currentProcess.readBytes"), null);
});

test("the log says what libVLC reports and how far the pictures get, without a line per second", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start(false);
  await h.playerOutput('{"event":"log","level":"warning","module":"direct3d11","text":"swapchain failed"}\n');
  await h.playerOutput('{"event":"window","text":"player window 900x500 visible, parent 900x500, 1 child windows; VLC video output 900x500 visible"}\n');
  assert.ok(h.logs.includes("libVLC warning [direct3d11] swapchain failed"), h.logs.join("\n"));
  assert.ok(h.logs.some((line) => /^Player player window 900x500 visible.*VLC video output/.test(line)), h.logs.join("\n"));

  const stats = (state, bytes, decoded, displayed) =>
    `{"event":"stats","state":${state},"readBytes":${bytes},"decoded":${decoded},"displayed":${displayed},"lost":0}\n`;
  for (let i = 0; i < 20; i += 1) await h.playerOutput(stats(3, 1000 * (i + 1), i * 25, 0));
  const stateLines = () => h.logs.filter((line) => /^Player (idle|opening|buffering|playing|paused|stopped|ended|error):/.test(line));
  // The first stats (a new state), the 2nd, 5th and 15th: four lines of twenty.
  assert.equal(stateLines().length, 4, stateLines().join("\n"));
  assert.match(stateLines()[0], /^Player playing: 1000 bytes read, 0 pictures decoded, 0 shown, 0 lost$/);

  await h.playerOutput(stats(7, 0, 5, 0));
  assert.match(stateLines().at(-1), /^Player error: /, "a change of state is always written");

  // A player of an older build has no picture counters.
  await h.playerOutput('{"event":"stats","state":2,"readBytes":3}\n');
  assert.match(stateLines().at(-1), /^Player buffering: 3 bytes read, \? pictures decoded, \? shown, \? lost$/);
});

test("a player stops through stdin and gets time to finalize its file", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start();
  await h.run("stopOperation()");
  assert.ok(h.stdin.some((text) => /stop/i.test(text)));
  assert.ok(h.actions.includes("stdInEnd"));
  assert.ok(!h.actions.includes("soft-stop"));
  assert.ok(!h.actions.includes("exit"));
});

test("automatic recovery waits for a slow player before forcing it to exit", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start();
  h.os.updateSpawnedProcess = async (id, action) => {
    h.actions.push(action);
    if (action === "exit") h.live.delete(id);
  };
  const before = h.run("Date.now()");
  h.advance(15000);
  await h.run("monitorStream()");
  assert.ok(h.actions.includes("exit"));
  assert.ok(h.run("Date.now()") - before >= 25000);
  assert.equal(h.launches.length, 2);
});

test("window geometry and the scan dialog are forwarded to the player", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start();
  h.run("openScanDialog()");
  assert.deepEqual(h.stdin, ["HIDE\n"]);
  h.run("closeScanDialog()");
  assert.deepEqual(h.stdin, ["HIDE\n", "SHOW\n"]);
});

test("a player started behind the scan dialog is hidden immediately", async () => {
  const h = harness();
  h.enablePlayer();
  h.elements.get("scanDialog").hidden = false;
  await h.start();
  assert.deepEqual(h.stdin, ["HIDE\n"]);
});

test("a player error is shown when it exits, with and without reconnect", async (t) => {
  for (const reconnect of [false, true]) await t.test(String(reconnect), async () => {
    const h = harness();
    h.enablePlayer();
    h.run(`parameters.auto_reconnect = ${reconnect}`);
    await h.start();
    await h.playerOutput('{"event":"error","code":"libvlc-not-found","message":"libVLC was not found. Install VLC 3."}\n');
    await h.exit();
    assert.match(h.run("statusText"), /libVLC was not found/);
    assert.equal(h.run("mode"), reconnect ? "recording" : "idle");
  });
});

// Room for the video in each layout of a 1280x720 window, as the page would measure it.
const ROOM_16_9_WINDOW = {
  "layout is-side": { width: 896, height: 720, panelWidth: 384 },
  "layout is-stack": { width: 1280, height: 570, panelWidth: 1280 },
  "layout is-side is-compact": { width: 1108, height: 720, panelWidth: 172 },
  "layout is-stack is-compact": { width: 1280, height: 674, panelWidth: 1280 }
};
const ROOM_21_9_WINDOW = {
  "layout is-side": { width: 1296, height: 720, panelWidth: 384 },
  "layout is-stack": { width: 1680, height: 570, panelWidth: 1680 },
  "layout is-side is-compact": { width: 1508, height: 720, panelWidth: 172 },
  "layout is-stack is-compact": { width: 1680, height: 674, panelWidth: 1680 }
};
const stagesFor = (room) => ["layout is-side", "layout is-stack", "layout is-side is-compact", "layout is-stack is-compact"].map((name) => room[name]);

function layoutHarness(room) {
  const h = harness();
  h.enablePlayer();
  const layout = h.elements.get("layout");
  const panel = h.elements.get("panel");
  const host = h.elements.get("videoHost");
  let measured = 0;
  // The stage reports the room of whichever layout class is applied at that moment.
  h.elements.get("stage").getBoundingClientRect = () => {
    measured += 1;
    const box = room.current[layout.className];
    // A side panel widened by app.js takes the extra width from the stage.
    const width = box.width - (Number.parseFloat(panel.style.width) || box.panelWidth) + box.panelWidth;
    return { width, height: box.height };
  };
  panel.getBoundingClientRect = () => ({ width: room.current[layout.className].panelWidth });
  // The video box is where app.js put it.
  host.getBoundingClientRect = () => {
    const [left, top, width, height] = ["left", "top", "width", "height"].map((key) => Number.parseFloat(host.style[key]) || 0);
    return { left, top, width, height };
  };
  h.run("videoHost.hidden = false; layoutReady = true");
  return {
    ...h, layout, panel, host: host.style, toggle: h.elements.get("panelToggle"),
    measured: () => measured,
    rects: () => h.stdin.filter((line) => line.startsWith("RECT")),
    // Like a window resize: new room and a new window size for the change detection.
    resize(next) {
      room.current = next;
      h.run(`window.innerWidth = ${next["layout is-stack"].width}; window.innerHeight = ${next["layout is-side"].height}`);
      h.run("updateLayout()");
    }
  };
}

test("anamorphic and rotated sizes give the display aspect ratio; nonsense is ignored", () => {
  const h = harness();
  assert.equal(h.run("displayAspect({ width: 1440, height: 1080, sarNum: 4, sarDen: 3 })"), 16 / 9);
  assert.equal(h.run("displayAspect({ width: 1080, height: 1920, sarNum: 1, sarDen: 1 })"), 9 / 16);
  assert.equal(h.run("displayAspect({ width: 720, height: 576, sarNum: 0, sarDen: 0 })"), 1.25);
  assert.equal(h.run("displayAspect({ width: 1, height: 1000 })"), 0);
  assert.equal(h.run("displayAspect({ width: 'x', height: 1080 })"), 0);
});

test("the layout with the largest video wins, and compact wins only by a clear margin", () => {
  const h = harness();
  const wide = h.run(`chooseLayout(${JSON.stringify(stagesFor(ROOM_16_9_WINDOW))}, 16 / 9, null)`);
  assert.equal(wide.full.name, "stack");
  assert.equal(wide.compact.name, "stack");
  assert.equal(wide.compactWins, true);
  // A 21:9 window has room for the full panel beside 16:9 video.
  const cinema = h.run(`chooseLayout(${JSON.stringify(stagesFor(ROOM_21_9_WINDOW))}, 16 / 9, null)`);
  assert.equal(cinema.full.name, "side");
  assert.equal(cinema.compactWins, false);
  // 4:3 video in the 16:9 window leaves room beside it, so the full side panel costs little.
  const classic = h.run(`chooseLayout(${JSON.stringify(stagesFor(ROOM_16_9_WINDOW))}, 4 / 3, null)`);
  assert.equal(classic.full.name, "side");
  assert.equal(classic.compactWins, false);
});

test("a nearly equal layout is kept while resizing", () => {
  const h = harness();
  const stages = JSON.stringify([
    { width: 1010, height: 600 }, { width: 1020, height: 600 },
    { width: 1000, height: 600 }, { width: 1100, height: 580 }
  ]);
  assert.equal(h.run(`chooseLayout(${stages}, 16 / 9, null)`).full.name, "stack");
  assert.equal(h.run(`chooseLayout(${stages}, 16 / 9, { name: "side" })`).full.name, "side");
});

test("the full panel collapses below 80% and expands again only above 85%", () => {
  const h = harness();
  // The full panel leaves 905x905 for square video, the compact one 1000x1000: 82%.
  const stages = JSON.stringify([{ width: 905, height: 905 }, { width: 1, height: 1 }, { width: 1000, height: 1000 }, { width: 1, height: 1 }]);
  assert.equal(h.run(`chooseLayout(${stages}, 1, null, false)`).compactWins, false);
  assert.equal(h.run(`chooseLayout(${stages}, 1, null, true)`).compactWins, true);
});

test("streaming collapses the panel when the window matches the video; the toggle overrides it until the situation changes", async () => {
  const room = { current: ROOM_16_9_WINDOW };
  const h = layoutHarness(room);
  h.run("updateLayout()");
  assert.equal(h.layout.className, "layout is-stack");
  assert.equal(h.toggle.attributes["aria-expanded"], "true");

  // The layout is arranged before the start, so the player opens at its final place.
  await h.start();
  assert.match(h.launches[0], /"--rect" "41,0,1198,674"/);
  await h.run("refreshState()");
  assert.equal(h.layout.className, "layout is-stack is-compact");
  assert.equal(h.toggle.attributes["aria-expanded"], "false");
  assert.deepEqual([h.host.width, h.host.height], ["1198px", "674px"]);
  assert.deepEqual(h.rects(), [], "the player already has this rectangle");

  h.toggle.click();
  assert.equal(h.layout.className, "layout is-stack");
  assert.deepEqual(h.rects(), ["RECT 133,0,1013,570\n"]);
  await h.run("refreshState()");
  assert.equal(h.layout.className, "layout is-stack", "the user's choice survives the periodic refresh");

  // A wider window has room for the full panel, so the automatic choice changes.
  h.resize(ROOM_21_9_WINDOW);
  assert.equal(h.layout.className, "layout is-side");
  h.resize(ROOM_16_9_WINDOW);
  assert.equal(h.layout.className, "layout is-stack is-compact");

  await h.run("stopOperation()");
  assert.equal(h.layout.className, "layout is-stack");
});

test("the layout is measured again only when something it depends on changed", async () => {
  const room = { current: ROOM_16_9_WINDOW };
  const h = layoutHarness(room);
  h.run("updateLayout()");
  const afterFirst = h.measured();
  for (let i = 0; i < 3; i += 1) await h.run("refreshState()");
  assert.equal(h.measured(), afterFirst);
  h.resize(ROOM_21_9_WINDOW);
  assert.ok(h.measured() > afterFirst);
  // The stage observer forces a pass when the stage changed for another reason.
  const beforeForced = h.measured();
  h.run("updateLayout(true)");
  assert.ok(h.measured() > beforeForced);
});

test("measuring the layouts keeps the panel's scroll position and the field being typed in", () => {
  const room = { current: ROOM_16_9_WINDOW };
  const h = layoutHarness(room);
  const field = h.elements.get("filename");
  const calls = [];
  let focused = field;
  Object.assign(field, {
    selectionStart: 3, selectionEnd: 5, getClientRects: () => [{}],
    focus() { calls.push("focus"); focused = field; },
    setSelectionRange(from, to) { calls.push(`select ${from}-${to}`); }
  });
  h.panel.contains = (element) => element === field;
  Object.defineProperty(h.run("document"), "activeElement", { get: () => focused });
  // A compact class hides the fields, which takes the focus away and clamps the scrolling.
  let className = "";
  Object.defineProperty(h.layout, "className", {
    get: () => className,
    set(value) {
      className = value;
      if (value.includes("is-compact")) { focused = null; h.panel.scrollTop = 0; }
    }
  });
  h.panel.scrollTop = 120;
  h.run("updateLayout()");
  assert.equal(h.layout.className, "layout is-stack");
  assert.equal(h.panel.scrollTop, 120);
  assert.deepEqual(calls, ["focus", "select 3-5"]);
});

test("the stream's aspect ratio sizes the video box, and spare width widens the side panel", async () => {
  const room = { current: ROOM_16_9_WINDOW };
  const h = layoutHarness(room);
  await h.start();
  await h.playerOutput('{"event":"video","width":1440,"height":1080,"sarNum":1,"sarDen":1}\n');
  assert.equal(h.run("videoAspect"), 4 / 3);
  assert.equal(h.layout.className, "layout is-side");
  assert.equal(h.panel.style.width, "384px");
  assert.deepEqual([h.host.width, h.host.height, h.host.left, h.host.top], ["896px", "672px", "0px", "24px"]);

  // 4:3 in a 21:9 window: the side panel takes 176 px of the spare width (up to its largest width, 560 px), the rest is centered.
  h.resize(ROOM_21_9_WINDOW);
  assert.equal(h.panel.style.width, "560px");
  assert.deepEqual([h.host.width, h.host.height, h.host.left, h.host.top], ["960px", "720px", "80px", "0px"]);

  await h.run("stopOperation()");
  assert.equal(h.run("videoAspect"), 4 / 3, "the last aspect ratio stays after the player stops");
});

test("a toggle while idle collapses the panel and the next stream decides again", async () => {
  const room = { current: ROOM_21_9_WINDOW };
  const h = layoutHarness(room);
  h.run("updateLayout()");
  h.toggle.click();
  assert.equal(h.layout.className, "layout is-side is-compact");
  await h.start();
  await h.run("refreshState()");
  assert.equal(h.layout.className, "layout is-side is-compact", "nothing changed automatically, so the choice stays");
  h.toggle.click();
  assert.equal(h.layout.className, "layout is-side");
});

test("a failed start leaves the idle layout", async () => {
  const room = { current: ROOM_16_9_WINDOW };
  const h = layoutHarness(room);
  h.run("updateLayout()");
  h.os.spawnProcess = async () => { throw new Error("spawn failed"); };
  assert.equal((await h.start()).ok, false);
  await h.run("refreshState()");
  assert.equal(h.layout.className, "layout is-stack");
  assert.equal(h.run("startingStream"), false);
});

test("without a player binary the panel is the whole window", () => {
  const h = harness();
  h.run("layoutReady = true; videoHost.hidden = true; updateLayout()");
  assert.equal(h.elements.get("layout").className, "layout is-side no-video");
});

test("Windows RC statistics command reads a real TCP response and handles a closed port", { skip: process.platform !== "win32" }, async () => {
  const h = harness();
  const server = createServer((socket) => {
    socket.on("data", (data) => {
      assert.match(data.toString(), /stats\n/);
      socket.write("| lokalizalt szamlalo : 1234 KiB\r\n");
      setTimeout(() => socket.end("+----[ end of statistical info ]\r\n"), 30);
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  h.os.execCommand = async (command) => {
    const result = await promisify(execFile)("powershell", command.split(" ").slice(1), { windowsHide: true, timeout: 10000 });
    return { exitCode: 0, stdOut: result.stdout };
  };
  try {
    assert.equal(await h.run(`readPreviewProgress('127.0.0.1:${port}')`), 1234);
  } finally {
    await new Promise((done) => server.close(done));
  }
  await assert.rejects(h.run(`readPreviewProgress('127.0.0.1:${port}')`));
});

// ---- optional camera control ----

function cameraHarness() {
  const h = harness();
  h.files.set("/app/player/vlc-rec-camera-win_x64.exe", 1);
  h.run('parameters.camera_ip = "192.168.1.50"');
  return h;
}

const cameraLines = (h) => h.stdin.filter((line) => /^(CENTER|ZOOM|NUDGE|SPEED|STOP)/.test(line));

test("camera: the helper starts with the settings, and only then the zoom buttons show", async () => {
  const h = cameraHarness();
  assert.equal(h.elements.get("cameraBar") && h.elements.get("cameraBar").hidden, true);
  await h.run("startCamera()");
  assert.equal(h.launches.length, 1);
  assert.match(h.launches[0], /vlc-rec-camera-win_x64\.exe"/);
  for (const pair of ['"--ip" "192.168.1.50"', '"--hfov" "76"', '"--zoom-ratio" "4.6"', '"--zoom-max" "36"', '"--speed" "10"', '"--nudge-speed" "30"']) {
    assert.ok(h.launches[0].includes(pair), `${pair} in ${h.launches[0]}`);
  }
  assert.equal(h.elements.get("cameraBar").hidden, false);
});

test("camera: no address, a bad address or no helper binary leaves the feature off", async () => {
  const none = harness();
  none.files.set("/app/player/vlc-rec-camera-win_x64.exe", 1);
  await none.run("startCamera()");
  assert.equal(none.launches.length, 0);

  const bad = cameraHarness();
  bad.run('parameters.camera_ip = "192.168.1.999"');
  await bad.run("startCamera()");
  assert.equal(bad.launches.length, 0);

  const missing = harness();
  missing.run('parameters.camera_ip = "192.168.1.50"');
  await missing.run("startCamera()");
  assert.equal(missing.launches.length, 0);
  assert.equal(missing.elements.get("cameraBar").hidden, true);
});

test("camera: a click turns the camera, a second one waits, the middle and an idle app do nothing", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  // The video box of the harness is 640x360 at (10, 20); the stream aspect is 16:9.
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  assert.deepEqual(cameraLines(h), [], "nothing is turned while no stream runs");

  assert.equal((await h.start(false)).ok, true);
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  assert.deepEqual(cameraLines(h), ["CENTER 0.7500 0.5000 1.7778\n"]);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(cameraLines(h).length, 1, "a click right after a turn aims at an out of date picture");
  h.advance(1100);
  h.run("handleVideoClick({ clientX: 330, clientY: 200 })");
  assert.equal(cameraLines(h).length, 1, "the middle needs no turn");
  h.run("handleVideoClick({ clientX: 10, clientY: 20 })");
  assert.equal(cameraLines(h)[1], "CENTER 0.0000 0.0000 1.7778\n");
});

test("camera: the aspect ratio of the stream goes with the click", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  await h.start(false);
  h.run("videoAspect = 4 / 3");
  h.run("handleVideoClick({ clientX: 650, clientY: 380 })");
  assert.deepEqual(cameraLines(h), ["CENTER 1.0000 1.0000 1.3333\n"]);
});

test("camera: the wheel zooms by half a step per notch, thinned out; up is in", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  let prevented = 0;
  h.run("globalThis.prevented = 0");
  h.run("handleStageWheel({ deltaY: -100, preventDefault() { globalThis.prevented++; } })");
  h.run("handleStageWheel({ deltaY: -100, preventDefault() { globalThis.prevented++; } })");
  assert.deepEqual(cameraLines(h), ["ZOOM 2\n"], "key repeat style bursts are thinned out");
  h.advance(200);
  h.run("handleStageWheel({ deltaY: 100, preventDefault() { globalThis.prevented++; } })");
  assert.deepEqual(cameraLines(h), ["ZOOM 2\n", "ZOOM -2\n"]);
  assert.equal(h.run("globalThis.prevented"), 3, "the page does not scroll");
  prevented = 0;
  void prevented;
});

test("camera: the zoom buttons use the configured step", async () => {
  const h = cameraHarness();
  h.run("parameters.camera_zoom_step = 15");
  await h.run("startCamera()");
  h.elements.get("zoomInBtn").click();
  h.elements.get("zoomOutBtn").click();
  assert.deepEqual(cameraLines(h), ["ZOOM 15\n", "ZOOM -15\n"]);
});

test("camera: arrow keys nudge the pan and tilt unless a field is being edited", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  const key = (extra) => h.run(`handleKeyDown(${JSON.stringify({ key: "ArrowRight", target: { tagName: "BODY" }, ...extra })
    .replace(/}$/, ", preventDefault() {} }")})`);
  key({});
  assert.deepEqual(cameraLines(h), ["NUDGE 2 0\n"]);
  key({});
  assert.equal(cameraLines(h).length, 1, "key repeat is thinned out");
  h.advance(100);
  key({ key: "ArrowUp", shiftKey: true });
  h.advance(100);
  key({ key: "ArrowLeft" });
  h.advance(100);
  key({ key: "ArrowDown" });
  assert.deepEqual(cameraLines(h), ["NUDGE 2 0\n", "NUDGE 0 10\n", "NUDGE -2 0\n", "NUDGE 0 -2\n"]);

  h.advance(100);
  key({ target: { tagName: "INPUT" } });
  key({ target: { tagName: "SELECT" } });
  key({ ctrlKey: true });
  key({ key: "a" });
  assert.equal(cameraLines(h).length, 4, "typing, shortcuts and other keys are left alone");

  h.elements.get("scanDialog").hidden = false;
  key({});
  assert.equal(cameraLines(h).length, 4, "not while a dialog is open");
});

test("camera: Escape still closes the scan dialog", () => {
  const h = harness();
  h.elements.get("scanDialog").hidden = false;
  h.run('handleKeyDown({ key: "Escape", target: { tagName: "BODY" }, preventDefault() {} })');
  assert.equal(h.elements.get("scanDialog").hidden, true);
});

test("camera: a message from the helper is shown with the status for a few seconds", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  const id = h.run("cameraProc.id");
  const event = (detail) => h.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, ...detail })} })`);
  event({ action: "stdOut", data: '{"event":"error","code":"no-reply","message":"The camera did not report its position."}\n' });
  assert.equal(h.run("withCameraNote('Preview.')"), "Preview. Camera: The camera did not report its position.");
  h.advance(7000);
  assert.equal(h.run("withCameraNote('Preview.')"), "Preview.");

  // A line split between two chunks is put together.
  event({ action: "stdOut", data: '{"event":"ready","answ' });
  event({ action: "stdOut", data: 'ered":false}\n' });
  assert.match(h.run("withCameraNote('')"), /does not answer/);

  event({ action: "exit" });
  assert.equal(h.elements.get("cameraBar").hidden, true);
  assert.equal(h.run("cameraActive()"), false);
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  assert.deepEqual(cameraLines(h), [], "nothing is sent to a helper that is gone");
});

test("camera: closing the window stops the helper", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  h.run("stopCamera()");
  assert.deepEqual(cameraLines(h), ["STOP\n"]);
});

test("camera: the speed slider shows the configured speed, follows the thumb, and tells the helper when it is let go", async () => {
  const h = cameraHarness();
  h.run("parameters.camera_turn_speed = 30");
  await h.run("startCamera()");
  const slider = h.elements.get("cameraSpeed");
  const readout = h.elements.get("cameraSpeedValue");
  assert.equal(slider.value, "30");
  assert.equal(readout.textContent, "30 °/s");
  assert.match(h.launches[0], /"--speed" "30"/);

  // Any whole speed from 1 to 90 can be set, not only a few.
  slider.value = "7";
  slider.input();
  assert.equal(readout.textContent, "7 °/s", "the number follows the thumb");
  assert.deepEqual(cameraLines(h), [], "but nothing is sent while it is dragged");
  slider.change();
  assert.deepEqual(cameraLines(h), ["SPEED 7\n"]);
  assert.equal(h.run("parameters.camera_turn_speed"), 7);
  assert.match(h.files.get("/app/vlc_rec_params.json"), /"camera_turn_speed": 7/, "the choice is saved");

  slider.value = "90";
  slider.change();
  slider.value = "1";
  slider.change();
  assert.deepEqual(cameraLines(h), ["SPEED 7\n", "SPEED 90\n", "SPEED 1\n"]);

  slider.value = "0"; // out of range: ignored
  slider.change();
  assert.equal(cameraLines(h).length, 3);
});

test("camera: the panel is arranged again when the camera controls appear and when the helper goes", async () => {
  const h = cameraHarness();
  const layout = h.elements.get("layout");
  assert.notEqual(layout.dataset.camera, "on");
  await h.run("startCamera()");
  assert.equal(layout.dataset.camera, "on", "the CSS has layouts with the camera controls");
  const withControls = h.run("layoutInputKey()");
  const id = h.run("cameraProc.id");
  h.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, action: "exit" })} })`);
  assert.equal(layout.dataset.camera, "off");
  assert.notEqual(h.run("layoutInputKey()"), withControls, "a change of the controls makes a new layout pass");
});

test("the status line is plain, and a warning or an error says so", async () => {
  const h = harness();
  const status = h.elements.get("status");
  await h.start(false);
  await h.run("refreshState()");
  assert.equal(status.dataset.kind, "info");
  assert.match(status.textContent, /VLC started in preview mode/);

  // The stream stops and nothing reconnects it: the process ends with a message.
  h.run("currentProcess.errorMessage = 'Cannot open the stream.'");
  await h.run("parameters.auto_reconnect = false");
  await h.exit();
  assert.equal(status.dataset.kind, "error");
  assert.match(status.textContent, /Cannot open the stream/);

  // With reconnecting on, the wait for the next try is a warning, a started preview plain again.
  const again = harness();
  const line = again.elements.get("status");
  await again.start(false);
  await again.exit();
  assert.equal(line.dataset.kind, "warn");
  assert.match(line.textContent, /reconnecting in 5 seconds/);
  again.advance(6000);
  await again.run("monitorStream()");
  assert.equal(line.dataset.kind, "info");

  // A message from the camera helper turns a plain status into a warning, an error stays an error.
  const cam = cameraHarness();
  await cam.run("startCamera()");
  const id = cam.run("cameraProc.id");
  cam.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, action: "stdOut", data: '{"event":"error","message":"No answer."}\n' })} })`);
  await cam.run("refreshState()");
  assert.equal(cam.elements.get("status").dataset.kind, "warn");
  assert.match(cam.elements.get("status").textContent, /Camera: No answer\./);

  // Nothing to say: no kind.
  const quiet = harness();
  quiet.run("setStatus('')");
  assert.equal(quiet.elements.get("status").dataset.kind, "");
});

test("camera: the next click waits for a slow turn to end and the picture to catch up", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  await h.start(false);
  const id = h.run("cameraProc.id");
  const event = (data) => h.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, action: "stdOut", data })} })`);
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  assert.equal(cameraLines(h).length, 1);
  // 19 degrees at 10 degrees per second: 400 ms to start + 1900 ms + 800 ms for the picture.
  event('{"event":"turned","moved":true,"fromPan":-19,"fromTilt":-3,"toPan":0,"toTilt":-3,"zoom":9}\n');
  h.advance(2500);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(cameraLines(h).length, 1, "still turning");
  h.advance(700);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(cameraLines(h).length, 2, "the turn is over and the picture has caught up");
});

test("camera: choosing a scan result sets the camera address too and restarts the helper there", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  await h.run('applySelectedAddress("192.168.1.77:5000")');
  assert.equal(h.run("parameters.camera_ip"), "192.168.1.77");
  assert.match(h.files.get("/app/vlc_rec_params.json"), /"camera_ip": "192\.168\.1\.77"/, "saved with the settings");
  assert.ok(h.stdin.includes("STOP\n"), "the old helper is asked to stop");
  assert.equal(h.launches.length, 2);
  assert.ok(h.launches[1].includes('"--ip" "192.168.1.77"'), h.launches[1]);
  assert.match(h.run("withCameraNote('')"), /address set to 192\.168\.1\.77/);

  // The same address again, or something that is not an address, leaves the helper alone.
  await h.run('applySelectedAddress("192.168.1.77:5001")');
  await h.run('applySelectedAddress("srt-encoder.local:5000")');
  assert.equal(h.launches.length, 2);
  assert.equal(h.run("parameters.camera_ip"), "192.168.1.77");
});

test("camera: a scan result switches the feature on when no camera address was set", async () => {
  const h = harness();
  h.files.set("/app/player/vlc-rec-camera-win_x64.exe", 1);
  await h.run('applySelectedAddress("192.168.1.50:5000")');
  assert.equal(h.launches.length, 1);
  assert.ok(h.launches[0].includes('"--ip" "192.168.1.50"'));
  assert.equal(h.elements.get("cameraBar").hidden, false);
});

test("the player gets a short network cache for the preview, any value from 0 is taken as it is and a negative value means VLC defaults", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start(false);
  assert.ok(h.launches[0].includes('"--caching" "500"'), h.launches[0]);
  await h.exit();
  h.run("parameters.preview_caching_ms = 100"); // how low it can go depends on the network: not guessed
  await h.start(false);
  assert.ok(h.launches[1].includes('"--caching" "100"'), h.launches[1]);
  await h.exit();
  h.run("parameters.preview_caching_ms = 0");
  await h.start(false);
  assert.ok(h.launches[2].includes('"--caching" "0"'), h.launches[2]);
  await h.exit();
  h.run("parameters.preview_caching_ms = -1");
  await h.start(false);
  assert.ok(!h.launches[3].includes("--caching"), h.launches[3]);
});

test("external VLC also gets the short network cache", async () => {
  const h = harness();
  await h.start(false);
  assert.ok(h.launches[0].includes('"--network-caching=500"'), h.launches[0]);
});

test("the preview buffer field shows the buffer of the settings and saves a new one within the limits", async () => {
  const h = harness();
  const field = h.elements.get("previewCaching");
  await h.run("refreshState()");
  assert.equal(field.value, "500", "the default");

  field.value = "800";
  field.change();
  assert.equal(h.run("parameters.preview_caching_ms"), 800);
  assert.match(h.files.get("/app/vlc_rec_params.json"), /"preview_caching_ms": 800/, "saved");

  field.value = "60"; // a fast network can do with this: not raised
  field.change();
  assert.equal(h.run("parameters.preview_caching_ms"), 60);
  assert.equal(field.value, "60");

  field.value = "0";
  field.change();
  assert.equal(h.run("parameters.preview_caching_ms"), 0);

  field.value = "-5"; // not a buffer
  field.change();
  assert.equal(h.run("parameters.preview_caching_ms"), 0);

  field.value = "999999";
  field.change();
  assert.equal(h.run("parameters.preview_caching_ms"), 10000);

  field.value = "";
  field.change();
  assert.equal(h.run("parameters.preview_caching_ms"), 500, "an empty field means the default");

  // The next preview takes the value.
  h.enablePlayer();
  field.value = "900";
  field.change();
  await h.start(false);
  assert.ok(h.launches[0].includes('"--caching" "900"'), h.launches[0]);
});

test("a running preview says that it still has the old buffer, and the button restarts it with the new one", async () => {
  const h = harness();
  h.enablePlayer();
  const field = h.elements.get("previewCaching");
  const pending = h.elements.get("bufferPending");
  const apply = h.elements.get("bufferApplyBtn");
  await h.start(false);
  await h.run("refreshState()");
  assert.equal(pending.hidden, true, "nothing to say while the field and the running player agree");
  assert.equal(apply.hidden, true);

  field.value = "300";
  field.change();
  assert.equal(pending.hidden, false, "said at once, not at the next refresh");
  assert.equal(apply.hidden, false);
  assert.match(h.elements.get("bufferPendingText").textContent, /Not in use yet.*running preview has 500 ms/);

  apply.click();
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await h.run("refreshState()");
  assert.equal(h.launches.length, 2, "the preview was started again");
  assert.ok(h.launches[1].includes('"--caching" "300"'), h.launches[1]);
  assert.equal(h.run("mode"), "preview");
  assert.equal(pending.hidden, true, "and now it is in use");

  // Back to the old value while it runs: the note is back, with the value that is running.
  field.value = "500";
  field.change();
  assert.match(h.elements.get("bufferPendingText").textContent, /has 300 ms/);

  // The note goes with the process.
  await h.exit();
  await h.run("refreshState()");
  assert.equal(pending.hidden, true);
});

test("a running recording keeps its buffer: the note says so and there is no restart button", async () => {
  const h = harness();
  h.enablePlayer();
  const field = h.elements.get("previewCaching");
  await h.start(true);
  await h.run("refreshState()");
  field.value = "200";
  field.change();
  assert.equal(h.elements.get("bufferPending").hidden, false);
  assert.equal(h.elements.get("bufferApplyBtn").hidden, true, "a recording must not be cut");
  assert.match(h.elements.get("bufferPendingText").textContent, /recording keeps 500 ms; the next start takes the new one/);
  h.elements.get("bufferApplyBtn").click();
  assert.equal(h.launches.length, 1);
});

test("camera: the web page button opens the camera's page in the browser, and shows only with a camera address", async () => {
  const h = harness();
  const page = h.elements.get("cameraPage");
  await h.run("refreshState()");
  assert.equal(page.hidden, true, "no address, no button");

  h.run('parameters.camera_ip = "192.168.1.50"');
  await h.run("refreshState()");
  assert.equal(page.hidden, false);
  assert.equal(h.elements.get("cameraAddressText").textContent, "192.168.1.50");

  h.elements.get("cameraPageBtn").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.opened, ["http://192.168.1.50/"]);

  // Not an address: nothing is opened, and nothing is built from it.
  h.run('parameters.camera_ip = "192.168.1.50/../x"');
  await h.run("refreshState()");
  assert.equal(page.hidden, true);
  h.elements.get("cameraPageBtn").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.opened.length, 1);
});

test("camera: a browser that cannot be started is reported with the status", async () => {
  const h = harness();
  h.run('parameters.camera_ip = "192.168.1.50"');
  h.os.openFails = true;
  await h.run("openCameraPage()");
  assert.match(h.run("withCameraNote('')"), /could not open http:\/\/192.168.1.50\/ in the browser/);
});

test("camera: a scan result shows the web page button too", async () => {
  const h = harness();
  h.files.set("/app/player/vlc-rec-camera-win_x64.exe", 1);
  await h.run('applySelectedAddress("192.168.1.77:5000")');
  assert.equal(h.elements.get("cameraPage").hidden, false);
  assert.equal(h.elements.get("cameraAddressText").textContent, "192.168.1.77");
});

test("the preview buffer field shows VLC's 1000 for a setting of -1 and is left alone while it is edited", async () => {
  const h = harness();
  const field = h.elements.get("previewCaching");
  h.run("parameters.preview_caching_ms = -1");
  await h.run("refreshState()");
  assert.equal(field.value, "1000");
  h.run("document.activeElement = document.getElementById('previewCaching')");
  field.value = "6";
  await h.run("refreshState()");
  assert.equal(field.value, "6", "what is being typed is not overwritten by the one second refresh");
});

test("camera: the waiting after a click follows the duration the helper reports", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  await h.start(false);
  const id = h.run("cameraProc.id");
  const event = (data) => h.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, action: "stdOut", data })} })`);
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  // 5 degrees at 10 degrees per second would be 500 ms; the helper says 3000.
  event('{"event":"turned","moved":true,"fromPan":-19,"fromTilt":-3,"toPan":-24,"toTilt":-3,"zoom":9,"durationMs":3000}\n');
  h.advance(3500);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(cameraLines(h).length, 1, "400 + 3000 + 800 ms are not over yet");
  h.advance(1000);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(cameraLines(h).length, 2);
});
