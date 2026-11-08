// Loaded after app.js in a temporary copy of index.html, never in the shipped app.
// It runs in the real window, so it can use app.js globals such as mode and currentProcess.
const E2E_MODE = "__MODE__";
const E2E_SCENARIO = "__SCENARIO__";

(async () => {
  const dir = `${NL_PATH}/e2e`;
  const results = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail: String(detail) });

  // The default is long because Windows Defender can delay the first start of a new .exe.
  async function waitFor(label, fn, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) {
        check(label, true, `${Date.now() - start} ms`);
        return true;
      }
      await sleep(200);
    }
    check(label, false, `timed out after ${timeoutMs} ms; mode=${mode}; busy=${uiBusy}; status=${statusText}`);
    await step(`failure-${results.length}`, { action: "screenshot", expect: "any" });
    return false;
  }

  function rectInfo() {
    const rect = videoHost.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    return { width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), dpr: scale };
  }

  async function step(name, data = {}) {
    await Neutralino.filesystem.writeFile(`${dir}/${name}.ready`, JSON.stringify({ ...data, rect: rectInfo() }));
    while (!await pathExists(`${dir}/${name}.done`)) await sleep(100);
    return JSON.parse(await Neutralino.filesystem.readFile(`${dir}/${name}.done`));
  }

  const shot = async (name, expect) => {
    await sleep(1200);
    const reply = await step(name, { action: "screenshot", expect });
    for (const item of reply.checks || []) check(`${name}: ${item.name}`, item.ok, item.detail);
  };

  // Every check gets its own step name, so a reply can never belong to an earlier file.
  let verifyCount = 0;
  async function verifyFile(label, file) {
    verifyCount += 1;
    const reply = await step(`verify-${verifyCount}`, { action: "verify", file });
    for (const item of reply.checks) check(`${label}: ${item.name}`, item.ok, item.detail);
  }

  async function finish() {
    await Neutralino.filesystem.writeFile(`${dir}/result.json`, JSON.stringify(results));
  }

  async function configure(name, ext, folder) {
    ip.value = "127.0.0.1:5000";
    outPath.value = folder;
    filename.value = name;
    extension.value = ext;
    parameters.output_path = folder;
    parameters.ip_address = ip.value;
    parameters.output_filename = `${name}.${ext}`;
  }

  const click = (button) => button.click();
  const isStopped = async () => (await Neutralino.os.getSpawnedProcesses()).length === 0;
  const hasStats = () => currentProcess && currentProcess.readBytes;

  async function stopAndWait(label) {
    const start = Date.now();
    await waitFor(`${label}: button enabled`, () => !uiBusy);
    click(mode === "recording" ? recordBtn : previewBtn);
    await waitFor(`${label}: returned to idle`, () => mode === "idle" && !uiBusy);
    await waitFor(`${label}: player exited`, isStopped, 14000);
    check(`${label}: stop time`, true, `${Date.now() - start} ms`);
  }

  try {
    await waitFor("app ready", () => typeof Neutralino.os !== "undefined" && !uiBusy && mode === "idle");
    await sleep(500);
    logDebug(`e2e start NL_PATH=${NL_PATH} NL_PID=${NL_PID} NL_ARCH=${NL_ARCH} dpr=${window.devicePixelRatio}`);
    await Neutralino.window.setAlwaysOnTop(true);
    logDebug("e2e always-on-top set");
    check("device pixel ratio", true, window.devicePixelRatio);
    if (E2E_MODE === "stub") videoHost.style.background = "#ff00ff";

    const folder = `${NL_PATH}/e2e/out ár'v{1},z`;
    await Neutralino.filesystem.createDirectory(folder);

    if (E2E_SCENARIO === "novlc" || E2E_SCENARIO === "wrongversion") {
      await configure("x", "mkv", folder);
      click(previewBtn);
      const want = E2E_SCENARIO === "novlc" ? /libVLC was not found/ : /VLC 3 is required/;
      await waitFor(`error shown: ${want}`, () => want.test(statusText), 15000);
      check("back to idle after error", mode === "idle", mode);
      await finish();
      await Neutralino.app.exit();
      return;
    }

    if (E2E_SCENARIO === "dialogs") {
      await Neutralino.window.setAlwaysOnTop(false); // The screenshots must show the dialogs.
      const dialogs = [
        ["folder", "Select output folder", () => Neutralino.os.showFolderDialog("Select output folder")],
        ["message", "E2E message", () => Neutralino.os.showMessageBox("E2E message", "Test", "OK", "WARNING")]
      ];
      for (const [name, title, open] of dialogs) {
        // An open dialog blocks every other native call, so the request has to be written first.
        const reply = step(`dialog-${name}`, { action: "dialog", title });
        await sleep(1000);
        await open().catch((err) => logDebug(`e2e ${name} dialog: ${normalizeError(err)}`));
        for (const item of (await reply).checks) check(`${name} dialog: ${item.name}`, item.ok, item.detail);
      }
      await finish();
      await Neutralino.app.exit();
      return;
    }

    if (E2E_SCENARIO === "closewhile" || E2E_SCENARIO === "hardkill") {
      await configure(E2E_SCENARIO, "mkv", folder);
      click(recordBtn);
      await waitFor("recording started", hasStats);
      await sleep(4000);
      await finish();
      if (E2E_SCENARIO === "closewhile") {
        // Same path as the windowClose event handler in app.js.
        closeRequested = true;
        withBusy(async () => {}).catch(() => {});
      } else {
        await step("kill-app", { pid: NL_PID });
      }
      return;
    }

    check("video panel visible", videoHost.hidden === false);
    await shot("idle", "idle");

    // Recording to a folder name with an accent, quote, braces, comma and space.
    await configure("rec", "mkv", folder);
    click(recordBtn);
    await waitFor("recording: mode", () => mode === "recording");
    await waitFor("recording: stats arrive", hasStats);
    await waitFor("recording: file grows", async () => {
      const stats = await Neutralino.filesystem.getStats(outputFile).catch(() => ({ size: 0 }));
      return stats.size > 0;
    });
    await sleep(3000);
    await shot("recording", "video");

    await Neutralino.window.setSize({ width: 1000, height: 520 });
    await shot("resized", "video");

    click(scanBtn);
    await shot("dialog-open", "covered");
    click(closeScanBtn);
    await shot("dialog-closed", "video");

    await stopAndWait("recording stop");
    await verifyFile("rec.mkv", `${folder}/rec.mkv`);
    await shot("after-stop", "idle");

    // Preview only: no output file, stats still flow.
    click(previewBtn);
    await waitFor("preview: mode", () => mode === "preview");
    await waitFor("preview: stats arrive", hasStats);
    const firstBytes = currentProcess.readBytes;
    await sleep(3000);
    check("preview: counter changes", currentProcess.readBytes !== firstBytes, `${firstBytes} -> ${currentProcess.readBytes}`);
    await shot("preview", "video");

    // Switching directly from preview to recording replaces the player.
    await configure("switched", "mp4", folder);
    click(recordBtn);
    await waitFor("switch: recording mode", () => mode === "recording" && !uiBusy);
    await waitFor("switch: stats arrive", hasStats);
    await sleep(3000);
    await stopAndWait("switch stop");
    await verifyFile("switched.mp4", `${folder}/switched.mp4`);

    // A crashed player is replaced when automatic reconnect is on.
    autoReconnect.checked = true;
    autoReconnect.dispatchEvent(new Event("change"));
    await sleep(1000); // Let the checkbox finish saving the settings file.
    await configure("crash", "mkv", folder);
    click(recordBtn);
    await waitFor("crash: stats arrive", hasStats);
    const crashedId = currentProcess.id;
    await step("kill-player");
    await waitFor("crash: reconnect message", () => /reconnecting/i.test(statusText), 10000);
    await waitFor("crash: new player running", () => currentProcess && currentProcess.id !== crashedId && hasStats(), 20000);
    check("crash: next numbered file", /crash_001\.mkv$/.test(outputFile), outputFile);
    await stopAndWait("crash stop");

    if (E2E_MODE === "real") {
      // The port scan's verification must work on a machine with no VLC or ffmpeg installed.
      await sleep(1500); // The source accepts a new client shortly after the last one left.
      const found = await verifySrtEndpoint("127.0.0.1:5000");
      check("scan: finds the SRT source", found === RESULT_STATE_FOUND, `${found} with ${scanState.verifierKind}`);
      const closed = await verifySrtEndpoint("127.0.0.1:5999");
      check("scan: rejects a closed port", closed === RESULT_STATE_NOT_SRT, `${closed} with ${scanState.verifierKind}`);
      await sleep(1500);

      // The source dies: the file stops growing, so a new numbered segment starts.
      parameters.stall_timeout_sec = 5;
      await configure("seg", "mp4", folder);
      click(recordBtn);
      await waitFor("stall: stats arrive", hasStats);
      await sleep(5000);
      await step("kill-source");
      await waitFor("stall: new segment", () => /seg_001\.mp4$/.test(outputFile), 40000);
      await step("start-source");
      await waitFor("stall: new segment grows", async () => {
        const stats = await Neutralino.filesystem.getStats(outputFile).catch(() => ({ size: 0 }));
        return stats.size > 100000;
      }, 40000);
      await sleep(4000); // Record long enough for the duration check on this segment.
      await stopAndWait("stall stop");
      await verifyFile("seg.mp4", `${folder}/seg.mp4`);
      await verifyFile("seg_001.mp4", `${folder}/seg_001.mp4`);
    }
  } catch (err) {
    logDebug(`e2e driver error: ${normalizeError(err)}`);
    check("driver error", false, normalizeError(err));
  }
  await finish().catch((err) => logDebug(`e2e could not write the result: ${normalizeError(err)}`));
  await Neutralino.app.exit();
})();
