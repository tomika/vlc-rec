#!/bin/sh
# Runs inside the native/Containerfile image with the repository as working directory.
set -eu
target="${VLC_REC_NATIVE_TARGET:-all}"
case "$target" in all|linux|win) ;; *) echo "Expected VLC_REC_NATIVE_TARGET=all, linux or win" >&2; exit 2 ;; esac
mkdir -p player
if [ "$target" != win ]; then
gcc -std=gnu11 -O2 -s -Wall -Wextra -o player/vlc-rec-player-linux_x64 \
  native/vlc-rec-player.c -ldl -lpthread -lX11
chmod 755 player/vlc-rec-player-linux_x64
fi
if [ "$target" != linux ]; then
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -s -Wall -Wextra -static -o player/vlc-rec-player-win_x64.exe \
  native/vlc-rec-player.c -ladvapi32 -lgdi32
fi

# Only the public adapters listed here are built into distributable runtime folders.
while IFS= read -r id || [ -n "$id" ]; do
  [ -n "$id" ] || continue
  case "$id" in *[!a-z0-9_-]*) echo "Invalid public plugin id: $id" >&2; exit 1 ;; esac
  mkdir -p "player/plugins/$id"
  if [ "$target" != win ]; then
  gcc -std=gnu11 -O2 -s -Wall -Wextra -o "player/plugins/$id/$id-linux_x64" "plugins/$id/$id.c" -lm
  chmod 755 "player/plugins/$id/$id-linux_x64"
  fi
  if [ "$target" != linux ]; then
  x86_64-w64-mingw32-gcc -std=gnu11 -O2 -s -Wall -Wextra -static -o "player/plugins/$id/$id-win_x64.exe" "plugins/$id/$id.c" -lws2_32 -lm
  fi
  cp "plugins/$id/plugin.json" "player/plugins/$id/"
done < packaging/public-plugins.txt
