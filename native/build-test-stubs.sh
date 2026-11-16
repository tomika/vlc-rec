#!/bin/sh
# Test doubles for libVLC; never shipped. Runs inside the native builder image.
set -eu
target="${VLC_REC_NATIVE_TARGET:-all}"
case "$target" in all|linux|win) ;; *) echo "Expected VLC_REC_NATIVE_TARGET=all, linux or win" >&2; exit 2 ;; esac
mkdir -p tests/fixtures/stub/win tests/fixtures/stub/linux
if [ "$target" != linux ]; then
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -Wall -Wextra -shared -static-libgcc \
  -o tests/fixtures/stub/win/libvlc.dll tests/fixtures/libvlc-stub.c
fi
if [ "$target" != win ]; then
gcc -std=gnu11 -O2 -Wall -Wextra -shared -fPIC \
  -o tests/fixtures/stub/linux/libvlc.so.5 tests/fixtures/libvlc-stub.c
fi
