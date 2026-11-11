// Measures the horizontal field of view of the camera at several zoom values, from its own SRT
// picture. A development tool for the defaults of camera_hfov_deg and camera_zoom_ratio, not
// part of the app. Run it in a container that has node and ffmpeg with SRT, on the host network:
//
//   podman run --rm --network host localhost/vlc-rec-e2e:1 node /path/calibrate-fov.js 192.168.1.50
//
// For each zoom value the camera is turned by +delta and -delta degrees (absolute targets, so
// the angle is the one commanded), a frame is taken before and after, and the horizontal shift
// of the picture is found by normalised cross correlation of the middle of the frame. A pure
// rotation by delta moves the picture centre by f * tan(delta) pixels, so
//   f = shift / tan(delta),  hfov = 2 * atan(width / (2 f)),  zoom ratio = f(zoom) / f(0).
// Pan and tilt, and the zoom, are put back at the end.
const dgram = require("node:dgram");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const IP = process.argv[2];
const ZOOMS = (process.argv[3] || "0,9,25,50").split(",").map(Number);
const W = 640;
const H = 360;
const FRAME = "/tmp/latest.pgm";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (!/^\d+\.\d+\.\d+\.\d+$/.test(IP || "")) {
  console.error("usage: calibrate-fov.js CAMERA_IP [zoom,zoom,...]");
  process.exit(2);
}

// ---- OSC over UDP ----
const pad = (n) => (n + 4) & ~3;
function encode(address, ints) {
  const a = pad(address.length), t = pad(ints.length + 1);
  const buf = Buffer.alloc(a + t + 4 * ints.length);
  buf.write(address, 0);
  buf.write("," + "i".repeat(ints.length), a);
  ints.forEach((v, i) => buf.writeInt32BE(v, a + t + 4 * i));
  return buf;
}
function decode(buf) {
  const end = buf.indexOf(0);
  const address = buf.toString("latin1", 0, end);
  let p = pad(end);
  const tagEnd = buf.indexOf(0, p);
  const tags = buf.toString("latin1", p + 1, tagEnd);
  p += pad(tagEnd - p);
  const ints = [];
  for (const tag of tags) {
    if (tag === "i") { ints.push(buf.readInt32BE(p)); p += 4; } else break;
  }
  return { address, ints };
}

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
const waiting = [];
sock.on("message", (data) => {
  let message;
  try { message = decode(data); } catch { return; }
  for (let i = 0; i < waiting.length; i++) {
    if (message.address.endsWith(waiting[i].suffix)) {
      clearTimeout(waiting[i].timer);
      waiting.splice(i, 1)[0].resolve(message.ints);
      return;
    }
  }
});
const send = (address, ints) => sock.send(encode(address, ints), 57110, IP);
function ask(request, suffix, ints = [0], timeout = 500) {
  return new Promise((resolve) => {
    const entry = { suffix, resolve, timer: setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); resolve(null); }, timeout) };
    waiting.push(entry);
    send(request, ints);
  });
}
const G = "/OBSBOT/WebCam/General/";
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function readPose() {
  const tilts = [], pans = [];
  for (let i = 0; i < 3; i++) {
    const ints = await ask(G + "GetGimbalPosInfo", "GetGimbalPosInfoResp");
    if (ints && ints.length >= 2) { tilts.push(ints[ints.length - 2]); pans.push(ints[ints.length - 1]); }
    await sleep(100);
  }
  if (!tilts.length) throw new Error("the camera does not report its position");
  return { tilt: median(tilts), pan: median(pans) };
}
async function readZoom() {
  const ints = await ask(G + "GetZoomInfo", "ZoomInfo");
  return ints ? ints[0] : null;
}
async function setZoom(percent) {
  send(G + "SetZoom", [percent]);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await readZoom() === percent) break;
  }
  await sleep(2500);
}
async function turnTo(pan, tilt) {
  send(G + "SetGimMotorDegree", [20, pan, tilt]);
  await sleep(3500);
}

// ---- pictures ----
function readFrame() {
  const buf = fs.readFileSync(FRAME);
  let p = 0, tokens = 0;
  while (tokens < 4) {
    while (buf[p] === 0x0a || buf[p] === 0x20) p++;
    while (buf[p] !== 0x0a && buf[p] !== 0x20) p++;
    tokens++;
  }
  p++;
  const data = buf.subarray(p, p + W * H);
  if (data.length !== W * H) throw new Error("unexpected frame size");
  return Uint8Array.from(data);
}
async function frame() {
  const first = readFrame();
  await sleep(700);
  const second = readFrame();
  let diff = 0;
  for (let i = 0; i < first.length; i += 7) diff += Math.abs(first[i] - second[i]);
  return diff / (first.length / 7) < 4 ? second : frame(); // a moving picture is taken again
}

// Shift s such that b(x) is about a(x + s): normalised cross correlation of the middle rows.
function shiftBetween(a, b) {
  const y0 = Math.floor(H * 0.25), y1 = Math.floor(H * 0.75);
  const score = (s) => {
    const x0 = Math.max(Math.floor(W * 0.15), Math.floor(W * 0.15) - s), x1 = Math.min(Math.floor(W * 0.85), Math.floor(W * 0.85) - s);
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const va = a[y * W + x + s], vb = b[y * W + x];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
    }
    const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    return va > 1 && vb > 1 ? cov / Math.sqrt(va * vb) : -1;
  };
  let best = -1, bestScore = -2;
  const scores = new Map();
  for (let s = -170; s <= 170; s++) {
    const value = score(s);
    scores.set(s, value);
    if (value > bestScore) { bestScore = value; best = s; }
  }
  // Parabola through the peak for a sub pixel position.
  const l = scores.get(best - 1), c = scores.get(best), r = scores.get(best + 1);
  const offset = l !== undefined && r !== undefined && l - 2 * c + r !== 0 ? 0.5 * (l - r) / (l - 2 * c + r) : 0;
  return { shift: best + offset, score: bestScore };
}

async function main() {
  await new Promise((resolve) => sock.bind(57120, resolve));
  const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-i", `srt://${IP}:5000?mode=caller&latency=200&connect_timeout=8000`,
    "-vf", `fps=2,scale=${W}:${H},format=gray`, "-f", "image2", "-update", "1", "-atomic_writing", "1", FRAME], { stdio: "inherit" });
  process.on("exit", () => ffmpeg.kill("SIGKILL"));
  for (let i = 0; i < 60 && !fs.existsSync(FRAME); i++) await sleep(500);
  if (!fs.existsSync(FRAME)) throw new Error("no picture from the camera");

  const home = await readPose();
  const homeZoom = await readZoom();
  console.log(`start: pan ${home.pan}, tilt ${home.tilt}, zoom ${homeZoom}`);
  const rows = [];
  try {
    for (const zoom of ZOOMS) {
      await setZoom(zoom);
      const real = await readZoom();
      const pose = await readPose();
      // About 12 percent of the width at a field of view of 80 degrees at zoom 0, then less angle as it zooms in.
      const ratioGuess = 1 + 11 * (real || zoom) / 100;
      const delta = Math.max(2, Math.round(14 / ratioGuess));
      const fs_ = [];
      for (const sign of [1, -1, 1, -1]) {
        await turnTo(pose.pan, pose.tilt);
        const before = await frame();
        await turnTo(pose.pan - sign * delta, pose.tilt);
        const after = await frame();
        const { shift, score } = shiftBetween(before, after);
        const f = Math.abs(shift) / Math.tan(delta * Math.PI / 180);
        fs_.push({ f, shift, score, ok: score > 0.6 && Math.abs(shift) < 165 && Math.sign(shift) === sign });
      }
      const good = fs_.filter((item) => item.ok);
      const f = good.length ? good.reduce((sum, item) => sum + item.f, 0) / good.length : NaN;
      rows.push({ zoom: real, delta, f, hfov: 2 * Math.atan(W / (2 * f)) * 180 / Math.PI, used: good.length, detail: fs_ });
      console.log(`zoom ${real}%: delta ${delta} deg, shifts ${fs_.map((item) => item.shift.toFixed(1) + (item.ok ? "" : "?")).join(" ")} px, correlation ${fs_.map((item) => item.score.toFixed(2)).join(" ")}, f ${f.toFixed(1)} px, hfov ${rows[rows.length - 1].hfov.toFixed(1)} deg`);
    }
  } finally {
    await turnTo(home.pan, home.tilt).catch(() => {});
    if (homeZoom !== null) await setZoom(homeZoom).catch(() => {});
    ffmpeg.kill("SIGKILL");
  }
  const f0 = (rows.find((row) => row.zoom === 0) || rows[0]).f;
  console.log("\nzoom  hfov    ratio (f / f at zoom 0)   linear model 1 + 11 * zoom / 100");
  for (const row of rows) console.log(`${String(row.zoom).padStart(4)}  ${row.hfov.toFixed(1).padStart(5)}   ${(row.f / f0).toFixed(2).padStart(5)}                    ${(1 + 11 * row.zoom / 100).toFixed(2)}`);
  process.exit(0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
