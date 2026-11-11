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
  const timerDelays = [];
  const spawnOptions = [];
  const stdin = [];
  const opened = [];
  const logs = [];
  const env = new Map();
  // An element of the page; one that app.js makes (createElement) has the same parts, but is not in the page.
  const newElement = () => ({
    value: "", checked: false, hidden: true, style: {}, dataset: {}, attributes: {}, children: [],
    classList: { names: new Set(), add(name) { this.names.add(name); }, remove(name) { this.names.delete(name); } },
    addEventListener(name, handler) { this[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }, focus() {},
    replaceChildren(...children) { this.children = children; },
    blur() {},
    getBoundingClientRect() { return { left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380 }; }
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, newElement());
    return elements.get(id);
  };
  const os = {
    async getEnv(name) { return env.get(name) || ""; },
    async spawnProcess(command, options) {
      // A second connection may open only after the previous VLC has exited.
      // The camera adapter runs alongside and does not count.
      const camera = command.includes("/plugins/");
      spawnOptions.push(options || null);
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
    document: { getElementById: element, activeElement: null, createElement: () => ({ ...newElement(), hidden: false }) },
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
      else { timeouts.push(fn); timerDelays.push(delay); }
    },
    clearTimeout() {}, setInterval() {}
  });
  // Load production handlers and functions, leaving initialization explicit.
  runInContext(source.slice(0, source.lastIndexOf("\ninit().catch")), context);
  const run = (code) => runInContext(code, context);
  run("parameters.auto_reconnect = true");
  return {
    files, live, launches, actions, os, elements, events, timeouts, timerDelays, spawnOptions, run, stdin, env, opened, logs,
    advance(ms) { now += ms; },
    // Runs the latest timer that was set with this delay.
    fireTimer(delay) {
      const index = timerDelays.lastIndexOf(delay);
      assert.ok(index >= 0, `a timer of ${delay} ms is waiting`);
      const [fn] = timeouts.splice(index, 1);
      timerDelays.splice(index, 1);
      fn();
    },
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
// A camera adapter is a program that speaks JSON Lines. The harness plays it: the requests the app
// wrote to its stdin are read back, and the answers come in through the process events.

const pluginManifest = readFileSync(resolve(__dirname, "../plugins/obsbot-tail2/plugin.json"), "utf8");

const FULL_CAPS = {
  device: { model: "OBSBOT Tail 2", address: "192.168.1.50" },
  ptz: { centerOn: "estimated", nudge: true, speed: { min: 1, max: 90, default: 10, unit: "deg/s" } },
  zoom: { by: true },
  webPage: { url: "http://192.168.1.50/" }
};

function putAdapter(h, base) {
  h.files.set(`${base}/obsbot-tail2/plugin.json`, pluginManifest);
  h.files.set(`${base}/obsbot-tail2/obsbot-tail2-win_x64.exe`, 1);
}

function cameraHarness() {
  const h = harness();
  putAdapter(h, "/app/player/plugins");
  h.run('parameters.camera_plugin = "obsbot-tail2"; parameters.camera_config = { host: "192.168.1.50" }');
  return h;
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// The JSON requests the app has written to adapters (the player gets plain lines).
const cameraRequests = (h, ...methods) => h.stdin
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line))
  .filter((request) => !methods.length || methods.includes(request.method));

// A line from the running adapter.
function cameraSays(h, message) {
  const id = h.run("cameraProc.id");
  h.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, action: "stdOut", data: `${JSON.stringify(message)}\n` })} })`);
}

// Answers the oldest request of this method that has no answer yet: { result } or { error }.
async function cameraAnswers(h, method, outcome) {
  await flush();
  h.answered = h.answered || new Set();
  const entry = h.stdin.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("{"))
    .find(({ line, index }) => JSON.parse(line).method === method && !h.answered.has(index));
  assert.ok(entry, `a ${method} request is waiting`);
  h.answered.add(entry.index);
  cameraSays(h, { id: JSON.parse(entry.line).id, ...outcome });
  await flush();
}

// Starts the adapter and plays the handshake.
async function connectCamera(h, caps = FULL_CAPS) {
  await h.run("startCamera()");
  await cameraAnswers(h, "hello", { result: { interface: 1 } });
  await cameraAnswers(h, "connect", { result: { capabilities: caps } });
}

test("camera: the adapter is found by its manifest and started in its folder; the controls show only once it has connected", async () => {
  const h = cameraHarness();
  assert.equal(h.elements.get("cameraBar").hidden, true);
  await h.run("startCamera()");
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0], '"/app/player/plugins/obsbot-tail2/obsbot-tail2-win_x64.exe"');
  assert.equal(h.spawnOptions[0].cwd, "/app/player/plugins/obsbot-tail2");
  await flush();
  assert.deepEqual(cameraRequests(h).map((r) => r.method), ["hello"], "connect waits for the answer to hello");
  assert.deepEqual(cameraRequests(h)[0].params, { interface: 1, app: "vlc-rec" });

  await cameraAnswers(h, "hello", { result: { interface: 1, plugin: { id: "obsbot-tail2" } } });
  // The manifest's defaults complete what the settings give.
  assert.deepEqual(cameraRequests(h, "connect")[0].params.config,
    { host: "192.168.1.50", hfov: 76, zoomRatio: 4.6, zoomMax: 36, nudgeSpeed: 30, oscPort: 57110, localPort: 57120 });
  assert.equal(h.elements.get("cameraBar").hidden, true, "not connected yet");

  await cameraAnswers(h, "connect", { result: { capabilities: FULL_CAPS } });
  assert.equal(h.elements.get("cameraBar").hidden, false);
  assert.equal(h.elements.get("layout").dataset.camera, "on");
  assert.deepEqual(cameraRequests(h, "ptz.setSpeed").map((r) => r.params), [{ value: 10 }], "the speed of the app goes to the adapter");
});

test("camera: no adapter chosen, an unknown or an unusable one leaves the feature off", async () => {
  const none = cameraHarness();
  none.run('parameters.camera_plugin = ""');
  await none.run("startCamera()");
  assert.equal(none.launches.length, 0);
  assert.equal(none.elements.get("cameraBar").hidden, true);

  const unknown = cameraHarness();
  unknown.run('parameters.camera_plugin = "nope"');
  await unknown.run("startCamera()");
  assert.equal(unknown.launches.length, 0);
  assert.match(unknown.run("withCameraNote('')"), /adapter 'nope' was not found/);

  const badId = cameraHarness();
  badId.run('parameters.camera_plugin = "../obsbot-tail2"');
  await badId.run("startCamera()");
  assert.equal(badId.launches.length, 0);

  const noProgram = cameraHarness();
  noProgram.files.delete("/app/player/plugins/obsbot-tail2/obsbot-tail2-win_x64.exe");
  await noProgram.run("startCamera()");
  assert.equal(noProgram.launches.length, 0, "no program for this system");

  // A manifest of another interface, one for another id, and programs outside the adapter's folder.
  const edits = [
    (m) => { m.interface = 2; },
    (m) => { m.id = "other"; },
    (m) => { m.command.win_x64 = ["../escape.exe"]; },
    (m) => { m.command.win_x64 = ["C:/Windows/x.exe"]; },
    (m) => { m.command.win_x64 = ["/usr/bin/x"]; },
    (m) => { m.command = {}; }
  ];
  for (const edit of edits) {
    const h = cameraHarness();
    const manifest = JSON.parse(pluginManifest);
    edit(manifest);
    h.files.set("/app/player/plugins/obsbot-tail2/plugin.json", JSON.stringify(manifest));
    await h.run("startCamera()");
    assert.equal(h.launches.length, 0, JSON.stringify(manifest));
  }
});

test("camera: adapters are looked for in VLC_REC_PLUGIN_DIR, then in the settings folder, then beside the player", async () => {
  const beside = cameraHarness();
  putAdapter(beside, "/app/plugins");
  await beside.run("startCamera()");
  assert.match(beside.launches[0], /^"\/app\/plugins\/obsbot-tail2\//, "the settings folder is before the one beside the player");

  const env = cameraHarness();
  putAdapter(env, "/app/plugins");
  putAdapter(env, "/custom");
  env.env.set("VLC_REC_PLUGIN_DIR", "/custom");
  await env.run("startCamera()");
  assert.match(env.launches[0], /^"\/custom\/obsbot-tail2\//, "the variable is first");

  // The AppImage keeps its adapters in the image, where VLC_REC_PLAYER_DIR points.
  const image = harness();
  image.run('parameters.camera_plugin = "obsbot-tail2"; parameters.camera_config = { host: "192.168.1.50" }');
  image.env.set("VLC_REC_PLAYER_DIR", "/image/player");
  putAdapter(image, "/image/player/plugins");
  await image.run("startCamera()");
  assert.match(image.launches[0], /^"\/image\/player\/plugins\/obsbot-tail2\//);
});

test("camera: connect is asked again while the camera does not answer, unless the settings are wrong", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  await cameraAnswers(h, "hello", { result: {} });
  await cameraAnswers(h, "connect", { error: { code: "timeout", message: "The camera did not answer. Check the address and the network." } });
  assert.match(h.run("withCameraNote('')"), /did not answer/);
  assert.equal(h.elements.get("cameraBar").hidden, true);
  assert.equal(cameraRequests(h, "connect").length, 1);
  h.fireTimer(5000);
  await flush();
  assert.equal(cameraRequests(h, "connect").length, 2, "asked again after a pause");
  await cameraAnswers(h, "connect", { result: { capabilities: FULL_CAPS } });
  assert.equal(h.elements.get("cameraBar").hidden, false);

  const wrong = cameraHarness();
  await wrong.run("startCamera()");
  await cameraAnswers(wrong, "hello", { result: {} });
  await cameraAnswers(wrong, "connect", { error: { code: "invalid_params", message: "config.host must be the IPv4 address of the camera." } });
  assert.ok(!wrong.timerDelays.includes(5000), "a setting that is wrong is not asked again");
  assert.match(wrong.run("withCameraNote('')"), /config\.host/);
});

test("camera: an adapter that refuses hello or does not answer is reported", async () => {
  const h = cameraHarness();
  await h.run("startCamera()");
  await cameraAnswers(h, "hello", { error: { code: "unsupported", message: "interface 2 only" } });
  assert.match(h.run("withCameraNote('')"), /does not take part: interface 2 only/);
  assert.equal(cameraRequests(h, "connect").length, 0);

  // A program that is new on the machine can take ten seconds to start on Windows: hello is waited for 30 s.
  const slow = cameraHarness();
  await slow.run("startCamera()");
  await flush();
  assert.ok(slow.timerDelays.includes(30000) && !slow.timerDelays.includes(3000), "the wait for hello is long");
  slow.advance(10500);
  await cameraAnswers(slow, "hello", { result: {} }); // the answer comes late, and is still taken
  assert.equal(cameraRequests(slow, "connect").length, 1);
  await cameraAnswers(slow, "connect", { result: { capabilities: FULL_CAPS } });
  assert.equal(slow.elements.get("cameraBar").hidden, false);

  const silent = cameraHarness();
  await silent.run("startCamera()");
  await flush();
  silent.fireTimer(30000); // and when it never comes
  await flush();
  assert.match(silent.run("withCameraNote('')"), /did not answer hello/);
});

test("camera: a click turns the camera, a second one waits, the middle and an idle app do nothing", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  const turns = () => cameraRequests(h, "ptz.centerOn");
  // The video box of the harness is 640x360 at (10, 20); the stream aspect is 16:9.
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  assert.deepEqual(turns(), [], "nothing is turned while no stream runs");

  assert.equal((await h.start(false)).ok, true);
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  assert.deepEqual(turns().map((r) => r.params), [{ x: 0.75, y: 0.5, aspect: 1.7778 }]);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(turns().length, 1, "a click right after a turn aims at an out of date picture");
  h.advance(1100);
  h.run("handleVideoClick({ clientX: 330, clientY: 200 })");
  assert.equal(turns().length, 1, "the middle needs no turn");
  h.run("handleVideoClick({ clientX: 10, clientY: 20 })");
  assert.deepEqual(turns()[1].params, { x: 0, y: 0, aspect: 1.7778 });
});

test("camera: the aspect ratio of the stream goes with the click", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  await h.start(false);
  h.run("videoAspect = 4 / 3");
  h.run("handleVideoClick({ clientX: 650, clientY: 380 })");
  assert.deepEqual(cameraRequests(h, "ptz.centerOn").map((r) => r.params), [{ x: 1, y: 1, aspect: 1.3333 }]);
});

test("camera: the controls follow what the adapter declares, and what it says later", async () => {
  // Only zoom: no speed slider; clicks and arrow keys do nothing.
  const h = cameraHarness();
  await connectCamera(h, { zoom: { by: true } });
  assert.equal(h.elements.get("cameraBar").hidden, false);
  assert.equal(h.elements.get("cameraZoomItem").hidden, false);
  assert.equal(h.elements.get("cameraSpeedItem").hidden, true);
  await h.start(false);
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  h.run('handleKeyDown({ key: "ArrowRight", target: { tagName: "BODY" }, preventDefault() {} })');
  assert.deepEqual(cameraRequests(h).map((r) => r.method), ["hello", "connect"], "no centering, no nudging, no speed");
  h.elements.get("zoomInBtn").click();
  assert.equal(cameraRequests(h, "zoom.by").length, 1);
  assert.equal(h.elements.get("cameraHint").textContent, "Mouse wheel: zoom.");

  // Only turning: no bar at all, but the hint.
  const turnOnly = cameraHarness();
  await connectCamera(turnOnly, { ptz: { centerOn: "native", nudge: true } });
  assert.equal(turnOnly.elements.get("cameraBar").hidden, true);
  assert.equal(turnOnly.elements.get("layout").dataset.camera, "off");
  await turnOnly.start(false);
  turnOnly.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  assert.equal(cameraRequests(turnOnly, "ptz.centerOn").length, 1);
  assert.match(turnOnly.elements.get("cameraHint").textContent, /Click the picture.*Arrow keys/);

  // Nothing at all: no panel either.
  const nothing = cameraHarness();
  await connectCamera(nothing, {});
  assert.equal(nothing.elements.get("cameraBar").hidden, true);
  assert.equal(nothing.elements.get("cameraPage").hidden, true);

  // A new capabilities event replaces the old; a lost camera takes the controls until it is back.
  cameraSays(h, { event: "capabilities", capabilities: FULL_CAPS });
  assert.equal(h.elements.get("cameraSpeedItem").hidden, false);
  cameraSays(h, { event: "state", state: "lost", reason: "The camera does not answer." });
  assert.equal(h.elements.get("cameraBar").hidden, true);
  assert.match(h.run("withCameraNote('')"), /does not answer/);
  cameraSays(h, { event: "capabilities", capabilities: FULL_CAPS });
  assert.equal(h.elements.get("cameraBar").hidden, false);
});

test("camera: the wheel zooms by half a step per notch, thinned out; up is in", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  h.run("globalThis.prevented = 0");
  h.run("handleStageWheel({ deltaY: -100, preventDefault() { globalThis.prevented++; } })");
  h.run("handleStageWheel({ deltaY: -100, preventDefault() { globalThis.prevented++; } })");
  assert.deepEqual(cameraRequests(h, "zoom.by").map((r) => r.params), [{ delta: 0.05 }], "bursts are thinned out; a step is 10 percent of the range");
  h.advance(200);
  h.run("handleStageWheel({ deltaY: 100, preventDefault() { globalThis.prevented++; } })");
  assert.deepEqual(cameraRequests(h, "zoom.by").map((r) => r.params), [{ delta: 0.05 }, { delta: -0.05 }]);
  assert.equal(h.run("globalThis.prevented"), 3, "the page does not scroll");
});

test("camera: the zoom buttons use the configured step", async () => {
  const h = cameraHarness();
  h.run("parameters.camera_zoom_step = 15");
  await connectCamera(h);
  h.elements.get("zoomInBtn").click();
  h.elements.get("zoomOutBtn").click();
  assert.deepEqual(cameraRequests(h, "zoom.by").map((r) => r.params), [{ delta: 0.15 }, { delta: -0.15 }]);
});

test("camera: arrow keys nudge the pan and tilt unless a field is being edited", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  const nudges = () => cameraRequests(h, "ptz.nudge").map((r) => r.params);
  const key = (extra) => h.run(`handleKeyDown(${JSON.stringify({ key: "ArrowRight", target: { tagName: "BODY" }, ...extra })
    .replace(/}$/, ", preventDefault() {} }")})`);
  key({});
  assert.deepEqual(nudges(), [{ pan: 2, tilt: 0 }]);
  key({});
  assert.equal(nudges().length, 1, "key repeat is thinned out");
  h.advance(100);
  key({ key: "ArrowUp", shiftKey: true });
  h.advance(100);
  key({ key: "ArrowLeft" });
  h.advance(100);
  key({ key: "ArrowDown" });
  assert.deepEqual(nudges(), [{ pan: 2, tilt: 0 }, { pan: 0, tilt: 10 }, { pan: -2, tilt: 0 }, { pan: 0, tilt: -2 }]);

  h.advance(100);
  key({ target: { tagName: "INPUT" } });
  key({ target: { tagName: "SELECT" } });
  key({ ctrlKey: true });
  key({ key: "a" });
  assert.equal(nudges().length, 4, "typing, shortcuts and other keys are left alone");

  h.elements.get("scanDialog").hidden = false;
  key({});
  assert.equal(nudges().length, 4, "not while a dialog is open");
});

test("camera: Escape still closes the scan dialog", () => {
  const h = harness();
  h.elements.get("scanDialog").hidden = false;
  h.run('handleKeyDown({ key: "Escape", target: { tagName: "BODY" }, preventDefault() {} })');
  assert.equal(h.elements.get("scanDialog").hidden, true);
});

test("camera: a message from the adapter is shown with the status for a few seconds", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  cameraSays(h, { event: "error", code: "timeout", message: "The camera did not report its position." });
  assert.equal(h.run("withCameraNote('Preview.')"), "Preview. Camera: The camera did not report its position.");
  h.advance(7000);
  assert.equal(h.run("withCameraNote('Preview.')"), "Preview.");

  // A line split between two chunks is put together, and a line that is not JSON is ignored.
  const id = h.run("cameraProc.id");
  const chunk = (data) => h.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, action: "stdOut", data })} })`);
  chunk("not json\n");
  chunk('{"event":"error","mess');
  chunk('age":"Split."}\n');
  assert.match(h.run("withCameraNote('')"), /Split\./);

  // An error as the answer to a request is a note too.
  await h.start(false);
  h.advance(7000);
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  await cameraAnswers(h, "ptz.centerOn", { error: { code: "busy", message: "The camera is moving." } });
  assert.match(h.run("withCameraNote('')"), /The camera is moving\./);

  chunk(`${JSON.stringify({ id: 0, result: {} })}\n`); // the answer to a request nobody waits for
  h.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, action: "exit" })} })`);
  assert.equal(h.elements.get("cameraBar").hidden, true);
  assert.equal(h.run("cameraActive()"), false);
  const sent = cameraRequests(h).length;
  h.advance(2000);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(cameraRequests(h).length, sent, "nothing is sent to an adapter that is gone");
  assert.match(h.run("withCameraNote('')"), /adapter stopped/);
});

test("camera: a request that gets no answer times out and says so", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  await h.start(false);
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  await flush();
  h.fireTimer(3000);
  await flush();
  assert.match(h.run("withCameraNote('')"), /did not answer ptz\.centerOn/);
});

test("camera: closing the window stops the adapter", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  h.run("stopCamera()");
  assert.equal(cameraRequests(h, "shutdown").length, 1);
});

test("camera: the speed slider takes its range from the adapter, shows the configured speed, and tells the adapter when it is let go", async () => {
  const h = cameraHarness();
  h.run("parameters.camera_turn_speed = 30");
  await connectCamera(h);
  const slider = h.elements.get("cameraSpeed");
  const readout = h.elements.get("cameraSpeedValue");
  const speeds = () => cameraRequests(h, "ptz.setSpeed").map((r) => r.params.value);
  assert.equal(slider.value, "30");
  assert.equal(slider.min, "1");
  assert.equal(slider.max, "90");
  assert.equal(readout.textContent, "30 °/s");
  assert.deepEqual(speeds(), [30], "the setting goes to the adapter after connect");

  // Any whole speed within the range can be set, not only a few.
  slider.value = "7";
  slider.input();
  assert.equal(readout.textContent, "7 °/s", "the number follows the thumb");
  assert.deepEqual(speeds(), [30], "but nothing is sent while it is dragged");
  slider.change();
  assert.deepEqual(speeds(), [30, 7]);
  assert.equal(h.run("parameters.camera_turn_speed"), 7);
  await flush();
  assert.match(h.files.get("/app/vlc_rec_params.json"), /"camera_turn_speed": 7/, "the choice is saved");

  slider.value = "90";
  slider.change();
  slider.value = "1";
  slider.change();
  assert.deepEqual(speeds(), [30, 7, 90, 1]);

  slider.value = "0"; // out of range: ignored
  slider.change();
  assert.equal(speeds().length, 4);

  // An adapter with another range: the slider follows it, and a saved speed outside it is not used.
  const slow = cameraHarness();
  slow.run("parameters.camera_turn_speed = 60");
  await connectCamera(slow, { ...FULL_CAPS, ptz: { ...FULL_CAPS.ptz, speed: { min: 2, max: 45, unit: "deg/s" } } });
  const narrow = slow.elements.get("cameraSpeed");
  assert.equal(narrow.min, "2");
  assert.equal(narrow.max, "45");
  assert.equal(narrow.value, "10", "60 is outside 2 to 45: the default");
  narrow.value = "50";
  narrow.change();
  assert.equal(cameraRequests(slow, "ptz.setSpeed").length, 1, "50 is outside the range");
});

test("camera: the panel is arranged again when the camera controls appear and when the adapter goes", async () => {
  const h = cameraHarness();
  const layout = h.elements.get("layout");
  assert.notEqual(layout.dataset.camera, "on");
  await connectCamera(h);
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

  // A message from the camera adapter turns a plain status into a warning, an error stays an error.
  const cam = cameraHarness();
  await connectCamera(cam);
  cameraSays(cam, { event: "error", message: "No answer." });
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
  await connectCamera(h);
  await h.start(false);
  const turns = () => cameraRequests(h, "ptz.centerOn").length;
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  assert.equal(turns(), 1);
  // 19 degrees at 10 degrees per second: 400 ms to start + 1900 ms + 800 ms for the picture.
  cameraSays(h, { event: "turned", moved: true, fromPan: 19, fromTilt: 3, toPan: 0, toTilt: 3, zoom: 0.25 });
  h.advance(2500);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(turns(), 1, "still turning");
  h.advance(700);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(turns(), 2, "the turn is over and the picture has caught up");
});

test("camera: choosing a scan result moves the camera to that address too, and restarts the adapter there", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  await h.run('applySelectedAddress("192.168.1.77:5000")');
  assert.equal(h.run("parameters.camera_config.host"), "192.168.1.77");
  assert.match(h.files.get("/app/vlc_rec_params.json"), /"host": "192\.168\.1\.77"/, "saved with the settings");
  assert.equal(cameraRequests(h, "shutdown").length, 1, "the old adapter is asked to stop");
  assert.equal(h.launches.length, 2);
  assert.match(h.run("withCameraNote('')"), /address set to 192\.168\.1\.77/);
  await cameraAnswers(h, "hello", { result: {} });
  assert.equal(cameraRequests(h, "connect").at(-1).params.config.host, "192.168.1.77", "the new adapter connects there");

  // The same address again, or something that is not an address, leaves the adapter alone.
  await h.run('applySelectedAddress("192.168.1.77:5001")');
  await h.run('applySelectedAddress("srt-encoder.local:5000")');
  assert.equal(h.launches.length, 2);
  assert.equal(h.run("parameters.camera_config.host"), "192.168.1.77");

  // An adapter that takes no address is left alone too.
  const noHost = cameraHarness();
  const manifest = JSON.parse(pluginManifest);
  manifest.config = [];
  noHost.files.set("/app/player/plugins/obsbot-tail2/plugin.json", JSON.stringify(manifest));
  await noHost.run('applySelectedAddress("192.168.1.77:5000")');
  assert.equal(noHost.launches.length, 0);
  assert.equal(noHost.run("parameters.camera_config.host"), "192.168.1.50");
});

test("camera: a scan result starts no camera when no adapter was chosen", async () => {
  const h = harness();
  putAdapter(h, "/app/player/plugins");
  await h.run('applySelectedAddress("192.168.1.50:5000")');
  assert.equal(h.launches.length, 0);
  assert.equal(h.elements.get("cameraBar").hidden, true);
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
  await flush();
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

test("camera: the web page button opens the page the adapter names, and only a plain http or https address", async () => {
  const h = cameraHarness();
  const page = h.elements.get("cameraPage");
  await h.run("refreshState()");
  assert.equal(page.hidden, true, "no camera, no panel");

  await connectCamera(h);
  assert.equal(page.hidden, false);
  assert.equal(h.elements.get("cameraAddressText").textContent, "OBSBOT Tail 2 192.168.1.50");
  assert.equal(h.elements.get("cameraPageBtn").hidden, false);
  h.elements.get("cameraPageBtn").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.opened, ["http://192.168.1.50/"]);

  // Not a web address: no button, and nothing is opened.
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "http://x/ y", 'http://x/"', "ftp://x/", ""]) {
    const bad = cameraHarness();
    await connectCamera(bad, { ...FULL_CAPS, webPage: { url } });
    assert.equal(bad.elements.get("cameraPageBtn").hidden, true, url);
    bad.elements.get("cameraPageBtn").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bad.opened.length, 0, url);
  }
});

test("camera: a browser that cannot be started is reported with the status", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  h.os.openFails = true;
  await h.run("openCameraPage()");
  assert.match(h.run("withCameraNote('')"), /could not open http:\/\/192\.168\.1\.50\/ in the browser/);
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

test("camera: the waiting after a click follows the duration the adapter reports", async () => {
  const h = cameraHarness();
  await connectCamera(h);
  await h.start(false);
  const turns = () => cameraRequests(h, "ptz.centerOn").length;
  h.run("handleVideoClick({ clientX: 490, clientY: 200 })");
  // 5 degrees at 10 degrees per second would be 500 ms; the adapter says 3000.
  cameraSays(h, { event: "turned", moved: true, fromPan: 19, fromTilt: 3, toPan: 24, toTilt: 3, zoom: 0.25, durationMs: 3000 });
  h.advance(3500);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(turns(), 1, "400 + 3000 + 800 ms are not over yet");
  h.advance(1000);
  h.run("handleVideoClick({ clientX: 100, clientY: 100 })");
  assert.equal(turns(), 2);
});

test("camera: settings of earlier builds become the config of the obsbot-tail2 adapter", async () => {
  const h = harness();
  h.files.set("/app/vlc_rec_params.json", JSON.stringify({
    ip_address: "10.0.0.5:5000", camera_ip: "192.168.1.50", camera_hfov_deg: 80, camera_zoom_max: 36,
    camera_zoom_ratio: 5, camera_arrow_speed: 20, camera_turn_speed: 25, camera_zoom_step: 4, camera_arrow_step_deg: 3
  }));
  await h.run("loadParams()");
  assert.equal(h.run("parameters.camera_plugin"), "obsbot-tail2");
  assert.equal(h.run("JSON.stringify(parameters.camera_config)"),
    JSON.stringify({ host: "192.168.1.50", hfov: 80, zoomRatio: 5, zoomMax: 36, nudgeSpeed: 20 }));
  assert.equal(h.run("parameters.camera_zoom_step"), 11, "4 of 36 units is 11 percent of the range");
  assert.equal(h.run("parameters.camera_turn_speed"), 25);
  assert.equal(h.run("parameters.camera_arrow_step_deg"), 3);
  for (const key of ["camera_ip", "camera_hfov_deg", "camera_zoom_max", "camera_zoom_ratio", "camera_arrow_speed"]) {
    assert.equal(h.run(`"${key}" in parameters`), false, key);
  }

  // An old file without a camera keeps the feature off; a file of the new kind is left alone.
  const off = harness();
  off.files.set("/app/vlc_rec_params.json", JSON.stringify({ camera_ip: "", camera_zoom_step: 4, camera_zoom_max: 36 }));
  await off.run("loadParams()");
  assert.equal(off.run("parameters.camera_plugin"), "");
  assert.equal(off.run("parameters.camera_zoom_step"), 11);

  const current = harness();
  current.files.set("/app/vlc_rec_params.json", JSON.stringify({ camera_plugin: "other", camera_config: { host: "10.1.1.1" }, camera_zoom_step: 4 }));
  await current.run("loadParams()");
  assert.equal(current.run("parameters.camera_plugin"), "other");
  assert.equal(current.run("parameters.camera_zoom_step"), 4, "no camera_ip: the new format, nothing is converted");
});

// ---- camera presets ----

const PRESET_CAPS = {
  ...FULL_CAPS,
  ptz: { ...FULL_CAPS.ptz, absolute: true },
  zoom: { by: true, absolute: true }
};

// A key press with the modifiers named; `code` is the physical key, the character it makes is not the digit
// (on a Hungarian keyboard Alt+Ctrl+1 types a tilde).
function presetKey(h, code, modifiers = {}, extra = {}) {
  const evt = { key: "~", code, target: { tagName: "BODY" }, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...modifiers, ...extra };
  h.run("globalThis.prevented = 0");
  h.run(`handleKeyDown(${JSON.stringify(evt).replace(/}$/, ", preventDefault() { globalThis.prevented++; } }")})`);
  return h.run("globalThis.prevented");
}

const storedPresets = (h) => JSON.parse(h.run("JSON.stringify(parameters.camera_presets)"));
const presetClasses = (container) => container.children.map((button) => button.className);

// Plays the camera answering a teaching: position, then zoom.
async function camerasPose(h, pan, tilt, zoom) {
  if (pan !== undefined) await cameraAnswers(h, "ptz.get", { result: { pan, tilt } });
  if (zoom !== undefined) await cameraAnswers(h, "zoom.get", { result: { value: zoom } });
  await flush();
}

test("presets: ten buttons in two rows (1 to 9 and the fixed 0), only for a camera that can report and take its position", async () => {
  const none = cameraHarness();
  await connectCamera(none); // FULL_CAPS: no absolute moves
  assert.equal(none.elements.get("presetBar").hidden, true);
  assert.equal(none.elements.get("presetDrawer").hidden, true);
  assert.equal(presetKey(none, "Digit1"), 0, "the key is not taken when there are no presets");

  const h = cameraHarness();
  await connectCamera(h, PRESET_CAPS);
  for (const id of ["presetBar", "presetDrawer"]) {
    const row = h.elements.get(id);
    assert.equal(row.hidden, false, id);
    assert.deepEqual(row.children.map((button) => button.textContent), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
    assert.deepEqual(presetClasses(row), [...Array(9).fill("preset-btn"), "preset-btn is-both is-fixed"], "1 to 9 empty: gray; 0 is always there");
  }
  assert.match(h.elements.get("presetBar").children[0].title, /Preset 1 \(empty\)\. Alt\+1 teaches it/);
  assert.match(h.elements.get("cameraHint").textContent, /Keys 1-9: apply a preset\. Alt\+number: teach/);

  // Only a zoom: still presets, of zoom.
  const zoomOnly = cameraHarness();
  await connectCamera(zoomOnly, { zoom: { by: true, absolute: true } });
  assert.equal(zoomOnly.elements.get("presetBar").hidden, false);

  // The camera goes: the rows go.
  const id = h.run("cameraProc.id");
  h.run(`handleCameraProcessEvent({ detail: ${JSON.stringify({ id, action: "exit" })} })`);
  assert.equal(h.elements.get("presetBar").hidden, true);
  assert.equal(h.elements.get("presetBar").children.length, 0);
});

test("presets: Alt+number teaches position and zoom, Alt+Shift the position, Alt+Ctrl the zoom, Alt+Ctrl+Shift deletes", async () => {
  const h = cameraHarness();
  await connectCamera(h, PRESET_CAPS);

  assert.equal(presetKey(h, "Digit1", { altKey: true }), 1, "the key is for the presets");
  await camerasPose(h, -20, 5, 0.5);
  assert.deepEqual(storedPresets(h), { 1: { pan: -20, tilt: 5, zoom: 0.5 } });
  assert.match(h.run("withCameraNote('')"), /preset 1 taught: position and zoom/);

  presetKey(h, "Digit2", { altKey: true, shiftKey: true });
  await camerasPose(h, 30, -4, undefined);
  presetKey(h, "Digit3", { altKey: true, ctrlKey: true });
  await camerasPose(h, undefined, undefined, 0.25);
  assert.deepEqual(storedPresets(h), {
    1: { pan: -20, tilt: 5, zoom: 0.5 },
    2: { pan: 30, tilt: -4 },
    3: { zoom: 0.25 }
  });
  assert.equal(cameraRequests(h, "ptz.get").length, 2, "the position is asked for only when it is wanted");
  assert.equal(cameraRequests(h, "zoom.get").length, 2, "and the zoom too");
  for (const id of ["presetBar", "presetDrawer"]) {
    assert.deepEqual(presetClasses(h.elements.get(id)).slice(0, 4), ["preset-btn is-both", "preset-btn is-position", "preset-btn is-zoom", "preset-btn"], id);
  }
  assert.match(h.elements.get("presetBar").children[1].title, /Preset 2 \(position\)/);
  assert.match(h.files.get("/app/vlc_rec_params.json"), /"camera_presets": \{[^]*"pan": -20[^]*"zoom": 0\.25/, "kept in the settings");

  // Teaching again replaces the preset whole: the position of preset 1 only makes it a position preset.
  presetKey(h, "Digit1", { altKey: true, shiftKey: true });
  await camerasPose(h, 7, 8, undefined);
  assert.deepEqual(storedPresets(h)[1], { pan: 7, tilt: 8 });
  assert.equal(presetClasses(h.elements.get("presetBar"))[0], "preset-btn is-position");

  presetKey(h, "Digit2", { altKey: true, ctrlKey: true, shiftKey: true });
  assert.deepEqual(Object.keys(storedPresets(h)), ["1", "3"]);
  assert.equal(presetClasses(h.elements.get("presetBar"))[1], "preset-btn");
  assert.match(h.run("withCameraNote('')"), /preset 2 deleted/);
  presetKey(h, "Digit2", { altKey: true, ctrlKey: true, shiftKey: true });
  assert.match(h.run("withCameraNote('')"), /preset 2 is empty/);
});

test("presets: a number key applies the position and/or the zoom that was taught", async () => {
  const h = cameraHarness();
  h.run("parameters.camera_presets = { 1: { pan: -20, tilt: 5, zoom: 0.5 }, 2: { pan: 30, tilt: -4 }, 3: { zoom: 0.25 } }");
  await connectCamera(h, PRESET_CAPS);
  const sent = () => cameraRequests(h, "ptz.moveTo", "zoom.set").map((request) => [request.method, request.params]);

  presetKey(h, "Digit1");
  assert.deepEqual(sent(), [["ptz.moveTo", { pan: -20, tilt: 5 }], ["zoom.set", { value: 0.5 }]]);
  assert.match(h.run("withCameraNote('')"), /preset 1 applied/);
  presetKey(h, "Digit2");
  presetKey(h, "Numpad3"); // the keypad does the same
  assert.deepEqual(sent().slice(2), [["ptz.moveTo", { pan: 30, tilt: -4 }], ["zoom.set", { value: 0.25 }]],
    "a position preset moves only, a zoom preset zooms only");

  presetKey(h, "Digit4");
  assert.equal(sent().length, 4, "an empty slot sends nothing");
  assert.match(h.run("withCameraNote('')"), /preset 4 is empty; Alt\+4 teaches it/);

  // A click on the button does the same as the key.
  h.elements.get("presetBar").children[1].click();
  assert.deepEqual(sent().at(-1), ["ptz.moveTo", { pan: 30, tilt: -4 }]);
  h.elements.get("presetDrawer").children[2].click();
  assert.deepEqual(sent().at(-1), ["zoom.set", { value: 0.25 }]);
});

test("presets: only the right keys count", async () => {
  const h = cameraHarness();
  h.run("parameters.camera_presets = { 1: { pan: 1, tilt: 2 } }");
  await connectCamera(h, PRESET_CAPS);
  const moves = () => cameraRequests(h, "ptz.moveTo").length;

  assert.equal(presetKey(h, "Digit1", {}, { target: { tagName: "INPUT" } }), 0, "typing into a field");
  assert.equal(presetKey(h, "Digit1", {}, { target: { tagName: "SELECT" } }), 0);
  assert.equal(presetKey(h, "Digit1", { shiftKey: true }), 0, "Shift+1 is an exclamation mark");
  assert.equal(presetKey(h, "Digit1", { ctrlKey: true }), 0, "Ctrl+1 is for the browser");
  assert.equal(presetKey(h, "Digit1", { ctrlKey: true, shiftKey: true }), 0);
  assert.equal(presetKey(h, "Digit1", { metaKey: true }), 0);
  assert.equal(presetKey(h, "Digit0", { ctrlKey: true }), 0, "Ctrl+0 resets the zoom of the browser");
  assert.equal(presetKey(h, "Digit0", { shiftKey: true }), 0);
  assert.equal(presetKey(h, "KeyA"), 0);
  assert.equal(moves(), 0);

  h.elements.get("scanDialog").hidden = false;
  assert.equal(presetKey(h, "Digit1"), 0, "not while a dialog is open");
  h.elements.get("scanDialog").hidden = true;

  assert.equal(presetKey(h, "Digit1", {}, { repeat: true }), 1, "a held key is taken, and does nothing");
  assert.equal(moves(), 0);
  presetKey(h, "Digit1");
  assert.equal(moves(), 1);
});

test("presets: a camera that can take only part of a preset, and a camera that fails", async () => {
  // Only a zoom: position teaching is refused, and teaching everything keeps the zoom.
  const zoomOnly = cameraHarness();
  zoomOnly.run("parameters.camera_presets = { 2: { pan: 1, tilt: 2, zoom: 0.5 } }");
  await connectCamera(zoomOnly, { zoom: { by: true, absolute: true } });
  presetKey(zoomOnly, "Digit1", { altKey: true, shiftKey: true });
  assert.match(zoomOnly.run("withCameraNote('')"), /cannot report its position/);
  presetKey(zoomOnly, "Digit1", { altKey: true });
  await camerasPose(zoomOnly, undefined, undefined, 0.75);
  assert.deepEqual(storedPresets(zoomOnly)[1], { zoom: 0.75 });
  presetKey(zoomOnly, "Digit2");
  assert.equal(cameraRequests(zoomOnly, "ptz.moveTo").length, 0, "the position of preset 2 is not applied: the camera cannot");
  assert.equal(cameraRequests(zoomOnly, "zoom.set").length, 1, "its zoom is");

  // Only a position.
  const positionOnly = cameraHarness();
  await connectCamera(positionOnly, { ptz: { absolute: true } });
  presetKey(positionOnly, "Digit1", { altKey: true, ctrlKey: true });
  assert.match(positionOnly.run("withCameraNote('')"), /cannot report its zoom/);

  // The camera does not answer, or says something that is not a position: nothing is stored.
  const h = cameraHarness();
  await connectCamera(h, PRESET_CAPS);
  presetKey(h, "Digit1", { altKey: true });
  await cameraAnswers(h, "ptz.get", { error: { code: "timeout", message: "The camera did not report its position." } });
  assert.deepEqual(storedPresets(h), {});
  assert.match(h.run("withCameraNote('')"), /preset 1 was not taught: The camera did not report its position/);
  presetKey(h, "Digit1", { altKey: true, shiftKey: true });
  await cameraAnswers(h, "ptz.get", { result: { pan: "left", tilt: 2 } });
  assert.deepEqual(storedPresets(h), {}, "an answer that is not a position");
});

test("presets: deleting or reteaching a slot cancels an older pending teaching", async () => {
  const h = cameraHarness();
  await connectCamera(h, PRESET_CAPS);
  presetKey(h, "Digit1", { altKey: true, shiftKey: true });
  presetKey(h, "Digit1", { altKey: true, ctrlKey: true, shiftKey: true });
  await cameraAnswers(h, "ptz.get", { result: { pan: 10, tilt: 20 } });
  assert.deepEqual(storedPresets(h), {}, "a late reply does not recreate the deleted slot");

  presetKey(h, "Digit1", { altKey: true, shiftKey: true });
  presetKey(h, "Digit1", { altKey: true, ctrlKey: true });
  await cameraAnswers(h, "zoom.get", { result: { value: 0.75 } });
  await cameraAnswers(h, "ptz.get", { result: { pan: 30, tilt: 40 } });
  assert.deepEqual(storedPresets(h), { 1: { zoom: 0.75 } }, "the latest teaching wins");
});

test("presets: a failed settings write is reported", async () => {
  const h = cameraHarness();
  await connectCamera(h, PRESET_CAPS);
  h.run('Neutralino.filesystem.writeFile = async () => { throw new Error("disk full"); }');
  presetKey(h, "Digit1", { altKey: true, shiftKey: true });
  await cameraAnswers(h, "ptz.get", { result: { pan: 10, tilt: 20 } });
  assert.match(h.run("withCameraNote('')"), /could not save presets:.*disk full/i);
});

test("settings: overlapping writes preserve the order of preset changes", async () => {
  const h = harness();
  h.run(`let writes = []; let finishFirst;
    Neutralino.filesystem.writeFile = (_path, data) => new Promise((resolve) => {
      writes.push(JSON.parse(data));
      if (writes.length === 1) finishFirst = resolve; else resolve();
    });
    parameters.camera_presets = { 1: { zoom: 0.5 } };
    saveParams('', '', 'first.mkv');
    parameters.camera_presets = {};
    saveParams('', '', 'second.mkv');`);
  await flush();
  assert.equal(h.run("writes.length"), 1);
  h.run("finishFirst()");
  await flush();
  assert.equal(h.run("writes.length"), 2);
  assert.equal(h.run("writes[1].output_filename"), "second.mkv");
  assert.equal(h.run("Object.keys(writes[1].camera_presets).length"), 0);
});

test("presets: the menu teaches, applies and deletes while keeping the video visible", async () => {
  const h = cameraHarness();
  h.enablePlayer();
  h.run("parameters.camera_presets = { 2: { pan: 30, tilt: -4 } }");
  await connectCamera(h, PRESET_CAPS);
  await h.start(false);
  h.elements.get("videoHost").hidden = false; // the video box is shown while a player runs
  const menu = h.elements.get("presetMenu");
  const video = h.elements.get("videoHost");
  Object.assign(video.style, { left: "0px", top: "0px", width: "640px", height: "360px" });
  video.getBoundingClientRect = () => ({ left: 10, top: 20, width: parseFloat(video.style.width), height: parseFloat(video.style.height), right: 10 + parseFloat(video.style.width), bottom: 20 + parseFloat(video.style.height) });
  menu.getBoundingClientRect = () => ({ width: 240, height: 200 });
  h.elements.get("presetDrawer").children[0].getBoundingClientRect = () => ({ left: 100, top: 200, right: 132, bottom: 226, width: 32, height: 26 });
  const labels = () => menu.children.slice(1).map((item) => item.children[0].textContent);
  const enabled = () => menu.children.slice(1).map((item) => !item.disabled);

  // An empty slot: only the teaching is possible.
  let prevented = 0;
  h.elements.get("presetBar").children[0].contextmenu({ preventDefault() { prevented++; } });
  assert.equal(menu.hidden, true, "the compact row has no context menu");
  h.elements.get("presetDrawer").children[0].contextmenu({ preventDefault() {} });
  assert.equal(prevented, 1, "the browser's own menu does not open");
  assert.equal(menu.hidden, false);
  assert.equal(menu.children[0].textContent, "Preset 1: empty");
  assert.deepEqual(labels(), ["Apply", "Teach position and zoom", "Teach position only", "Teach zoom only", "Delete"]);
  assert.deepEqual(enabled(), [false, true, true, true, false]);
  assert.deepEqual(menu.children.slice(1).map((item) => item.children[1].textContent), ["1", "Alt+1", "Alt+Shift+1", "Alt+Ctrl+1", "Alt+Ctrl+Shift+1"]);
  assert.ok(!h.stdin.includes("HIDE\n"), "the video stays visible");
  assert.equal(video.style.width, "640px", "the video geometry is unchanged");
  assert.equal(menu.style.left, "100px");
  assert.equal(menu.style.top, "20px");

  menu.children[3].click(); // Teach position only
  assert.equal(menu.hidden, true);
  assert.equal(video.style.width, "640px", "the video geometry remains unchanged");
  await camerasPose(h, 12, 3, undefined);
  assert.deepEqual(storedPresets(h)[1], { pan: 12, tilt: 3 });

  // A slot with a preset: apply and delete work.
  h.elements.get("presetDrawer").children[1].contextmenu({ preventDefault() {} });
  assert.equal(menu.children[0].textContent, "Preset 2: position");
  assert.deepEqual(enabled(), [true, true, true, true, true]);
  menu.children[1].click(); // Apply
  assert.deepEqual(cameraRequests(h, "ptz.moveTo").at(-1).params, { pan: 30, tilt: -4 });
  h.elements.get("presetDrawer").children[1].contextmenu({ preventDefault() {} });
  menu.children[5].click(); // Delete
  assert.deepEqual(Object.keys(storedPresets(h)), ["1"]);

  // Closing: Escape, a press outside, a key of its own. The arrow keys do not turn the camera meanwhile.
  h.elements.get("presetDrawer").children[0].contextmenu({ preventDefault() {} });
  h.run('handleKeyDown({ key: "ArrowUp", code: "ArrowUp", target: { tagName: "BODY" }, preventDefault() {} })');
  h.run('handleKeyDown({ key: "ArrowRight", code: "ArrowRight", target: { tagName: "BODY" }, preventDefault() {} })');
  assert.equal(cameraRequests(h, "ptz.nudge").length, 0);
  assert.equal(menu.hidden, false);
  h.run('handleKeyDown({ key: "Escape", code: "Escape", target: { tagName: "BODY" }, preventDefault() {} })');
  assert.equal(menu.hidden, true);
  h.elements.get("presetDrawer").children[0].contextmenu({ preventDefault() {} });
  h.run("handleWindowPointerDown({ target: {} })");
  assert.equal(menu.hidden, true);
  h.elements.get("presetDrawer").children[0].contextmenu({ preventDefault() {} });
  presetKey(h, "Digit1");
  assert.equal(menu.hidden, true, "a preset key closes it");
  h.run("closePresetMenu()"); // nothing to close
  assert.equal(h.stdin.filter((line) => line === "HIDE\n").length, h.stdin.filter((line) => line === "SHOW\n").length, "every hide has its show");
});

test("presets: a layout change closes the menu before calculating new video geometry", () => {
  const h = layoutHarness({ current: ROOM_16_9_WINDOW });
  h.run("updateLayout(true)");
  h.run("presetMenu.hidden = false; videoHost.style.width = '10px'");
  h.run("setVideoSize({ width: 4, height: 3 })");
  assert.equal(h.elements.get("presetMenu").hidden, true);
  assert.notEqual(h.host.width, "10px");
  assert.ok(Math.abs(parseFloat(h.host.width) / parseFloat(h.host.height) - 4 / 3) < 0.01);
});

test("presets: compact layout stays below the video and filters empty slots only when needed", () => {
  const h = layoutHarness({ current: ROOM_21_9_WINDOW });
  const row = h.elements.get("presetBar");
  h.run("cameraProc = { caps: { ptz: { absolute: true } } }; presetBar.hidden = false; panelOverride = 'compact'; lastAutoCompact = false");
  row.scrollWidth = 360;
  row.clientWidth = 100;
  h.run("updateLayout(true)");
  assert.equal(h.layout.className, "layout is-stack is-compact");
  assert.equal(row.classList.names.has("is-filtered"), true);
  row.clientWidth = 360;
  h.run("updateLayout(true)");
  assert.equal(row.classList.names.has("is-filtered"), false);
});

test("presets: the menu is limited to the visible part of a scrolling drawer", async () => {
  const h = cameraHarness();
  await connectCamera(h, PRESET_CAPS);
  h.run("window.innerWidth = 640; window.innerHeight = 400; videoHost.hidden = false");
  h.elements.get("drawer").getBoundingClientRect = () => ({ left: 10, top: -100, right: 300, bottom: 600 });
  h.elements.get("panel").getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, bottom: 100 });
  h.elements.get("presetMenu").getBoundingClientRect = () => ({ width: 240, height: 200 });
  h.elements.get("presetDrawer").children[0].getBoundingClientRect = () => ({ left: 250, top: 50, bottom: 76 });
  h.elements.get("presetDrawer").children[0].contextmenu({ preventDefault() {} });
  assert.equal(h.elements.get("presetMenu").style.left, "56px");
  assert.equal(h.elements.get("presetMenu").style.top, "4px");
  assert.equal(h.elements.get("presetMenu").style.maxHeight, "92px");
});

test("presets: only sensible presets are read from the settings", async () => {
  const h = harness();
  h.files.set("/app/vlc_rec_params.json", JSON.stringify({
    camera_presets: {
      0: { pan: 9, tilt: 9, zoom: 0.9 }, 1: { pan: -20, tilt: 5, zoom: 0.5 }, 2: { pan: "x", tilt: 1 }, 3: { zoom: 2 }, 4: { pan: 10 }, 5: null, 6: { pan: 1, tilt: 2, zoom: -1 },
      10: { zoom: 0.1 }, 7: { zoom: 0 }, 8: "preset", 9: { pan: 400, tilt: 0 }
    }
  }));
  await h.run("loadParams()");
  assert.deepEqual(storedPresets(h), { 1: { pan: -20, tilt: 5, zoom: 0.5 }, 6: { pan: 1, tilt: 2 }, 7: { zoom: 0 } });

  const absent = harness();
  await absent.run("loadParams()");
  assert.deepEqual(storedPresets(absent), {});
});

test("presets: 0 is the fixed wide shot with the camera centered; it cannot be taught or deleted", async () => {
  const h = cameraHarness();
  h.run("parameters.camera_presets = { 1: { pan: -20, tilt: 5, zoom: 0.5 } }");
  await connectCamera(h, PRESET_CAPS);
  const sent = () => cameraRequests(h, "ptz.moveTo", "zoom.set").map((request) => [request.method, request.params]);
  const zero = h.elements.get("presetBar").children[9];
  assert.equal(zero.textContent, "0");
  assert.match(zero.title, /Preset 0 \(fixed: wide shot, camera centered\)\. Click or key 0: apply/);

  // The key and the button turn the camera straight ahead and zoom it out fully.
  assert.equal(presetKey(h, "Digit0"), 1);
  assert.deepEqual(sent(), [["ptz.moveTo", { pan: 0, tilt: 0 }], ["zoom.set", { value: 0 }]]);
  assert.match(h.run("withCameraNote('')"), /preset 0 applied \(wide shot, camera centered\)/);
  presetKey(h, "Numpad0");
  h.elements.get("presetDrawer").children[9].click();
  assert.equal(sent().length, 6, "three ways to apply it");

  // Nothing teaches or deletes it: not Alt+0 in any form, not the menu, not the code.
  for (const modifiers of [{ altKey: true }, { altKey: true, shiftKey: true }, { altKey: true, ctrlKey: true }, { altKey: true, ctrlKey: true, shiftKey: true }]) {
    assert.equal(presetKey(h, "Digit0", modifiers), 1, "the key is taken, so that the browser does nothing with it");
    assert.match(h.run("withCameraNote('')"), /preset 0 is fixed \(wide shot, camera centered\): it cannot be taught or deleted/);
    h.advance(7000);
  }
  await flush();
  assert.equal(cameraRequests(h, "ptz.get").length, 0, "nothing was asked of the camera");
  assert.equal(cameraRequests(h, "zoom.get").length, 0);
  assert.equal(sent().length, 6);
  assert.deepEqual(Object.keys(storedPresets(h)), ["1"], "and nothing was stored");
  await h.run("teachPreset(0, 'both')");
  h.run("deletePreset(0)");
  assert.deepEqual(Object.keys(storedPresets(h)), ["1"]);

  // The menu: Apply only.
  const menu = h.elements.get("presetMenu");
  h.elements.get("presetDrawer").children[9].contextmenu({ preventDefault() {} });
  assert.equal(menu.children[0].textContent, "Preset 0: fixed, wide shot, camera centered");
  assert.deepEqual(menu.children.slice(1).map((item) => !item.disabled), [true, false, false, false, false]);
  menu.children[1].click();
  assert.equal(sent().length, 8, "Apply works from the menu");

  // A camera that can only zoom or only turn does what it can.
  const zoomOnly = cameraHarness();
  await connectCamera(zoomOnly, { zoom: { by: true, absolute: true } });
  presetKey(zoomOnly, "Digit0");
  assert.deepEqual(cameraRequests(zoomOnly, "ptz.moveTo", "zoom.set").map((request) => request.method), ["zoom.set"]);
});

// ---- SRT latency of the preview ----

test("the SRT latency is off by default and then no option reaches the player or VLC", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start(false);
  assert.ok(!h.launches[0].includes("--srt-latency"), h.launches[0]);
  await h.exit();

  const external = harness(); // no player binary: external VLC
  await external.start(false);
  assert.ok(!/--latency/.test(external.launches[0]), external.launches[0]);
});

test("a set SRT latency goes to the preview only, to the player and to external VLC", async () => {
  const h = harness();
  h.enablePlayer();
  h.run("parameters.srt_latency_ms = 40");
  await h.start(false);
  assert.ok(h.launches[0].includes('"--srt-latency" "40"'), h.launches[0]);
  await h.exit();
  await h.start(true);
  assert.ok(!h.launches[1].includes("--srt-latency"), "a recording keeps VLC's default: " + h.launches[1]);

  const external = harness();
  external.run("parameters.srt_latency_ms = 40");
  await external.start(false);
  assert.match(external.launches[0], /--latency=40/);
  await external.exit();
  await external.start(true);
  assert.ok(!/--latency/.test(external.launches[1]), external.launches[1]);
});

test("the SRT latency field takes whole milliseconds, empty or nonsense switches it off", async () => {
  const h = harness();
  const field = h.elements.get("srtLatency");
  await h.run("refreshState()");
  assert.equal(field.value, "", "off: an empty field");

  field.value = "40";
  field.change();
  assert.equal(h.run("parameters.srt_latency_ms"), 40);
  assert.match(h.files.get("/app/vlc_rec_params.json"), /"srt_latency_ms": 40/, "saved");

  field.value = "999999";
  field.change();
  assert.equal(h.run("parameters.srt_latency_ms"), 10000);
  assert.equal(field.value, "10000");

  for (const off of ["", "0", "-5", "abc"]) {
    field.value = "40";
    field.change();
    field.value = off;
    field.change();
    assert.equal(h.run("parameters.srt_latency_ms"), -1, `"${off}" switches it off`);
    assert.equal(field.value, "");
  }
  assert.match(h.files.get("/app/vlc_rec_params.json"), /"srt_latency_ms": -1/);

  // A setting from the file that is not a number or is below 1 is off too.
  for (const bad of ['"x"', "0", "-3", "null"]) {
    h.run(`parameters.srt_latency_ms = ${bad}`);
    assert.equal(h.run("srtLatencyMs()"), -1, bad);
  }
});

test("a running preview says that it has another SRT latency, and the button restarts it with the new one", async () => {
  const h = harness();
  h.enablePlayer();
  const field = h.elements.get("srtLatency");
  const pending = h.elements.get("bufferPending");
  const apply = h.elements.get("bufferApplyBtn");
  const text = () => h.elements.get("bufferPendingText").textContent;
  await h.start(false);
  await h.run("refreshState()");
  assert.equal(pending.hidden, true, "nothing to say while the preview has what the fields say");

  field.value = "60";
  field.change();
  assert.equal(pending.hidden, false);
  assert.equal(apply.hidden, false);
  assert.equal(text(), "Not in use yet: the running preview has SRT latency VLC's default.");

  // Both fields changed: both are named.
  h.elements.get("previewCaching").value = "300";
  h.elements.get("previewCaching").change();
  assert.equal(text(), "Not in use yet: the running preview has 500 ms and SRT latency VLC's default.");

  apply.click();
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await h.run("refreshState()");
  assert.equal(h.launches.length, 2, "the preview started again");
  assert.ok(h.launches[1].includes('"--srt-latency" "60"') && h.launches[1].includes('"--caching" "300"'), h.launches[1]);
  assert.equal(pending.hidden, true, "and now both are in use");

  // Back to off while it runs: the note names the latency that runs.
  field.value = "";
  field.change();
  assert.equal(text(), "Not in use yet: the running preview has SRT latency 60 ms.");
});

test("a recording takes no SRT latency, so a changed one is nothing to note", async () => {
  const h = harness();
  h.enablePlayer();
  await h.start(true);
  await h.run("refreshState()");
  const field = h.elements.get("srtLatency");
  field.value = "40";
  field.change();
  assert.equal(h.elements.get("bufferPending").hidden, true, "a recording never had it");

  h.elements.get("previewCaching").value = "200";
  h.elements.get("previewCaching").change();
  assert.equal(h.elements.get("bufferPending").hidden, false, "the buffer is another matter");
  assert.match(h.elements.get("bufferPendingText").textContent, /recording keeps 500 ms/);
});
