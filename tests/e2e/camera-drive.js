// Production adapter, loopback OSC only. No camera and no desktop window.
// node tests/e2e/camera-drive.js [path-to-adapter]
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { spawn } = require("node:child_process");
const path = require("node:path");
const binary = process.argv[2] || path.resolve(__dirname, `../../player/plugins/osc/osc-${process.platform === "win32" ? "win_x64.exe" : "linux_x64"}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bind = socket => new Promise(resolve => socket.bind(0, "127.0.0.1", resolve));
const string = value => { const b = Buffer.from(value + "\0"); return Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4)]); };
const packet = (name, values) => Buffer.concat([string(`/OBSBOT/WebCam/General/${name}`), string("," + "i".repeat(values.length)), ...values.map(v => { const b=Buffer.alloc(4); b.writeInt32BE(v); return b; })]);
function decode(data) {
  let offset = data.indexOf(0) + 1;
  const name = data.subarray(0, offset - 1).toString().split("/").pop();
  offset = (offset + 3) & ~3;
  const end = data.indexOf(0, offset);
  const count = end - offset - 1;
  offset = (end + 4) & ~3;
  return { name, values: Array.from({ length: count }, (_, i) => data.readInt32BE(offset + i * 4)) };
}
(async () => {
  const server = dgram.createSocket("udp4");
  const reserve = dgram.createSocket("udp4");
  await bind(server); await bind(reserve);
  const localPort = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const commands = [];
  server.on("message", (data) => {
    const message = decode(data);
    commands.push(message);
    if (message.name === "Connected") server.send(packet("ConnectedResp", [1]), localPort, "127.0.0.1");
  });
  let child;
  try {
    for (const ending of ["shutdown", "EOF"]) {
      commands.length = 0;
      child = spawn(binary, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`adapter exited ${code}`))); });
      let buffer = "", id = 0;
      const pending = new Map();
      child.stdout.on("data", data => {
        buffer += data;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const handler = pending.get(message.id);
          if (handler) { pending.delete(message.id); handler(message); }
        }
      });
      const request = (method, params = {}) => new Promise((resolve, reject) => {
        const next = ++id;
        const timer = setTimeout(() => reject(new Error(`No ${method} response`)), 3000);
        pending.set(next, message => { clearTimeout(timer); resolve(message); });
        child.stdin.write(JSON.stringify({ id: next, method, params }) + "\n");
      });
      const result = await request("connect", { config: { host: "127.0.0.1", oscPort: server.address().port, localPort } });
      assert.deepEqual(result.result.capabilities.ptz.continuous, { axes: "single", defaultSpeed: 0.2 });
      const motion = () => commands.filter(c => c.name.startsWith("SetGimbal"));
      const move = (pan, tilt = 0, ttl_ms = 300) => request("ptz.move", { pan, tilt, ttl_ms });
      await move(0.2); await sleep(100); await move(0.2); await sleep(100); await move(0.2); await sleep(100);
      assert.deepEqual(motion(), [{ name: "SetGimbalRight", values: [20] }], "heartbeats never restart the motor");
      await request("ptz.stop"); await sleep(60);
      assert.deepEqual(motion().at(-1), { name: "SetGimbalRight", values: [0] });
      const stoppedCount = motion().length;
      await request("ptz.stop"); await sleep(40);
      assert.equal(motion().length, stoppedCount, "stopping is idempotent");
      await move(0, 0.5);
      await move(-0.4);
      await sleep(50);
      assert.deepEqual(motion().slice(-2), [{ name: "SetGimbalUp", values: [50] }, { name: "SetGimbalLeft", values: [40] }], "changing axis must not append an unused zero command");
      assert.equal((await move(1,1)).error.code, "invalid_params");
      assert.equal((await move(1,0,10)).error.code, "invalid_params");
      await request("ptz.stop");
      await move(0,-0.25,200);
      child.stdin.write('{"id":999,"method":');
      await sleep(350);
      assert.deepEqual(motion().at(-1), { name: "SetGimbalRight", values: [0] }, "lease expires even with an incomplete input line");
      child.stdin.write("\n");
      await move(0.2);
      if (ending === "shutdown") await request("shutdown");
      else child.stdin.end();
      await exited; await sleep(50);
      assert.deepEqual(motion().slice(-2), [{ name: "SetGimbalRight", values: [20] }, { name: "SetGimbalRight", values: [0] }], `${ending} stops a held motor`);
      child = null;
    }
    console.log(`PASS: continuous drive, no duplicate starts, axis changes, validation, lease expiry with partial input, shutdown and EOF (${process.platform})`);
  } finally {
    if (child) child.kill();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
