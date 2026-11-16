/* Incremental Annex B HEVC worker. One decode message is one complete access unit. */
let modulePromise;
let moduleInstance;
let decoder;

function loadModule() {
  if (!modulePromise) {
    importScripts('./libde265.js');
    modulePromise = createLibde265({ locateFile: (name) => new URL(name, self.location.href).href })
      .then((mod) => { moduleInstance = mod; return mod; });
  }
  return modulePromise;
}

function errorText(code) {
  try { return moduleInstance.UTF8ToString(moduleInstance._h265_error_text(code)); }
  catch (_) { return `libde265 error ${code}`; }
}

function drainFrames(timestamp) {
  const mod = moduleInstance;
  const wPtr = mod._malloc(4);
  const hPtr = mod._malloc(4);
  const ptsPtr = mod._malloc(8);
  try {
    while (true) {
      const framePtr = mod._h265_next_frame(decoder, wPtr, hPtr, ptsPtr);
      if (!framePtr) break;
      if (framePtr === 1) throw new Error('The HEVC stream uses an unsupported or oversized picture.');
      try {
        const width = mod.getValue(wPtr, 'i32');
        const height = mod.getValue(hPtr, 'i32');
        const pixels = new Uint8Array(mod.HEAPU8.subarray(framePtr, framePtr + width * height * 4));
        const pts = Number(mod.getValue(ptsPtr, 'i64'));
        self.postMessage({ type: 'frame', width, height, data: pixels.buffer, timestamp: Number.isSafeInteger(pts) ? pts : timestamp }, [pixels.buffer]);
      } finally {
        mod._h265_release_frame(framePtr);
      }
    }
  } finally {
    mod._free(wPtr);
    mod._free(hPtr);
    mod._free(ptsPtr);
  }
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      const mod = await loadModule();
      decoder = mod._h265_create();
      if (!decoder) throw new Error('Could not allocate the HEVC decoder');
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'decode') {
      if (!decoder) throw new Error('Decoder is not initialized');
      const mod = moduleInstance;
      const data = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
      const ptr = mod._malloc(data.byteLength);
      try {
        mod.HEAPU8.set(data, ptr);
        const pts = BigInt(Math.trunc(Number(msg.timestamp) || 0));
        const result = mod._h265_decode(decoder, ptr, data.byteLength, pts);
        if (result !== 0) throw new Error(errorText(result));
      } finally {
        mod._free(ptr);
      }
      drainFrames(Number(msg.timestamp) || 0);
      self.postMessage({ type: 'decoded', timestamp: Number(msg.timestamp) || 0 });
    } else if (msg.type === 'reset') {
      if (decoder) moduleInstance._h265_reset(decoder);
    } else if (msg.type === 'close') {
      if (decoder) moduleInstance._h265_destroy(decoder);
      decoder = undefined;
      self.close();
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error && error.message || error) });
  }
};
