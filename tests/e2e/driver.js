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
    for (const button of [recordBtn, previewBtn]) {
      const height = button.getBoundingClientRect().height;
      check(`${label}: ${button.id} label on one line`, height < 40, `${Math.round(height)} px`);
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
  // The camera helper keeps running between streams; the others must be gone.
  const isStopped = async () => (await Neutralino.os.getSpawnedProcesses())
    .filter((proc) => !cameraProc || proc.id !== cameraProc.id).length === 0;
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

    if (E2E_SCENARIO === "motion") {
      // Does the preview of the stream in the settings file (E2E_PARAMS) show a moving picture?
      await setWindow(1120, 630);
      click(previewBtn);
      await waitFor("motion: preview running", () => mode === "preview" && hasStats(), 40000);
      await sleep(4000);
      for (let i = 1; i <= 6; i += 1) await shot(`m${i}`, "any", 1000);
      const reply = await step("motion-verify", { action: "motion-verify" });
      for (const item of reply.checks) check(`motion: ${item.name}`, item.ok, item.detail);
      await stopAndWait("motion stop");
      await finish();
      await Neutralino.app.exit();
      return;
    }

    if (E2E_SCENARIO === "camera") {
      // run-e2e.js starts a fake OSC camera and writes its address into the settings file, so
      // init() has started the camera helper. Mouse and keys come through the X server, as a
      // user's would: over the real native video window.
      await setWindow(1120, 630);
      await waitFor("camera: helper running", () => cameraActive());
      check("camera: controls shown", cameraBar.hidden === false);
      await configure("camera", "mkv", folder);
      click(previewBtn);
      await waitFor("camera: preview running", () => mode === "preview" && hasStats());
      await sleep(2500); // The picture and the window settle.
      const host = videoHost.getBoundingClientRect();
      const at = (fx, fy) => [Math.round(host.left + host.width * fx), Math.round(host.top + host.height * fy)];
      await step("input-click", { action: "input", steps: [{ move: at(0.75, 0.5), wait: 300 }, { click: 1, wait: 800 }] });
      await step("input-wheel", { action: "input", steps: [{ move: at(0.5, 0.5), wait: 200 }, { wheel: "up", wait: 400 }] });
      await step("input-keys", { action: "input", steps: [{ key: "Right", wait: 400 }, { key: "Up", wait: 400 }] });
      const reply = await step("camera-verify", { action: "camera-verify" });
      for (const item of reply.checks) check(`camera: ${item.name}`, item.ok, item.detail);
      // The camera controls are a block of their own: the zoom buttons and the speed slider with its
      // number must be there, whole, inside the panel and the window, in the full panel and the compact one,
      // and must not cover the buttons or the status line.
      const cameraControlChecks = (label) => {
        const side = panel.getBoundingClientRect();
        const boxes = {};
        // A full panel that the user forced into a window too small for it scrolls: what is below the
        // fold is then reachable, not cut off, so only the width has to fit.
        const scrolls = panel.scrollHeight > panel.clientHeight + 1;
        for (const control of [zoomOutBtn, zoomInBtn, cameraSpeed, cameraSpeedValue, recordBtn, previewBtn, status]) {
          const box = control.getBoundingClientRect();
          boxes[control.id] = box;
          const detail = `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}${scrolls ? " (the panel scrolls)" : ""}`;
          const inside = box.left >= side.left - 0.5 && box.right <= Math.min(side.right, innerWidth) + 0.5
            && (scrolls || (box.top >= side.top - 0.5 && box.bottom <= side.bottom + 0.5));
          check(`${label}: ${control.id} fully visible`, box.width > 0 && box.height > 0 && inside, detail);
        }
        const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        const names = Object.keys(boxes);
        for (let i = 0; i < names.length; i += 1) {
          for (let j = i + 1; j < names.length; j += 1) {
            if (overlap(boxes[names[i]], boxes[names[j]])) check(`${label}: ${names[i]} and ${names[j]} do not overlap`, false);
          }
        }
        check(`${label}: no overlapping controls`, true);
        // The drawer: folded away in the compact panel, else every field of it is there, whole and apart
        // from the others, and the bar is not covered by it.
        const drawerBox = document.getElementById("drawer").getBoundingClientRect();
        if (layoutEl.classList.contains("is-compact")) {
          check(`${label}: drawer folded away`, drawerBox.width === 0 && drawerBox.height === 0, `${Math.round(drawerBox.width)}x${Math.round(drawerBox.height)}`);
        } else {
          const fields = [ip, scanBtn, outPath, browseBtn, filename, extension, autoReconnect, previewCaching, document.getElementById("bufferHint"), cameraPageBtn];
          const seen = {};
          for (const field of fields) {
            const box = field.getBoundingClientRect();
            seen[field.id] = box;
            const detail = `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}${scrolls ? " (the panel scrolls)" : ""}`;
            const inside = box.left >= side.left - 0.5 && box.right <= Math.min(side.right, innerWidth) + 0.5
              && box.left >= drawerBox.left - 0.5 && box.right <= drawerBox.right + 0.5
              && (scrolls || (box.top >= side.top - 0.5 && box.bottom <= side.bottom + 0.5));
            check(`${label}: ${field.id} in the drawer`, box.width > 0 && box.height > 0 && inside, detail);
          }
          const ids = Object.keys(seen);
          let apart = true;
          for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) if (overlap(seen[ids[i]], seen[ids[j]])) { apart = false; check(`${label}: ${ids[i]} and ${ids[j]} apart`, false); }
          check(`${label}: the drawer fields do not overlap`, apart);
          const barBox = document.querySelector(".bar").getBoundingClientRect();
          check(`${label}: drawer and bar do not overlap`, !overlap(drawerBox, barBox));
        }
        // The slider is long enough to be set within a few degrees per second: 89 steps over its width.
        check(`${label}: slider at least 60 px wide`, boxes.cameraSpeed.width >= 60, `${Math.round(boxes.cameraSpeed.width)} px`);
      };
      for (const [name, width, height] of [["16x9", 1280, 720], ["4x3", 1024, 768], ["small", 640, 400], ["wide-short", 1100, 460]]) {
        await setWindow(width, height);
        panelOverride = "";
        updateLayout();
        layoutChecks(`camera ${name}`);
        cameraControlChecks(`camera ${name}`);
        await shot(`camera-${name}`, "any", 500);
        click(panelToggle);
        layoutChecks(`camera ${name} toggled`);
        cameraControlChecks(`camera ${name} toggled`);
        await shot(`camera-${name}-toggled`, "any", 500);
        click(panelToggle);
      }
      // A changed preview buffer: the running preview says it still has the old one, and the button
      // starts it again with the new one (a real player, so the argument really changes).
      await setWindow(1280, 720);
      panelOverride = "full";
      updateLayout(true);
      previewCaching.value = "300";
      handlePreviewCachingChange();
      await sleep(300);
      check("camera: buffer note shown for the running preview", bufferPending.hidden === false && bufferApplyBtn.hidden === false, bufferPendingText.textContent);
      check("camera: the note names the buffer that runs", /500 ms/.test(bufferPendingText.textContent), bufferPendingText.textContent);
      const noteBox = bufferPending.getBoundingClientRect();
      const noteSide = panel.getBoundingClientRect();
      check("camera: the note is inside the panel", noteBox.width > 0 && noteBox.left >= noteSide.left - 0.5 && noteBox.right <= noteSide.right + 0.5 && noteBox.bottom <= noteSide.bottom + 0.5,
        `${Math.round(noteBox.left)},${Math.round(noteBox.top)} ${Math.round(noteBox.width)}x${Math.round(noteBox.height)}`);
      layoutChecks("camera buffer note");
      await shot("camera-buffer-pending", "any", 500);
      const oldProcess = currentProcess;
      click(bufferApplyBtn);
      await waitFor("camera: preview restarted with the new buffer", () => mode === "preview" && currentProcess && currentProcess !== oldProcess
        && currentProcess.cachingMs === 300 && hasStats(), 40000);
      await sleep(500);
      check("camera: the note is gone once it is in use", bufferPending.hidden === true);
      await shot("camera-buffer-applied", "any", 500);
      panelOverride = "";
      await stopAndWait("camera stop");
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
