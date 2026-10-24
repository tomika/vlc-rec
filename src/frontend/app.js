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

const DEFAULT_PARAMS = {
  ip_address: "127.0.0.1:5000",
  output_path: "",
  output_filename: `${new Date().toISOString().slice(0, 10)}.mkv`,
  bash_path: "bash",
  scan_concurrency: 25,
  scan_timeout_ms: 300,
  auto_reconnect: false,
  stall_timeout_sec: 15
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

let parameters = { ...DEFAULT_PARAMS };
let mode = "idle";
let currentProcess = null;
let startTimeMs = 0;
let outputFile = "";
let statusText = "";
let operationToken = 0;
let simSizeBytes = 1024;
let simLastTickSec = 0;
let uiBusy = false;
let activeSession = null;
let monitorBusy = false;
let closeRequested = false;
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

function setStatus(text) {
  status.textContent = text || "";
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

async function loadParams() {
  try {
    if (await pathExists(PARAMS_FILE)) {
      const raw = await Neutralino.filesystem.readFile(PARAMS_FILE);
      parameters = { ...parameters, ...JSON.parse(raw) };
    }
  } catch {
    parameters = { ...DEFAULT_PARAMS };
  }

  parameters.output_filename = `${new Date().toISOString().slice(0, 10)}.${inferExt(parameters.output_filename)}`;
}

async function saveParams(ipAddress, outputPathValue, outputFilename) {
  parameters = {
    ...parameters,
    ip_address: ipAddress,
    output_path: outputPathValue,
    output_filename: outputFilename
  };
  await Neutralino.filesystem.writeFile(PARAMS_FILE, `${JSON.stringify(parameters, null, 2)}\n`);
}

function resetState(newStatus = "Stopped.") {
  activeSession = null;
  mode = "idle";
  currentProcess = null;
  startTimeMs = 0;
  outputFile = "";
  simSizeBytes = 1024;
  simLastTickSec = 0;
  statusText = newStatus;
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
  return NL_OS === "Windows" ? `cmd /c ${script}` : bashInvocation(script);
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

async function verifyWithVlc(address, port) {
  const uri = buildSrtCallerUri(address, port);
  const vlc = `vlc --intf dummy --play-and-exit --run-time=2 \"${uri}\" vlc://quit`;

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

  try {
    await saveParams(addressPort, outPath.value.trim(), currentOutputFilenameFromUI());
  } catch {
    // Ignore persistence failures for selection convenience.
  }
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
    for (let attempt = 0; attempt < 13; attempt += 1) {
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

  const warningText = wasRecording
    ? "VLC is still recording. If the app force-stops VLC, mp4 finalization may fail and the file can become corrupted or unusable. For safest results, stop VLC manually in the VLC window when possible."
    : "";
  const warningState = { shown: false };

  // Always keep a hard-stop fallback so we don't leak VLC processes.
  scheduleProcessExit(procId, softStopIssued ? 2600 : 800, { warningText, warningState });
  scheduleProcessExit(procId, softStopIssued ? 7000 : 2200, { warningText, warningState });
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
    statusText = `${reason} Reconnecting VLC...`;
    setStatus(statusText);
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
      statusText = `Automatically reconnected. ${statusText}`;
    } catch (err) {
      // Keep the user's operation active and retry without any modal dialogs.
      session.nextRetryAt = Date.now() + RECONNECT_RETRY_MS;
      statusText = `Reconnect failed: ${normalizeError(err)} Retrying in 5 seconds.`;
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
        progress = await readPreviewProgress(proc.rcHost);
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
        statusText = "Preview monitoring available.";
      }
    } else if (session.previewProgress === null) {
      if (now - session.lastProgressAt >= stallTimeoutMs() && !session.previewUnavailable) {
        session.previewUnavailable = true;
        statusText = "Preview monitoring unavailable: VLC RC statistics could not be read. Process exits are still monitored.";
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
      if (!recoverySession) resetState(message);
      return { ok: false, error: message };
    }
  }

  const args = ["--no-one-instance", "--stats", streamUri];

  let rcHost = "";
  if (!simMode && (NL_OS === "Linux" || NL_OS === "Darwin" || NL_OS === "Windows")) {
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
      const command = buildCommand("vlc", args);
      logDebug(`Launching VLC with command: ${command}`);
      const procInfo = await Neutralino.os.spawnProcess(command);
      currentProcess = {
        type: "real",
        id: procInfo.id,
        pid: procInfo.pid,
        rcHost,
        output: "",
        command,
        token
      };
    }
  } catch (err) {
    const message = friendlySpawnError(err);
    logDebug(`Failed to spawn VLC: ${message}`);
    if (!recoverySession) resetState(message);
    return { ok: false, error: message };
  }

  mode = record ? "recording" : "preview";
  activeSession = recoverySession || createSession({ record, ipAddress, outputPathValue, filenameBase: outputFilename, ext });
  resetSessionProgress(activeSession);
  startTimeMs = Date.now();
  outputFile = record ? fullOutput : "";
  statusText = simMode
    ? record
      ? `SIMULATION started. Recording to '${fullOutput}'.`
      : "SIMULATION started in preview mode."
    : record
      ? `VLC started. Recording to '${fullOutput}'.`
      : "VLC started in preview mode.";

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
    previewBtn.textContent = "Preview Only";
    basePreviewDisabled = true;
  } else if (mode === "preview") {
    recordBtn.textContent = "Start VLC Stream & Record";
    previewBtn.textContent = "Stop Preview";
    basePreviewDisabled = false;
  } else {
    recordBtn.textContent = "Start VLC Stream & Record";
    previewBtn.textContent = "Preview Only";
    basePreviewDisabled = false;
  }

  const locked = uiBusy || scanState.running;
  recordBtn.disabled = locked;
  previewBtn.disabled = locked || basePreviewDisabled;
  browseBtn.disabled = locked;
  scanBtn.disabled = uiBusy || scanState.running;
  autoReconnect.disabled = uiBusy;
}

function applyState(state) {
  mode = state.mode || "idle";
  fileSize.textContent = `File Size: ${state.fileSize || "0 B"}`;
  elapsed.textContent = `Time Elapsed: ${state.elapsed || "00:00:00"}`;
  setStatus(state.status || "");
  autoReconnect.checked = Boolean(parameters.auto_reconnect);

  if (state.fields && scanDialog.hidden) {
    if (document.activeElement !== ip) ip.value = state.fields.ip_address || "";
    if (document.activeElement !== outPath) outPath.value = state.fields.output_path || "";
    if (document.activeElement !== filename) filename.value = state.fields.output_filename_base || "";
    extension.value = state.fields.extension || "mkv";
  }

  updateButtons();
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
    const existing = String(currentProcess.output || "");
    const combined = `${existing}${chunk}`;
    currentProcess.output = combined.slice(-8000);
    return;
  }

  if (detail.action === "exit" && mode !== "idle") {
    currentProcess.exited = true;
    if (parameters.auto_reconnect && activeSession) {
      activeSession.nextRetryAt = Date.now() + RECONNECT_RETRY_MS;
      statusText = "VLC exited. Automatically reconnecting in 5 seconds...";
      logDebug(`VLC exited; reconnect scheduled. ${currentProcess.output || ""}`);
      await refreshState();
      return;
    }
    const output = String(currentProcess.output || "").trim();
    if (output) {
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const preferred = lines.findLast((line) => /(error|unknown|invalid|missing|not found|failed)/i.test(line));
      const detailLine = preferred || lines[lines.length - 1] || "VLC exited.";
      const cleanLast = detailLine.length > 220 ? `${detailLine.slice(0, 217)}...` : detailLine;
      resetState(`Stopped. ${cleanLast}`);
      logDebug(`VLC process exited. Last output: ${cleanLast}`);
    } else {
      resetState("Stopped. VLC process exited with no output.");
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
  });

  Neutralino.events.on("windowClose", () => {
    closeRequested = true;
    withBusy(async () => {}).catch(() => {});
  });

  await loadParams();
  await refreshState();
  ensureBashAvailable().catch(() => {});

  setInterval(() => {
    (async () => {
      await monitorStream();
      await refreshState();
    })().catch((err) => logDebug(`Stream monitor: ${normalizeError(err)}`));
  }, 1000);
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
      statusText = `Could not save automatic reconnect setting: ${normalizeError(err)}`;
      setStatus(statusText);
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

window.addEventListener("keydown", (evt) => {
  if (evt.key === "Escape" && !scanDialog.hidden) {
    closeScanDialog();
  }
});

init().catch(async (err) => {
  await showError(normalizeError(err));
});
