#!/bin/sh
# Runs inside the native/Containerfile image with the repository as working directory.
set -eu
mkdir -p player
gcc -std=gnu11 -O2 -s -Wall -Wextra -o player/vlc-rec-player-linux_x64 \
  native/vlc-rec-player.c -ldl -lpthread -lX11
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -s -Wall -Wextra -static -o player/vlc-rec-player-win_x64.exe \
  native/vlc-rec-player.c -ladvapi32 -lgdi32
chmod 755 player/vlc-rec-player-linux_x64

# Camera helper (OSC over UDP), optional; the app has no camera controls without it.
gcc -std=gnu11 -O2 -s -Wall -Wextra -o player/vlc-rec-camera-linux_x64 \
  native/vlc-rec-camera.c -lm
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -s -Wall -Wextra -static -o player/vlc-rec-camera-win_x64.exe \
  native/vlc-rec-camera.c -lws2_32 -lm
chmod 755 player/vlc-rec-camera-linux_x64

# Test double for libVLC; never shipped.
mkdir -p tests/fixtures/stub/win tests/fixtures/stub/linux
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -Wall -Wextra -shared -static-libgcc \
  -o tests/fixtures/stub/win/libvlc.dll tests/fixtures/libvlc-stub.c
gcc -std=gnu11 -O2 -Wall -Wextra -shared -fPIC \
  -o tests/fixtures/stub/linux/libvlc.so.5 tests/fixtures/libvlc-stub.c
