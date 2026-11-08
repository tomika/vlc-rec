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
  const env = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, hidden: true, style: {},
      addEventListener(name, handler) { this[name] = handler; },
      setAttribute() {}, focus() {},
      getBoundingClientRect() { return { left: 10, top: 20, width: 640, height: 360 }; }
    });
    return elements.get(id);
  };
  const os = {
    async getEnv(name) { return env.get(name) || ""; },
    async spawnProcess(command) {
      // A second connection may open only after the previous VLC has exited.
      assert.equal(live.size, 0);
      const proc = { id: nextId++, pid: nextId + 1000 };
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
    document: { getElementById: element, activeElement: null },
    window: { addEventListener() {} },
    NL_PATH: "/app", NL_OS: "Windows", NL_ARCH: "x64", NL_PID: "4242",
    TextEncoder,
    Date: class extends Date { static now() { return now; } },
    Neutralino: {
      os, filesystem, init() {}, debug: { async log() {} },
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
    files, live, launches, actions, os, elements, events, timeouts, run, stdin, env,
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
