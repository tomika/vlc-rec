// Protocol-only test fixture: no device, vendor API or network transport.
const readline = require("node:readline");
let enabled = false;
const reply = (id, result) => console.log(JSON.stringify({ id, result }));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "hello") return reply(id, { interface: 1, plugin: { id: "camera-ai", name: "Test camera", version: "1.0.0" } });
  if (method === "connect") return reply(id, { capabilities: { device: { model: "Test camera" }, ai: { trackPerson: true, status: true, stop: true } } });
  if (method === "shutdown") { reply(id, {}); process.exit(0); }
  if (method === "ai.trackPerson") { enabled = true; return reply(id, {}); }
  if (method === "ai.stop") { enabled = false; return reply(id, {}); }
  if (method === "ai.get") return reply(id, { enabled });
  console.log(JSON.stringify({ id, error: { code: "unsupported", message: "Unsupported test method" } }));
});
