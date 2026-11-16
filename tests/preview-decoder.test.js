const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createContext, runInContext } = require('node:vm');
const { test } = require('node:test');

const decoderDir = path.resolve(__dirname, '../src/frontend/preview-decoder');
const workerSource = readFileSync(path.join(decoderDir, 'worker.js'), 'utf8');
const fixture = readFileSync(path.join(__dirname, 'fixtures/preview-decoder.hevc'));

function accessUnits(bytes) {
  const nals = [];
  for (let i = 0; i + 4 < bytes.length;) {
    let prefix = 0;
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) prefix = 3;
    else if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) prefix = 4;
    if (!prefix) { i++; continue; }
    nals.push({ start: i, prefix, type: (bytes[i + prefix] >> 1) & 63 });
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

function workerHarness() {
  const messages = [];
  const context = createContext({
    URL,
    BigInt,
    Uint8Array,
    ArrayBuffer,
    Number,
    Error,
    console,
    setTimeout,
    clearTimeout,
    location: { href: `file:///${path.join(decoderDir, 'worker.js').replace(/\\/g, '/')}` },
    importScripts() {
      context.createLibde265 = require(path.join(decoderDir, 'libde265.js'));
    },
    postMessage(message) { messages.push(message); },
    close() { context.didClose = true; },
  });
  context.self = context;
  runInContext(workerSource, context, { filename: 'preview-decoder/worker.js' });
  return { context, messages };
}

test('bundled libde265 worker decodes synthetic Annex B frames and handles its lifecycle', async () => {
  const units = accessUnits(fixture);
  assert.equal(units.length, 3, 'the checked-in synthetic fixture must contain three access units');

  const { context, messages } = workerHarness();
  await context.onmessage({ data: { type: 'init' } });
  assert.equal(messages.filter((message) => message.type === 'ready').length, 1);

  const timestamps = [0, 33333, 66666];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const data = unit.buffer.slice(unit.byteOffset, unit.byteOffset + unit.byteLength);
    await context.onmessage({ data: { type: 'decode', data, timestamp: timestamps[i] } });
  }

  const frames = messages.filter((message) => message.type === 'frame');
  assert.equal(messages.filter((message) => message.type === 'decoded').length, 3);
  assert.deepEqual(frames.map(({ width, height, timestamp, data }) => [width, height, timestamp, data.byteLength]), [
    [64, 64, 0, 64 * 64 * 4],
    [64, 64, 33333, 64 * 64 * 4],
    [64, 64, 66666, 64 * 64 * 4],
  ]);
  const hashes = frames.map(({ data }) => {
    const pixels = new Uint8Array(data);
    assert.equal(pixels[3], 255, 'RGBA alpha must be opaque');
    assert.ok(pixels.some((value) => value !== 0), 'RGBA pixels must contain decoded image data');
    return Buffer.from(pixels).toString('hex');
  });
  assert.equal(new Set(hashes).size, 3, 'the three synthetic source frames should be distinct');

  await context.onmessage({ data: { type: 'reset' } });
  const keyUnit = units[0];
  await context.onmessage({ data: {
    type: 'decode',
    data: keyUnit.buffer.slice(keyUnit.byteOffset, keyUnit.byteOffset + keyUnit.byteLength),
    timestamp: 99999,
  } });
  assert.equal(messages.filter((message) => message.type === 'decoded').length, 4);
  assert.ok(messages.some((message) => message.type === 'frame' && message.timestamp === 99999));

  await context.onmessage({ data: { type: 'close' } });
  assert.equal(context.didClose, true);
  assert.equal(messages.some((message) => message.type === 'error'), false);
});
