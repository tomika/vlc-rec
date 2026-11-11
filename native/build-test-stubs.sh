#!/bin/sh
# Test doubles for libVLC; never shipped. Runs inside the native builder image.
set -eu
mkdir -p tests/fixtures/stub/win tests/fixtures/stub/linux
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -Wall -Wextra -shared -static-libgcc \
  -o tests/fixtures/stub/win/libvlc.dll tests/fixtures/libvlc-stub.c
gcc -std=gnu11 -O2 -Wall -Wextra -shared -fPIC \
  -o tests/fixtures/stub/linux/libvlc.so.5 tests/fixtures/libvlc-stub.c
