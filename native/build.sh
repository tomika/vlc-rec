#!/bin/sh
# Runs inside the native/Containerfile image with the repository as working directory.
set -eu
mkdir -p player
gcc -std=gnu11 -O2 -s -Wall -Wextra -o player/vlc-rec-player-linux_x64 \
  native/vlc-rec-player.c -ldl -lpthread -lX11
x86_64-w64-mingw32-gcc -std=gnu11 -O2 -s -Wall -Wextra -static -o player/vlc-rec-player-win_x64.exe \
  native/vlc-rec-player.c -ladvapi32 -lgdi32
chmod 755 player/vlc-rec-player-linux_x64

# Only the public adapters listed here are built into distributable runtime folders.
while IFS= read -r id || [ -n "$id" ]; do
  [ -n "$id" ] || continue
  case "$id" in *[!a-z0-9_-]*) echo "Invalid public plugin id: $id" >&2; exit 1 ;; esac
  mkdir -p "player/plugins/$id"
  gcc -std=gnu11 -O2 -s -Wall -Wextra -o "player/plugins/$id/$id-linux_x64" "plugins/$id/$id.c" -lm
  x86_64-w64-mingw32-gcc -std=gnu11 -O2 -s -Wall -Wextra -static -o "player/plugins/$id/$id-win_x64.exe" "plugins/$id/$id.c" -lws2_32 -lm
  cp "plugins/$id/plugin.json" "player/plugins/$id/"
  chmod 755 "player/plugins/$id/$id-linux_x64"
done < packaging/public-plugins.txt
