const ip = document.getElementById("ip");
const scanBtn = document.getElementById("scanBtn");
const outPath = document.getElementById("outPath");
const filename = document.getElementById("filename");
const extension = document.getElementById("extension");
const browseBtn = document.getElementById("browseBtn");
const recordBtn = document.getElementById("recordBtn");
const previewBtn = document.getElementById("previewBtn");
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
  output_filename: `${new Date().toISOString().slice(0, 10)}.mkv`
};

const PARAMS_FILE = `${NL_PATH}/vlc_rec_params.json`;
const SCAN_CONCURRENCY = 25;
const MAX_SCAN_TARGETS = 65536;
const probeProcessHandlers = new Map();
const VERIFY_CONCURRENCY = 3;
const RESULT_STATE_UNTESTED = "untested";
const RESULT_STATE_TESTING = "testing";
const RESULT_STATE_FOUND = "SRT found";
const RESULT_STATE_NOT_SRT = "not srt";
const RESULT_STATE_UNKNOWN = "unknown";

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
  verifyQueue: [],
  verifyRunning: 0,
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

  scanCurrent.textContent = `Current: ${formatIpRanges(active)}`;
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
  if (state === RESULT_STATE_TESTING) return "#f1c40f";
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
  scanState.verifyQueue = [];
}

function addScanResult(addressPort) {
  if (scanState.found.has(addressPort)) return;
  scanState.found.add(addressPort);

  const option = document.createElement("option");
  option.value = addressPort;
  scanResults.appendChild(option);
  scanState.resultOptions.set(addressPort, option);
  setResultState(addressPort, RESULT_STATE_UNTESTED);

  queueResultVerification(addressPort).catch(() => {});
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
  scanState.activeHosts = new Set();
  updateScanCurrentInfo();
  abortActiveScanProbes().catch(() => {});
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
    const unixCmd = "bash -lc \"ip -o -f inet addr show 2>/dev/null | awk '{print $4}' | paste -sd, -\"";
    const unixInfo = await Neutralino.os.execCommand(unixCmd);
    const cidrs = splitCsvValues(unixInfo.stdOut).filter((entry) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(entry));
    if (cidrs.length > 0) return cidrs;

    const fallbackCmd = "bash -lc \"ifconfig 2>/dev/null | awk '/inet / && $2 != \\\"127.0.0.1\\\" {print $2\\\"/24\\\"}' | paste -sd, -\"";
    const fallbackInfo = await Neutralino.os.execCommand(fallbackCmd);
    return splitCsvValues(fallbackInfo.stdOut).filter((entry) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(entry));
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

    const info = await Neutralino.os.execCommand(`bash -lc "command -v ${commandName}"`);
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

  if (await commandExists("srt-live-transmit")) {
    scanState.verifierKind = "srt-live-transmit";
    return scanState.verifierKind;
  }

  scanState.verifierKind = "vlc";
  return scanState.verifierKind;
}

function buildSrtCallerUri(address, port) {
  return `srt://${address}:${port}?mode=caller&connect_timeout=1000&latency=120`;
}

async function verifyWithFfprobe(address, port) {
  const uri = buildSrtCallerUri(address, port);
  const cmd = `ffprobe -v error -show_entries format=format_name -of default=nk=1:nw=1 \"${uri}\"`;
  const info = await Neutralino.os.execCommand(cmd);
  const output = `${info.stdOut || ""}\n${info.stdErr || ""}`.toLowerCase();
  if (Number(info.exitCode) === 0 && !output.includes("error") && !output.includes("failed")) {
    return RESULT_STATE_FOUND;
  }

  if (
    output.includes("input/output error")
    || output.includes("connection")
    || output.includes("failed")
    || output.includes("refused")
    || output.includes("timed out")
    || output.includes("invalid")
    || Number(info.exitCode) !== 0
  ) {
    return RESULT_STATE_NOT_SRT;
  }

  return RESULT_STATE_UNKNOWN;
}

async function verifyWithSrtLiveTransmit(address, port) {
  const uri = buildSrtCallerUri(address, port);

  if (NL_OS === "Windows") {
    const ps = [
      "$src='" + uri + "'",
      "$proc=Start-Process 'srt-live-transmit' -ArgumentList @($src,'file://con') -PassThru -NoNewWindow",
      "if($proc.WaitForExit(2000)){ if($proc.ExitCode -eq 0){'SRT_OK'} else {'SRT_FAIL'} } else { $proc.Kill(); 'SRT_TIMEOUT' }"
    ].join("; ");
    const info = await Neutralino.os.execCommand(`powershell -NoProfile -NonInteractive -Command \"${ps}\"`);
    const output = `${info.stdOut || ""}\n${info.stdErr || ""}`.toUpperCase();
    if (output.includes("SRT_OK")) return RESULT_STATE_FOUND;
    if (output.includes("SRT_FAIL") || output.includes("SRT_TIMEOUT")) return RESULT_STATE_NOT_SRT;
    return RESULT_STATE_UNKNOWN;
  }

  const cmd = `bash -lc \"timeout 2 srt-live-transmit '${uri}' 'file://con' >/dev/null 2>&1; code=$?; if [ $code -eq 0 ]; then echo SRT_OK; else echo SRT_FAIL; fi\"`;
  const info = await Neutralino.os.execCommand(cmd);
  const output = `${info.stdOut || ""}\n${info.stdErr || ""}`.toUpperCase();
  if (output.includes("SRT_OK")) return RESULT_STATE_FOUND;
  if (output.includes("SRT_FAIL") || output.includes("SRT_TIMEOUT") || Number(info.exitCode) !== 0) {
    return RESULT_STATE_NOT_SRT;
  }
  return RESULT_STATE_UNKNOWN;
}

async function verifyWithVlc(address, port) {
  const uri = buildSrtCallerUri(address, port);
  const cmd = `vlc --intf dummy --play-and-exit --run-time=2 \"${uri}\" vlc://quit`;
  const info = await Neutralino.os.execCommand(cmd);
  const output = `${info.stdOut || ""}\n${info.stdErr || ""}`.toLowerCase();
  if (Number(info.exitCode) === 0 && !output.includes("error") && !output.includes("failed")) {
    return RESULT_STATE_FOUND;
  }

  if (output.includes("error") || output.includes("failed") || Number(info.exitCode) !== 0) {
    return RESULT_STATE_NOT_SRT;
  }

  return RESULT_STATE_UNKNOWN;
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

    if (verifier === "srt-live-transmit") {
      return await verifyWithSrtLiveTransmit(parsed.host, parsed.port);
    }

    return await verifyWithVlc(parsed.host, parsed.port);
  } catch {
    return RESULT_STATE_UNKNOWN;
  }
}

async function pumpVerificationQueue() {
  while (scanState.verifyRunning < VERIFY_CONCURRENCY && scanState.verifyQueue.length > 0) {
    const addressPort = scanState.verifyQueue.shift();
    if (!addressPort) return;

    scanState.verifyRunning += 1;
    (async () => {
      const verifyState = await verifySrtEndpoint(addressPort);
      setResultState(addressPort, verifyState);
    })()
      .catch(() => {
        setResultState(addressPort, RESULT_STATE_UNKNOWN);
      })
      .finally(() => {
        scanState.verifyRunning = Math.max(0, scanState.verifyRunning - 1);
        pumpVerificationQueue().catch(() => {});
      });
  }
}

async function queueResultVerification(addressPort) {
  const option = scanState.resultOptions.get(addressPort);
  if (!option) return;

  if (option.dataset.state !== RESULT_STATE_UNTESTED) return;
  setResultState(addressPort, RESULT_STATE_TESTING);
  scanState.verifyQueue.push(addressPort);
  await pumpVerificationQueue();
}

function buildProbeCommand(address, port) {
  if (NL_OS === "Windows") {
    const winScript = `$c=New-Object Net.Sockets.TcpClient;try{$a=$c.BeginConnect('${address}',${port},$null,$null);if($a.AsyncWaitHandle.WaitOne(700,$false)-and $c.Connected){$c.EndConnect($a)|Out-Null;Write-Output OPEN}else{Write-Output CLOSED}}catch{Write-Output CLOSED}finally{$c.Close()}`;
    return `powershell -NoProfile -NonInteractive -Command \"${winScript}\"`;
  }

  if (NL_OS === "Linux") {
    return `bash -lc \"timeout 1 bash -c '</dev/tcp/${address}/${port}' >/dev/null 2>&1 && echo OPEN || echo CLOSED\"`;
  }

  if (NL_OS === "Darwin") {
    return `bash -lc \"nc -G 1 -z ${address} ${port} >/dev/null 2>&1 && echo OPEN || echo CLOSED\"`;
  }

  throw new Error(`Port scan is not supported on this OS (${NL_OS}).`);
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
    const isOpen = /\bOPEN\b/i.test(handler.output);
    probeProcessHandlers.delete(id);
    scanState.activeProbeIds.delete(id);
    handler.resolve(isOpen);
  }
}

async function abortActiveScanProbes() {
  const probeIds = Array.from(scanState.activeProbeIds);
  if (probeIds.length === 0) return;

  await Promise.all(
    probeIds.map((probeId) => Neutralino.os.updateSpawnedProcess(probeId, "exit").catch(() => {}))
  );
}

async function probePortOpen(address, port, token) {
  if (token !== scanState.token || scanState.abortRequested) {
    return false;
  }

  const command = buildProbeCommand(address, port);
  const procInfo = await Neutralino.os.spawnProcess(command);
  const probeId = procInfo.id;

  if (token !== scanState.token || scanState.abortRequested) {
    try {
      await Neutralino.os.updateSpawnedProcess(probeId, "exit");
    } catch {
      // Ignore cancellation errors.
    }
    return false;
  }

  scanState.activeProbeIds.add(probeId);

  return await new Promise((resolve) => {
    probeProcessHandlers.set(probeId, {
      resolve,
      output: "",
      token
    });
  });
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
    const resolvedHosts = await resolveScanHosts(scanMaskInput.value);
    const hosts = prioritizeHostsNearCurrent(resolvedHosts);
    if (scanState.token !== token) return;

    scanState.total = hosts.length;
    updateScanProgressBar();
    setScanProgress(`Scanning ${hosts.length} addresses on port ${port} with concurrency ${SCAN_CONCURRENCY}...`);

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, hosts.length) }, async () => {
      while (!scanState.abortRequested && scanState.token === token) {
        const idx = nextIndex;
        if (idx >= hosts.length) break;
        nextIndex += 1;

        const host = hosts[idx];
        let isOpen = false;
        scanState.activeHosts.add(host);
        updateScanCurrentInfo();
        try {
          isOpen = await probePortOpen(host, port, token);
        } catch {
          isOpen = false;
        }
        scanState.activeHosts.delete(host);
        updateScanCurrentInfo();

        if (scanState.token !== token) return;

        scanState.checked += 1;
        updateScanProgressBar();
        if (isOpen) {
          addScanResult(`${host}:${port}`);
        }

        if (scanState.checked % 5 === 0 || isOpen || scanState.checked === scanState.total) {
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
      scanState.activeProbeIds = new Set();
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
      await Neutralino.os.execCommand(`bash -lc "kill -TERM ${processId}"`);
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
      const cmd = `bash -lc "exec 3<>/dev/tcp/${target.host}/${target.port}; printf 'stop\\nshutdown\\nquit\\n' >&3; exec 3<&-; exec 3>&-"`;
      const info = await Neutralino.os.execCommand(cmd);
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

async function startOperation({ record, ipAddress, outputPathValue, filenameBase, ext }) {
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

  if (mode !== "idle") {
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
      resetState(message);
      return { ok: false, error: message };
    }
  }

  const args = [
    streamUri
  ];

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
    resetState(message);
    return { ok: false, error: message };
  }

  mode = record ? "recording" : "preview";
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
}

function applyState(state) {
  mode = state.mode || "idle";
  fileSize.textContent = `File Size: ${state.fileSize || "0 B"}`;
  elapsed.textContent = `Time Elapsed: ${state.elapsed || "00:00:00"}`;
  setStatus(state.status || "");

  if (state.fields && scanDialog.hidden) {
    if (document.activeElement !== ip) ip.value = state.fields.ip_address || "";
    if (document.activeElement !== outPath) outPath.value = state.fields.output_path || "";
    if (document.activeElement !== filename) filename.value = state.fields.output_filename_base || "";
    extension.value = state.fields.extension || "mkv";
  }

  updateButtons();
}

async function refreshState() {
  const state = await currentState();
  applyState(state);
}

async function withBusy(fn) {
  if (uiBusy) return;
  setBusy(true);
  try {
    await fn();
  } finally {
    setBusy(false);
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
    withBusy(async () => {
      if (mode !== "idle") {
        await terminateCurrent("Stopped.");
      }
      await Neutralino.app.exit();
    }).catch(() => {});
  });

  await loadParams();
  await refreshState();

  setInterval(() => {
    refreshState().catch(() => {});
  }, 1000);
}

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

scanBtn.addEventListener("click", () => {
  openScanDialog();
});

startScanBtn.addEventListener("click", () => {
  startScan().catch(() => {});
});

abortScanBtn.addEventListener("click", () => {
  requestScanAbort("Abort requested...");
});

closeScanBtn.addEventListener("click", () => {
  closeScanDialog();
});

scanResults.addEventListener("change", () => {
  const selected = scanResults.value;
  if (!selected) return;

  (async () => {
    if (scanState.running) {
      requestScanAbort("Address selected. Stopping scan...");
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
