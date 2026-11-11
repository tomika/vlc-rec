#!/bin/bash
# Builds dist/vlc-rec-x86_64.AppImage inside the container from packaging/appimage/Containerfile.
# /repo is the repository (read-only), /out receives the result.
set -euo pipefail

REPO=/repo
OUT=/out
SYSTEM_LIB=/usr/lib/x86_64-linux-gnu
APPDIR=/tmp/AppDir
USR=$APPDIR/usr
LIB=$USR/lib
# Neutralino tries WebKit 4.0 first. With 4.1 here, a host that has 4.0 would load its own copy.
WEBKIT_DIR=x86_64-linux-gnu/webkit2gtk-4.0
WEBKIT_LIB=libwebkit2gtk-4.0.so.37

# Everything here must come from the host: glibc and the C++ runtime, because host drivers need
# versions at least as new as their own; the GL stack, because it has to match the host's GPU
# drivers; and the libraries that read host configuration or that host drivers link against.
is_host_library() {
  case "$1" in
    ld-linux*|libc.so*|libm.so*|libmvec.so*|libdl.so*|libpthread.so*|librt.so*|libresolv.so*|libutil.so*|libnsl.so*|libnss_*|libanl.so*|libthread_db.so*) return 0 ;;
    libstdc++.so*|libgcc_s.so*) return 0 ;;
    libGL.so*|libGLX*|libGLdispatch.so*|libOpenGL.so*|libEGL*|libglapi.so*|libdrm*|libgbm.so*|libwayland-client.so*) return 0 ;;
    libX11.so*|libX11-xcb.so*|libxcb.so*) return 0 ;;
    libasound.so*|libfontconfig.so*|libfreetype.so*|libharfbuzz.so*|libz.so*|libexpat.so*) return 0 ;;
  esac
  return 1
}

is_elf() {
  [ "$(head -c 4 "$1" | tail -c 3)" = "ELF" ]
}

elf_files() {
  find "$USR" -type f | while read -r file; do
    if is_elf "$file"; then echo "$file"; fi
  done
}

rm -rf "$APPDIR"
mkdir -p "$USR/bin" "$USR/player" "$LIB/x86_64-linux-gnu" "$LIB/vlc" "$LIB/gtk-3.0" "$USR/share/glib-2.0/schemas" "$USR/share/doc/third-party"

cp "$REPO/dist/vlc-rec/vlc-rec-linux_x64" "$USR/bin/vlc-rec"
cp "$REPO/player/vlc-rec-player-linux_x64" "$USR/player/"
# Camera adapters (optional; the app has no camera controls without one): the manifest and the Linux
# program of each, where the app looks for them, in plugins beside the player.
for dir in "$REPO"/player/plugins/*/; do
  id=$(basename "$dir")
  if [ -f "${dir}plugin.json" ] && [ -f "${dir}${id}-linux_x64" ]; then
    mkdir -p "$USR/player/plugins/$id"
    cp "${dir}plugin.json" "${dir}${id}-linux_x64" "$USR/player/plugins/$id/"
  fi
done
cp /usr/bin/vlc /usr/bin/zenity "$USR/bin/"
cp -rL "$SYSTEM_LIB/vlc/plugins" "$LIB/vlc/plugins"
cp -rL "$SYSTEM_LIB/gdk-pixbuf-2.0/2.10.0/loaders" "$LIB/gdk-pixbuf-loaders"
cp -rL "/usr/lib/$WEBKIT_DIR" "$LIB/x86_64-linux-gnu/"
# These two are loaded at run time, so no program lists them as a dependency.
cp -L "$SYSTEM_LIB/$WEBKIT_LIB" "$SYSTEM_LIB/libvlc.so.5" "$LIB/"
chmod 755 "$USR/bin/"* "$USR/player/"*
# Debian's zenity links WebKit 4.1 for its rarely used HTML mode. The API is the same, and a
# second WebKit would add about 120 MB.
patchelf --replace-needed libwebkit2gtk-4.1.so.0 "$WEBKIT_LIB" \
  --replace-needed libjavascriptcoregtk-4.1.so.0 libjavascriptcoregtk-4.0.so.18 "$USR/bin/zenity"
# Neutralino's dialogs look for zenity with "which", which Fedora and Arch may not have.
printf '#!/bin/sh\ncommand -v "$@"\n' > "$USR/bin/which"
chmod 755 "$USR/bin/which"

echo "[appimage] Copying dependencies"
missing=0
for file in $(elf_files); do
  while read -r name _ path _; do
    if [ "$path" = "not" ]; then
      echo "[appimage] $file needs $name, which is not installed in the build image"
      missing=1
    elif [ -n "$path" ] && ! is_host_library "$name" && [ ! -e "$LIB/$name" ]; then
      cp -L "$path" "$LIB/$name"
      realpath "$path" >> /tmp/bundled-files
    fi
  done < <(ldd "$file" 2>/dev/null | awk '$2 == "=>" { print $1, $2, $3 }')
done
[ "$missing" -eq 0 ]

echo "[appimage] Setting RUNPATH"
for file in $(elf_files); do
  relative=$(realpath --relative-to="$(dirname "$file")" "$LIB")
  patchelf --set-rpath "\$ORIGIN/$relative" "$file"
done

# WebKit starts its helpers from a fixed path, and only developer builds can change it. The
# replacement has the same length and is relative to the working directory that AppRun sets.
size_before=$(stat -c %s "$LIB/$WEBKIT_LIB")
LC_ALL=C sed -i "s|/usr/lib/$WEBKIT_DIR|././/lib/$WEBKIT_DIR|g" "$LIB/$WEBKIT_LIB"
grep -qa "././/lib/$WEBKIT_DIR" "$LIB/$WEBKIT_LIB"
[ "$(stat -c %s "$LIB/$WEBKIT_LIB")" = "$size_before" ]

(cd "$USR" && "$SYSTEM_LIB/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders" lib/gdk-pixbuf-loaders/*.so) \
  | sed "s|$USR/||" > "$LIB/gdk-pixbuf-loaders.cache"
: > "$LIB/gtk-3.0/immodules.cache"
cp /usr/share/glib-2.0/schemas/*.xml /usr/share/glib-2.0/schemas/*.override "$USR/share/glib-2.0/schemas/" 2>/dev/null || true
glib-compile-schemas "$USR/share/glib-2.0/schemas"
# Zenity looks for this file in the working directory after its compiled-in path.
cp /usr/share/zenity/zenity.ui "$USR/"

# Without a cache libVLC scans about 300 plugins at every start.
"$SYSTEM_LIB/vlc/vlc-cache-gen" "$LIB/vlc/plugins"

echo "[appimage] Writing the list of bundled packages and their licenses"
{
  cat /tmp/bundled-files
  realpath "$SYSTEM_LIB/$WEBKIT_LIB" "$SYSTEM_LIB/libvlc.so.5"
  echo /usr/bin/vlc
  echo /usr/bin/zenity
  find "$SYSTEM_LIB/vlc/plugins" "$SYSTEM_LIB/gdk-pixbuf-2.0/2.10.0/loaders" "/usr/lib/$WEBKIT_DIR" -type f
} | sort -u | while read -r file; do
  # Debian 12 records some libraries under /lib although they are stored in /usr/lib.
  dpkg -S "$file" 2>/dev/null || dpkg -S "${file#/usr}" 2>/dev/null || echo "[appimage] No package owns $file" >&2
done | cut -d: -f1 | sort -u > /tmp/packages
while read -r package; do
  dpkg-query -W -f='${Package} ${Version}\n' "$package" >> "$USR/share/doc/third-party/packages.txt"
  if [ -f "/usr/share/doc/$package/copyright" ]; then
    cp "/usr/share/doc/$package/copyright" "$USR/share/doc/third-party/$package.copyright"
  fi
done < /tmp/packages

cp "$REPO/packaging/appimage/AppRun" "$APPDIR/AppRun"
chmod 755 "$APPDIR/AppRun"
cp "$REPO/assets/vlc-rec.png" "$APPDIR/vlc-rec.png"
cp "$APPDIR/vlc-rec.png" "$APPDIR/.DirIcon"
cat > "$APPDIR/vlc-rec.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=VLC Stream Recorder
Comment=Preview and record SRT streams
Exec=vlc-rec
Icon=vlc-rec
Terminal=false
Categories=AudioVideo;Video;
StartupNotify=true
EOF

echo "[appimage] Creating the image"
mksquashfs "$APPDIR" /tmp/app.squashfs -comp zstd -Xcompression-level 19 -root-owned -noappend -quiet
# Not cp: a mounted Windows folder refuses the permission change that cp attempts.
cat /opt/runtime-x86_64 /tmp/app.squashfs > "$OUT/vlc-rec-x86_64.AppImage"
chmod 755 "$OUT/vlc-rec-x86_64.AppImage" 2>/dev/null || true
du -h "$OUT/vlc-rec-x86_64.AppImage"
