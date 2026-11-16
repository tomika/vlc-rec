const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const image = 'docker.io/emscripten/emsdk:3.1.64';
const tool = ['podman', 'docker'].find((name) => !spawnSync(name, ['--version'], { stdio: 'ignore' }).error);
if (!tool) throw new Error('Building the HEVC preview decoder needs podman or docker.');

const build = `set -eu
cd /src
mkdir -p .tmp/preview-decoder
cd .tmp/preview-decoder
source_tar=/src/src/frontend/preview-decoder/libde265-1.1.3.tar.gz
echo '554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905  /src/src/frontend/preview-decoder/libde265-1.1.3.tar.gz' | sha256sum --check --status
tar -xzf "$source_tar"
cd libde265-1.1.3
rm -rf build
emcmake cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DENABLE_SIMD=OFF -DENABLE_SDL=OFF -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF -DENABLE_SHERLOCK265=OFF -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF -DWITH_FUZZERS=OFF
cmake --build build --parallel 2
mkdir -p /src/src/frontend/preview-decoder
cp COPYING /src/src/frontend/preview-decoder/COPYING
cp /emsdk/LICENSE /src/src/frontend/preview-decoder/EMSCRIPTEN-COPYING
emcc /src/src/frontend/preview-decoder/decoder.c build/libde265/libde265.a -I. -Ibuild -Ilibde265 -Ibuild/libde265 -O3 \\
  -s WASM=1 -s WASM_BIGINT=1 -s MODULARIZE=1 -s EXPORT_NAME=createLibde265 \\
  -s ENVIRONMENT=web,worker,node -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=67108864 -s STACK_SIZE=5242880 \\
  -s FILESYSTEM=0 -s ASSERTIONS=0 -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","getValue"]' \\
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_h265_create","_h265_destroy","_h265_reset","_h265_decode","_h265_next_frame","_h265_release_frame","_h265_error_text"]' \\
  -o /src/src/frontend/preview-decoder/libde265.js
`;

const result = spawnSync(tool, ['run', '--rm', '-v', `${root}:/src`, '-w', '/src', image, 'bash', '-lc', build], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log('[build-preview-decoder] Built LGPL libde265 worker assets');
