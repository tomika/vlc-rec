"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const fixture = fs.readFileSync(path.join(__dirname, "preview-decoder.hevc"));
const accessUnits = splitAccessUnits(fixture);
let input = "";
let previewServer = null;
let previewSocket = null;
let frameTimer = null;
let sessionToken = "";
let frameNumber = 0;
let cameraRecording = false;
let cameraPowerOn = true;
let cameraZoom = 0.25;
let cameraFormatStartedAt = 0;

function splitAccessUnits(bytes) {
  const nals = [];
  for (let i = 0; i + 4 < bytes.length;) {
    let prefix = 0;
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) prefix = 3;
    else if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) prefix = 4;
    if (!prefix) { i++; continue; }
    nals.push({ start: i, type: (bytes[i + prefix] >> 1) & 63 });
    i += prefix;
  }

  const starts = [0];
  let hasPicture = false;
  for (const nal of nals) {
    if (nal.type === 32 && hasPicture) {
      starts.push(nal.start);
      hasPicture = false;
    }
    if (nal.type <= 31) hasPicture = true;
  }
  starts.push(bytes.length);
  return starts.slice(0, -1).map((start, i) => bytes.subarray(start, starts[i + 1]));
}

if (accessUnits.length !== 3) throw new Error("Preview fixture must contain exactly three HEVC access units");

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function event(type, value = {}) {
  process.stdout.write(`${JSON.stringify({ event: type, ...value })}\n`);
}

function websocketFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendPicture() {
  if (!previewSocket || previewSocket.destroyed) return;
  const timestamp = frameNumber * 33333;
  const meta = {
    type: "frame",
    timestamp,
    key: true,
    tracking: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
  };
  const accessUnit = accessUnits[frameNumber++ % accessUnits.length];
  previewSocket.write(websocketFrame(1, JSON.stringify(meta)));
  previewSocket.write(websocketFrame(2, accessUnit));
}

function parseClientFrames(socket) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const first = pending[0];
      const second = pending[1];
      let headerLength = 2;
      let payloadLength = second & 0x7f;
      if (payloadLength === 126) {
        if (pending.length < 4) return;
        payloadLength = pending.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (pending.length < 10) return;
        const extendedLength = pending.readBigUInt64BE(2);
        if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) { socket.destroy(); return; }
        payloadLength = Number(extendedLength);
        headerLength = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (payloadLength > 1024 * 1024) { socket.destroy(); return; }
      const frameLength = headerLength + maskLength + payloadLength;
      if (pending.length < frameLength) return;
      const opcode = first & 0x0f;
      const payloadOffset = headerLength + maskLength;
      let payload = pending.subarray(payloadOffset, frameLength);
      if (masked) {
        const mask = pending.subarray(headerLength, payloadOffset);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      pending = pending.subarray(frameLength);
      if (opcode === 8) { closePreview(); return; }
      if (opcode === 9) socket.write(websocketFrame(10, payload));
    }
  };
}

function closePreview() {
  clearInterval(frameTimer);
  frameTimer = null;
  const socket = previewSocket;
  previewSocket = null;
  if (socket && !socket.destroyed) {
    socket.write(websocketFrame(8));
    socket.end();
  }
  const server = previewServer;
  previewServer = null;
  sessionToken = "";
  if (server) server.close();
}

function openPreview(id) {
  closePreview();
  sessionToken = crypto.randomBytes(32).toString("hex");
  const token = sessionToken;
  const server = previewServer = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (request.url !== `/${token}` || !key || previewServer !== server) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    previewSocket = socket;
    frameNumber = 0;
    sendPicture();
    frameTimer = setInterval(sendPicture, 250);
    socket.on("data", parseClientFrames(socket));
    socket.on("close", () => {
      if (previewSocket === socket) closePreview();
    });
    socket.on("error", () => {
      if (previewSocket === socket) closePreview();
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    reply(id, {
      url: `ws://127.0.0.1:${address.port}/${token}`,
      format: "hevc-annexb-v1",
      codec: "hev1.1.6.L93.B0",
      width: 64,
      height: 64
    });
  });
  server.on("error", (error) => {
    event("error", { message: `Browser preview fixture failed: ${error.message}` });
  });
}

function handle(request) {
  const { id, method } = request;
  switch (method) {
    case "hello":
      return reply(id, { interface: 1, plugin: { id: "camera-preview" } });
    case "connect":
      return reply(id, { capabilities: {
        device: { model: "Browser Preview Test Fixture" },
        preview: { format: "hevc-annexb-v1" },
        zoom: { absolute: true },
        telemetry: { pollMs: 500, battery: true, storage: true, recording: true, power: true },
        record: { start: true, stop: true },
        power: { on: true, off: true, mode: "remote" },
        storage: { format: true }
      } });
    case "preview.open":
      return openPreview(id);
    case "preview.close":
      closePreview();
      return reply(id, {});
    case "telemetry.get":
      {
        const elapsed = cameraFormatStartedAt ? Date.now() - cameraFormatStartedAt : Infinity;
        const formatting = elapsed < 1800;
        const status = elapsed < 700 ? "preparing" : elapsed < 1800 ? "initializing" : "ready";
        return reply(id, {
          fresh: true,
          battery: { present: true, level: 0.75, charging: false },
          storage: {
            status: status === "preparing" || status === "initializing" ? status : "ready",
            format: "fixture", totalBytes: 1000000, freeBytes: 750000, remainingSeconds: 3600,
            formatting, formatCompleted: cameraFormatStartedAt > 0 && !formatting, formatFailed: false
          },
          recording: cameraRecording,
          power: { on: cameraPowerOn },
          zoom: { value: cameraZoom }
        });
      }
    case "zoom.get":
      return reply(id, { value: cameraZoom });
    case "zoom.set":
      if (!Number.isFinite(request.params?.value) || request.params.value < 0 || request.params.value > 1) {
        return process.stdout.write(`${JSON.stringify({ id, error: { code: "invalid_params", message: "zoom.set needs a value from 0 to 1." } })}\n`);
      }
      cameraZoom = request.params.value;
      return reply(id, {});
    case "record.start":
      cameraRecording = true;
      return reply(id, { accepted: true });
    case "record.stop":
      cameraRecording = false;
      return reply(id, { accepted: true });
    case "power.set":
      cameraPowerOn = request.params?.on === true;
      return reply(id, { accepted: true });
    case "storage.format":
      if (request.params?.confirmed !== true) {
        return process.stdout.write(`${JSON.stringify({ id, error: { code: "invalid_params", message: "storage.format requires confirmation." } })}\n`);
      }
      cameraFormatStartedAt = Date.now();
      return reply(id, { accepted: true });
    case "shutdown":
      closePreview();
      reply(id, {});
      setTimeout(() => process.exit(0), 20);
      return;
    default:
      return process.stdout.write(`${JSON.stringify({ id, error: { code: "unsupported", message: `Unsupported method: ${method}` } })}\n`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch (error) { event("error", { message: `Adapter fixture error: ${error.message}` }); }
  }
});
process.stdin.on("end", closePreview);
