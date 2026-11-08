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

  function rectInfo(element = videoHost) {
    const rect = element.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    return { width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), dpr: scale };
  }

  async function step(name, data = {}) {
    await Neutralino.filesystem.writeFile(`${dir}/${name}.ready`, JSON.stringify({ ...data, rect: rectInfo(), stage: rectInfo(stage) }));
    while (!await pathExists(`${dir}/${name}.done`)) await sleep(100);
    return JSON.parse(await Neutralino.filesystem.readFile(`${dir}/${name}.done`));
  }

  const shot = async (name, expect, settleMs = 1200) => {
    await sleep(settleMs);
    const reply = await step(name, { action: "screenshot", expect });
    for (const item of reply.checks || []) check(`${name}: ${item.name}`, item.ok, item.detail);
  };

  // Resizes the client area and waits until the page has seen the new size.
  async function setWindow(width, height) {
    await Neutralino.window.setSize({ width, height, minWidth: 320, minHeight: 240 });
    await Neutralino.window.move(16, 16);
    let last = "";
    let stableSince = Date.now();
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const now = `${innerWidth}x${innerHeight}`;
      if (innerWidth === width && innerHeight === height) break;
      if (now !== last) { last = now; stableSince = Date.now(); }
      if (Date.now() - stableSince > 600) break;
      await sleep(100);
    }
    return { width: innerWidth, height: innerHeight };
  }

  const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

  // Geometry the screenshot cannot show: aspect ratio, a maximal video box, no overlap, nothing cut off.
  function layoutChecks(label) {
    const host = videoHost.getBoundingClientRect();
    const room = stage.getBoundingClientRect();
    const side = panel.getBoundingClientRect();
    const aspect = host.width / host.height;
    const slack = 0.005 + 2 / Math.max(1, Math.min(host.width, host.height));
    check(`${label}: video keeps the stream's aspect ratio`, Math.abs(aspect - videoAspect) / videoAspect <= slack,
      `${host.width}x${host.height} = ${aspect.toFixed(4)}, stream ${videoAspect.toFixed(4)}`);
    check(`${label}: video stays inside its stage`, host.left >= room.left - 0.5 && host.top >= room.top - 0.5 &&
      host.right <= room.right + 0.5 && host.bottom <= room.bottom + 0.5);
    check(`${label}: video fills the stage in one direction`, room.width - host.width <= 1.5 || room.height - host.height <= 1.5,
      `stage ${room.width}x${room.height}`);
    check(`${label}: panel and video do not overlap`, !overlaps(side, host));
    check(`${label}: panel has no horizontal scrolling`, panel.scrollWidth <= panel.clientWidth + 1, `${panel.scrollWidth} > ${panel.clientWidth}`);
    for (const button of [recordBtn, previewBtn, panelToggle]) {
      const box = button.getBoundingClientRect();
      const visible = box.width > 0 && box.top >= side.top - 0.5 && box.bottom <= side.bottom + 0.5 && box.right <= innerWidth + 0.5;
      check(`${label}: ${button.id} fully visible`, visible, `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    const text = (button) => (layoutEl.classList.contains("is-compact") ? button.querySelector(".btn-label-short") : button.querySelector(".btn-label-full")) || button;
    for (const button of [recordBtn, previewBtn]) {
      const height = text(button).getBoundingClientRect().height;
      check(`${label}: ${button.id} label on one line`, height < 24, `${Math.round(height)} px`);
    }
    check(`${label}: chosen`, true, `${layoutEl.className.replace("layout ", "")}; window ${innerWidth}x${innerHeight}; video ${Math.round(host.width)}x${Math.round(host.height)} = ${Math.round(100 * host.width * host.height / (innerWidth * innerHeight))}% of the window; panel ${Math.round(side.width)}x${Math.round(side.height)}${panel.scrollHeight > panel.clientHeight + 1 ? " scrolls" : ""}`);
  }

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
    if (E2E_MODE === "stub") {
      videoHost.style.background = "#ff00ff";
      stage.style.background = "#00ffff";
    }

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

    if (E2E_SCENARIO === "aspect") {
      // Real libVLC must report the display size in preview and while recording (sout).
      // 1920x1080 H.264 is coded as 1088 lines; 1440x1080 with 4:3 pixels displays as 16:9.
      const sources = [["hd", "1920x1080", "", 16 / 9], ["sd", "640x480", "", 4 / 3],
        ["anamorphic", "1440x1080", "4/3", 16 / 9], ["portrait", "720x1280", "", 9 / 16]];
      await setWindow(1120, 630);
      for (const [name, size, sar, aspect] of sources) {
        await step(`source-${name}`, { action: "restart-source", size, sar });
        for (const record of [false, true]) {
          const label = `${name} ${record ? "recording" : "preview"}`;
          videoAspect = 0.5; // Not a size any source has, so the wait below needs a new event.
          if (record) await configure(`aspect-${name}`, "mkv", folder);
          click(record ? recordBtn : previewBtn);
          await waitFor(`${label}: video size arrives`, () => Math.abs(videoAspect - aspect) / aspect < 0.002, 20000);
          check(`${label}: reported aspect ratio`, true, videoAspect.toFixed(4));
          await sleep(2500);
          layoutChecks(label);
          await shot(`${name}-${record ? "recording" : "preview"}`, "video");
          await stopAndWait(`${label} stop`);
        }
        await verifyFile(`aspect-${name}.mkv`, `${folder}/aspect-${name}.mkv`);
      }
      // run-e2e.js puts the default source back after this scenario.
      await finish();
      await Neutralino.app.exit();
      return;
    }

    if (E2E_SCENARIO === "layout") {
      // Client areas and stream sizes (width height sarNum sarDen orientation) in all combinations.
      // Consecutive streams differ in aspect ratio, so each one must arrive as a new "video" event.
      const windows = [["16x9", 1280, 720], ["4x3", 1024, 768], ["1x1", 800, 800], ["21x9", 1680, 720],
        ["portrait", 600, 1000], ["small", 640, 400], ["wide-short", 1100, 460]];
      const streams = [["1x1", "1080 1080 1 1 0", 1], ["16x9", "1920 1080 1 1 0", 16 / 9],
        ["portrait", "1080 1920 1 1 0", 9 / 16], ["4x3", "1440 1080 1 1 0", 4 / 3],
        ["rotated", "1920 1080 1 1 6", 9 / 16], ["21x9", "2560 1080 1 1 0", 64 / 27],
        ["anamorphic", "1440 1080 4 3 0", 16 / 9]];
      const videoFile = `${dir}/stub-video.txt`;
      for (const [name, width, height] of windows) {
        await setWindow(width, height);
        layoutChecks(`idle ${name}`);
        await shot(`idle-${name}`, "layout-idle", 500);
      }
      await Neutralino.filesystem.writeFile(videoFile, streams[0][1]);
      await configure("layout", "mkv", folder);
      click(recordBtn);
      await waitFor("layout: recording", hasStats);
      for (const [stream, size, aspect] of streams) {
        await Neutralino.filesystem.writeFile(videoFile, size);
        await waitFor(`${stream}: video size arrives`, () => Math.abs(videoAspect - aspect) < 1e-6, 8000);
        for (const [name, width, height] of windows) {
          await setWindow(width, height);
          panelOverride = "";
          updateLayout();
          layoutChecks(`${stream} in ${name}`);
          await shot(`${stream}-in-${name}`, "layout", 500);
          click(panelToggle);
          layoutChecks(`${stream} in ${name} toggled`);
          await shot(`${stream}-in-${name}-toggled`, "layout", 500);
        }
      }
      await stopAndWait("layout stop");
      await verifyFile("layout.mkv", `${folder}/layout.mkv`);
      await finish();
      await Neutralino.app.exit();
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
