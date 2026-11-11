// Tests player/vlc-rec-camera-linux_x64 against the fake OSC camera, in a container.
//   node tests/e2e/camera-helper.js
// Needs podman or docker and the built helper (npm run build:player, or the gcc line of
// native/build.sh). No camera, no window. The expected turn angles come from a second,
// independent implementation of the geometry written here.
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const IMAGE = "localhost/vlc-rec-e2e:1";
const tool = spawnSync("podman", ["--version"], { stdio: "ignore" }).error ? "docker" : "podman";

const HFOV = 80;
const RATIO = 12;
const ASPECT = 1920 / 1080;
const SPEED = 30;
const rad = Math.PI / 180;

// The readout counts the other way: Right and Up make the numbers smaller. tilt = A, pan = B.
function expectedTurn(x, y, aspect, tilt, pan, zoom) {
  const t = Math.tan(HFOV * rad / 2) / (1 + (RATIO - 1) * zoom / 100);
  const rx = (2 * x - 1) * t;
  const ry = (1 - 2 * y) * t / aspect;
  const phi = -tilt * rad;
  const dy = ry * Math.cos(phi) + Math.sin(phi);
  const dz = -ry * Math.sin(phi) + Math.cos(phi);
  const yaw = Math.atan2(rx, dz) / rad;
  const elevation = Math.atan2(dy, Math.hypot(rx, dz)) / rad;
  return { pan: Math.round(pan - yaw), tilt: Math.round(-elevation) };
}

const commands = [
  "GET",
  "CENTER 0.5 0.5 " + ASPECT,   // the middle: nothing to do
  "CENTER 1 0.5 " + ASPECT,     // right edge, middle row, level camera
  "CENTER 0.5 0 " + ASPECT,     // top middle
  "CENTER 1 0.5 " + ASPECT,     // right edge again, now with the camera pitched up
  "NUDGE 2 1",                  // right 2 and up 1 degree; builds on the last target
  "NUDGE -2 -1",                // and back
  "ZOOM 10", "ZOOM 10",         // the second builds on the first target
  "ZOOM -50",                   // clamps at 0
  "ZOOM 100",
  "CENTER 1 0.5 " + ASPECT,     // at the longest focal length the same point is a small turn
  "CENTER 2 0.5 " + ASPECT      // out of range: an error, no command
];

const script = [
  "python3 -I /repo/tools/camera/fake_osc_camera.py > /tmp/fake.log 2>&1 &",
  "sleep 0.5",
  `( ${commands.map((c) => `sleep 0.4; echo '${c}'`).join("; ")}; sleep 0.5 ) | ` +
    `/repo/player/vlc-rec-camera-linux_x64 --ip 127.0.0.1 --hfov ${HFOV} --zoom-ratio ${RATIO} --zoom-max 100 --speed ${SPEED} > /tmp/helper.out 2>&1`,
  // The defaults: the zoom of the Tail 2 stops at 36 whatever it is asked for, so targets stop there too.
  // (The fake camera is left at zoom 100 by the first run, so the second one starts by putting it back.)
  // The same run checks the speeds: CENTER at the default, after SPEED 5, and a NUDGE with its own.
  `( sleep 0.4; echo 'ZOOM -100'; sleep 0.4; echo 'ZOOM 100'; sleep 0.4; echo 'ZOOM 100'; sleep 0.4; echo 'ZOOM -100'; ` +
    `sleep 0.4; echo 'CENTER 1 0.5 ${ASPECT}'; sleep 0.4; echo 'SPEED 5'; sleep 0.4; echo 'CENTER 0 0.5 ${ASPECT}'; ` +
    `sleep 0.4; echo 'NUDGE 2 0'; sleep 0.4; echo 'SPEED 0'; sleep 0.5 ) | ` +
    "/repo/player/vlc-rec-camera-linux_x64 --ip 127.0.0.1 > /tmp/helper2.out 2>&1",
  "echo '=====HELPER====='; cat /tmp/helper.out; echo '=====FAKE====='; cat /tmp/fake.log; echo '=====HELPER2====='; cat /tmp/helper2.out"
].join("\n");

const result = spawnSync(tool, ["run", "--rm", "--network", "none", "-v", `${repo}:/repo:ro`, IMAGE, "bash", "-c", script],
  { encoding: "utf8" });
const out = result.stdout + result.stderr;
if (process.env.SHOW) console.log(out);
const [, rest = ""] = out.split("=====HELPER=====");
const [helperText, afterHelper = ""] = rest.split("=====FAKE=====");
const [fakeText, helper2Text = ""] = afterHelper.split("=====HELPER2=====");
assert.ok(fakeText, `no output:\n${out}`);
const events = helperText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const fakeLog = fakeText.split("\n").filter((l) => l.startsWith("recv "));
const near = (actual, wanted, what) => assert.ok(Math.abs(actual - wanted) <= 1, `${what}: ${actual}, expected ${wanted}`);
const names = fakeLog.map((l) => l.split(" ")[1].split("/").pop());

assert.equal(events[0].event, "ready");
assert.equal(events[0].answered, true);
assert.deepEqual(events.find((e) => e.event === "state"), { event: "state", pan: 0, tilt: 0, zoom: 0 });

const turned = events.filter((e) => e.event === "turned");
assert.equal(turned.length, 5);
assert.equal(turned[0].moved, false, "the middle needs no turn");

const right = expectedTurn(1, 0.5, ASPECT, 0, 0, 0);
near(turned[1].toPan, right.pan, "right edge, pan");
near(turned[1].toTilt, right.tilt, "right edge, tilt");
assert.ok(turned[1].toPan < -35, "a point on the right means smaller pan values");

const top = expectedTurn(0.5, 0, ASPECT, turned[1].toTilt, turned[1].toPan, 0);
near(turned[2].toPan, top.pan, "top middle, pan");
near(turned[2].toTilt, top.tilt, "top middle, tilt");
assert.ok(turned[2].toTilt < -20, "a point above the middle means smaller tilt values");

// With the camera pitched up, the edge of the middle row lies lower in the world than the
// camera's own axis: the elevation to aim at is smaller, so the tilt value is larger.
const pitched = expectedTurn(1, 0.5, ASPECT, turned[2].toTilt, turned[2].toPan, 0);
near(turned[3].toPan, pitched.pan, "pitched camera, pan");
near(turned[3].toTilt, pitched.tilt, "pitched camera, tilt");
assert.ok(turned[3].toTilt > turned[2].toTilt, "turning to the side lowers the aim");

// At zoom 100 the same screen point is a much smaller turn.
const zoomed = expectedTurn(1, 0.5, ASPECT, turned[3].toTilt, turned[3].toPan, 100);
near(turned[4].toPan, zoomed.pan, "zoomed, pan");
near(turned[4].toTilt, zoomed.tilt, "zoomed, tilt");
assert.equal(turned[4].zoom, 100);
assert.ok(Math.abs(turned[4].toPan - turned[3].toPan) < 6, "a small turn at the longest focal length");

// Nudges: right 2 and up 1 (both numbers smaller), then back.
const nudged = events.filter((e) => e.event === "nudged");
assert.equal(nudged.length, 2);
assert.equal(nudged[0].toPan, turned[3].toPan - 2);
assert.equal(nudged[0].toTilt, turned[3].toTilt - 1);
assert.equal(nudged[1].toPan, turned[3].toPan);
assert.equal(nudged[1].toTilt, turned[3].toTilt);

// Zoom steps build on the last target, the third one clamps at 0.
const zoomEvents = events.filter((e) => e.event === "zoom");
assert.deepEqual(zoomEvents.map((e) => [e.from, e.to]), [[0, 10], [10, 20], [20, 0], [0, 100]]);

// No readout between a move command and a nudge, none between two zoom commands.
const turnIdx = names.map((n, i) => (n === "SetGimMotorDegree" ? i : -1)).filter((i) => i >= 0);
assert.equal(turnIdx.length, 9, "first run: four turns that moved, two nudges, none for the middle; second run: two turns and a nudge");
const between = (a, b, name) => names.slice(a + 1, b).includes(name);
// turnIdx: right, top, pitched, nudge, nudge back, zoomed.
assert.ok(!between(turnIdx[2], turnIdx[3], "GetGimbalPosInfo"), "the nudge builds on the target, not a readout");
assert.ok(!between(turnIdx[3], turnIdx[4], "GetGimbalPosInfo"), "the second nudge too");
const zoomIdx = names.map((n, i) => (n === "SetZoom" ? i : -1)).filter((i) => i >= 0);
assert.ok(!between(zoomIdx[0], zoomIdx[1], "GetZoomInfo"), "the second zoom builds on the first target");

assert.ok(events.some((e) => e.event === "error" && e.code === "bad-command"), "out of range CENTER is refused");
const turnLines = fakeLog.filter((l) => l.includes("SetGimMotorDegree"));
assert.ok(turnLines.slice(0, 6).every((l) => l.includes(`[${SPEED}, `)), "the speed is passed on, for turns and nudges alike");
// Second run: default speed 10 for CENTER, 5 after SPEED 5, and NUDGE keeps its own 30.
assert.deepEqual(turnLines.slice(6).map((l) => JSON.parse(l.replace(/^.*SetGimMotorDegree /, ""))[0]), [10, 5, 30]);
// The default zoom range ends at 36: asking for more does not plan beyond it.
const zoom2 = helper2Text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.event === "zoom");
assert.deepEqual(zoom2.map((e) => [e.from, e.to]), [[100, 0], [0, 36], [36, 36], [36, 0]]);
const speeds2 = helper2Text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
assert.deepEqual(speeds2.filter((e) => e.event === "speed"), [{ event: "speed", value: 5 }]);
assert.ok(speeds2.some((e) => e.event === "error" && e.code === "bad-command"), "SPEED 0 is refused");
console.log("camera helper test passed");
