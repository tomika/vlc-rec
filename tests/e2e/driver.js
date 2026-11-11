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
  // The camera adapter keeps running between streams; the others must be gone.
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
      // init() has started the camera adapter. Mouse and keys come through the X server, as a
      // user's would: over the real native video window.
      await setWindow(1120, 630);
      await waitFor("camera: adapter connected", () => cameraCan("zoom"));
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
      // ---- presets: real keys and the mouse through the X server, a fake camera that remembers what it was told ----
      const shown = (element) => getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0;
      check("presets: ten buttons in each row, 1 to 9 and the fixed 0", presetBar.children.length === 10 && presetDrawer.children.length === 10
        && presetBar.children[9].textContent === "0" && presetBar.children[9].className.includes("is-fixed"));
      // With settings open the row always belongs to the drawer; compact mode uses the bar.
      // Window shapes that give each layout; at least one must put the panel below the video.
      let stackSize = null;
      for (const [name, width, height] of [["side", 1280, 720], ["tall", 1280, 1000], ["square", 1000, 900], ["wide-short", 1600, 700], ["narrow", 800, 900], ["minimum", 640, 400]]) {
        await setWindow(width, height);
        panelOverride = "full";
        updateLayout(true);
        await sleep(800);
        const wideStack = layoutEl.classList.contains("is-stack") && innerWidth >= 900;
        if (wideStack && !stackSize) stackSize = [width, height];
        const drawerOpen = !layoutEl.classList.contains("is-compact");
        check(`presets ${name}: the row is in the settings drawer`,
          !shown(presetBar) && shown(presetDrawer) === drawerOpen,
          `bar ${shown(presetBar)}, drawer ${shown(presetDrawer)}, ${layoutEl.className}, ${innerWidth}x${innerHeight}`);
        const visibleRow = shown(presetBar) ? presetBar : presetDrawer;
        const rowBox = visibleRow.getBoundingClientRect();
        check(`presets ${name}: the row is whole inside the window and on one line`,
          rowBox.left >= 0 && rowBox.right <= innerWidth + 0.5 && (panel.scrollHeight > panel.clientHeight || rowBox.bottom <= innerHeight + 0.5) && rowBox.height < 40,
          `${Math.round(rowBox.left)},${Math.round(rowBox.top)} ${Math.round(rowBox.width)}x${Math.round(rowBox.height)} in ${innerWidth}x${innerHeight}`);
        layoutChecks(`camera presets ${name}`);
        await shot(`camera-presets-${name}`, "any", 400);
        parameters.camera_presets = { 1: { pan: 1, tilt: 2 }, 3: { zoom: 0.5 } };
        renderPresets();
        panelOverride = "compact";
        updateLayout(true);
        await sleep(300);
        const compactBox = presetBar.getBoundingClientRect();
        check(`presets ${name}: buttons remain reachable with settings closed`, shown(presetBar) && !shown(presetDrawer) &&
          compactBox.left >= 0 && compactBox.right <= innerWidth + 0.5 && compactBox.bottom <= innerHeight + 0.5,
          `${layoutEl.className}, ${compactBox.left},${compactBox.top} ${compactBox.width}x${compactBox.height}`);
        const controlBox = recordBtn.getBoundingClientRect();
        check(`presets ${name}: presets and controls share a line`, compactBox.top < controlBox.bottom && compactBox.bottom > controlBox.top);
        const visibleSlots = [...presetBar.children].filter(shown).map((button) => button.textContent);
        check(`presets ${name}: trained slots and home are visible`, ["1", "3", "0"].every((slot) => visibleSlots.includes(slot)), visibleSlots.join(","));
        if (presetBar.classList.contains("is-filtered")) {
          check(`presets ${name}: only trained slots and home are shown when space is tight`, visibleSlots.join(",") === "1,3,0", visibleSlots.join(","));
        }
        if (width === 1600) check("presets: all slots return when there is room", visibleSlots.length === 10, visibleSlots.join(","));
        layoutChecks(`compact camera presets ${name}`);
        parameters.camera_presets = {};
        renderPresets();
      }
      check("presets: a window shape with the panel below the video was tried", stackSize !== null);
      // The rest runs with the settings drawer open.
      await setWindow(...(stackSize || [1280, 720]));
      panelOverride = "full";
      updateLayout(true);
      await sleep(800);
      const row = shown(presetBar) ? presetBar : presetDrawer;
      row.scrollIntoView({ block: "nearest" });

      const centre = () => {
        const box = videoHost.getBoundingClientRect();
        return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
      };
      const centreOf = (element) => {
        const box = element.getBoundingClientRect();
        return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
      };
      const commands = async (name) => step(name, { action: "camera-state" });
      // The middle of the picture needs no turn; the click only gives the page the keyboard.
      await step("input-preset-focus", { action: "input", steps: [{ move: centre(), wait: 200 }, { click: 1, wait: 600 }] });
      await step("input-preset-teach", { action: "input", steps: [{ key: "alt+1", wait: 1500 }, { key: "alt+shift+2", wait: 1500 }, { key: "alt+ctrl+3", wait: 1500 }] });
      const taught = parameters.camera_presets;
      check("presets: Alt+1 stored the position and the zoom", Boolean(taught[1]) && taught[1].pan !== undefined && taught[1].zoom !== undefined, JSON.stringify(taught[1]));
      check("presets: Alt+Shift+2 stored the position only", Boolean(taught[2]) && taught[2].pan !== undefined && taught[2].zoom === undefined, JSON.stringify(taught[2]));
      check("presets: Alt+Ctrl+3 stored the zoom only", Boolean(taught[3]) && taught[3].zoom !== undefined && taught[3].pan === undefined, JSON.stringify(taught[3]));
      check("presets: the settings file has them", (await Neutralino.filesystem.readFile(PARAMS_FILE)).includes('"camera_presets"'));

      // Colours: all four kinds differ, and an empty preset is gray (the same amount of every colour).
      const swatch = (index) => {
        const style = getComputedStyle(row.children[index]);
        return { color: style.backgroundColor, image: style.backgroundImage };
      };
      const looks = [0, 1, 2, 3].map(swatch);
      check("presets: position and zoom, position, zoom and empty look different", new Set(looks.map((look) => `${look.color} ${look.image}`)).size === 4,
        looks.map((look) => look.image !== "none" ? "gradient" : look.color).join(" | "));
      check("presets: a preset with both has both colours", looks[0].image.includes("linear-gradient"), looks[0].image);
      const [r, g, b] = (looks[3].color.match(/\d+/g) || []).map(Number);
      check("presets: an empty preset is gray", r === g && g === b, looks[3].color);
      check("presets: the others are not gray", [1, 2].every((i) => { const c = (looks[i].color.match(/\d+/g) || []).map(Number); return !(c[0] === c[1] && c[1] === c[2]); }));
      await shot("camera-presets", "any", 500);

      // Away from the taught pose and zoom, then the number brings the camera back.
      const taughtTurn = (preset) => [-Math.round(preset.pan), -Math.round(preset.tilt)];
      await step("input-preset-away", { action: "input", steps: [{ key: "Right", wait: 400 }, { key: "Right", wait: 400 }, { key: "Up", wait: 400 }, { move: centre(), wait: 100 }, { wheel: "up", wait: 800 }] });
      let was = await commands("preset-state-1");
      await step("input-preset-apply-1", { action: "input", steps: [{ key: "1", wait: 2000 }] });
      let now = await commands("preset-state-2");
      const lastTurn = now.turns.at(-1);
      const wanted = taughtTurn(taught[1]);
      check("presets: the key 1 turned the camera to the taught position", now.turns.length === was.turns.length + 1 && Math.abs(lastTurn[1] - wanted[0]) <= 1 && Math.abs(lastTurn[2] - wanted[1]) <= 1,
        `turned ${JSON.stringify(lastTurn)}, taught ${JSON.stringify(wanted)}`);
      check("presets: and set the taught zoom", now.zooms.length === was.zooms.length + 1 && now.zooms.at(-1) === Math.round(taught[1].zoom * 36), `zoom ${now.zooms.at(-1)}, taught ${taught[1].zoom * 36}`);

      // A position preset turns only; a zoom preset zooms only.
      await step("input-preset-away-2", { action: "input", steps: [{ key: "Left", wait: 400 }, { key: "Left", wait: 400 }, { move: centre(), wait: 100 }, { wheel: "up", wait: 800 }] });
      was = await commands("preset-state-3");
      await step("input-preset-apply-2", { action: "input", steps: [{ key: "2", wait: 2000 }] });
      now = await commands("preset-state-4");
      check("presets: the key 2 (position only) turned the camera and left the zoom alone", now.turns.length === was.turns.length + 1 && now.zooms.length === was.zooms.length,
        `turns ${was.turns.length} -> ${now.turns.length}, zooms ${was.zooms.length} -> ${now.zooms.length}`);
      was = now;
      await step("input-preset-apply-3", { action: "input", steps: [{ key: "3", wait: 2000 }] });
      now = await commands("preset-state-5");
      check("presets: the key 3 (zoom only) zoomed the camera and did not turn it", now.zooms.length === was.zooms.length + 1 && now.turns.length === was.turns.length,
        `turns ${was.turns.length} -> ${now.turns.length}, zooms ${was.zooms.length} -> ${now.zooms.length}`);

      // The fixed preset 0: straight ahead and zoomed out fully, and nothing teaches or deletes it.
      const fixedLook = getComputedStyle(row.children[9]);
      check("presets: the button of 0 has both colours and a ring", fixedLook.backgroundImage.includes("linear-gradient") && fixedLook.boxShadow !== "none", `${fixedLook.boxShadow}`);
      was = await commands("preset-state-6");
      await step("input-preset-apply-0", { action: "input", steps: [{ key: "0", wait: 2000 }] });
      now = await commands("preset-state-7");
      check("presets: the key 0 turned the camera straight ahead", now.turns.length === was.turns.length + 1 && now.turns.at(-1)[1] === 0 && now.turns.at(-1)[2] === 0,
        `turned ${JSON.stringify(now.turns.at(-1))}`);
      check("presets: and zoomed it out fully", now.zooms.length === was.zooms.length + 1 && now.zooms.at(-1) === 0, `zoom ${now.zooms.at(-1)}`);
      was = now;
      await step("input-preset-fixed", { action: "input", steps: [{ key: "alt+0", wait: 600 }, { key: "alt+shift+0", wait: 600 }, { key: "alt+ctrl+0", wait: 600 }, { key: "alt+ctrl+shift+0", wait: 800 }] });
      now = await commands("preset-state-8");
      check("presets: Alt+0 in all forms changed nothing", parameters.camera_presets[0] === undefined && now.turns.length === was.turns.length && now.zooms.length === was.zooms.length
        && Boolean(parameters.camera_presets[1]), `${JSON.stringify(Object.keys(parameters.camera_presets))}`);
      check("presets: and said why", /preset 0 is fixed/.test(statusText + (status.textContent || "")), status.textContent);

      // The menu of a button: a right click opens it next to the button, inside the window; Escape closes it.
      await step("input-preset-menu", { action: "input", steps: [{ move: centreOf(row.children[3]), wait: 300 }, { click: 3, wait: 800 }] });
      const menuBox = presetMenu.getBoundingClientRect();
      check("presets: a right click opens the menu", presetMenu.hidden === false && presetMenu.children.length === 6, `${presetMenu.children.length} children`);
      check("presets: the menu is whole inside the window", menuBox.left >= 0 && menuBox.top >= 0 && menuBox.right <= innerWidth + 0.5 && menuBox.bottom <= innerHeight + 0.5,
        `${Math.round(menuBox.left)},${Math.round(menuBox.top)} ${Math.round(menuBox.width)}x${Math.round(menuBox.height)} in ${innerWidth}x${innerHeight}`);
      const menuVideo = videoHost.getBoundingClientRect();
      const menuDrawer = drawer.getBoundingClientRect();
      check("presets: the menu stays inside the settings drawer", menuBox.left >= menuDrawer.left - 0.5 && menuBox.right <= menuDrawer.right + 0.5 &&
        menuBox.top >= Math.max(menuDrawer.top, panel.getBoundingClientRect().top) - 0.5 && menuBox.bottom <= Math.min(menuDrawer.bottom, panel.getBoundingClientRect().bottom) + 0.5);
      check("presets: the video remains visible outside the menu", menuVideo.width > 0 && menuVideo.height > 0 &&
        (menuBox.right <= menuVideo.left + 1 || menuBox.left >= menuVideo.right - 1 || menuBox.bottom <= menuVideo.top + 1 || menuBox.top >= menuVideo.bottom - 1));
      await shot("camera-preset-menu", "any", 300);
      await step("input-preset-menu-close", { action: "input", steps: [{ key: "Escape", wait: 600 }] });
      check("presets: Escape closes the menu", presetMenu.hidden === true);

      // Delete from the menu of the zoom preset.
      await step("input-preset-menu-delete", { action: "input", steps: [{ move: centreOf(row.children[2]), wait: 300 }, { click: 3, wait: 800 }] });
      await step("input-preset-menu-delete-click", { action: "input", steps: [{ move: centreOf(presetMenu.children[5]), wait: 300 }, { click: 1, wait: 800 }] });
      check("presets: Delete in the menu removed preset 3", parameters.camera_presets[3] === undefined && presetMenu.hidden === true, JSON.stringify(parameters.camera_presets[3]));
      check("presets: and its button is gray again", getComputedStyle(row.children[2]).backgroundColor === looks[3].color);
      await step("input-preset-delete-key", { action: "input", steps: [{ key: "alt+ctrl+shift+2", wait: 800 }] });
      check("presets: Alt+Ctrl+Shift+2 deleted preset 2", parameters.camera_presets[2] === undefined, JSON.stringify(parameters.camera_presets[2]));

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
