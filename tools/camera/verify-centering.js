// Closed loop check of "turn so that the clicked point ends up in the middle", on a real camera.
// A development tool, not part of the app. Run in a container that has node and ffmpeg with SRT,
// on the host network, with the built camera helper mounted:
//
//   podman run --rm --network host -v REPO/player:/p:ro -v REPO/tools/camera:/t:ro \
//     localhost/vlc-rec-e2e:1 node /t/verify-centering.js 192.168.1.50 [zoom steps...]
//
// For some points of the picture the helper is asked to CENTER them, as a click would. A patch
// around the point is cut out of the picture taken before, and looked for in the picture taken
// after the turn (normalised cross correlation). It should now be in the middle. After each turn
// the camera is turned back, and at the end the zoom is put back too.
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const IP = process.argv[2];
const EXTRA_ZOOM = (process.argv[3] || "0,15").split(",").map(Number); // zoom steps relative to the start
const W = 640;
const H = 360;
const FRAME = "/tmp/latest.pgm";
const POINTS = [[0.75, 0.5], [0.25, 0.5], [0.5, 0.2], [0.5, 0.8], [0.8, 0.25], [0.2, 0.75]];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (!/^\d+\.\d+\.\d+\.\d+$/.test(IP || "")) {
  console.error("usage: verify-centering.js CAMERA_IP [zoom,zoom,...]");
  process.exit(2);
}

function readFrame() {
  const buf = fs.readFileSync(FRAME);
  let p = 0, tokens = 0;
  while (tokens < 4) {
    while (buf[p] === 0x0a || buf[p] === 0x20) p++;
    while (buf[p] !== 0x0a && buf[p] !== 0x20) p++;
    tokens++;
  }
  p++;
  return Uint8Array.from(buf.subarray(p, p + W * H));
}
async function frame() {
  const first = readFrame();
  await sleep(700);
  const second = readFrame();
  let diff = 0;
  for (let i = 0; i < first.length; i += 7) diff += Math.abs(first[i] - second[i]);
  return diff / (first.length / 7) < 4 ? second : frame();
}

// Where does the patch of picture a at (cx, cy) (pixels, centre) appear in picture b?
function findPatch(a, b, cx, cy, half = [40, 30], range = [150, 110]) {
  const [hw, hh] = half;
  const px0 = Math.round(cx) - hw, py0 = Math.round(cy) - hh;
  let best = null;
  for (let dy = -range[1]; dy <= range[1]; dy += 2) {
    for (let dx = -range[0]; dx <= range[0]; dx += 2) {
      const x0 = px0 + dx, y0 = py0 + dy;
      if (x0 < 0 || y0 < 0 || x0 + 2 * hw >= W || y0 + 2 * hh >= H || px0 < 0 || py0 < 0 || px0 + 2 * hw >= W || py0 + 2 * hh >= H) continue;
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
      for (let y = 0; y < 2 * hh; y += 2) for (let x = 0; x < 2 * hw; x += 2) {
        const va = a[(py0 + y) * W + px0 + x], vb = b[(y0 + y) * W + x0 + x];
        sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
      }
      const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
      const score = va > 20 && vb > 20 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -1;
      if (!best || score > best.score) best = { x: x0 + hw, y: y0 + hh, score };
    }
  }
  return best;
}

// The horizontal shift s of the whole middle of the picture: b(x) is about a(x + s). A click at
// x should make the picture move by (x - 0.5) * width, to the left for a click on the right.
function globalShift(a, b) {
  const y0 = Math.floor(H * 0.25), y1 = Math.floor(H * 0.75);
  const score = (s) => {
    const x0 = Math.max(Math.floor(W * 0.15), Math.floor(W * 0.15) - s), x1 = Math.min(Math.floor(W * 0.85), Math.floor(W * 0.85) - s);
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const va = a[y * W + x + s], vb = b[y * W + x];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
    }
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    return va > 1 && vb > 1 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -1;
  };
  let best = 0, bestScore = -2;
  for (let s = -250; s <= 250; s++) {
    const value = score(s);
    if (value > bestScore) { bestScore = value; best = s; }
  }
  return { shift: best, score: bestScore };
}

async function main() {
  const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-i", `srt://${IP}:5000?mode=caller&latency=200&connect_timeout=8000`,
    "-vf", `fps=2,scale=${W}:${H},format=gray`, "-f", "image2", "-update", "1", "-atomic_writing", "1", FRAME], { stdio: "inherit" });
  const helper = spawn("/p/vlc-rec-camera-linux_x64", ["--ip", IP, "--speed", "30"], { stdio: ["pipe", "pipe", "inherit"] });
  process.on("exit", () => { ffmpeg.kill("SIGKILL"); helper.kill("SIGKILL"); });

  const waiters = [];
  let buffer = "";
  helper.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      for (let i = 0; i < waiters.length; i++) if (waiters[i].name === event.event) { waiters.splice(i, 1)[0].resolve(event); break; }
    }
  });
  const command = (line, answer, timeout = 8000) => new Promise((resolve, reject) => {
    const entry = { name: answer, resolve };
    waiters.push(entry);
    setTimeout(() => { const i = waiters.indexOf(entry); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`no ${answer} for ${line}`)); } }, timeout);
    helper.stdin.write(line + "\n");
  });

  for (let i = 0; i < 60 && !fs.existsSync(FRAME); i++) await sleep(500);
  if (!fs.existsSync(FRAME)) throw new Error("no picture from the camera");
  await command("GET", "state");
  const start = await command("GET", "state");
  console.log(`start: pan ${start.pan}, tilt ${start.tilt}, zoom ${start.zoom}`);
  let totalZoom = 0;
  const results = [];
  try {
    for (const step of EXTRA_ZOOM) {
      if (step) {
        await command(`ZOOM ${step}`, "zoom");
        totalZoom += step;
        await sleep(4000);
      }
      const state = await command("GET", "state");
      for (const [x, y] of POINTS) {
        const before = await frame();
        const turned = await command(`CENTER ${x} ${y} ${W / H}`, "turned");
        await sleep(3500);
        const after = await frame();
        const found = findPatch(before, after, x * W, y * H);
        const global = globalShift(before, after);
        const fx = found.x / W, fy = found.y / H;
        const error = Math.hypot((fx - 0.5) * 100, (fy - 0.5) * 100 * H / W);
        results.push({ zoom: state.zoom, x, y, fx, fy, score: found.score, error });
        console.log(`zoom ${String(state.zoom).padStart(2)}  point (${x.toFixed(2)}, ${y.toFixed(2)}) turned ${turned.fromPan},${turned.fromTilt} -> ${turned.toPan},${turned.toTilt}  found at (${fx.toFixed(3)}, ${fy.toFixed(3)}) correlation ${found.score.toFixed(2)}  miss ${error.toFixed(1)} % of the width; whole picture moved ${global.shift} px (needed ${Math.round((x - 0.5) * W)}, correlation ${global.score.toFixed(2)})`);
        // Back to where it was, so that the next point starts from the same picture.
        await command(`NUDGE ${turned.toPan - turned.fromPan} ${turned.toTilt - turned.fromTilt}`, "nudged");
        await sleep(3000);
      }
    }
  } finally {
    if (totalZoom) await command(`ZOOM ${-totalZoom}`, "zoom").catch(() => {});
    await sleep(3000);
    helper.stdin.write("STOP\n");
  }
  const good = results.filter((r) => r.score > 0.6);
  const mean = good.reduce((sum, r) => sum + r.error, 0) / (good.length || 1);
  console.log(`\n${good.length} of ${results.length} points matched reliably; mean miss ${mean.toFixed(1)} % of the width (0 = exactly in the middle)`);
  process.exit(0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
