#!/bin/sh
# Runs inside the native/Containerfile image with the repository as working directory.
set -eu
mkdir -p player
gcc -std=gnu11 -O2 -s -Wall -Wextra -o player/vlc-rec-player-linux_x64 \
  native/vlc-rec-player.c -ldl -lpthread -lX11
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -s -Wall -Wextra -static -o player/vlc-rec-player-win_x64.exe \
  native/vlc-rec-player.c -ladvapi32 -lgdi32
chmod 755 player/vlc-rec-player-linux_x64

# Camera adapters (plugins/<id>/), optional; the app has no camera controls without one. The
# built programs go with their manifests to player/plugins/<id>/, next to the player.
mkdir -p player/plugins/obsbot-tail2
gcc -std=gnu11 -O2 -s -Wall -Wextra -o player/plugins/obsbot-tail2/obsbot-tail2-linux_x64 \
  plugins/obsbot-tail2/obsbot-tail2.c -lm
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -s -Wall -Wextra -static -o player/plugins/obsbot-tail2/obsbot-tail2-win_x64.exe \
  plugins/obsbot-tail2/obsbot-tail2.c -lws2_32 -lm
cp plugins/obsbot-tail2/plugin.json player/plugins/obsbot-tail2/
chmod 755 player/plugins/obsbot-tail2/obsbot-tail2-linux_x64

# Test double for libVLC; never shipped.
mkdir -p tests/fixtures/stub/win tests/fixtures/stub/linux
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -Wall -Wextra -shared -static-libgcc \
  -o tests/fixtures/stub/win/libvlc.dll tests/fixtures/libvlc-stub.c
gcc -std=gnu11 -O2 -Wall -Wextra -shared -fPIC \
  -o tests/fixtures/stub/linux/libvlc.so.5 tests/fixtures/libvlc-stub.c
