// Tests the obsbot-tail2 adapter (player/plugins/obsbot-tail2) against the fake OSC camera, in a container.
//   node tests/e2e/camera-plugin.js
// Needs podman or docker and the built adapter (npm run build:player, or the gcc lines for the
// plugin in native/build.sh). No camera, no window. The expected turn angles come from a second,
// independent implementation of the geometry written here.
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const IMAGE = "localhost/vlc-rec-e2e:1";
const tool = spawnSync("podman", ["--version"], { stdio: "ignore" }).error ? "docker" : "podman";
const PLUGIN = "/repo/player/plugins/obsbot-tail2/obsbot-tail2-linux_x64";

const HFOV = 80;
const RATIO = 12;
const ASPECT = 1920 / 1080;
const SPEED = 30;
const rad = Math.PI / 180;

// The camera counts the other way: Right and Up make the numbers smaller. tilt = A, pan = B.
// This returns the target in the camera's numbers; the adapter reports degrees with right and up
// positive, so an event carries the negative of it.
function expectedTurn(x, y, aspect, tilt, pan, zoomUnits) {
  const t = Math.tan(HFOV * rad / 2) / (1 + (RATIO - 1) * zoomUnits / 100);
  const rx = (2 * x - 1) * t;
  const ry = (1 - 2 * y) * t / aspect;
  const phi = -tilt * rad;
  const dy = ry * Math.cos(phi) + Math.sin(phi);
  const dz = -ry * Math.sin(phi) + Math.cos(phi);
  const yaw = Math.atan2(rx, dz) / rad;
  const elevation = Math.atan2(dy, Math.hypot(rx, dz)) / rad;
  return { pan: Math.round(pan - yaw), tilt: Math.round(-elevation) };
}

// A run is a list of requests; each gets the next id, so response i belongs to request i + 1.
const request = (method, params) => ({ method, params });
const run1 = [
  request("hello", { interface: 1 }),
  request("connect", { config: { host: "127.0.0.1", hfov: HFOV, zoomRatio: RATIO, zoomMax: 100, nudgeSpeed: SPEED } }),
  request("ptz.setSpeed", { value: SPEED }),
  request("ptz.get", {}),
  request("zoom.get", {}),
  request("ptz.centerOn", { x: 0.5, y: 0.5, aspect: ASPECT }),   // the middle: nothing to do
  request("ptz.centerOn", { x: 1, y: 0.5, aspect: ASPECT }),     // right edge, middle row, level camera
  request("ptz.centerOn", { x: 0.5, y: 0, aspect: ASPECT }),     // top middle
  request("ptz.centerOn", { x: 1, y: 0.5, aspect: ASPECT }),     // right edge again, now with the camera pitched up
  request("ptz.nudge", { pan: 2, tilt: 1 }),                     // right 2 and up 1 degree; builds on the last target
  request("ptz.nudge", { pan: -2, tilt: -1 }),                   // and back
  request("zoom.by", { delta: 0.1 }), request("zoom.by", { delta: 0.1 }), // the second builds on the first target
  request("zoom.by", { delta: -0.5 }),                           // clamps at 0
  request("zoom.by", { delta: 1 }),
  request("ptz.centerOn", { x: 1, y: 0.5, aspect: ASPECT }),     // at the longest focal length the same point is a small turn
  request("ptz.centerOn", { x: 2, y: 0.5, aspect: ASPECT }),     // out of range: an error, no command
  request("zoom.by", { delta: -1 }),                             // the next run starts at zoom 0
  request("shutdown", {})
];
// The defaults: the zoom of the Tail 2 stops at 36 whatever it is asked for, so targets stop there too.
// The same run checks the speeds: ptz.centerOn at the default, after ptz.setSpeed 5, and ptz.nudge with its own.
const run2 = [
  request("connect", { config: { host: "127.0.0.1" } }),
  request("zoom.by", { delta: 1 }), request("zoom.by", { delta: 1 }), request("zoom.by", { delta: -1 }),
  request("ptz.centerOn", { x: 1, y: 0.5, aspect: ASPECT }),
  request("ptz.setSpeed", { value: 5 }),
  request("ptz.centerOn", { x: 0, y: 0.5, aspect: ASPECT }),
  request("ptz.nudge", { pan: 2, tilt: 0 }),
  request("ptz.setSpeed", { value: 0 }),
  request("shutdown", {})
];
// Refusals: nothing works before connect, a bad config and an unreachable camera are told apart.
const run3 = [
  request("ptz.nudge", { pan: 1, tilt: 0 }),
  request("connect", { config: { host: "camera.local" } }),
  request("connect", { config: { host: "127.0.0.1", hfov: 500 } }),
  request("connect", { config: { host: "127.0.0.2" } }),
  request("bogus.method", {}),
  request("hello", { interface: 1 }),
  request("shutdown", {})
];

// Absolute moves, for presets: what ptz.get and zoom.get answer is where the camera is going, too.
const run4 = [
  request("connect", { config: { host: "127.0.0.1" } }),
  request("ptz.moveTo", { pan: -20, tilt: 10 }),
  request("ptz.get", {}),
  request("ptz.moveTo", { pan: 400, tilt: 0 }),
  request("zoom.set", { value: 0.5 }),
  request("zoom.get", {}),
  request("zoom.set", { value: 1.5 }),
  request("ptz.moveTo", { pan: 0, tilt: 0 }),
  request("zoom.set", { value: 0 }),
  request("shutdown", {})
];

const lines = (requests) => requests.map((r, i) => JSON.stringify({ id: i + 1, ...r }));
const feed = (requests, pause) => `( ${lines(requests).map((l) => `sleep ${pause}; echo '${l}'`).join("; ")}; sleep 0.5 )`;

const script = [
  "python3 -I /repo/tools/camera/fake_osc_camera.py > /tmp/fake.log 2>&1 &",
  "sleep 0.5",
  `${feed(run1, 0.4)} | ${PLUGIN} > /tmp/plugin1.out 2>&1`,
  `${feed(run2, 0.4)} | ${PLUGIN} > /tmp/plugin2.out 2>&1`,
  `${feed(run3, 0.2)} | ${PLUGIN} > /tmp/plugin3.out 2>&1`,
  `${feed(run4, 0.4)} | ${PLUGIN} > /tmp/plugin4.out 2>&1`,
  "echo '=====FAKE====='; cat /tmp/fake.log; echo '=====PLUGIN1====='; cat /tmp/plugin1.out; echo '=====PLUGIN2====='; cat /tmp/plugin2.out; echo '=====PLUGIN3====='; cat /tmp/plugin3.out; echo '=====PLUGIN4====='; cat /tmp/plugin4.out"
].join("\n");

const result = spawnSync(tool, ["run", "--rm", "--network", "none", "-v", `${repo}:/repo:ro`, IMAGE, "bash", "-c", script],
  { encoding: "utf8" });
if (result.error) throw result.error;
const out = (result.stdout || "") + (result.stderr || "");
assert.equal(result.status, 0, `${tool} failed:\n${out}`);
if (process.env.SHOW) console.log(out);
const section = (name, next) => {
  const start = out.indexOf(`=====${name}=====`);
  assert.ok(start >= 0, `no ${name} section:\n${out}`);
  const end = next ? out.indexOf(`=====${next}=====`) : out.length;
  return out.slice(start + name.length + 10, end);
};
const parse = (text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const fakeLog = section("FAKE", "PLUGIN1").split("\n").filter((l) => l.startsWith("recv "));
const messages1 = parse(section("PLUGIN1", "PLUGIN2"));
const messages2 = parse(section("PLUGIN2", "PLUGIN3"));
const messages3 = parse(section("PLUGIN3", "PLUGIN4"));
const messages4 = parse(section("PLUGIN4"));
const near = (actual, wanted, what) => assert.ok(Math.abs(actual - wanted) <= 1, `${what}: ${actual}, expected ${wanted}`);
const names = fakeLog.map((l) => l.split(" ")[1].split("/").pop());
const events = (messages, name) => messages.filter((m) => m.event === name);
const response = (messages, id) => messages.find((m) => m.id === id);

// ---- the handshake and the capabilities ----
assert.deepEqual(response(messages1, 1).result, { interface: 1, plugin: { id: "obsbot-tail2", name: "OBSBOT Tail 2", version: "0.1.0" } });
const caps = response(messages1, 2).result.capabilities;
assert.equal(caps.device.model, "OBSBOT Tail 2");
assert.equal(caps.device.address, "127.0.0.1");
assert.equal(caps.ptz.centerOn, "estimated");
assert.equal(caps.ptz.nudge, true);
assert.equal(caps.ptz.absolute, true, "ptz.get and ptz.moveTo");
assert.equal(caps.zoom.absolute, true, "zoom.get and zoom.set");
assert.deepEqual(caps.ptz.speed, { min: 1, max: 90, default: 10, unit: "deg/s" });
assert.deepEqual(caps.zoom, { by: true, absolute: true });
assert.equal(caps.webPage.url, "http://127.0.0.1/");
assert.deepEqual(events(messages1, "state")[0], { event: "state", state: "connected" });
assert.deepEqual(response(messages1, 4).result, { pan: 0, tilt: 0 });
assert.deepEqual(response(messages1, 5).result, { value: 0 });
for (let id = 1; id <= run1.length; id++) {
  assert.ok(response(messages1, id), `request ${id} (${run1[id - 1].method}) got a response`);
}

// ---- turns ----
const turned = events(messages1, "turned");
assert.equal(turned.length, 5);
assert.equal(turned[0].moved, false, "the middle needs no turn");

const right = expectedTurn(1, 0.5, ASPECT, 0, 0, 0);
near(-turned[1].toPan, right.pan, "right edge, pan");
near(-turned[1].toTilt, right.tilt, "right edge, tilt");
assert.ok(turned[1].toPan > 35, "a point on the right is a positive pan");

const top = expectedTurn(0.5, 0, ASPECT, -turned[1].toTilt, -turned[1].toPan, 0);
near(-turned[2].toPan, top.pan, "top middle, pan");
near(-turned[2].toTilt, top.tilt, "top middle, tilt");
assert.ok(turned[2].toTilt > 20, "a point above the middle is a positive tilt");

// With the camera pitched up, the edge of the middle row lies lower in the world than the
// camera's own axis: the elevation to aim at is smaller.
const pitched = expectedTurn(1, 0.5, ASPECT, -turned[2].toTilt, -turned[2].toPan, 0);
near(-turned[3].toPan, pitched.pan, "pitched camera, pan");
near(-turned[3].toTilt, pitched.tilt, "pitched camera, tilt");
assert.ok(turned[3].toTilt < turned[2].toTilt, "turning to the side lowers the aim");

// At the longest focal length the same screen point is a much smaller turn.
const zoomed = expectedTurn(1, 0.5, ASPECT, -turned[3].toTilt, -turned[3].toPan, 100);
near(-turned[4].toPan, zoomed.pan, "zoomed, pan");
near(-turned[4].toTilt, zoomed.tilt, "zoomed, tilt");
assert.equal(turned[4].zoom, 1);
assert.ok(Math.abs(turned[4].toPan - turned[3].toPan) < 6, "a small turn at the longest focal length");
assert.ok(turned[1].durationMs > 0 && turned[0].durationMs === 0, "a turn says how long it takes");

// ---- nudges: right 2 and up 1, then back ----
const nudged = events(messages1, "nudged");
assert.equal(nudged.length, 2);
assert.equal(nudged[0].toPan, turned[3].toPan + 2);
assert.equal(nudged[0].toTilt, turned[3].toTilt + 1);
assert.equal(nudged[1].toPan, turned[3].toPan);
assert.equal(nudged[1].toTilt, turned[3].toTilt);

// ---- zoom steps build on the last target, the third one clamps at 0 ----
assert.deepEqual(events(messages1, "zoom").map((e) => [e.from, e.to]), [[0, 0.1], [0.1, 0.2], [0.2, 0], [0, 1], [1, 0]]);

// No readout between a move command and a nudge, none between two zoom commands.
const turnIdx = names.map((n, i) => (n === "SetGimMotorDegree" ? i : -1)).filter((i) => i >= 0);
assert.equal(turnIdx.length, 11, "first run: four turns that moved, two nudges, none for the middle; second run: two turns and a nudge; fourth run: two absolute turns");
const between = (a, b, name) => names.slice(a + 1, b).includes(name);
// turnIdx: right, top, pitched, nudge, nudge back, zoomed.
assert.ok(!between(turnIdx[2], turnIdx[3], "GetGimbalPosInfo"), "the nudge builds on the target, not a readout");
assert.ok(!between(turnIdx[3], turnIdx[4], "GetGimbalPosInfo"), "the second nudge too");
const zoomIdx = names.map((n, i) => (n === "SetZoom" ? i : -1)).filter((i) => i >= 0);
assert.ok(!between(zoomIdx[0], zoomIdx[1], "GetZoomInfo"), "the second zoom builds on the first target");

// ---- errors come as responses ----
const refused = response(messages1, 16 + 1);
assert.equal(refused.error.code, "invalid_params", "out of range ptz.centerOn is refused");
const turnLines = fakeLog.filter((l) => l.includes("SetGimMotorDegree"));
assert.ok(turnLines.slice(0, 6).every((l) => l.includes(`[${SPEED}, `)), "the speed is passed on, for turns and nudges alike");
// Second run: default speed 10 for ptz.centerOn, 5 after ptz.setSpeed 5, and ptz.nudge keeps its own 30.
assert.deepEqual(turnLines.slice(6, 9).map((l) => JSON.parse(l.replace(/^.*SetGimMotorDegree /, ""))[0]), [10, 5, 30]);
// The default zoom range ends at 36: asking for more does not plan beyond it.
assert.deepEqual(events(messages2, "zoom").map((e) => [e.from, e.to]), [[0, 1], [1, 1], [1, 0]]);
assert.deepEqual(events(messages2, "speed"), [{ event: "speed", value: 5 }]);
assert.equal(response(messages2, 9).error.code, "invalid_params", "ptz.setSpeed 0 is refused");
assert.equal(response(messages2, 10).result && Object.keys(response(messages2, 10).result).length, 0, "shutdown is answered");
assert.equal(messages2.at(-1).event, "stopped");

// ---- absolute moves: the numbers go to the camera with the signs turned round ----
const moved = events(messages4, "turned");
assert.equal(moved.length, 2);
// The fake camera is where the earlier runs left it; the speed is the default 10 degrees per second.
assert.deepEqual([moved[0].moved, moved[0].toPan, moved[0].toTilt], [true, -20, 10]);
assert.equal(moved[0].durationMs, Math.max(Math.abs(-20 - moved[0].fromPan), Math.abs(10 - moved[0].fromTilt)) * 100);
assert.deepEqual(response(messages4, 3).result, { pan: -20, tilt: 10 }, "ptz.get answers with the target while the camera is on its way");
assert.equal(response(messages4, 4).error.code, "invalid_params", "a pan of 400 degrees");
assert.deepEqual(events(messages4, "zoom").map((e) => [e.from, e.to]), [[0, 0.5], [0.5, 0]]);
assert.deepEqual(response(messages4, 6).result, { value: 0.5 }, "zoom.get answers with the target too");
assert.equal(response(messages4, 7).error.code, "invalid_params", "a zoom of 1.5");
assert.deepEqual(turnLines.slice(9).map((l) => JSON.parse(l.replace(/^.*SetGimMotorDegree /, ""))), [[10, 20, -10], [10, 0, 0]],
  "right and up positive in the interface, the other way for the camera");
assert.ok(fakeLog.some((l) => /SetZoom \[18\]/.test(l)), "half of the range 36 is 18 units");

// ---- refusals ----
assert.equal(response(messages3, 1).error.code, "not_connected", "nothing works before connect");
assert.equal(response(messages3, 2).error.code, "invalid_params", "a host name is not an address");
assert.equal(response(messages3, 3).error.code, "invalid_params", "a field of view out of range");
assert.equal(response(messages3, 4).error.code, "timeout", "a camera that does not answer");
assert.match(response(messages3, 4).error.message, /did not answer/);
assert.equal(response(messages3, 5).error.code, "unsupported");
assert.ok(response(messages3, 6).result, "hello works at any time");
console.log("camera plugin test passed");
