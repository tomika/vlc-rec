# Browser HEVC preview decoder

This worker uses the independently developed [libde265](https://github.com/strukturag/libde265) decoder. It accepts complete HEVC Annex B access units and emits RGBA8 frames. It supports 8-bit 4:2:0 pictures, the expected profile for the captured preview sample. The decoder runs in a dedicated Web Worker without SharedArrayBuffer or cross-origin isolation.

## Build

From the public repository root, run `node scripts/build-preview-decoder.js`. The script uses the pinned Emscripten SDK image `docker.io/emscripten/emsdk:3.1.64`, verifies the included upstream libde265 1.1.3 source archive against SHA-256 `554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905`, and compiles `decoder.c` with the static library. The source archive is included beside this file so distributions carry the complete corresponding source. The build writes generated `libde265.js`, `libde265.wasm`, the upstream `COPYING`, and the Emscripten runtime license (`EMSCRIPTEN-COPYING`) alongside this file; intermediate build files stay under `.tmp/preview-decoder/`.

The generated decoder is licensed under LGPL-3.0-or-later. Keep this license and the source/build recipe available with distributions. The upstream release and source are at <https://github.com/strukturag/libde265/releases/tag/v1.1.3>.

## Worker protocol

Create a worker with `new Worker('/preview-decoder/worker.js')` (or the app's equivalent asset URL), then send:

- `{type: 'init'}` produces `{type: 'ready'}`
- `{type: 'decode', data: ArrayBuffer, timestamp: number}` for each complete Annex B access unit produces zero or more `{type: 'frame', width, height, data: ArrayBuffer, timestamp}` messages
- `{type: 'decoded', timestamp}` acknowledges each accepted access unit, even when HEVC picture reordering means no output frame is ready yet
- `{type: 'reset'}` clears decoder reference state after dropping queued input; resume from a keyframe with parameter sets
- `{type: 'close'}` destroys the decoder and closes the worker

The caller should transfer each input buffer to avoid copying. Output RGBA buffers are transferable. A frame may be emitted after a later access unit because HEVC picture reordering delays output. Parameters and access units must remain in Annex B format, including NAL start codes and parameter sets.
