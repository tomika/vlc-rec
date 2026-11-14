const ip = document.getElementById("ip");
const scanBtn = document.getElementById("scanBtn");
const outPath = document.getElementById("outPath");
const filename = document.getElementById("filename");
const extension = document.getElementById("extension");
const browseBtn = document.getElementById("browseBtn");
const recordBtn = document.getElementById("recordBtn");
const previewBtn = document.getElementById("previewBtn");
const autoReconnect = document.getElementById("autoReconnect");
const fileSize = document.getElementById("fileSize");
const elapsed = document.getElementById("elapsed");
const status = document.getElementById("status");
const scanDialog = document.getElementById("scanDialog");
const scanMaskInput = document.getElementById("scanMask");
const scanPortInput = document.getElementById("scanPort");
const startScanBtn = document.getElementById("startScanBtn");
const abortScanBtn = document.getElementById("abortScanBtn");
const closeScanBtn = document.getElementById("closeScanBtn");
const scanProgress = document.getElementById("scanProgress");
const scanCurrent = document.getElementById("scanCurrent");
const scanProgressBar = document.getElementById("scanProgressBar");
const scanProgressBarFill = document.getElementById("scanProgressBarFill");
const scanResults = document.getElementById("scanResults");
const videoHost = document.getElementById("videoHost");
const layoutEl = document.getElementById("layout");
const panel = document.getElementById("panel");
const drawer = document.getElementById("drawer");
const stage = document.getElementById("stage");
const panelToggle = document.getElementById("panelToggle");
const modeBadge = document.getElementById("modeBadge");
const cameraBar = document.getElementById("cameraBar");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const cameraSpeed = document.getElementById("cameraSpeed");
const cameraSpeedValue = document.getElementById("cameraSpeedValue");
const previewCaching = document.getElementById("previewCaching");
const srtLatency = document.getElementById("srtLatency");
const bufferPending = document.getElementById("bufferPending");
const bufferPendingText = document.getElementById("bufferPendingText");
const bufferApplyBtn = document.getElementById("bufferApplyBtn");
const cameraPluginItem = document.getElementById("cameraPluginItem");
const cameraPluginSelect = document.getElementById("cameraPluginSelect");
const cameraPage = document.getElementById("cameraPage");
const cameraAddressText = document.getElementById("cameraAddressText");
const cameraPageBtn = document.getElementById("cameraPageBtn");
const cameraHintText = document.getElementById("cameraHint");
const cameraClickDelay = document.getElementById("cameraClickDelay");
const cameraClickDelayRow = document.getElementById("cameraClickDelayRow");
const cameraClickDelayHint = document.getElementById("cameraClickDelayHint");
const cameraZoomItem = document.getElementById("cameraZoomItem");
const cameraSpeedItem = document.getElementById("cameraSpeedItem");
const presetBar = document.getElementById("presetBar");
const presetDrawer = document.getElementById("presetDrawer");
const presetMenu = document.getElementById("presetMenu");

const DEFAULT_PARAMS = {
  ip_address: "127.0.0.1:5000",
  output_path: "",
  output_filename: `${new Date().toISOString().slice(0, 10)}.mkv`,
  bash_path: "bash",
  scan_concurrency: 25,
  scan_timeout_ms: 300,
  auto_reconnect: false,
  stall_timeout_sec: 15,
  // Optional camera control through an adapter (plugins/<id>/, docs/camera-plugin-interface.md).
  // camera_plugin is the id of the adapter ("" selects the sole available adapter) and camera_config what its
  // manifest asks for (the address of the camera, ...). camera_turn_speed is the speed of a turn after
  // a click in degrees per second; the slider next to the zoom buttons changes it. The zoom step is a
  // percent of the zoom range, the arrow key step is in degrees.
  camera_plugin: "",
  camera_config: {},
  camera_turn_speed: 10,
  camera_zoom_step: 10,
  camera_arrow_step_deg: 2,
  camera_double_click_ms: 300,
  // Camera presets 1 to 9: { "1": { pan, tilt, zoom }, ... }. A preset has a position (pan and tilt in degrees),
  // a zoom (0..1 of the range of the camera), or both. The keys 1 to 9 apply one, Alt+number teaches it.
  camera_presets: {},
  // VLC's own network caching (1000 ms) delays the picture by about that much. How small it can be
  // depends on the network and the computer: with the 4K stream of a Tail 2 over a LAN and software
  // decoding, 150 ms froze the picture, 250 ms and more moved, 500 ms lost none. 0 and up is taken as
  // it is; -1 leaves VLC's default.
  preview_caching_ms: 500,
  // SRT latency of the preview in ms, a VLC option on top of the network cache. -1 (the default) leaves VLC's own,
  // which is the same as not having the option. Only a preview takes it: a recording keeps VLC's default, because
  // a low latency drops packets on a lossy link, and a hole in a recording stays there.
  srt_latency_ms: -1
};

const PARAMS_FILE = `${NL_PATH}/vlc_rec_params.json`;
const SCAN_CONCURRENCY_DEFAULT = 25;
const SCAN_CONCURRENCY_MIN = 1;
const SCAN_CONCURRENCY_MAX = 256;
const MAX_SCAN_TARGETS = 65536;
const probeProcessHandlers = new Map();
// Dead hosts dominate a scan (a /24 has ~253 of them) and each costs exactly one
// connect_timeout, so this value drives both total scan time and how fast an
// abort drains. On a LAN the SRT handshake completes in well under 100ms.
const SCAN_TIMEOUT_MS_DEFAULT = 300;
const SCAN_TIMEOUT_MS_MIN = 100;
const SCAN_TIMEOUT_MS_MAX = 5000;
// VLC is heavy and slow (~3-6s per host); cap its concurrency well below the
// ffprobe/ffmpeg path so a VLC-only fallback scan does not overload the machine.
const VLC_VERIFY_CONCURRENCY_MAX = 6;
const RESULT_STATE_FOUND = "SRT found";
const RESULT_STATE_NOT_SRT = "not srt";
const RESULT_STATE_UNKNOWN = "unknown";
const RECONNECT_RETRY_MS = 5000;
const PREVIEW_CHECK_MS = 5000;
const RECORDING_CADENCE_SAMPLES = 8;
const RECORDING_CADENCE_MIN_SAMPLES = 3;
const RECORDING_STALL_MIN_MS = 3000;
// The player finalizes the output file while stopping; large MP4 files need time.
const PLAYER_STOP_GRACE_MS = 10000;
// The panel goes beside or below the video, in full or as the compact essentials.
const LAYOUTS = [
  { name: "side", compact: false },
  { name: "stack", compact: false },
  { name: "side", compact: true },
  { name: "stack", compact: true }
];
const DEFAULT_VIDEO_ASPECT = 16 / 9;
// While a stream runs, the panel collapses when the full panel would leave the
// video less than this share of the area it gets next to the compact controls.
// It expands again only above the second share, so resizing near the limit does
// not flip it back and forth.
const FULL_PANEL_MIN_SHARE = 0.8;
const FULL_PANEL_EXPAND_SHARE = 0.85;
// Resizing keeps the current arrangement while it is nearly as good, so the panel
// does not jump between the side and the bottom around the break-even size.
const LAYOUT_KEEP_SHARE = 0.97;
const SIDE_PANEL_MAX_WIDTH = 560;
// The camera needs about half a second to turn and the picture lags behind it, so a click
// right after a turn would aim at a picture that is already out of date.
const CAMERA_CLICK_COOLDOWN_MS = 1000;
const CAMERA_NUDGE_INTERVAL_MS = 90;
const CAMERA_WHEEL_INTERVAL_MS = 120;
const CAMERA_NOTE_MS = 6000;
// Measured on a Tail 2 with its SRT picture: a turn starts 150 to 500 ms after the command, and
// the picture shows it about 600 ms later even with the smallest receiver buffer.
const CAMERA_TURN_START_MS = 400;
const CAMERA_PICTURE_LAG_MS = 800;

let parameters = { ...DEFAULT_PARAMS };
let mode = "idle";
let currentProcess = null;
let startTimeMs = 0;
let outputFile = "";
let statusText = "";
// How the status line looks: "info" (plain), "warn" (something is being worked around) or "error".
let statusKind = "info";
let operationToken = 0;
let simSizeBytes = 1024;
let simLastTickSec = 0;
let uiBusy = false;
let activeSession = null;
let monitorBusy = false;
let closeRequested = false;
// Display aspect ratio of the stream; the last one is kept after the player stops.
let videoAspect = DEFAULT_VIDEO_ASPECT;
let layoutReady = false;
let currentLayout = null;
let lastAutoCompact = null;
// What the last layout pass was computed from, and the stage size it produced.
let layoutInputs = "";
let layoutStageSize = "";
// True while a player is being started, so the layout is already the streaming one
// when the player receives its rectangle.
let startingStream = false;
// "", "full" or "compact": a choice made with the toggle button.
let panelOverride = "";
// The camera adapter process, or null; and a short message about it shown with the status.
let cameraProc = null;
let cameraNote = "";
let cameraNoteUntil = 0;
let cameraBusyUntil = 0;
let lastNudgeAt = 0;
let lastWheelAt = 0;
let scanState = {
  running: false,
  abortRequested: false,
  token: 0,
  total: 0,
  checked: 0,
  found: new Set(),
  activeHosts: new Set(),
  activeProbeIds: new Set(),
  resultOptions: new Map(),
  verifierChecked: false,
  verifierKind: ""
};

function inferExt(name) {
  const value = String(name || "").toLowerCase();
  return value.endsWith(".mp4") ? "mp4" : "mkv";
}

function baseNameWithoutExt(name) {
  const value = String(name || "");
  if (value.toLowerCase().endsWith(".mkv") || value.toLowerCase().endsWith(".mp4")) {
    return value.slice(0, -4);
  }
  return value;
}

function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes || 0);
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(2)} ${units[idx]}`;
}

function formatElapsed(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function isSimulationMode() {
  return parameters.srt_mode === "simulation";
}

function normalizeError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (typeof err.message === "string" && err.message.trim()) return err.message;
  return JSON.stringify(err);
}

function friendlySpawnError(err) {
  const text = normalizeError(err);
  if (text.includes("ENOENT") || text.includes("NE_OS_")) {
    return "VLC executable was not found. Install VLC and add it to PATH, or set srt_mode to simulation in vlc_rec_params.json.";
  }
  return `Failed to start VLC: ${text}`;
}

function logDebug(message) {
  try {
    if (Neutralino && Neutralino.debug && typeof Neutralino.debug.log === "function") {
      Neutralino.debug.log(String(message || "")).catch(() => {});
    }
  } catch {
    // Ignore debug logger availability errors.
  }
}

function setStatus(text, kind = "info") {
  status.textContent = text || "";
  status.dataset.kind = text ? kind : "";
  // Narrow layouts cut the message to one line; the tooltip shows all of it.
  status.title = text || "";
}

// What the status line says on the next refresh (once a second, and after each operation).
function noteStatus(text, kind = "info") {
  statusText = text;
  statusKind = kind;
}

function setScanProgress(text) {
  scanProgress.textContent = text || "";
}

function updateScanProgressBar() {
  const total = Number(scanState.total || 0);
  const checked = Number(scanState.checked || 0);
  const percent = total > 0
    ? Math.max(0, Math.min(100, Math.round((checked / total) * 100)))
    : 0;

  scanProgressBarFill.style.width = `${percent}%`;
  scanProgressBarFill.textContent = `${percent}%`;
  scanProgressBar.setAttribute("aria-valuenow", String(percent));
}

function buildIpRanges(hosts) {
  const normalized = hosts
    .filter((host) => isValidIPv4(host))
    .map((host) => normalizeIPv4(host));

  if (normalized.length === 0) {
    return [];
  }

  const sorted = Array.from(new Set(normalized)).sort((a, b) => ipv4ToInt(a) - ipv4ToInt(b));
  const ranges = [];

  let start = sorted[0];
  let prevInt = ipv4ToInt(sorted[0]);

  for (let i = 1; i < sorted.length; i += 1) {
    const host = sorted[i];
    const currentInt = ipv4ToInt(host);
    if (currentInt === prevInt + 1) {
      prevInt = currentInt;
      continue;
    }

    ranges.push({ start, end: intToIPv4(prevInt) });
    start = host;
    prevInt = currentInt;
  }

  ranges.push({ start, end: intToIPv4(prevInt) });
  return ranges;
}

function formatIpRanges(hosts, maxRanges = 4) {
  const ranges = buildIpRanges(hosts);
  if (ranges.length === 0) {
    return "idle";
  }

  const labels = ranges.slice(0, maxRanges).map((range) => {
    if (range.start === range.end) {
      return range.start;
    }
    return `${range.start}-${range.end}`;
  });

  if (ranges.length > maxRanges) {
    labels.push(`+${ranges.length - maxRanges} more range(s)`);
  }

  return labels.join(", ");
}

function updateScanCurrentInfo() {
  const active = Array.from(scanState.activeHosts);
  if (active.length === 0) {
    scanCurrent.textContent = "Current: idle";
    return;
  }

  // Keep this short: the line is a single fixed-height row, so a long list
  // would just get clipped instead of showing the "+N more" summary.
  scanCurrent.textContent = `Current: ${formatIpRanges(active, 2)}`;
}

function resetScanVisuals() {
  scanState.total = 0;
  scanState.checked = 0;
  scanState.activeHosts = new Set();
  scanState.activeProbeIds = new Set();
  updateScanCurrentInfo();
  updateScanProgressBar();
}

function setBusy(value) {
  uiBusy = Boolean(value);
  updateButtons();
}

function isValidOctet(value) {
  if (!/^\d{1,3}$/.test(String(value))) return false;
  const n = Number(value);
  return n >= 0 && n <= 255;
}

function isValidIPv4(value) {
  const parts = String(value || "").split(".");
  return parts.length === 4 && parts.every(isValidOctet);
}

function isExcludedScanHost(host) {
  const value = String(host || "").trim();
  return value === "0.0.0.0"
    || value.startsWith("127.")
    || value.startsWith("169.254.");
}

function normalizeIPv4(value) {
  return String(value || "")
    .split(".")
    .map((part) => String(Number(part)))
    .join(".");
}

function ipv4ToInt(value) {
  const parts = normalizeIPv4(value).split(".").map((part) => Number(part));
  return (
    ((parts[0] << 24) >>> 0)
    + ((parts[1] << 16) >>> 0)
    + ((parts[2] << 8) >>> 0)
    + (parts[3] >>> 0)
  ) >>> 0;
}

function intToIPv4(value) {
  const n = value >>> 0;
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255
  ].join(".");
}

function parseAddressPort(text) {
  const raw = String(text || "").trim();
  if (!raw) return { host: "", port: 0 };
  const idx = raw.lastIndexOf(":");
  if (idx < 0) return { host: raw, port: 0 };

  const host = raw.slice(0, idx).trim();
  const port = Number(raw.slice(idx + 1).trim());
  return {
    host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0
  };
}

function buildPlaybackUri(ipAddress) {
  const raw = String(ipAddress || "").trim();
  if (!raw) {
    throw new Error("SRT stream address is empty.");
  }

  if (/^srt:\/\//i.test(raw)) {
    return raw;
  }

  const modeValue = String(parameters.srt_mode || "").trim();
  const suffix = modeValue ? `?mode=${encodeURIComponent(modeValue)}` : "";
  return `srt://@${raw}${suffix}`;
}

function currentOutputFilenameFromUI() {
  const base = filename.value.trim()
    || baseNameWithoutExt(parameters.output_filename || DEFAULT_PARAMS.output_filename);
  const ext = extension.value === "mp4" ? "mp4" : "mkv";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

function resultLabel(addressPort, state) {
  return `${addressPort} [${state}]`;
}

function resultStateKey(state) {
  return String(state || "")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function resultColorForState(state) {
  if (state === RESULT_STATE_FOUND) return "#2ecc71";
  if (state === RESULT_STATE_NOT_SRT) return "#e67e22";
  if (state === RESULT_STATE_UNKNOWN) return "#bdc3c7";
  return "#ecf0f1";
}

function setResultState(addressPort, state) {
  const option = scanState.resultOptions.get(addressPort);
  if (!option) return;

  option.dataset.state = state;
  option.dataset.stateKey = resultStateKey(state);
  option.className = `scan-result-option scan-state-${resultStateKey(state)}`;
  option.style.color = resultColorForState(state);
  option.textContent = resultLabel(addressPort, state);
}

function clearScanResults() {
  scanResults.innerHTML = "";
  scanState.found = new Set();
  scanState.resultOptions = new Map();
}

function addScanResult(addressPort, state) {
  if (scanState.found.has(addressPort)) return;
  scanState.found.add(addressPort);

  const option = document.createElement("option");
  option.value = addressPort;
  scanResults.appendChild(option);
  scanState.resultOptions.set(addressPort, option);
  setResultState(addressPort, state || RESULT_STATE_FOUND);
}

function updateScanControls() {
  startScanBtn.disabled = scanState.running;
  abortScanBtn.disabled = !scanState.running;
  scanMaskInput.disabled = scanState.running;
  scanPortInput.disabled = scanState.running;
}

function openScanDialog() {
  const currentIpValue = ip.value.trim();
  if (currentIpValue) {
    parameters.ip_address = currentIpValue;
  }

  const parsed = parseAddressPort(ip.value.trim());

  if (parsed.port) {
    scanPortInput.value = String(parsed.port);
  } else if (!scanPortInput.value) {
    scanPortInput.value = "5000";
  }

  if (!scanMaskInput.value && isValidIPv4(parsed.host) && !isExcludedScanHost(parsed.host)) {
    const parts = normalizeIPv4(parsed.host).split(".");
    scanMaskInput.value = `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  }

  scanDialog.hidden = false;
  sendPlayerCommand("HIDE");
  setScanProgress("Configure IP mask and port, then click Start Scan.");
  resetScanVisuals();
  updateScanControls();
  setTimeout(() => {
    scanMaskInput.focus();
  }, 0);
}

function requestScanAbort(message) {
  if (!scanState.running) return;
  scanState.abortRequested = true;

  // Kill the probes that are still running so they stop occupying the machine,
  // and bump the token to orphan their workers: results are discarded at the
  // next checkpoint and startScan's finally block skips its cleanup, so the UI
  // is released here and now rather than after the in-flight probes finish.
  abortActiveScanProbes().catch(() => {});
  scanState.token += 1;
  scanState.running = false;
  scanState.activeHosts = new Set();
  updateScanCurrentInfo();
  updateScanProgressBar();
  updateScanControls();
  updateButtons();

  if (message) setScanProgress(message);
}

function closeScanDialog() {
  if (scanState.running) {
    requestScanAbort("Abort requested...");
  }
  setScanProgress("Idle.");
  resetScanVisuals();
  scanDialog.hidden = true;
  sendPlayerCommand("SHOW");
}

async function showError(text) {
  if (!text) return;
  try {
    await Neutralino.os.showMessageBox("VLC Stream Recorder", text, "OK", "ERROR");
  } catch {
    alert(text);
  }
}

async function pathExists(path) {
  try {
    await Neutralino.filesystem.getStats(path);
    return true;
  } catch {
    return false;
  }
}

// Earlier builds named an OBSBOT camera by camera_ip and kept its tuning in camera_* keys of their own.
// Those became the config of the OSC adapter; the zoom step was in the camera's units and is now
// a percent of the zoom range.
function migrateCameraSettings(loaded) {
  if (!loaded || typeof loaded !== "object" || !Object.prototype.hasOwnProperty.call(loaded, "camera_ip")) return loaded;
  const out = { ...loaded };
  const host = String(out.camera_ip || "").trim();
  const zoomMax = numberParam(out.camera_zoom_max, 36, 1, 100);
  if (host && !out.camera_plugin) {
    out.camera_plugin = "osc";
    out.camera_config = {
      host,
      hfov: numberParam(out.camera_hfov_deg, 76, 10, 170),
      zoomRatio: numberParam(out.camera_zoom_ratio, 4.6, 1, 100),
      zoomMax,
      nudgeSpeed: numberParam(out.camera_arrow_speed, 30, 1, 90)
    };
  }
  if (out.camera_zoom_step !== undefined) {
    out.camera_zoom_step = Math.min(50, Math.max(1, Math.round(numberParam(out.camera_zoom_step, 4, 1, 100) * 100 / zoomMax)));
  }
  for (const key of ["camera_ip", "camera_hfov_deg", "camera_zoom_max", "camera_zoom_ratio", "camera_arrow_speed"]) delete out[key];
  return out;
}

async function loadParams() {
  try {
    if (await pathExists(PARAMS_FILE)) {
      const raw = await Neutralino.filesystem.readFile(PARAMS_FILE);
      parameters = { ...parameters, ...migrateCameraSettings(JSON.parse(raw)) };
    }
  } catch {
    parameters = { ...DEFAULT_PARAMS };
  }

  parameters.output_filename = `${new Date().toISOString().slice(0, 10)}.${inferExt(parameters.output_filename)}`;
  parameters.camera_presets = normalizePresets(parameters.camera_presets);
}

let pendingParamsWrite = Promise.resolve();

async function saveParams(ipAddress, outputPathValue, outputFilename) {
  parameters = {
    ...parameters,
    ip_address: ipAddress,
    output_path: outputPathValue,
    output_filename: outputFilename
  };
  const contents = `${JSON.stringify(parameters, null, 2)}\n`;
  // Keep writes in the order of the user actions, even if the filesystem is slow.
  const write = pendingParamsWrite.catch(() => {}).then(() => Neutralino.filesystem.writeFile(PARAMS_FILE, contents));
  pendingParamsWrite = write;
  await write;
}

function resetState(newStatus = "Stopped.", kind = "info") {
  activeSession = null;
  mode = "idle";
  currentProcess = null;
  startTimeMs = 0;
  outputFile = "";
  simSizeBytes = 1024;
  simLastTickSec = 0;
  noteStatus(newStatus, kind);
}

function shellQuote(value) {
  const input = String(value == null ? "" : value);
  if (NL_OS === "Windows") {
    return `"${input.replace(/"/g, '""')}"`;
  }
  return `'${input.replace(/'/g, "'\\''")}'`;
}

function bashPath() {
  const raw = String(parameters.bash_path || DEFAULT_PARAMS.bash_path || "bash").trim();
  return raw || "bash";
}

function bashInvocation(script) {
  return `${shellQuote(bashPath())} -c ${shellQuote(script)}`;
}

function scanConcurrency() {
  const raw = Number(parameters.scan_concurrency);
  if (!Number.isFinite(raw)) return SCAN_CONCURRENCY_DEFAULT;
  const value = Math.floor(raw);
  if (value < SCAN_CONCURRENCY_MIN) return SCAN_CONCURRENCY_MIN;
  if (value > SCAN_CONCURRENCY_MAX) return SCAN_CONCURRENCY_MAX;
  return value;
}

function scanTimeoutMs() {
  const raw = Number(parameters.scan_timeout_ms);
  if (!Number.isFinite(raw)) return SCAN_TIMEOUT_MS_DEFAULT;
  const value = Math.floor(raw);
  if (value < SCAN_TIMEOUT_MS_MIN) return SCAN_TIMEOUT_MS_MIN;
  if (value > SCAN_TIMEOUT_MS_MAX) return SCAN_TIMEOUT_MS_MAX;
  return value;
}

async function ensureBashAvailable() {
  if (NL_OS === "Windows") return true;
  try {
    const info = await Neutralino.os.execCommand(`${shellQuote(bashPath())} -c "exit 0"`);
    if (Number(info.exitCode) === 0) return true;
  } catch {
    // Fall through to warning below.
  }

  const message = `This app requires the 'bash' shell to control VLC and to scan ports on Linux/macOS. `
    + `It could not be launched using '${bashPath()}'. `
    + `Install bash (most distributions ship it by default) or set the 'bash_path' parameter `
    + `in vlc_rec_params.json to the full path of the bash executable.`;
  try {
    await Neutralino.os.showMessageBox("VLC Stream Recorder", message, "OK", "WARNING");
  } catch {
    // Ignore dialog errors; the warning is best-effort.
  }
  logDebug(`bash not available at '${bashPath()}'.`);
  return false;
}

function splitCsvValues(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function prioritizeHostsNearCurrent(hosts) {
  const parsed = parseAddressPort(ip.value.trim());
  if (!isValidIPv4(parsed.host)) {
    return hosts;
  }

  const targetInt = ipv4ToInt(parsed.host);
  const weighted = hosts.map((host) => ({
    host,
    dist: Math.abs(ipv4ToInt(host) - targetInt)
  }));

  weighted.sort((a, b) => a.dist - b.dist);
  return weighted.map((item) => item.host);
}

function cidrToHosts(cidr) {
  const match = String(cidr || "").trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return [];

  const ipValue = match[1];
  const prefix = Number(match[2]);

  if (!isValidIPv4(ipValue) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return [];
  }

  const ipInt = ipv4ToInt(ipValue);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  const start = network;
  const end = broadcast;

  const total = end >= start ? (end - start + 1) : 0;
  if (total > MAX_SCAN_TARGETS) {
    throw new Error(
      `Detected subnet ${cidr} with ${total} hosts. Please enter a narrower IP mask (for example 192.168.1.*).`
    );
  }

  const hosts = [];
  for (let current = start; current <= end; current += 1) {
    hosts.push(intToIPv4(current));
  }
  return hosts;
}

function hostsFromMask(maskValue) {
  const mask = String(maskValue || "").trim();
  if (!mask) return [];

  if (isValidIPv4(mask)) {
    return [normalizeIPv4(mask)];
  }

  const wildcard = mask.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\*$/);
  if (wildcard) {
    const [a, b, c] = wildcard.slice(1).map((part) => Number(part));
    if ([a, b, c].some((part) => part < 0 || part > 255)) {
      throw new Error(`Invalid IP mask: ${mask}`);
    }

    const hosts = [];
    for (let d = 0; d <= 255; d += 1) {
      hosts.push(`${a}.${b}.${c}.${d}`);
    }
    return hosts;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(mask)) {
    return cidrToHosts(mask);
  }

  throw new Error(`Invalid IP mask: ${mask}. Use values like 192.168.1.* or 192.168.1.0/24.`);
}

function dedupe(values) {
  return Array.from(new Set(values));
}

async function detectLocalCidrs() {
  if (NL_OS === "Windows") {
    const winCmd = "powershell -NoProfile -NonInteractive -Command \"$items=Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '0.0.0.0' } | ForEach-Object { '{0}/{1}' -f $_.IPAddress, $_.PrefixLength }; $items -join ','\"";
    const winInfo = await Neutralino.os.execCommand(winCmd);
    return splitCsvValues(winInfo.stdOut).filter((entry) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(entry));
  }

  if (NL_OS === "Linux" || NL_OS === "Darwin") {
    const primary = await Neutralino.os.execCommand(bashInvocation("ip -o -f inet addr show 2>/dev/null | awk '{print $4}' | paste -sd, -"));
    const cidrs = splitCsvValues(primary.stdOut).filter((entry) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(entry));
    if (cidrs.length > 0) return cidrs;

    const fallback = await Neutralino.os.execCommand(bashInvocation("ifconfig 2>/dev/null | awk '/inet / && $2 != \"127.0.0.1\" {print $2\"/24\"}' | paste -sd, -"));
    return splitCsvValues(fallback.stdOut).filter((entry) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(entry));
  }

  return [];
}

async function resolveScanHosts(maskValue) {
  const mask = String(maskValue || "").trim();
  if (mask) {
    const maskedHosts = hostsFromMask(mask);
    return dedupe(maskedHosts).filter((host) => !isExcludedScanHost(host));
  }

  const cidrs = await detectLocalCidrs();
  if (cidrs.length === 0) {
    throw new Error("Could not detect local networks automatically. Enter an IP mask like 192.168.1.*.");
  }

  const hosts = [];
  for (const cidr of cidrs) {
    const cidrIp = String(cidr).split("/")[0] || "";
    if (isExcludedScanHost(cidrIp)) continue;
    hosts.push(...cidrToHosts(cidr));
  }

  const deduped = dedupe(hosts).filter((host) => !isExcludedScanHost(host));
  if (deduped.length === 0) {
    throw new Error("No scan targets found from local network interfaces.");
  }
  return deduped;
}

async function commandExists(commandName) {
  try {
    if (NL_OS === "Windows") {
      const info = await Neutralino.os.execCommand(`where ${commandName}`);
      return Number(info.exitCode) === 0;
    }

    const info = await Neutralino.os.execCommand(bashInvocation(`command -v ${commandName}`));
    return Number(info.exitCode) === 0;
  } catch {
    return false;
  }
}

async function getVerifierKind() {
  if (scanState.verifierChecked) {
    return scanState.verifierKind;
  }

  scanState.verifierChecked = true;

  if (await commandExists("ffprobe")) {
    scanState.verifierKind = "ffprobe";
    return scanState.verifierKind;
  }

  if (await commandExists("ffmpeg")) {
    scanState.verifierKind = "ffmpeg";
    return scanState.verifierKind;
  }

  scanState.verifierKind = "vlc";
  return scanState.verifierKind;
}

function buildSrtCallerUri(address, port) {
  return `srt://${address}:${port}?mode=caller&connect_timeout=${scanTimeoutMs()}&latency=120`;
}

// A successful endpoint still costs ~900ms if ffprobe/ffmpeg is allowed to
// analyse the stream at its default depth. We only need to know the handshake
// succeeded, so cap the analysis — this roughly halves the hit case.
const PROBE_ANALYSIS_LIMITS = "-probesize 100000 -analyzeduration 300000";
const PROBE_OK_MARKER = "SRT_PROBE_OK";
const VLC_PROBE_WATCHDOG_MS = 9000;

// Probes deliberately use spawnProcess rather than execCommand. execCommand is
// serviced serially by the native layer, so 25 "concurrent" probes actually ran
// one after another (~8s per batch of 25) and every other Neutralino call --
// including the writeFile behind selecting a result -- queued behind them.
// spawnProcess returns immediately and reports output/exit as events, which
// gives real concurrency and lets an abort kill probes that are still running.

function probeWatchdogMs() {
  return scanTimeoutMs() + 4000;
}

// Decide on a marker echoed by the shell instead of the process exit code, so
// the verdict does not depend on how the exit code is surfaced per platform.
function markerScript(commandLine) {
  const nullDevice = NL_OS === "Windows" ? "nul" : "/dev/null";
  return `${commandLine} >${nullDevice} 2>&1 && echo ${PROBE_OK_MARKER}`;
}

function probeShellCommand(script) {
  // Always route through an explicit shell: the script relies on redirection
  // and '&&', and the SRT URI contains '&'. Being explicit keeps the quoting
  // identical no matter how spawnProcess hands the string to the OS.
  return NL_OS === "Windows" ? `cmd /d /s /c "${script}"` : bashInvocation(script);
}

async function runSrtProbe(commandLine, watchdogMs) {
  const command = probeShellCommand(markerScript(commandLine));
  const procInfo = await Neutralino.os.spawnProcess(command);
  const probeId = procInfo.id;
  scanState.activeProbeIds.add(probeId);

  const output = await new Promise((resolve) => {
    let settled = false;
    const settle = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probeProcessHandlers.delete(probeId);
      scanState.activeProbeIds.delete(probeId);
      resolve(text);
    };

    // Backstop: a probe that never reports an exit must not stall its worker.
    const timer = setTimeout(() => {
      Neutralino.os.updateSpawnedProcess(probeId, "exit").catch(() => {});
      settle("");
    }, watchdogMs);

    probeProcessHandlers.set(probeId, { output: "", settle });
  });

  return output.includes(PROBE_OK_MARKER) ? RESULT_STATE_FOUND : RESULT_STATE_NOT_SRT;
}

async function verifyWithFfprobe(address, port) {
  const uri = buildSrtCallerUri(address, port);
  return await runSrtProbe(
    `ffprobe -v error ${PROBE_ANALYSIS_LIMITS} -show_entries format=format_name -of default=nk=1:nw=1 \"${uri}\"`,
    probeWatchdogMs()
  );
}

async function verifyWithFfmpeg(address, port) {
  const uri = buildSrtCallerUri(address, port);
  // connect_timeout in the SRT URI bounds this on every OS (it is a libsrt
  // option, not a shell feature), so no external timeout wrapper is required.
  // -t 0.5 stops reading a successful stream quickly so ffmpeg exits cleanly.
  return await runSrtProbe(
    `ffmpeg -hide_banner -loglevel error ${PROBE_ANALYSIS_LIMITS} -i \"${uri}\" -t 0.5 -f null -`,
    probeWatchdogMs()
  );
}

async function vlcCommand() {
  if (NL_OS === "Windows" && await pathExists(`${NL_PATH}/vlc/vlc.exe`)) return `${NL_PATH}/vlc/vlc.exe`;
  return "vlc";
}

async function verifyWithVlc(address, port) {
  const uri = buildSrtCallerUri(address, port);
  const vlc = `${shellQuote(await vlcCommand())} --intf dummy --play-and-exit --run-time=2 \"${uri}\" vlc://quit`;

  // VLC has no SRT connect-timeout: on an unreachable host it retries forever
  // and never reaches --run-time, so it must be killed from outside. On unix
  // `timeout` also reaps the VLC child; on Windows the watchdog kill covers it.
  return await runSrtProbe(
    NL_OS === "Windows" ? vlc : `timeout 6 ${vlc}`,
    VLC_PROBE_WATCHDOG_MS
  );
}

async function verifySrtEndpoint(addressPort) {
  const parsed = parseAddressPort(addressPort);
  if (!isValidIPv4(parsed.host) || !parsed.port) {
    return RESULT_STATE_UNKNOWN;
  }

  const verifier = await getVerifierKind();

  try {
    if (verifier === "ffprobe") {
      return await verifyWithFfprobe(parsed.host, parsed.port);
    }

    if (verifier === "ffmpeg") {
      return await verifyWithFfmpeg(parsed.host, parsed.port);
    }

    return await verifyWithVlc(parsed.host, parsed.port);
  } catch {
    return RESULT_STATE_UNKNOWN;
  }
}

function handleProbeSpawnedProcessEvent(evt) {
  if (!evt || !evt.detail) return;
  const { id, action, data } = evt.detail;
  const handler = probeProcessHandlers.get(id);
  if (!handler) return;

  if (action === "stdOut" || action === "stdErr") {
    handler.output += String(data || "");
    return;
  }

  if (action === "exit") {
    handler.settle(handler.output);
  }
}

async function abortActiveScanProbes() {
  const probeIds = Array.from(scanState.activeProbeIds);
  if (probeIds.length === 0) return;

  await Promise.all(
    probeIds.map((probeId) => Neutralino.os.updateSpawnedProcess(probeId, "exit").catch(() => {}))
  );
}

async function applySelectedAddress(addressPort) {
  ip.value = addressPort;
  parameters.ip_address = addressPort;
  setStatus(`Selected stream endpoint: ${addressPort}`);
  // The camera follows the address of the stream (saved with the settings below), when its adapter
  // takes an address.
  const cameraHost = await cameraHostFor(parseAddressPort(addressPort).host);
  if (cameraHost) parameters.camera_config = { ...(parameters.camera_config || {}), host: cameraHost };

  try {
    await saveParams(addressPort, outPath.value.trim(), currentOutputFilenameFromUI());
  } catch {
    // Ignore persistence failures for selection convenience.
  }
  if (cameraHost) {
    setCameraNote(`address set to ${cameraHost}.`);
    await restartCamera().catch((err) => logDebug(`Camera adapter: ${normalizeError(err)}`));
  }
}

// The address to give the camera adapter for the host of a stream, or "" when the camera stays as it is:
// no adapter chosen, not an IPv4 address, the same address, or an adapter that takes no host.
async function cameraHostFor(host) {
  const id = String(parameters.camera_plugin || "").trim();
  if (!id || !isValidIPv4(host)) return "";
  const current = parameters.camera_config && parameters.camera_config.host;
  if (host === current) return "";
  const found = await findPlugin(id);
  return found && manifestFields(found.manifest).some((field) => field.key === "host") ? host : "";
}

async function startScan() {
  if (scanState.running) return;

  const port = Number(scanPortInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    await showError("Scan port must be an integer between 1 and 65535.");
    return;
  }

  scanState.running = true;
  scanState.abortRequested = false;
  scanState.token += 1;
  scanState.total = 0;
  scanState.checked = 0;
  scanState.activeHosts = new Set();
  scanState.activeProbeIds = new Set();
  clearScanResults();
  updateScanProgressBar();
  updateScanCurrentInfo();
  updateScanControls();
  updateButtons();

  const token = scanState.token;

  try {
    const verifier = await getVerifierKind();
    if (scanState.token !== token) return;
    // VLC verification is heavy and slow, so throttle it much harder than the
    // ffprobe/ffmpeg path, which is fast and bounded by the SRT connect_timeout.
    const concurrency = verifier === "vlc"
      ? Math.min(scanConcurrency(), VLC_VERIFY_CONCURRENCY_MAX)
      : scanConcurrency();

    const resolvedHosts = await resolveScanHosts(scanMaskInput.value);
    const hosts = prioritizeHostsNearCurrent(resolvedHosts);
    if (scanState.token !== token) return;

    scanState.total = hosts.length;
    updateScanProgressBar();
    setScanProgress(
      `Scanning ${hosts.length} addresses on port ${port} (concurrency ${concurrency}, timeout ${scanTimeoutMs()}ms)...`
    );

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
      while (!scanState.abortRequested && scanState.token === token) {
        const idx = nextIndex;
        if (idx >= hosts.length) break;
        nextIndex += 1;

        const host = hosts[idx];
        const addressPort = `${host}:${port}`;
        let state = RESULT_STATE_NOT_SRT;
        scanState.activeHosts.add(host);
        updateScanCurrentInfo();
        try {
          // The SRT handshake IS the reachability test now — a raw UDP port
          // probe cannot tell an open SRT listener from a silently dropped
          // packet, which is what used to hang the scan.
          state = await verifySrtEndpoint(addressPort);
        } catch {
          state = RESULT_STATE_UNKNOWN;
        }
        // Check the token first: an orphaned worker from an aborted scan must
        // not touch the state of whatever scan is running now.
        if (scanState.token !== token) return;

        scanState.activeHosts.delete(host);
        updateScanCurrentInfo();

        scanState.checked += 1;
        updateScanProgressBar();
        if (state === RESULT_STATE_FOUND) {
          addScanResult(addressPort, state);
        }

        if (scanState.checked % 5 === 0 || state === RESULT_STATE_FOUND || scanState.checked === scanState.total) {
          setScanProgress(
            `Scanning ${scanState.checked}/${scanState.total} | found ${scanState.found.size}`
          );
        }
      }
    });

    await Promise.all(workers);
    if (scanState.token !== token) return;

    if (scanState.abortRequested) {
      setScanProgress(`Scan aborted. Checked ${scanState.checked}/${scanState.total}, found ${scanState.found.size}.`);
    } else {
      setScanProgress(`Scan complete. Checked ${scanState.total}, found ${scanState.found.size}.`);
    }
  } catch (err) {
    if (scanState.token === token) {
      setScanProgress(`Scan failed: ${normalizeError(err)}`);
      await showError(normalizeError(err));
    }
  } finally {
    if (scanState.token === token) {
      scanState.running = false;
      scanState.activeHosts = new Set();
      updateScanCurrentInfo();
      updateScanProgressBar();
      updateScanControls();
      updateButtons();
    }
  }
}

function utf8Hex(text) {
  return Array.from(new TextEncoder().encode(String(text)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Returns "" when this platform or architecture has no player; the app then
// starts VLC as an external program, as it does on macOS.
async function findHelperBinary(name) {
  const platform = NL_OS === "Windows" ? "win" : NL_OS === "Linux" ? "linux" : "";
  if (!platform) return "";
  // The AppImage keeps the helpers in its read-only image, and NL_PATH is the settings folder there.
  const playerDir = await Neutralino.os.getEnv("VLC_REC_PLAYER_DIR") || `${NL_PATH}/player`;
  const path = `${playerDir}/${name}-${platform}_${NL_ARCH}${NL_OS === "Windows" ? ".exe" : ""}`;
  return await pathExists(path) ? path : "";
}

async function findPlayerBinary() {
  return findHelperBinary("vlc-rec-player");
}

// ---- optional camera control ----
// A camera adapter (plugins/<id>/, described in docs/camera-plugin-interface.md) is a separate program
// that speaks the camera's own protocol. The frontend has no socket API, so the app talks to it through
// stdin and stdout, one JSON object per line, as it does with the player. The adapter says what the
// camera can do (its capabilities), and the controls follow that.

const CAMERA_INTERFACE = 1;
const CAMERA_REQUEST_TIMEOUT_MS = 3000;
// The first start of a program that is new on the machine can take ten seconds or more on Windows (the answer
// to hello came after 10.5 s in a log), so the wait for hello is long. Later requests are quick.
const CAMERA_START_TIMEOUT_MS = 30000;
const CAMERA_CONNECT_TIMEOUT_MS = 6000;
const CAMERA_RETRY_MS = 5000;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function numberParam(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function cameraActive() {
  return Boolean(cameraProc && !cameraProc.exited);
}

// What the connected camera can do, as the adapter declared it; null while there is no camera.
function cameraCaps() {
  return cameraActive() && cameraProc.caps ? cameraProc.caps : null;
}

function cameraCan(feature) {
  const caps = cameraCaps();
  if (!caps) return false;
  const ptz = caps.ptz && typeof caps.ptz === "object" ? caps.ptz : {};
  switch (feature) {
    case "centerOn": return Boolean(ptz.centerOn);
    case "nudge": return Boolean(ptz.nudge);
    case "speed": return Boolean(ptz.speed && typeof ptz.speed === "object");
    case "zoom": return Boolean(caps.zoom && caps.zoom.by);
    case "trackPerson": return Boolean(caps.ai && caps.ai.trackPerson);
    case "trackStatus": return Boolean(caps.ai && caps.ai.status && caps.ai.stop);
    // Absolute moves: the camera tells where it points (ptz.get, zoom.get) and goes there (ptz.moveTo, zoom.set).
    case "moveTo": return Boolean(ptz.absolute);
    case "zoomSet": return Boolean(caps.zoom && caps.zoom.absolute);
    default: return false;
  }
}

// The range of the turning speed slider, in the unit the adapter declares (degrees per second).
function cameraSpeedRange() {
  const caps = cameraCaps();
  const speed = caps && caps.ptz && caps.ptz.speed;
  const min = Number(speed && speed.min);
  const max = Number(speed && speed.max);
  return Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max > min
    ? { min: Math.ceil(min), max: Math.floor(max) }
    : { min: 1, max: 90 };
}

// The camera's own control page (where, for example, the SD card can be formatted) opens in the web
// browser of the system. The address comes from the adapter, so only a plain http or https one is used.
function cameraPageUrl() {
  const caps = cameraCaps();
  const url = String((caps && caps.webPage && caps.webPage.url) || "").trim();
  return /^https?:\/\/[^\s"'<>`]+$/.test(url) ? url : "";
}

function cameraLabel() {
  const caps = cameraCaps();
  const device = caps && caps.device && typeof caps.device === "object" ? caps.device : {};
  return [device.model, device.address].filter((part) => typeof part === "string" && part).join(" ");
}

function cameraHint() {
  const parts = [];
  if (cameraCan("centerOn")) parts.push("Click the picture to centre it.");
  if (cameraCan("trackPerson")) parts.push("Double-click a person to follow them.");
  if (cameraCan("zoom")) parts.push("Mouse wheel: zoom.");
  if (cameraCan("nudge")) parts.push("Arrow keys: turn (Shift: larger steps).");
  if (presetsAvailable()) {
    parts.push("Keys 1-9: apply a preset. Alt+number: teach it from the camera as it is now, Alt+Shift: position only, " +
      "Alt+Ctrl: zoom only, Alt+Ctrl+Shift: delete. Key 0: the fixed wide shot with the camera centered. " +
      "Right click a preset button in settings for a menu.");
  }
  return parts.join(" ");
}

function showCameraPage() {
  const hint = cameraHint();
  const label = cameraLabel();
  const url = cameraPageUrl();
  cameraPage.hidden = !(cameraCaps() && (hint || label || url));
  cameraAddressText.textContent = label;
  cameraPageBtn.hidden = !url;
  cameraHintText.textContent = hint;
  cameraClickDelayRow.hidden = cameraClickDelayHint.hidden = !cameraCan("trackPerson");
  if (document.activeElement !== cameraClickDelay) cameraClickDelay.value = String(cameraDoubleClickMs());
}

function cameraDoubleClickMs() {
  return Math.round(numberParam(parameters.camera_double_click_ms, DEFAULT_PARAMS.camera_double_click_ms, 100, 1000));
}

function handleCameraClickDelayChange() {
  const typed = Number(cameraClickDelay.value);
  parameters.camera_double_click_ms = cameraClickDelay.value !== "" && Number.isFinite(typed)
    ? Math.max(100, Math.min(1000, Math.round(typed))) : DEFAULT_PARAMS.camera_double_click_ms;
  cameraClickDelay.value = String(parameters.camera_double_click_ms);
  saveParams(parameters.ip_address, parameters.output_path, parameters.output_filename)
    .catch((err) => logDebug(`Could not save the double-click interval: ${normalizeError(err)}`));
}

async function openCameraPage() {
  const url = cameraPageUrl();
  if (!url) return;
  try {
    await Neutralino.os.open(url);
  } catch (err) {
    logDebug(`Could not open ${url}: ${normalizeError(err)}`);
    setCameraNote(`could not open ${url} in the browser.`);
  }
}

function setCameraNote(text) {
  cameraNote = text;
  cameraNoteUntil = Date.now() + CAMERA_NOTE_MS;
}

function withCameraNote(text) {
  if (!cameraNote || Date.now() > cameraNoteUntil) return text;
  return text ? `${text} Camera: ${cameraNote}` : `Camera: ${cameraNote}`;
}

// ---- finding an adapter ----

// The folders adapters are looked for in, first match wins: VLC_REC_PLUGIN_DIR, the plugins folder of the
// settings (where a user installs one), and the plugins folder beside the player (what the app ships with).
async function pluginSearchDirs() {
  const dirs = [];
  const own = await Neutralino.os.getEnv("VLC_REC_PLUGIN_DIR");
  if (own) dirs.push(own);
  dirs.push(`${NL_PATH}/plugins`);
  const playerDir = await Neutralino.os.getEnv("VLC_REC_PLAYER_DIR") || `${NL_PATH}/player`;
  dirs.push(`${playerDir}/plugins`);
  return dirs;
}

// Discover unique usable adapters in search order. An invalid copy does not mask a valid one.
async function discoverCameraPlugins() {
  const ids = new Set();
  for (const dir of await pluginSearchDirs()) {
    try {
      for (const entry of await Neutralino.filesystem.readDirectory(dir)) {
        if (entry.type === "DIRECTORY" && PLUGIN_ID_PATTERN.test(entry.entry)) ids.add(entry.entry);
      }
    } catch (err) {
      logDebug(`Could not scan camera adapters in ${dir}: ${normalizeError(err)}`);
    }
  }
  const plugins = [];
  for (const id of ids) {
    const found = await findPlugin(id);
    if (found) plugins.push({ id, name: found.manifest.name || id });
  }
  return plugins;
}

async function setupCameraPlugins() {
  const plugins = await discoverCameraPlugins();
  const selected = String(parameters.camera_plugin || "").trim();
  // Reuse a configured adapter when available; otherwise a sole usable adapter is unambiguous.
  if (!plugins.some((plugin) => plugin.id === selected) && plugins.length === 1) parameters.camera_plugin = plugins[0].id;
  cameraPluginItem.hidden = plugins.length < 2;
  const options = [];
  if (!parameters.camera_plugin || !plugins.some((plugin) => plugin.id === parameters.camera_plugin)) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a camera adapter";
    options.push(placeholder);
  }
  for (const plugin of plugins) {
    const option = document.createElement("option");
    option.value = plugin.id;
    option.textContent = plugin.name;
    options.push(option);
  }
  cameraPluginSelect.replaceChildren(...options);
  cameraPluginSelect.value = plugins.some((plugin) => plugin.id === parameters.camera_plugin) ? parameters.camera_plugin : "";
}

async function selectCameraPlugin() {
  const id = cameraPluginSelect.value;
  if (!id || id === parameters.camera_plugin) return;
  parameters.camera_plugin = id;
  const host = await cameraHostFor(parseAddressPort(parameters.ip_address).host);
  if (host) parameters.camera_config = { ...(parameters.camera_config || {}), host };
  try { await saveParams(parameters.ip_address, parameters.output_path, parameters.output_filename); }
  catch (err) { setCameraNote(`could not save camera adapter: ${normalizeError(err)}`); }
  await restartCamera();
}

// The program to start and its arguments, from the manifest: the entry for this system and architecture
// (win_x64), then for this system (win), then "default". The program is a path inside the adapter's folder.
function pluginCommand(manifest) {
  const platform = NL_OS === "Windows" ? "win" : NL_OS === "Linux" ? "linux" : NL_OS === "Darwin" ? "mac" : "";
  const table = manifest && typeof manifest.command === "object" && manifest.command ? manifest.command : {};
  const argv = table[`${platform}_${NL_ARCH}`] || table[platform] || table.default;
  if (!Array.isArray(argv) || !argv.length || !argv.every((item) => typeof item === "string" && item)) return null;
  const program = argv[0].replace(/^\.\//, "");
  if (/^[a-zA-Z]:|^[\\/]|\.\.|\\/.test(program)) return null;
  return [program, ...argv.slice(1)];
}

// { dir, manifest, argv } of the adapter with this id, or null.
async function findPlugin(id) {
  if (!PLUGIN_ID_PATTERN.test(id)) return null;
  for (const base of await pluginSearchDirs()) {
    const dir = `${base}/${id}`;
    const manifestPath = `${dir}/plugin.json`;
    if (!await pathExists(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await Neutralino.filesystem.readFile(manifestPath));
    } catch (err) {
      logDebug(`${manifestPath} could not be read: ${normalizeError(err)}`);
      continue;
    }
    if (!manifest || manifest.id !== id || manifest.interface !== CAMERA_INTERFACE) {
      logDebug(`${manifestPath} is not an adapter '${id}' of interface ${CAMERA_INTERFACE}.`);
      continue;
    }
    const argv = pluginCommand(manifest);
    if (!argv || !await pathExists(`${dir}/${argv[0]}`)) {
      logDebug(`The adapter '${id}' has no program for this system (${NL_OS} ${NL_ARCH}).`);
      continue;
    }
    return { dir, manifest, argv };
  }
  return null;
}

function manifestFields(manifest) {
  return manifest && Array.isArray(manifest.config) ? manifest.config.filter((field) => field && typeof field.key === "string") : [];
}

// The config sent with connect: the fields the manifest declares, from the settings, else their defaults.
function cameraConfigFor(manifest) {
  const saved = parameters.camera_config && typeof parameters.camera_config === "object" ? parameters.camera_config : {};
  const config = {};
  for (const field of manifestFields(manifest)) {
    const value = saved[field.key] !== undefined ? saved[field.key] : field.default;
    if (value === undefined || value === null) continue;
    if (field.type === "int" || field.type === "number") {
      const number = Number(value);
      if (Number.isFinite(number)) config[field.key] = number;
      else if (Number.isFinite(Number(field.default))) config[field.key] = Number(field.default);
    } else if (field.type === "bool") {
      config[field.key] = value === true || value === "true";
    } else {
      config[field.key] = String(value);
    }
  }
  return config;
}

// ---- talking to it ----

function cameraError(code, message) {
  return Object.assign(new Error(message), { code });
}

// One request, one answer. Rejects with the adapter's error (code and message) or with a timeout.
function cameraRequest(proc, method, params = {}, timeoutMs = CAMERA_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!proc || proc.exited) {
      reject(cameraError("not_connected", "the camera adapter is not running."));
      return;
    }
    const id = proc.nextId++;
    const timer = setTimeout(() => {
      proc.pending.delete(id);
      reject(cameraError("timeout", `the camera adapter did not answer ${method}.`));
    }, timeoutMs);
    proc.pending.set(id, { resolve, reject, timer });
    Neutralino.os.updateSpawnedProcess(proc.id, "stdIn", `${JSON.stringify({ id, method, params })}\n`).catch(() => {
      clearTimeout(timer);
      proc.pending.delete(id);
      reject(cameraError("not_connected", "the camera adapter is not running."));
    });
  });
}

// A request from a control: the answer matters only when it is an error.
function sendCameraRequest(method, params) {
  const proc = cameraProc;
  if (!proc || proc.exited || !proc.caps) return false;
  // An adapter that is stopped on purpose (a restart) leaves requests unanswered; that is not worth a note.
  cameraRequest(proc, method, params).catch((err) => { if (err.code !== "stopped") setCameraNote(err.message); });
  return true;
}

function failPendingCameraRequests(proc) {
  for (const entry of proc.pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(cameraError("stopped", "the camera adapter stopped."));
  }
  proc.pending.clear();
}

async function startCamera() {
  if (cameraProc) return;
  const id = String(parameters.camera_plugin || "").trim();
  if (!id) return;
  const found = await findPlugin(id);
  if (!found) {
    logDebug(`The camera adapter '${id}' was not found; camera controls are off.`);
    setCameraNote(`the camera adapter '${id}' was not found.`);
    return;
  }
  const command = buildCommand(`${found.dir}/${found.argv[0]}`, found.argv.slice(1));
  logDebug(`Starting the camera adapter: ${command}`);
  const info = await Neutralino.os.spawnProcess(command, { cwd: found.dir });
  const proc = { id: info.id, lineBuffer: "", exited: false, plugin: found, nextId: 1, pending: new Map(), caps: null };
  cameraProc = proc;
  connectCamera(proc).catch((err) => logDebug(`Camera adapter: ${normalizeError(err)}`));
}

// hello, then connect until the camera answers: it may be switched on after the app. The adapter
// answers connect with the capabilities.
async function connectCamera(proc) {
  try {
    await cameraRequest(proc, "hello", { interface: CAMERA_INTERFACE, app: "vlc-rec" }, CAMERA_START_TIMEOUT_MS);
  } catch (err) {
    if (!proc.exited) setCameraNote(`the camera adapter does not take part: ${err.message}`);
    return;
  }
  while (cameraProc === proc && !proc.exited && !proc.stopping) {
    try {
      const result = await cameraRequest(proc, "connect", { config: cameraConfigFor(proc.plugin.manifest) }, CAMERA_CONNECT_TIMEOUT_MS);
      applyCameraCapabilities(proc, result.capabilities);
      return;
    } catch (err) {
      if (proc.exited || proc.stopping) return;
      setCameraNote(err.message);
      // The settings are wrong: asking again does not help.
      if (err.code === "invalid_params") return;
      await new Promise((resolve) => setTimeout(resolve, CAMERA_RETRY_MS));
    }
  }
}

function applyCameraCapabilities(proc, caps) {
  proc.caps = caps && typeof caps === "object" ? caps : {};
  showCameraControls();
  if (cameraCan("trackStatus")) refreshCameraAiState(proc);
  // The speed is the app's setting, not the adapter's.
  if (cameraCan("speed")) sendCameraRequest("ptz.setSpeed", { value: cameraTurnSpeed() });
}

// The panel is arranged differently with the camera controls, so a change arranges it again.
function showCameraControls() {
  const zoom = cameraCan("zoom");
  const speed = cameraCan("speed");
  cameraZoomItem.hidden = !zoom;
  cameraSpeedItem.hidden = !speed;
  cameraBar.hidden = !(zoom || speed);
  layoutEl.dataset.camera = cameraBar.hidden ? "off" : "on";
  if (speed) {
    const range = cameraSpeedRange();
    cameraSpeed.min = String(range.min);
    cameraSpeed.max = String(range.max);
    showCameraSpeed();
  }
  showCameraPage();
  updateAiIndicator();
  renderPresets();
  updateLayout();
}

function updateAiIndicator() {
  const active = Boolean(cameraCan("trackStatus") && cameraProc.aiEnabled === true);
  if (active) videoHost.classList.add("ai-tracking");
  else videoHost.classList.remove("ai-tracking");
  syncPlayerRect();
}

async function refreshCameraAiState(proc = cameraProc) {
  if (!proc || proc !== cameraProc || !cameraCan("trackStatus") || proc.aiPolling || proc.aiBusy) return;
  const revision = proc.aiRevision || 0;
  proc.aiPolling = true;
  try {
    const result = await cameraRequest(proc, "ai.get");
    if (cameraProc !== proc || proc.aiBusy || revision !== (proc.aiRevision || 0)) return;
    if (typeof result.enabled !== "boolean") throw new Error("invalid AI status");
    if (proc.aiEnabled !== result.enabled || proc.aiStateError) logDebug(`Camera AI tracking: ${result.enabled ? "on" : "off"}.`);
    proc.aiStateError = "";
    proc.aiEnabled = result.enabled;
  } catch (err) {
    if (cameraProc !== proc || proc.aiBusy || revision !== (proc.aiRevision || 0)) return;
    const error = normalizeError(err);
    if (proc.aiStateError !== error) logDebug(`Camera AI status unavailable: ${error}`);
    proc.aiStateError = error;
    proc.aiEnabled = null;
  } finally {
    proc.aiPolling = false;
    if (cameraProc === proc) updateAiIndicator();
  }
}

async function runCameraAiAction(method, params = {}, verifyStopped = false) {
  const proc = cameraProc;
  if (!proc || !cameraCan("trackStatus")) return false;
  if (proc.aiBusy) {
    setCameraNote("the previous AI tracking request is still in progress.");
    return false;
  }
  proc.aiBusy = true;
  proc.aiRevision = (proc.aiRevision || 0) + 1;
  try {
    await cameraRequest(proc, method, params);
    if (cameraProc !== proc || proc.exited || !proc.caps) return false;
    if (verifyStopped) {
      let stopped = false;
      for (let i = 0; i < 5; i++) {
        const status = await cameraRequest(proc, "ai.get");
        if (cameraProc !== proc || proc.exited || !proc.caps) return false;
        if (status.enabled === false) { stopped = true; break; }
        if (status.enabled !== true) throw cameraError("device_error", "the camera returned an invalid AI status.");
        if (i < 4) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!stopped) throw cameraError("device_error", "the camera did not turn off AI tracking.");
    }
    proc.aiEnabled = verifyStopped ? false : null;
    updateAiIndicator();
    return true;
  } catch (err) {
    if (err.code !== "stopped") setCameraNote(err.message);
    return false;
  } finally {
    proc.aiBusy = false;
    if (cameraProc === proc) setTimeout(() => refreshCameraAiState(proc), 250);
  }
}

function stopCamera() {
  const proc = cameraProc;
  if (!proc || proc.exited) return;
  proc.stopping = true;
  Neutralino.os.updateSpawnedProcess(proc.id, "stdIn", `${JSON.stringify({ id: 0, method: "shutdown" })}\n`).catch(() => {});
}

// Stops the adapter, waits until it is gone (it may hold a port the camera answers to), starts it
// again with the current settings.
async function restartCamera() {
  const proc = cameraProc;
  if (proc) {
    proc.restarting = true;
    stopCamera();
    for (let i = 0; i < 15 && cameraProc === proc; i++) await new Promise((resolve) => setTimeout(resolve, 200));
    if (cameraProc === proc) {
      Neutralino.os.updateSpawnedProcess(proc.id, "exit").catch(() => {});
      proc.exited = true;
      failPendingCameraRequests(proc);
      cameraProc = null;
      showCameraControls();
    }
  }
  await startCamera();
}

function cameraTurnSpeed() {
  const range = cameraSpeedRange();
  return Math.round(numberParam(parameters.camera_turn_speed, DEFAULT_PARAMS.camera_turn_speed, range.min, range.max));
}

function showCameraSpeedValue(speed) {
  cameraSpeedValue.textContent = `${speed} °/s`;
}

function showCameraSpeed() {
  const current = cameraTurnSpeed();
  cameraSpeed.value = String(current);
  showCameraSpeedValue(current);
}

// A whole speed within the range the adapter declares, or 0.
function sliderSpeed() {
  const range = cameraSpeedRange();
  const speed = Math.round(Number(cameraSpeed.value));
  return speed >= range.min && speed <= range.max ? speed : 0;
}

// While the slider is dragged: only the number next to it follows.
function handleCameraSpeedInput() {
  const speed = sliderSpeed();
  if (speed) showCameraSpeedValue(speed);
}

// When it is let go: the adapter and the settings file get the new speed.
function handleCameraSpeedChange() {
  const speed = sliderSpeed();
  if (!speed) return;
  showCameraSpeedValue(speed);
  parameters.camera_turn_speed = speed;
  sendCameraRequest("ptz.setSpeed", { value: speed });
  saveParams(parameters.ip_address, parameters.output_path, parameters.output_filename).catch(() => {});
}

// The picture lags behind the camera, so a click right after a turn aims at an out of date
// picture: the next click waits until the turn is over (it starts after a moment) and the picture
// has caught up.
function extendCameraBusy(turn) {
  // The adapter reports how long the turn takes; without it the duration follows from the speed.
  const degrees = Math.max(Math.abs(turn.toPan - turn.fromPan), Math.abs(turn.toTilt - turn.fromTilt));
  const turnMs = Number.isFinite(turn.durationMs) ? turn.durationMs : degrees / cameraTurnSpeed() * 1000;
  cameraBusyUntil = Math.max(cameraBusyUntil, Date.now() + CAMERA_TURN_START_MS + turnMs + CAMERA_PICTURE_LAG_MS);
}

function handleCameraMessage(proc, message) {
  if (message.id !== undefined && message.id !== null) {
    const entry = proc.pending.get(message.id);
    if (!entry) return;
    proc.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(cameraError(String(message.error.code || "device_error"), String(message.error.message || message.error.code || "error")));
    } else {
      entry.resolve(message.result && typeof message.result === "object" ? message.result : {});
    }
    return;
  }
  if (message.event === "turned" && message.moved) extendCameraBusy(message);
  if (message.event === "error") setCameraNote(String(message.message || message.code || "error"));
  if (message.event === "capabilities") applyCameraCapabilities(proc, message.capabilities);
  if (message.event === "state" && (message.state === "lost" || message.state === "error")) {
    // The camera is gone; the controls go until the adapter says it is back (a capabilities event).
    proc.aiRevision = (proc.aiRevision || 0) + 1;
    proc.aiEnabled = null;
    proc.caps = null;
    showCameraControls();
    setCameraNote(String(message.reason || "the camera is not reachable."));
  }
}

function handleCameraOutput(chunk) {
  const proc = cameraProc;
  proc.lineBuffer += chunk;
  const lines = proc.lineBuffer.split("\n");
  proc.lineBuffer = lines.pop();
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (!message || typeof message !== "object") continue;
    logDebug(`Camera: ${line.trim()}`);
    handleCameraMessage(proc, message);
  }
}

function handleCameraProcessEvent(evt) {
  if (!evt || !evt.detail || !cameraProc || evt.detail.id !== cameraProc.id) return;
  const detail = evt.detail;
  if (detail.action === "stdOut") {
    handleCameraOutput(String(detail.data || ""));
  } else if (detail.action === "exit") {
    const proc = cameraProc;
    cameraProc = null;
    proc.exited = true;
    failPendingCameraRequests(proc);
    showCameraControls();
    if (!proc.restarting && !proc.stopping) setCameraNote("the camera adapter stopped.");
  }
}

// x and y: where the click fell on the picture, 0..1 from its top left corner.
function turnCameraTo(x, y) {
  if (!cameraCan("centerOn") || mode === "idle" || !scanDialog.hidden) return;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
  // A click in the middle needs no turn, and a double click must not turn twice.
  if (Math.abs(x - 0.5) < 0.02 && Math.abs(y - 0.5) < 0.02) return;
  if (Date.now() < cameraBusyUntil) return;
  cameraBusyUntil = Date.now() + CAMERA_CLICK_COOLDOWN_MS;
  sendCameraRequest("ptz.centerOn", { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), aspect: Number(videoAspect.toFixed(4)) });
}

// Percent of the zoom range per button press.
function cameraZoomStep() {
  return Math.round(numberParam(parameters.camera_zoom_step, DEFAULT_PARAMS.camera_zoom_step, 1, 50));
}

// delta: percent of the zoom range, negative zooms out.
function zoomCamera(delta) {
  if (!cameraCan("zoom")) return;
  sendCameraRequest("zoom.by", { delta: delta / 100 });
}

let videoClickGeneration = 0;
let videoClickPending = null;
function videoPoint(evt) {
  const rect = videoHost.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const inset = videoHost.classList.contains("ai-tracking") ? 4 : 0;
  if (rect.width <= inset * 2 || rect.height <= inset * 2) return null;
  const x = (evt.clientX - rect.left - inset) / (rect.width - inset * 2), y = (evt.clientY - rect.top - inset) / (rect.height - inset * 2);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

function handleVideoClick(evt) {
  const point = videoPoint(evt);
  if (!point || evt.detail > 1) return;
  if (!cameraCan("trackPerson")) return turnCameraTo(point.x, point.y);
  const generation = ++videoClickGeneration, proc = cameraProc, video = currentProcess;
  videoClickPending = { proc, video };
  setTimeout(() => {
    if (generation === videoClickGeneration) {
      videoClickPending = null;
      if (proc === cameraProc && video === currentProcess)
        turnCameraTo(point.x, point.y);
    }
  }, cameraDoubleClickMs());
}

function handleVideoDoubleClick(evt) {
  const pending = videoClickPending;
  videoClickPending = null;
  ++videoClickGeneration;
  if (!pending || pending.proc !== cameraProc || pending.video !== currentProcess ||
      !cameraCan("trackPerson") || mode === "idle" || !scanDialog.hidden) return;
  const point = videoPoint(evt);
  if (!point) return;
  const params = { x: Number(point.x.toFixed(4)), y: Number(point.y.toFixed(4)) };
  if (!cameraCan("trackStatus")) return sendCameraRequest("ai.trackPerson", params);
  const proc = cameraProc;
  if (proc.aiEnabled === null || proc.aiEnabled === undefined) {
    setCameraNote("AI tracking status is not available yet.");
    refreshCameraAiState(proc);
    return;
  }
  runCameraAiAction(proc.aiEnabled ? "ai.stop" : "ai.trackPerson", params);
}

// A wheel notch is half a button step. Wheel up zooms in.
function handleStageWheel(evt) {
  if (!cameraCan("zoom") || !scanDialog.hidden) return;
  evt.preventDefault();
  const now = Date.now();
  if (now - lastWheelAt < CAMERA_WHEEL_INTERVAL_MS) return;
  lastWheelAt = now;
  const step = Math.max(1, Math.round(cameraZoomStep() / 2));
  zoomCamera(evt.deltaY < 0 ? step : -step);
}

const ARROW_DIRECTIONS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1]
};

// Arrow keys turn the camera while no text field has the focus; Shift makes the step five times larger.
// Key repeat is thinned out, and the adapter builds each step on the previous target.
function handleArrowKey(evt) {
  const direction = ARROW_DIRECTIONS[evt.key];
  if (!direction || !cameraCan("nudge") || !scanDialog.hidden) return;
  if (evt.ctrlKey || evt.altKey || evt.metaKey || isTypingTarget(evt)) return;
  evt.preventDefault();
  const now = Date.now();
  if (now - lastNudgeAt < CAMERA_NUDGE_INTERVAL_MS) return;
  lastNudgeAt = now;
  // Whole degrees: the camera takes no finer steps.
  const step = Math.max(1, Math.round(numberParam(parameters.camera_arrow_step_deg, DEFAULT_PARAMS.camera_arrow_step_deg, 1, 20))) * (evt.shiftKey ? 5 : 1);
  sendCameraRequest("ptz.nudge", { pan: direction[0] * step, tilt: direction[1] * step });
}

function handleKeyDown(evt) {
  if (evt.key === "Escape") {
    if (!scanDialog.hidden) {
      closeScanDialog();
      return;
    }
    if (!presetMenu.hidden) {
      closePresetMenu();
      return;
    }
  }
  if (!presetMenu.hidden && handlePresetMenuKey(evt)) return;
  if (handlePresetKey(evt)) return;
  handleArrowKey(evt);
}

// A key typed into a field, a list or a text area is not for the camera.
function isTypingTarget(evt) {
  const tag = evt.target && evt.target.tagName ? String(evt.target.tagName).toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(evt.target && evt.target.isContentEditable);
}

// ---- camera presets ----
// The presets belong to the app, not to the camera: a preset is a position (pan and tilt in degrees) and/or a
// zoom (0..1) kept in the settings, and applying one is an absolute move (ptz.moveTo, zoom.set) on any camera
// that can tell and take its position (the capabilities ptz.absolute and zoom.absolute). So every adapter that
// can do those has nine presets, without a memory in the camera.

const PRESET_SLOTS = 9;
const presetRevisions = Array(PRESET_SLOTS + 1).fill(0);
const PRESET_KIND_TEXT = { both: "position and zoom", position: "position", zoom: "zoom" };
// Preset 0 is fixed: the whole scene, the camera straight ahead (0, 0) and zoomed out fully. It is not in the
// settings, and it can be neither taught nor deleted.
const HOME_PRESET = Object.freeze({ pan: 0, tilt: 0, zoom: 0 });
const HOME_TEXT = "wide shot, camera centered";

function presetOf(slot) {
  return slot === 0 ? HOME_PRESET : parameters.camera_presets[slot];
}

// camera_presets as it comes from the settings file: only slots 1 to 9 with sensible numbers are kept.
function normalizePresets(raw) {
  const presets = {};
  if (!raw || typeof raw !== "object") return presets;
  for (let slot = 1; slot <= PRESET_SLOTS; slot += 1) {
    const item = raw[slot];
    if (!item || typeof item !== "object") continue;
    const preset = {};
    if (Number.isFinite(item.pan) && Number.isFinite(item.tilt) && Math.abs(item.pan) <= 360 && Math.abs(item.tilt) <= 360) {
      preset.pan = item.pan;
      preset.tilt = item.tilt;
    }
    if (Number.isFinite(item.zoom) && item.zoom >= 0 && item.zoom <= 1) preset.zoom = item.zoom;
    if (preset.pan !== undefined || preset.zoom !== undefined) presets[slot] = preset;
  }
  return presets;
}

// "both", "position", "zoom", or "" for an empty slot.
function presetKind(preset) {
  if (!preset) return "";
  const position = preset.pan !== undefined;
  const zoom = preset.zoom !== undefined;
  return position && zoom ? "both" : position ? "position" : zoom ? "zoom" : "";
}

function presetsAvailable() {
  return cameraCan("moveTo") || cameraCan("zoomSet");
}

function presetTitle(slot, menuAvailable) {
  if (slot === 0) return `Preset 0 (fixed: ${HOME_TEXT}). Click or key 0: apply. It cannot be taught or deleted.`;
  const kind = presetKind(parameters.camera_presets[slot]);
  const menuHint = menuAvailable ? "Right click: menu." : "Open settings for the preset menu.";
  return kind
    ? `Preset ${slot} (${PRESET_KIND_TEXT[kind]}). Click or key ${slot}: apply. ${menuHint}`
    : `Preset ${slot} (empty). Alt+${slot} teaches it. ${menuHint}`;
}

function renderPresetRow(container) {
  const buttons = [];
  // 1 to 9, and 0 after them as on the keyboard.
  for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
    const kind = presetKind(presetOf(slot));
    const button = document.createElement("button");
    button.type = "button";
    button.className = `preset-btn${kind ? ` is-${kind}` : ""}${slot === 0 ? " is-fixed" : ""}`;
    button.textContent = String(slot);
    button.title = presetTitle(slot, container === presetDrawer);
    button.setAttribute("aria-label", presetTitle(slot, container === presetDrawer));
    button.dataset.slot = String(slot);
    button.addEventListener("click", () => applyPreset(slot));
    button.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      if (container === presetDrawer) openPresetMenu(slot, button);
    });
    buttons.push(button);
  }
  container.replaceChildren(...buttons);
}

// Two rows with the same buttons: the bar for compact mode and the settings drawer otherwise.
function renderPresets() {
  const available = presetsAvailable();
  layoutEl.dataset.presets = available ? "on" : "off";
  presetBar.hidden = !available;
  presetDrawer.hidden = !available;
  if (!available) {
    closePresetMenu();
    presetBar.replaceChildren();
    presetDrawer.replaceChildren();
    return;
  }
  renderPresetRow(presetBar);
  renderPresetRow(presetDrawer);
}

function savePresets() {
  renderPresets();
  showCameraPage();
  updateLayout(true);
  saveParams(parameters.ip_address, parameters.output_path, parameters.output_filename)
    .catch((err) => setCameraNote(`could not save presets: ${normalizeError(err)}`));
}

async function applyPreset(slot) {
  if (!presetsAvailable()) return;
  const preset = presetOf(slot);
  if (!preset) {
    setCameraNote(`preset ${slot} is empty; Alt+${slot} teaches it.`);
    return;
  }
  const canMove = preset.pan !== undefined && cameraCan("moveTo");
  const canZoom = preset.zoom !== undefined && cameraCan("zoomSet");
  if (!canMove && !canZoom) {
    setCameraNote(`this camera cannot apply preset ${slot}.`);
    return;
  }
  if (cameraCan("trackStatus") && !await runCameraAiAction("ai.stop", {}, true)) return;
  let sent = false;
  if (preset.pan !== undefined && cameraCan("moveTo")) {
    sendCameraRequest("ptz.moveTo", { pan: preset.pan, tilt: preset.tilt });
    sent = true;
  }
  if (preset.zoom !== undefined && cameraCan("zoomSet")) {
    sendCameraRequest("zoom.set", { value: preset.zoom });
    sent = true;
  }
  setCameraNote(sent ? `preset ${slot} applied${slot === 0 ? ` (${HOME_TEXT})` : ""}.` : `this camera cannot apply preset ${slot}.`);
}

function noteFixedPreset() {
  setCameraNote(`preset 0 is fixed (${HOME_TEXT}): it cannot be taught or deleted.`);
}

// Takes the position and/or the zoom from the camera as it is (or is going to be: the adapter answers with the
// target while the camera is still turning). kind: "both" (as far as the camera can), "position" or "zoom".
// A taught preset replaces the old one whole, so teaching the position of a position and zoom preset makes it
// a position preset.
async function teachPreset(slot, kind) {
  if (slot === 0) {
    noteFixedPreset();
    return;
  }
  const proc = cameraProc;
  if (!proc || !proc.caps || !presetsAvailable()) return;
  const revision = ++presetRevisions[slot];
  const position = kind !== "zoom" && cameraCan("moveTo");
  const zoom = kind !== "position" && cameraCan("zoomSet");
  if (!position && !zoom) {
    setCameraNote(`this camera cannot report its ${kind === "zoom" ? "zoom" : "position"}.`);
    return;
  }
  const preset = {};
  try {
    if (position) {
      const pose = await cameraRequest(proc, "ptz.get");
      if (!Number.isFinite(pose.pan) || !Number.isFinite(pose.tilt)) throw cameraError("device_error", "the camera sent no position.");
      preset.pan = pose.pan;
      preset.tilt = pose.tilt;
    }
    if (zoom) {
      const level = await cameraRequest(proc, "zoom.get");
      if (!Number.isFinite(level.value)) throw cameraError("device_error", "the camera sent no zoom.");
      preset.zoom = Math.min(1, Math.max(0, level.value));
    }
  } catch (err) {
    if (err.code !== "stopped" && cameraProc === proc && presetRevisions[slot] === revision) setCameraNote(`preset ${slot} was not taught: ${err.message}`);
    return;
  }
  if (cameraProc !== proc || presetRevisions[slot] !== revision) return;
  parameters.camera_presets = { ...parameters.camera_presets, [slot]: preset };
  savePresets();
  setCameraNote(`preset ${slot} taught: ${PRESET_KIND_TEXT[presetKind(preset)]}.`);
}

function deletePreset(slot) {
  if (slot === 0) {
    noteFixedPreset();
    return;
  }
  presetRevisions[slot] += 1;
  if (!parameters.camera_presets[slot]) {
    setCameraNote(`preset ${slot} is empty.`);
    return;
  }
  const rest = { ...parameters.camera_presets };
  delete rest[slot];
  parameters.camera_presets = rest;
  savePresets();
  setCameraNote(`preset ${slot} deleted.`);
}

// The digit of a number key, whatever the layout makes of it with Alt (on a Hungarian keyboard Alt+Ctrl is AltGr,
// and the character is not the digit): 0 to 9, or -1 for any other key.
function presetSlotOf(evt) {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(String(evt.code || ""));
  return match ? Number(match[1]) : -1;
}

// 1-9 apply, and 0 is the fixed wide shot. With Alt: Alt teaches position and zoom, Alt+Shift the position only,
// Alt+Ctrl the zoom only, Alt+Ctrl+Shift deletes (for 1 to 9; 0 says that it is fixed). Returns true when the key
// was for the presets. Ctrl+0 and Shift+0 are not: the browser zooms with them.
function handlePresetKey(evt) {
  const slot = presetSlotOf(evt);
  if (slot < 0 || evt.metaKey || !presetsAvailable() || !scanDialog.hidden || isTypingTarget(evt)) return false;
  let action = null;
  if (!evt.altKey && !evt.ctrlKey && !evt.shiftKey) action = () => applyPreset(slot);
  else if (evt.altKey && !evt.ctrlKey && !evt.shiftKey) action = () => teachPreset(slot, "both");
  else if (evt.altKey && evt.shiftKey && !evt.ctrlKey) action = () => teachPreset(slot, "position");
  else if (evt.altKey && evt.ctrlKey && !evt.shiftKey) action = () => teachPreset(slot, "zoom");
  else if (evt.altKey && evt.ctrlKey && evt.shiftKey) action = () => deletePreset(slot);
  if (!action) return false;
  evt.preventDefault();
  closePresetMenu();
  // A held key does not repeat a teaching or an apply.
  if (!evt.repeat) action();
  return true;
}

// ---- the menu of a preset button ----
// Keep the menu in the settings drawer, clear of the native video window.

function menuItem(label, keys, enabled, run) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "preset-menu-item";
  item.setAttribute("role", "menuitem");
  item.disabled = !enabled;
  const text = document.createElement("span");
  text.textContent = label;
  const hint = document.createElement("span");
  hint.className = "preset-menu-keys";
  hint.textContent = keys;
  item.replaceChildren(text, hint);
  item.addEventListener("click", () => {
    closePresetMenu();
    run();
  });
  return item;
}

function openPresetMenu(slot, anchor) {
  if (!presetsAvailable()) return;
  closePresetMenu();
  const preset = presetOf(slot);
  // The fixed preset 0 can be applied and nothing else.
  const fixed = slot === 0;
  const canPosition = cameraCan("moveTo") && !fixed;
  const canZoom = cameraCan("zoomSet") && !fixed;
  const title = document.createElement("div");
  title.className = "preset-menu-title";
  title.textContent = fixed ? `Preset 0: fixed, ${HOME_TEXT}` : `Preset ${slot}: ${PRESET_KIND_TEXT[presetKind(preset)] || "empty"}`;
  presetMenu.replaceChildren(
    title,
    menuItem("Apply", String(slot), Boolean(preset), () => applyPreset(slot)),
    menuItem("Teach position and zoom", `Alt+${slot}`, canPosition || canZoom, () => teachPreset(slot, "both")),
    menuItem("Teach position only", `Alt+Shift+${slot}`, canPosition, () => teachPreset(slot, "position")),
    menuItem("Teach zoom only", `Alt+Ctrl+${slot}`, canZoom, () => teachPreset(slot, "zoom")),
    menuItem("Delete", `Alt+Ctrl+Shift+${slot}`, Boolean(preset) && !fixed, () => deletePreset(slot))
  );
  presetMenu.hidden = false;

  // Keep the menu inside the visible part of the drawer, even when the panel scrolls.
  const margin = 4;
  const drawerBox = drawer.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  const bounds = {
    left: Math.max(margin, drawerBox.left, panelBox.left),
    top: Math.max(margin, drawerBox.top, panelBox.top),
    right: Math.min(window.innerWidth || 1280, drawerBox.right, panelBox.right) - margin,
    bottom: Math.min(window.innerHeight || 720, drawerBox.bottom, panelBox.bottom) - margin
  };
  presetMenu.style.maxWidth = `${Math.max(1, bounds.right - bounds.left)}px`;
  presetMenu.style.maxHeight = `${Math.max(1, bounds.bottom - bounds.top)}px`;
  const anchorBox = anchor.getBoundingClientRect();
  const size = presetMenu.getBoundingClientRect();
  const left = Math.max(bounds.left, Math.min(anchorBox.left, bounds.right - size.width));
  const below = anchorBox.bottom + margin;
  const top = below + size.height <= bounds.bottom ? below : Math.max(bounds.top, Math.min(anchorBox.top - size.height - margin, bounds.bottom - size.height));
  presetMenu.style.left = `${Math.round(left)}px`;
  presetMenu.style.top = `${Math.round(top)}px`;
  const first = Array.from(presetMenu.children || []).find((child) => child.disabled === false);
  if (first) first.focus();
}

function closePresetMenu() {
  if (presetMenu.hidden) return;
  presetMenu.hidden = true;
  presetMenu.replaceChildren();
}

// Up and down move through the items. The arrow keys must not turn the camera while the menu is open.
function handlePresetMenuKey(evt) {
  if (!ARROW_DIRECTIONS[evt.key]) return false;
  evt.preventDefault();
  if (evt.key === "ArrowLeft" || evt.key === "ArrowRight") return true;
  const items = Array.from(presetMenu.children || []).filter((child) => child.disabled === false);
  if (!items.length) return true;
  const current = items.findIndex((child) => child === document.activeElement);
  const next = evt.key === "ArrowDown" ? (current + 1) % items.length : (current <= 0 ? items.length - 1 : current - 1);
  items[next].focus();
  return true;
}

// A press outside the menu closes it.
function handleWindowPointerDown(evt) {
  if (presetMenu.hidden) return;
  const inside = typeof presetMenu.contains === "function" && presetMenu.contains(evt.target);
  if (!inside) closePresetMenu();
}

function videoRectArg() {
  const rect = videoHost.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const inset = videoHost.classList.contains("ai-tracking") ? 4 : 0;
  return [rect.left + inset, rect.top + inset, Math.max(0, rect.width - inset * 2), Math.max(0, rect.height - inset * 2)].map((value) => Math.round(value * scale)).join(",");
}

// What the user types is limited only to what VLC takes. How small a buffer can be without freezing the
// picture depends on the network and the computer (a 4K stream decoded in software froze at 150 ms
// on a LAN in a container), so the field does not guess; the hint under it says what to look for.
const PREVIEW_CACHING_MIN_MS = 0;
const PREVIEW_CACHING_FIELD_MAX_MS = 10000;

// Network caching in ms for the player, or -1 for VLC's own default.
function previewCachingMs() {
  const value = Number(parameters.preview_caching_ms);
  if (!Number.isFinite(value)) return DEFAULT_PARAMS.preview_caching_ms;
  return value < 0 ? -1 : Math.min(60000, Math.max(PREVIEW_CACHING_MIN_MS, Math.round(value)));
}

function describeCaching(ms) {
  return ms < 0 ? "VLC's default (1000 ms)" : `${ms} ms`;
}

const SRT_LATENCY_MIN_MS = 1;
const SRT_LATENCY_MAX_MS = 10000;

// SRT latency in ms for the preview, or -1 for VLC's own default (the option is off).
function srtLatencyMs() {
  const value = Number(parameters.srt_latency_ms);
  if (!Number.isFinite(value) || value < SRT_LATENCY_MIN_MS) return -1;
  return Math.min(SRT_LATENCY_MAX_MS, Math.round(value));
}

function describeSrtLatency(ms) {
  return ms < 0 ? "VLC's default" : `${ms} ms`;
}

// The field shows the buffer in the settings (a setting of -1, VLC's own default, is VLC's 1000); a
// note appears while the running preview or recording still has another one.
function showPreviewCaching() {
  if (document.activeElement !== previewCaching) {
    const value = previewCachingMs();
    previewCaching.value = String(value < 0 ? 1000 : value);
  }
  // The SRT latency field is empty while the option is off.
  if (document.activeElement !== srtLatency) {
    const latency = srtLatencyMs();
    srtLatency.value = latency < 0 ? "" : String(latency);
  }
  const proc = currentProcess;
  const running = proc && proc.type === "real" && !proc.exited;
  const cachingStale = running && proc.cachingMs !== undefined && proc.cachingMs !== previewCachingMs();
  // Only a preview takes the SRT latency, so only a preview can have an old one.
  const latencyStale = running && mode === "preview" && proc.srtLatencyMs !== undefined && proc.srtLatencyMs !== srtLatencyMs();
  const stale = cachingStale || latencyStale;
  bufferPending.hidden = !stale;
  bufferApplyBtn.hidden = !(stale && mode === "preview");
  if (!stale) return;
  if (mode !== "preview") {
    bufferPendingText.textContent = `Not in use yet: the running recording keeps ${describeCaching(proc.cachingMs)}; the next start takes the new one.`;
    return;
  }
  const parts = [];
  if (cachingStale) parts.push(describeCaching(proc.cachingMs));
  if (latencyStale) parts.push(`SRT latency ${describeSrtLatency(proc.srtLatencyMs)}`);
  bufferPendingText.textContent = `Not in use yet: the running preview has ${parts.join(" and ")}.`;
}

function handleSrtLatencyChange() {
  const typed = Math.round(Number(srtLatency.value));
  // Empty (or not a number) switches the option off.
  const value = srtLatency.value !== "" && Number.isFinite(typed) && typed >= SRT_LATENCY_MIN_MS
    ? Math.min(SRT_LATENCY_MAX_MS, typed)
    : -1;
  parameters.srt_latency_ms = value;
  srtLatency.value = value < 0 ? "" : String(value);
  showPreviewCaching();
  saveParams(parameters.ip_address, parameters.output_path, parameters.output_filename)
    .catch((err) => logDebug(`Could not save the SRT latency: ${normalizeError(err)}`));
}

function handlePreviewCachingChange() {
  const typed = Math.round(Number(previewCaching.value));
  const value = Number.isFinite(typed) && previewCaching.value !== ""
    ? Math.min(PREVIEW_CACHING_FIELD_MAX_MS, Math.max(PREVIEW_CACHING_MIN_MS, typed))
    : DEFAULT_PARAMS.preview_caching_ms;
  parameters.preview_caching_ms = value;
  previewCaching.value = String(value);
  showPreviewCaching();
  saveParams(parameters.ip_address, parameters.output_path, parameters.output_filename)
    .catch((err) => logDebug(`Could not save the preview buffer: ${normalizeError(err)}`));
}

// Stops the running preview and starts it again, so that it has the buffer of the field. Only a
// preview: a recording must not be cut.
function restartPreview() {
  return withBusy(async () => {
    if (mode !== "preview") return;
    await terminateCurrent("Restarting the preview...");
    const result = await startOperation({ record: false, ...payload() });
    await refreshState();
    if (!result.ok) await showError(result.error);
  });
}

function buildPlayerCommand(playerPath, streamUri, record, ext, fullOutput, rect) {
  const args = ["--parent-pid", String(NL_PID), "--url-hex", utf8Hex(streamUri), "--rect", rect];
  if (previewCachingMs() >= 0) args.push("--caching", String(previewCachingMs()));
  if (!record && srtLatencyMs() >= 0) args.push("--srt-latency", String(srtLatencyMs()));
  if (record) args.push("--record-hex", utf8Hex(fullOutput), "--mux", ext === "mp4" ? "mp4" : "mkv");
  return buildCommand(playerPath, args);
}

function sendPlayerCommand(line) {
  const proc = currentProcess;
  if (!proc || !proc.player || proc.exited) return;
  Neutralino.os.updateSpawnedProcess(proc.id, "stdIn", `${line}\n`).catch(() => {});
}

function handlePlayerOutput(proc, chunk) {
  proc.lineBuffer += chunk;
  const lines = proc.lineBuffer.split("\n");
  proc.lineBuffer = lines.pop();
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.event === "stats") {
      proc.readBytes = message.readBytes;
      noteStats(proc, message);
    }
    if (message.event === "video") setVideoSize(message);
    if (message.event === "error") {
      proc.errorMessage = String(message.message || "");
      logDebug(`Player error ${message.code}: ${proc.errorMessage}`);
    }
    // libVLC's own warnings and errors, and the window tree of the player: the way to tell why a
    // picture stays black.
    if (message.event === "log") logDebug(`libVLC ${message.level} [${message.module}] ${message.text}`);
    if (message.event === "window") logDebug(`Player ${message.text}`);
  }
}

const PLAYER_STATE_NAMES = ["idle", "opening", "buffering", "playing", "paused", "stopped", "ended", "error"];
const PLAYER_STATS_LOGGED = new Set([2, 5, 15]);

// Written to the log when the state changes and at a few of the first stats of a process: enough to
// see whether data arrives, is decoded and is shown, without a line per second for a whole recording.
function noteStats(proc, message) {
  proc.statsSeen = (proc.statsSeen || 0) + 1;
  const changed = message.state !== proc.lastState;
  proc.lastState = message.state;
  if (!changed && !PLAYER_STATS_LOGGED.has(proc.statsSeen)) return;
  const state = PLAYER_STATE_NAMES[message.state] || String(message.state);
  logDebug(`Player ${state}: ${message.readBytes} bytes read, ${message.decoded ?? "?"} pictures decoded, ` +
    `${message.displayed ?? "?"} shown, ${message.lost ?? "?"} lost`);
}

// Display aspect ratio from the player's "video" event; anamorphic video has a
// sample aspect ratio other than 1:1.
function displayAspect({ width, height, sarNum, sarDen }) {
  const aspect = (Number(width) * (Number(sarNum) || 1)) / (Number(height) * (Number(sarDen) || 1));
  return Number.isFinite(aspect) && aspect >= 0.1 && aspect <= 10 ? aspect : 0;
}

function setVideoSize(message) {
  const aspect = displayAspect(message);
  if (!aspect || Math.abs(aspect - videoAspect) < 1e-6) return;
  logDebug(`Video size ${message.width}x${message.height}, sample aspect ${message.sarNum}:${message.sarDen}`);
  videoAspect = aspect;
  updateLayout();
}

function fitToAspect(width, height, aspect) {
  if (!(width > 0 && height > 0 && aspect > 0)) return { width: 0, height: 0 };
  return width / height > aspect
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
}

// stages[i] is the room LAYOUTS[i] leaves for the video. Returns the best full and
// the best compact layout, and whether the compact one gives the video much more.
// wasCompact: the previous automatic choice was compact.
function chooseLayout(stages, aspect, current, wasCompact = false) {
  const scored = LAYOUTS.map((layout, index) => {
    const video = fitToAspect(stages[index].width, stages[index].height, aspect);
    return { ...layout, index, area: video.width * video.height };
  });
  const best = (compact) => {
    const options = scored.filter((item) => item.compact === compact &&
      !(compact && presetsAvailable() && item.name !== "stack"));
    const top = options.reduce((a, b) => (b.area > a.area ? b : a));
    const kept = current && options.find((item) => item.name === current.name);
    return kept && kept.area >= top.area * LAYOUT_KEEP_SHARE ? kept : top;
  };
  const full = best(false);
  const compact = best(true);
  const share = wasCompact ? FULL_PANEL_EXPAND_SHARE : FULL_PANEL_MIN_SHARE;
  return { full, compact, compactWins: full.area < compact.area * share };
}

function layoutClassName(layout) {
  return `layout is-${layout.name}${layout.compact ? " is-compact" : ""}`;
}

function applyLayoutClass(layout) {
  layoutEl.className = layoutClassName(layout);
}

function syncPlayerRect() {
  const proc = currentProcess;
  if (!proc || !proc.player) return;
  const rect = videoRectArg();
  if (proc.sentRect === rect) return;
  proc.sentRect = rect;
  sendPlayerCommand(`RECT ${rect}`);
}

function layoutInputKey() {
  return [window.innerWidth, window.innerHeight, window.devicePixelRatio, videoAspect, mode,
    startingStream, panelOverride, videoHost.hidden, cameraBar.hidden, cameraPage.hidden, presetBar.hidden].join("|");
}

// Measuring switches the panel through every layout, which can clamp its scroll
// position and hide the field being typed in; both are put back afterwards.
function keepPanelState(fn) {
  const scrollTop = panel.scrollTop;
  const focused = document.activeElement;
  const inPanel = Boolean(focused && focused !== document.body && panel.contains(focused));
  let selection = null;
  try {
    if (inPanel && typeof focused.selectionStart === "number") selection = [focused.selectionStart, focused.selectionEnd];
  } catch {
    // Some input types have no selection.
  }
  fn();
  panel.scrollTop = scrollTop;
  if (inPanel && document.activeElement !== focused && focused.getClientRects().length > 0) {
    focused.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  }
}

// Gives the video the largest box of its aspect ratio that the window allows, then
// moves the player's window onto it. Each candidate is measured in the real page,
// so fonts and wrapping are always accounted for; nothing is painted in between.
// It runs again only when something it depends on changed, or when forced.
function updateLayout(force = false) {
  if (!layoutReady) return;
  if (!force && layoutInputKey() === layoutInputs) return;
  // A new layout invalidates both the menu position and the saved video geometry.
  closePresetMenu();
  if (videoHost.hidden) {
    layoutEl.className = "layout is-side no-video";
    layoutInputs = layoutInputKey();
    return;
  }
  keepPanelState(() => arrangeLayout());
  layoutInputs = layoutInputKey();
  syncPlayerRect();
}

function arrangeLayout() {
  panel.style.width = "";
  const stages = LAYOUTS.map((layout) => {
    applyLayoutClass(layout);
    const box = stage.getBoundingClientRect();
    return { width: box.width, height: box.height, panelWidth: panel.getBoundingClientRect().width };
  });
  const { full, compact, compactWins } = chooseLayout(stages, videoAspect, currentLayout, Boolean(lastAutoCompact));
  const autoCompact = (mode !== "idle" || startingStream) && compactWins;
  // A choice made with the toggle button lasts until the automatic choice changes.
  if (autoCompact !== lastAutoCompact) panelOverride = "";
  lastAutoCompact = autoCompact;
  const layout = (panelOverride ? panelOverride === "compact" : autoCompact) ? compact : full;
  currentLayout = layout;
  applyLayoutClass(layout);
  presetBar.classList.remove("is-filtered");
  if (layout.compact && presetsAvailable() && presetBar.scrollWidth > presetBar.clientWidth) {
    presetBar.classList.add("is-filtered");
  }

  // Width the video cannot use widens the full side panel, up to a limit, instead of
  // leaving bars between the panel and the video. Below the video the panel keeps
  // its height and the video is centered in the dark stage, as in a player.
  if (!layout.compact && layout.name === "side") {
    const room = stages[layout.index];
    const fitted = fitToAspect(room.width, room.height, videoAspect);
    panel.style.width = `${Math.floor(Math.min(SIDE_PANEL_MAX_WIDTH, room.panelWidth + room.width - fitted.width))}px`;
    applyLayoutClass(layout);
  }

  const rect = stage.getBoundingClientRect();
  const video = fitToAspect(rect.width, rect.height, videoAspect);
  const width = Math.floor(video.width);
  const height = Math.floor(video.height);
  videoHost.style.width = `${width}px`;
  videoHost.style.height = `${height}px`;
  videoHost.style.left = `${Math.floor((rect.width - width) / 2)}px`;
  videoHost.style.top = `${Math.floor((rect.height - height) / 2)}px`;
  layoutStageSize = `${rect.width}x${rect.height}`;

  const label = layout.compact ? "Show settings" : "Hide settings";
  panelToggle.setAttribute("aria-expanded", String(!layout.compact));
  panelToggle.setAttribute("aria-label", label);
  panelToggle.title = label;
}

function buildCommand(executable, args) {
  // Quote each argument so paths and VLC sout expressions survive shell parsing.
  const tokens = [shellQuote(executable), ...args.map((arg) => shellQuote(arg))];
  return tokens.join(" ");
}

function createRcHost() {
  const port = 42000 + Math.floor(Math.random() * 20000);
  return `127.0.0.1:${port}`;
}

function parseRcHostPort(rcHost) {
  const value = String(rcHost || "").trim();
  const match = value.match(/^([^:]+):(\d{1,5})$/);
  if (!match) return null;

  const host = match[1];
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

async function isSpawnedProcessAlive(procId) {
  try {
    const processes = await Neutralino.os.getSpawnedProcesses();
    return Array.isArray(processes) && processes.some((proc) => Number(proc.id) === Number(procId));
  } catch {
    // If process listing fails, assume alive and try exit.
    return true;
  }
}

function scheduleProcessExit(procId, delayMs, options = {}) {
  const warningText = String(options.warningText || "").trim();
  const warningState = options.warningState || null;

  setTimeout(() => {
    (async () => {
      const alive = await isSpawnedProcessAlive(procId);
      if (!alive) return;

      if (warningText && warningState && !warningState.shown) {
        warningState.shown = true;
        try {
          await Neutralino.os.showMessageBox("VLC Stream Recorder", warningText, "OK", "WARNING");
        } catch {
          // Ignore warning dialog errors and continue with forced stop.
        }
      }

      await Neutralino.os.updateSpawnedProcess(procId, "exit").catch(() => {});
    })().catch(() => {});
  }, delayMs);
}

async function sendSoftTerminateByPid(pid) {
  const processId = Number(pid || 0);
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }

  try {
    if (NL_OS === "Linux" || NL_OS === "Darwin") {
      await Neutralino.os.execCommand(bashInvocation(`kill -TERM ${processId}`));
      return true;
    }

    if (NL_OS === "Windows") {
      await Neutralino.os.execCommand(`powershell -NoProfile -NonInteractive -Command "Stop-Process -Id ${processId} -ErrorAction SilentlyContinue"`);
      return true;
    }
  } catch {
    // Ignore soft-stop errors and use hard fallback below.
  }

  return false;
}

async function sendRcShutdown(rcHost) {
  const target = parseRcHostPort(rcHost);
  if (!target) return false;

  try {
    if (NL_OS === "Linux" || NL_OS === "Darwin") {
      const script = `timeout 2 bash -c 'exec 3<>/dev/tcp/${target.host}/${target.port}; printf %b "stop\\nshutdown\\nquit\\n" >&3; exec 3<&-; exec 3>&-'`;
      const info = await Neutralino.os.execCommand(bashInvocation(script));
      return Number(info.exitCode) === 0;
    }

    if (NL_OS === "Windows") {
      const ps = [
        `$c=New-Object Net.Sockets.TcpClient('${target.host}',${target.port})`,
        "$s=$c.GetStream()",
        "$w=New-Object IO.StreamWriter($s)",
        "$w.NewLine='`n'",
        "$w.AutoFlush=$true",
        "$w.WriteLine('stop')",
        "$w.WriteLine('shutdown')",
        "$w.WriteLine('quit')",
        "$w.Dispose()",
        "$c.Close()"
      ].join("; ");
      const info = await Neutralino.os.execCommand(`powershell -NoProfile -NonInteractive -Command \"${ps}\"`);
      return Number(info.exitCode) === 0;
    }
  } catch {
    // Ignore rc control errors and use fallback stop methods.
  }

  return false;
}

async function readPreviewProgress(rcHost) {
  const target = parseRcHostPort(rcHost);
  if (!target || target.host !== "127.0.0.1") throw new Error("VLC RC is unavailable.");

  let command;
  if (NL_OS === "Windows") {
    // Encode the script so PowerShell variables survive native command parsing.
    // Both connect and reads are bounded; a stuck RC must not block recovery.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$c=New-Object Net.Sockets.TcpClient",
      "try {",
      `$task=$c.ConnectAsync('${target.host}',${target.port})`,
      "if (-not $task.Wait(800)) { throw 'RC connect timed out' }",
      "$s=$c.GetStream()",
      "$s.ReadTimeout=800; $s.WriteTimeout=800",
      "$bytes=[Text.Encoding]::ASCII.GetBytes(\"stats`n\")",
      "$s.Write($bytes,0,$bytes.Length)",
      "$buf=New-Object byte[] 4096; $text=''",
      "$until=[DateTime]::UtcNow.AddMilliseconds(1600)",
      "while ([DateTime]::UtcNow -lt $until) {",
      "try { $n=$s.Read($buf,0,$buf.Length) } catch { break }",
      "if ($n -eq 0) { break }",
      "$text += [Text.Encoding]::UTF8.GetString($buf,0,$n)",
      "if ($text.Contains('end of statistical info')) { break }",
      "}",
      "[Console]::Write($text)",
      "} finally { $c.Dispose() }"
    ].join("\n");
    const encoded = btoa(Array.from(script, (ch) => `${ch}\0`).join(""));
    command = `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  } else {
    const script = `exec 3<>/dev/tcp/${target.host}/${target.port} || exit 1; `
      + `printf 'stats\\n' >&3; deadline=$((SECONDS+2)); `
      + `while (( SECONDS < deadline )) && IFS= read -r -t 1 line <&3; do `
      + `printf '%s\\n' "$line"; case "$line" in *'end of statistical info'*) break;; esac; done`;
    command = bashInvocation(script);
  }

  const info = await Neutralino.os.execCommand(command);
  if (Number(info.exitCode) !== 0) throw new Error("Could not read VLC statistics.");
  // The first KiB counter is input bytes, in both VLC's native and Lua RC.
  // Match the unit instead of the label to also accept translated native RC.
  const match = String(info.stdOut || "").match(/:\s*(\d+(?:[.,]\d+)?)\s*KiB\b/i);
  if (!match) return null;
  return Number(match[1].replace(",", "."));
}

async function stopVlcGracefully(proc, options = {}) {
  if (!proc || proc.type !== "real") return;
  const procId = proc.id;
  const wasRecording = Boolean(options.wasRecording);
  let softStopIssued = false;

  if (proc.rcHost) {
    softStopIssued = await sendRcShutdown(proc.rcHost);
  }

  // Try stdin quit first in case VLC accepts console commands.
  if (!softStopIssued) {
    try {
      await Neutralino.os.updateSpawnedProcess(procId, "stdIn", "stop\nshutdown\nquit\n");
      await Neutralino.os.updateSpawnedProcess(procId, "stdInEnd");
      softStopIssued = true;
    } catch {
      // Ignore stdin control errors and try PID signal path.
    }
  }

  if (!softStopIssued) {
    softStopIssued = await sendSoftTerminateByPid(proc.pid);
  }

  logDebug(`Stopping VLC (pid=${proc.pid || "n/a"}) using ${softStopIssued ? "soft-stop" : "forced-stop"} strategy.`);

  if (options.waitForExit) {
    // Reconnect only after the old process releases the SRT connection and file.
    // Automatic recovery must never wait for a modal force-stop warning.
    const softStopAttempts = proc.player ? PLAYER_STOP_GRACE_MS / 200 : 13;
    for (let attempt = 0; attempt < softStopAttempts; attempt += 1) {
      if (!await isSpawnedProcessAlive(procId)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await Neutralino.os.updateSpawnedProcess(procId, "exit");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!await isSpawnedProcessAlive(procId)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("VLC has not stopped yet.");
  }

  const warningText = !wasRecording
    ? ""
    : proc.player
      ? "The recording is still being finalized. If the app force-stops it, the file can become corrupted or unusable."
      : "VLC is still recording. If the app force-stops VLC, mp4 finalization may fail and the file can become corrupted or unusable. For safest results, stop VLC manually in the VLC window when possible.";
  const warningState = { shown: false };

  // Always keep a hard-stop fallback so we don't leak VLC processes.
  const firstExitMs = proc.player ? PLAYER_STOP_GRACE_MS : softStopIssued ? 2600 : 800;
  const secondExitMs = proc.player ? PLAYER_STOP_GRACE_MS + 5000 : softStopIssued ? 7000 : 2200;
  scheduleProcessExit(procId, firstExitMs, { warningText, warningState });
  scheduleProcessExit(procId, secondExitMs, { warningText, warningState });
}

async function terminateCurrent(newStatus = "Stopped.") {
  const proc = currentProcess;
  const wasRecording = mode === "recording";
  operationToken += 1;
  currentProcess = null;

  try {
    if (proc && proc.type === "sim") {
      proc.running = false;
    } else if (proc && proc.type === "real") {
      await stopVlcGracefully(proc, { wasRecording });
    }
  } catch {
    // Ignore termination errors.
  }

  resetState(newStatus);
}

async function ensureDirectoryForFile(filePath) {
  const parts = await Neutralino.filesystem.getPathParts(filePath);
  const parent = parts && parts.parentPath ? parts.parentPath : "";
  if (parent && parent !== ".") {
    await Neutralino.filesystem.createDirectory(parent);
  }
}

function outputFields() {
  return {
    ip_address: parameters.ip_address || DEFAULT_PARAMS.ip_address,
    output_path: parameters.output_path || DEFAULT_PARAMS.output_path,
    output_filename_base: baseNameWithoutExt(parameters.output_filename || DEFAULT_PARAMS.output_filename),
    extension: inferExt(parameters.output_filename),
    srt_mode: parameters.srt_mode || ""
  };
}

async function currentState() {
  const elapsedSec = startTimeMs ? Math.floor((Date.now() - startTimeMs) / 1000) : 0;
  let currentFileSize = "0 B";

  if (mode === "recording" && outputFile) {
    if (isSimulationMode()) {
      const delta = Math.max(0, elapsedSec - simLastTickSec);
      if (delta > 0) {
        simSizeBytes += delta * 1024 * 1024;
        simLastTickSec = elapsedSec;
      }
      currentFileSize = formatSize(simSizeBytes);
    } else {
      try {
        const stats = await Neutralino.filesystem.getStats(outputFile);
        currentFileSize = formatSize(stats.size || 0);
      } catch {
        currentFileSize = "0 B";
      }
    }
  }

  return {
    mode,
    status: statusText,
    statusKind,
    elapsed: formatElapsed(elapsedSec),
    fileSize: currentFileSize,
    fields: outputFields()
  };
}

function stallTimeoutMs() {
  const seconds = Number(parameters.stall_timeout_sec);
  return (Number.isFinite(seconds) && seconds >= 5 ? seconds : DEFAULT_PARAMS.stall_timeout_sec) * 1000;
}

function recordingStallTimeoutMs(session) {
  const ceiling = stallTimeoutMs();
  if (session.growthIntervalsMs.length < RECORDING_CADENCE_MIN_SAMPLES) return ceiling;
  // Use the longest recent write interval so buffered/bursty writes do not
  // make a single short interval trigger premature reconnects. The monitor
  // samples once a second, so three seconds is the shortest useful timeout.
  const cadence = Math.max(...session.growthIntervalsMs);
  return Math.min(ceiling, Math.max(RECORDING_STALL_MIN_MS, cadence * 3));
}

function resetSessionProgress(session) {
  session.lastSize = 0;
  session.lastProgressAt = Date.now();
  session.lastGrowthAt = null;
  session.growthIntervalsMs = [];
  session.lastPreviewCheckAt = 0;
  session.previewProgress = null;
  session.previewUnavailable = false;
  session.nextRetryAt = 0;
}

function createSession(request) {
  const base = baseNameWithoutExt(request.filenameBase);
  const suffix = base.match(/_(\d+)$/);
  const session = {
    request: { ...request },
    filenameRoot: suffix ? base.slice(0, -suffix[0].length) : base,
    nextSuffix: suffix ? BigInt(suffix[1]) + 1n : 1n
  };
  resetSessionProgress(session);
  return session;
}

async function nextReconnectFilename(session) {
  while (true) {
    const base = `${session.filenameRoot}_${String(session.nextSuffix++).padStart(3, "0")}`;
    const name = `${base}.${session.request.ext}`;
    const path = session.request.outputPathValue
      ? await Neutralino.filesystem.getJoinedPath(session.request.outputPathValue, name)
      : name;
    if (!await pathExists(path)) return base;
  }
}

async function reconnectSession(session, reason) {
  if (activeSession !== session || !parameters.auto_reconnect || uiBusy) return;
  await withBusy(async () => {
    noteStatus(`${reason} Reconnecting VLC...`, "warn");
    setStatus(statusText, statusKind);
    logDebug(statusText);
    try {
      const proc = currentProcess;
      // Ignore late events from the old VLC while it finalizes its file.
      operationToken += 1;
      if (proc && !proc.exited) {
        await stopVlcGracefully(proc, { wasRecording: session.request.record, waitForExit: true });
      }
      currentProcess = null;
      if (closeRequested) return;
      const request = { ...session.request };
      if (request.record) request.filenameBase = await nextReconnectFilename(session);
      if (closeRequested) return;
      const result = await startOperation({ ...request, recoverySession: session });
      if (!result.ok) throw new Error(result.error);
      noteStatus(`Automatically reconnected. ${statusText}`);
    } catch (err) {
      // Keep the user's operation active and retry without any modal dialogs.
      session.nextRetryAt = Date.now() + RECONNECT_RETRY_MS;
      noteStatus(`Reconnect failed: ${normalizeError(err)} Retrying in 5 seconds.`, "error");
      logDebug(statusText);
    }
    await refreshState();
  });
}

async function monitorStream() {
  if (monitorBusy || uiBusy || closeRequested || !parameters.auto_reconnect || !activeSession || isSimulationMode()) return;
  monitorBusy = true;
  try {
    const session = activeSession;
    const proc = currentProcess;
    if (session.nextRetryAt) {
      if (Date.now() >= session.nextRetryAt) await reconnectSession(session, "Stream interrupted.");
      return;
    }
    if (!proc || proc.exited) return;

    let progress = null;
    if (session.request.record) {
      try {
        const stats = await Neutralino.filesystem.getStats(outputFile);
        progress = Number(stats.size || 0);
      } catch {
        // A missing/unreadable output also counts as no recording progress.
      }
    } else {
      if (Date.now() - session.lastPreviewCheckAt < PREVIEW_CHECK_MS) return;
      session.lastPreviewCheckAt = Date.now();
      try {
        progress = proc.player ? proc.readBytes : await readPreviewProgress(proc.rcHost);
      } catch {
        // RC availability is best-effort; do not restart solely because an
        // installed VLC version has never supplied usable preview statistics.
      }
    }

    // Stop, operation switches and checkbox changes can happen during a read.
    if (activeSession !== session || currentProcess !== proc || uiBusy || !parameters.auto_reconnect) return;
    const now = Date.now();
    if (session.request.record) {
      if (progress !== null && progress > session.lastSize) {
        // The first write may just be the container header. Measure complete
        // intervals between later growth events, excluding startup latency.
        if (session.lastGrowthAt !== null && now > session.lastGrowthAt) {
          session.growthIntervalsMs.push(now - session.lastGrowthAt);
          if (session.growthIntervalsMs.length > RECORDING_CADENCE_SAMPLES) session.growthIntervalsMs.shift();
        }
        session.lastGrowthAt = now;
        session.lastSize = progress;
        session.lastProgressAt = now;
      }
    } else if (progress !== null) {
      if (session.previewProgress === null || progress !== session.previewProgress) session.lastProgressAt = now;
      session.previewProgress = progress;
      if (session.previewUnavailable) {
        session.previewUnavailable = false;
        noteStatus("Preview monitoring available.");
      }
    } else if (session.previewProgress === null) {
      if (now - session.lastProgressAt >= stallTimeoutMs() && !session.previewUnavailable) {
        session.previewUnavailable = true;
        noteStatus("Preview monitoring unavailable: VLC RC statistics could not be read. Process exits are still monitored.", "warn");
      }
      return;
    }

    const timeout = session.request.record ? recordingStallTimeoutMs(session) : stallTimeoutMs();
    if (now - session.lastProgressAt >= timeout) {
      await reconnectSession(session, session.request.record ? "Recording stopped growing." : "Preview stopped receiving data.");
    }
  } finally {
    monitorBusy = false;
  }
}

async function startOperation({ record, ipAddress, outputPathValue, filenameBase, ext, recoverySession = null }) {
  if (!ipAddress) {
    return { ok: false, error: "Please enter the SRT Stream IP Address." };
  }
  if (!filenameBase) {
    return { ok: false, error: "Please enter the Output Filename." };
  }

  let outputFilename = filenameBase;
  if (!outputFilename.toLowerCase().endsWith(`.${ext}`)) {
    outputFilename += `.${ext}`;
  }

  const fullOutput = outputPathValue
    ? await Neutralino.filesystem.getJoinedPath(outputPathValue, outputFilename)
    : outputFilename;

  if (record && await pathExists(fullOutput)) {
    return { ok: false, error: `The file '${fullOutput}' already exists.` };
  }

  if (mode !== "idle" && !recoverySession) {
    await terminateCurrent("Switching operation...");
  }

  await saveParams(ipAddress, outputPathValue, outputFilename);

  const simMode = isSimulationMode();
  let streamUri = "";
  if (!simMode) {
    try {
      streamUri = buildPlaybackUri(ipAddress);
    } catch (err) {
      const message = normalizeError(err);
      if (!recoverySession) resetState(message, "error");
      return { ok: false, error: message };
    }
  }

  const playerPath = simMode ? "" : await findPlayerBinary();
  const args = ["--no-one-instance", "--stats", streamUri];
  if (previewCachingMs() >= 0) args.splice(2, 0, `--network-caching=${previewCachingMs()}`);
  // External VLC: the SRT module's own option, for a preview only.
  if (!record && srtLatencyMs() >= 0) args.splice(2, 0, `--latency=${srtLatencyMs()}`);

  let rcHost = "";
  if (!simMode && !playerPath && (NL_OS === "Linux" || NL_OS === "Darwin" || NL_OS === "Windows")) {
    rcHost = createRcHost();
    if (NL_OS === "Windows") {
      args.unshift("--extraintf", "rc", "--rc-host", rcHost, "--rc-quiet");
    } else {
      args.unshift("--extraintf", "rc", "--rc-host", rcHost);
    }
  }

  if (record) {
    const mux = ext === "mp4" ? "mp4" : "mkv";
    args.push("--sout");
    args.push(`#duplicate{dst=std{access=file,mux=${mux},dst=${fullOutput}},dst=display}`);
  }

  operationToken += 1;
  const token = operationToken;

  try {
    if (simMode) {
      currentProcess = { type: "sim", running: true, token };
      if (record) {
        await ensureDirectoryForFile(fullOutput);
        const buf = new Uint8Array(1024);
        await Neutralino.filesystem.writeBinaryFile(fullOutput, buf.buffer);
        simSizeBytes = 1024;
        simLastTickSec = 0;
      }
    } else {
      // Arrange the window for streaming first, so the player's window opens at its
      // final place instead of jumping there after the start.
      startingStream = true;
      updateLayout();
      const startRect = videoRectArg();
      const command = playerPath
        ? buildPlayerCommand(playerPath, streamUri, record, ext, fullOutput, startRect)
        : buildCommand(await vlcCommand(), args);
      logDebug(`Launching VLC with command: ${command}`);
      const procInfo = await Neutralino.os.spawnProcess(command);
      currentProcess = {
        type: "real",
        id: procInfo.id,
        pid: procInfo.pid,
        rcHost,
        output: "",
        command,
        token,
        player: Boolean(playerPath),
        // A later layout change sends RECT only when it differs from this.
        sentRect: startRect,
        cachingMs: previewCachingMs(),
        // What a preview was started with; a recording takes no SRT latency.
        srtLatencyMs: record ? -1 : srtLatencyMs(),
        readBytes: null,
        lineBuffer: "",
        errorMessage: ""
      };
      // The layout may have changed while the process was starting.
      syncPlayerRect();
      // A reconnect can start a player while the scan dialog covers the window.
      if (!scanDialog.hidden) sendPlayerCommand("HIDE");
    }
  } catch (err) {
    startingStream = false;
    const message = friendlySpawnError(err);
    logDebug(`Failed to spawn VLC: ${message}`);
    if (!recoverySession) resetState(message, "error");
    return { ok: false, error: message };
  }

  startingStream = false;
  mode = record ? "recording" : "preview";
  activeSession = recoverySession || createSession({ record, ipAddress, outputPathValue, filenameBase: outputFilename, ext });
  resetSessionProgress(activeSession);
  startTimeMs = Date.now();
  outputFile = record ? fullOutput : "";
  noteStatus(simMode
    ? record
      ? `SIMULATION started. Recording to '${fullOutput}'.`
      : "SIMULATION started in preview mode."
    : record
      ? `VLC started. Recording to '${fullOutput}'.`
      : "VLC started in preview mode.");

  return { ok: true };
}

function payload() {
  return {
    ipAddress: ip.value.trim(),
    outputPathValue: outPath.value.trim(),
    filenameBase: filename.value.trim(),
    ext: extension.value === "mp4" ? "mp4" : "mkv"
  };
}

function updateButtons() {
  let basePreviewDisabled = false;

  if (mode === "recording") {
    recordBtn.textContent = "Stop Recording";
    previewBtn.textContent = "Preview";
    basePreviewDisabled = true;
  } else if (mode === "preview") {
    recordBtn.textContent = "Record";
    previewBtn.textContent = "Stop Preview";
    basePreviewDisabled = false;
  } else {
    recordBtn.textContent = "Record";
    previewBtn.textContent = "Preview";
    basePreviewDisabled = false;
  }

  const locked = uiBusy || scanState.running;
  recordBtn.disabled = locked;
  previewBtn.disabled = locked || basePreviewDisabled;
  browseBtn.disabled = locked;
  scanBtn.disabled = uiBusy || scanState.running;
  autoReconnect.disabled = uiBusy;
  bufferApplyBtn.disabled = uiBusy;
}

function applyState(state) {
  mode = state.mode || "idle";
  fileSize.textContent = state.fileSize || "0 B";
  elapsed.textContent = state.elapsed || "00:00:00";
  layoutEl.dataset.mode = mode;
  modeBadge.hidden = mode === "idle";
  modeBadge.className = `mode-badge is-${mode}`;
  modeBadge.textContent = mode === "recording" ? "REC" : mode === "preview" ? "PREVIEW" : "";
  const shown = withCameraNote(state.status || "");
  // A message from the camera adapter makes an otherwise plain status a warning.
  const kind = state.statusKind || "info";
  setStatus(shown, shown !== (state.status || "") && kind === "info" ? "warn" : kind);
  autoReconnect.checked = Boolean(parameters.auto_reconnect);
  showPreviewCaching();
  showCameraPage();

  if (state.fields && scanDialog.hidden) {
    if (document.activeElement !== ip) ip.value = state.fields.ip_address || "";
    if (document.activeElement !== outPath) outPath.value = state.fields.output_path || "";
    if (document.activeElement !== filename) filename.value = state.fields.output_filename_base || "";
    extension.value = state.fields.extension || "mkv";
  }

  updateButtons();
  updateLayout();
}

async function refreshState() {
  const token = operationToken;
  const session = activeSession;
  const proc = currentProcess;
  const state = await currentState();
  if (token !== operationToken || session !== activeSession || proc !== currentProcess) return;
  applyState(state);
}

async function withBusy(fn) {
  if (uiBusy) return;
  setBusy(true);
  try {
    await fn();
  } finally {
    setBusy(false);
    if (closeRequested) {
      await terminateCurrent("Stopped.");
      await pendingParamsWrite.catch(() => {});
      await Neutralino.app.exit();
    }
  }
}

async function stopOperation() {
  await terminateCurrent("Stopped.");
  await refreshState();
}

function isCanceledDialogError(err) {
  const message = normalizeError(err).toLowerCase();
  return message.includes("cancel") || message.includes("aborted") || message.includes("dismissed");
}

async function handleSpawnedProcessEvent(evt) {
  if (!evt || !evt.detail || !currentProcess || currentProcess.type !== "real") return;
  const detail = evt.detail;
  if (detail.id !== currentProcess.id || currentProcess.token !== operationToken) return;

  if (detail.action === "stdOut" || detail.action === "stdErr") {
    const chunk = String(detail.data || "");
    if (currentProcess.player && detail.action === "stdOut") {
      handlePlayerOutput(currentProcess, chunk);
      return;
    }
    const existing = String(currentProcess.output || "");
    const combined = `${existing}${chunk}`;
    currentProcess.output = combined.slice(-8000);
    return;
  }

  if (detail.action === "exit" && mode !== "idle") {
    currentProcess.exited = true;
    if (parameters.auto_reconnect && activeSession) {
      activeSession.nextRetryAt = Date.now() + RECONNECT_RETRY_MS;
      noteStatus(currentProcess.errorMessage
        ? `${currentProcess.errorMessage} Automatically reconnecting in 5 seconds...`
        : "VLC exited. Automatically reconnecting in 5 seconds...", "warn");
      logDebug(`VLC exited; reconnect scheduled. ${currentProcess.output || ""}`);
      await refreshState();
      return;
    }
    const output = String(currentProcess.errorMessage || currentProcess.output || "").trim();
    if (output) {
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const preferred = lines.findLast((line) => /(error|unknown|invalid|missing|not found|failed)/i.test(line));
      const detailLine = preferred || lines[lines.length - 1] || "VLC exited.";
      const cleanLast = detailLine.length > 220 ? `${detailLine.slice(0, 217)}...` : detailLine;
      resetState(`Stopped. ${cleanLast}`, "error");
      logDebug(`VLC process exited. Last output: ${cleanLast}`);
    } else {
      resetState("Stopped. VLC process exited with no output.", "warn");
      logDebug("VLC process exited with no captured output.");
    }
    await refreshState();
  }
}

async function init() {
  Neutralino.init();
  scanDialog.hidden = true;
  resetScanVisuals();

  Neutralino.events.on("spawnedProcess", (evt) => {
    handleSpawnedProcessEvent(evt).catch(() => {});
    handleProbeSpawnedProcessEvent(evt);
    handleCameraProcessEvent(evt);
  });

  Neutralino.events.on("windowClose", () => {
    closeRequested = true;
    stopCamera();
    withBusy(async () => {}).catch(() => {});
  });

  await loadParams();
  await setupCameraPlugins();
  videoHost.hidden = !await findPlayerBinary();
  layoutReady = true;
  await refreshState();
  ensureBashAvailable().catch(() => {});
  startCamera().catch((err) => logDebug(`Camera helper: ${normalizeError(err)}`));

  window.addEventListener("resize", () => updateLayout());
  // The stage can also change size without a window resize, for example when a
  // longer file size wraps a line of the bottom panel.
  new ResizeObserver(() => {
    if (videoHost.hidden) return;
    const box = stage.getBoundingClientRect();
    if (`${box.width}x${box.height}` !== layoutStageSize) updateLayout(true);
  }).observe(stage);

  setInterval(() => {
    (async () => {
      await monitorStream();
      await refreshState();
    })().catch((err) => logDebug(`Stream monitor: ${normalizeError(err)}`));
  }, 1000);
  setInterval(() => refreshCameraAiState(), 2000);
}

autoReconnect.addEventListener("change", () => {
  parameters.auto_reconnect = autoReconnect.checked;
  if (activeSession) {
    if (!parameters.auto_reconnect && (!currentProcess || currentProcess.exited)) {
      resetState("Automatic reconnect disabled. Stopped.");
    } else {
      resetSessionProgress(activeSession);
    }
  }
  saveParams(parameters.ip_address, parameters.output_path, parameters.output_filename)
    .catch((err) => {
      noteStatus(`Could not save automatic reconnect setting: ${normalizeError(err)}`, "error");
      setStatus(statusText, statusKind);
    });
  refreshState().catch(() => {});
});

recordBtn.addEventListener("click", () => {
  withBusy(async () => {
    if (mode === "recording") {
      await stopOperation();
      return;
    }

    const result = await startOperation({ record: true, ...payload() });
    await refreshState();
    if (!result.ok) {
      await showError(result.error);
    }
  }).catch(() => {});
});

previewBtn.addEventListener("click", () => {
  withBusy(async () => {
    if (mode === "recording") return;

    if (mode === "preview") {
      await stopOperation();
      return;
    }

    const result = await startOperation({ record: false, ...payload() });
    await refreshState();
    if (!result.ok) {
      await showError(result.error);
    }
  }).catch(() => {});
});

browseBtn.addEventListener("click", () => {
  withBusy(async () => {
    try {
      const selected = await Neutralino.os.showFolderDialog("Select output folder", {
        defaultPath: outPath.value.trim() || undefined
      });
      if (selected) {
        outPath.value = selected;
        parameters.output_path = selected;
      }
    } catch (err) {
      if (!isCanceledDialogError(err)) {
        await showError(normalizeError(err));
      }
    }
  }).catch(() => {});
});

ip.addEventListener("input", () => {
  const value = ip.value.trim();
  if (value) {
    parameters.ip_address = value;
  }
});

outPath.addEventListener("input", () => {
  parameters.output_path = outPath.value;
});

filename.addEventListener("input", () => {
  parameters.output_filename = currentOutputFilenameFromUI();
});

extension.addEventListener("change", () => {
  parameters.output_filename = currentOutputFilenameFromUI();
});

scanBtn.addEventListener("click", () => {
  openScanDialog();
});

panelToggle.addEventListener("click", () => {
  panelOverride = currentLayout && currentLayout.compact ? "full" : "compact";
  updateLayout();
});

startScanBtn.addEventListener("click", () => {
  startScan().catch(() => {});
});

abortScanBtn.addEventListener("click", () => {
  requestScanAbort(
    `Scan aborted. Checked ${scanState.checked}/${scanState.total}, found ${scanState.found.size}.`
  );
});

closeScanBtn.addEventListener("click", () => {
  closeScanDialog();
});

scanResults.addEventListener("change", () => {
  const selected = scanResults.value;
  if (!selected) return;

  (async () => {
    if (scanState.running) {
      requestScanAbort("Address selected. Scan stopped.");
    }
    await applySelectedAddress(selected);
    closeScanDialog();
  })().catch(() => {});
});

scanDialog.addEventListener("click", (evt) => {
  if (evt.target === scanDialog) {
    closeScanDialog();
  }
});

// The native video window may or may not pass mouse input on to the page, depending on the
// platform; both are plain page events here.
videoHost.addEventListener("click", handleVideoClick);
videoHost.addEventListener("dblclick", handleVideoDoubleClick);
stage.addEventListener("wheel", handleStageWheel, { passive: false });
zoomInBtn.addEventListener("click", () => zoomCamera(cameraZoomStep()));
zoomOutBtn.addEventListener("click", () => zoomCamera(-cameraZoomStep()));
cameraPluginSelect.addEventListener("change", () => selectCameraPlugin().catch((err) => setCameraNote(normalizeError(err))));
cameraPageBtn.addEventListener("click", () => openCameraPage().catch(() => {}));
cameraClickDelay.addEventListener("change", handleCameraClickDelayChange);
cameraSpeed.addEventListener("input", handleCameraSpeedInput);
cameraSpeed.addEventListener("change", handleCameraSpeedChange);
// A slider that keeps the focus would take the arrow keys, which turn the camera.
cameraSpeed.addEventListener("pointerup", () => cameraSpeed.blur());
previewCaching.addEventListener("change", handlePreviewCachingChange);
srtLatency.addEventListener("change", handleSrtLatencyChange);
bufferApplyBtn.addEventListener("click", () => restartPreview().catch(() => {}));
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("pointerdown", handleWindowPointerDown);
panel.addEventListener("scroll", closePresetMenu);
window.addEventListener("blur", closePresetMenu);
window.addEventListener("resize", closePresetMenu);

init().catch(async (err) => {
  await showError(normalizeError(err));
});
