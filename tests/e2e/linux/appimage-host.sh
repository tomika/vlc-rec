#!/bin/bash
# Runs inside a distribution container, started by tests/e2e/run-appimage.js.
set -u

# Sway runs start this script again inside the session.
if [ "${E2E_SESSION:-x11}" = "sway" ] && [ -z "${IN_SESSION:-}" ]; then
  IN_SESSION=1 exec bash /repo/tests/e2e/linux/session.sh sway bash "$0"
fi

TOOL_LIBS=/tools/usr/local/lib:/tools/usr/lib/x86_64-linux-gnu:/tools/usr/lib/x86_64-linux-gnu/pulseaudio:/tools/usr/lib/x86_64-linux-gnu/blas:/tools/usr/lib/x86_64-linux-gnu/lapack
TOOL_LOADER=/tools/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
FAILED=0
fail() { echo "FAIL $1"; FAILED=1; }
pass() { echo "PASS $1"; }

# Starts a program from the tools image with its own loader, so no variable reaches the app.
tool() {
  printf '#!/bin/sh\nexec %s --library-path %s %s "$@"\n' "$TOOL_LOADER" "$TOOL_LIBS" "$2" > "/tmp/toolbin/$1"
  chmod +x "/tmp/toolbin/$1"
}
mkdir -p /tmp/toolbin /tmp/onpath
tool node /tools/usr/local/bin/node
tool ffmpeg /tools/usr/bin/ffmpeg
tool ffprobe /tools/usr/bin/ffprobe
tool xwininfo /tools/usr/bin/xwininfo
# run-e2e.js takes screenshots with "import -window root png24:FILE".
cat > /tmp/onpath/import <<'EOF'
#!/bin/sh
for last; do :; done
exec /tmp/toolbin/ffmpeg -y -loglevel error -f x11grab -video_size 1400x900 -i "$DISPLAY" -frames:v 1 "${last#png24:}"
EOF
chmod +x /tmp/onpath/import
export PATH=/tmp/onpath:$PATH

grep PRETTY_NAME /etc/os-release
ldd --version | head -1

# A host library would make this test prove nothing, except on the host that has them on purpose.
if [ "${E2E_SYSTEM_LIBS:-0}" != "1" ]; then
  FOREIGN=$(ldconfig -p 2>/dev/null | grep -E 'libwebkit|libvlc|libgtk-3|libsoup|libsrt' || true)
  if [ -z "$FOREIGN" ]; then pass "host has no VLC, WebKit, GTK or SRT libraries"; else fail "host has: $FOREIGN"; fi
fi

APP=/tmp/vlc-rec-x86_64.AppImage
# Not cp -p and not a mount: the mounted Windows folder carries no execute permission.
cat /repo/dist/vlc-rec-x86_64.AppImage > "$APP"
chmod +x "$APP"

if [ "${E2E_TOO_OLD:-0}" = "1" ]; then
  OUTPUT=$("$APP" 2>&1)
  STATUS=$?
  echo "$OUTPUT"
  if [ "$STATUS" -ne 0 ] && echo "$OUTPUT" | grep -q "needs glibc"; then
    pass "a system that is too old gets a clear message"
    exit 0
  fi
  fail "a system that is too old gets a clear message (exit $STATUS)"
  exit 1
fi

# Every library that the bundle leaves to the host must exist here.
(cd /tmp && "$APP" --appimage-extract >/dev/null 2>&1)
if [ -d /tmp/squashfs-root/usr ]; then
  find /tmp/squashfs-root/usr -type f \( -name '*.so*' -o -path '*/bin/*' -o -path '*/player/*' -o -name 'WebKit*Process' \) -print0 \
    | xargs -0 -n 40 ldd 2>/dev/null | grep 'not found' | sort -u > /tmp/missing-libs
  if [ -s /tmp/missing-libs ]; then fail "libraries missing on this host:"; cat /tmp/missing-libs; else pass "all host libraries are present"; fi
else
  fail "the image could not be extracted"
fi
rm -rf /tmp/squashfs-root

if [ -z "${IN_SESSION:-}" ]; then
  mkdir -p -m 1777 /tmp/.X11-unix 2>/dev/null
  export XDG_RUNTIME_DIR=/tmp/xdg NO_AT_BRIDGE=1 DISPLAY=:99
  mkdir -p -m 700 "$XDG_RUNTIME_DIR"
  Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &
  sleep 1
  openbox >/dev/null 2>&1 &
  sleep 1
fi
# session.sh sets this for the older tests. The shipped app must work without it.
unset WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS

# Use FUSE when the container allows it, because that is how users run the file.
"$APP" --appimage-mount >/tmp/mount.txt 2>/tmp/mount.err &
MOUNT_PID=$!
sleep 3
# The runtime prints the mount point even when mounting fails, so look inside it.
if [ -x "$(cat /tmp/mount.txt)/AppRun" ]; then
  pass "the image mounts through FUSE"
else
  echo "NOTE FUSE is not available in this container ($(cat /tmp/mount.err 2>/dev/null)); extracting instead"
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
kill "$MOUNT_PID" 2>/dev/null
sleep 1

dbus-run-session -- /tmp/toolbin/node /repo/tests/e2e/appimage-smoke.js "$APP" || FAILED=1

mkdir /tmp/repo
cp -r /repo/src /repo/assets /repo/bin /repo/player /repo/tests /repo/neutralino.config.json /tmp/repo/
E2E_OUT=/out E2E_APPIMAGE="$APP" E2E_FFMPEG=/tmp/toolbin/ffmpeg E2E_FFPROBE=/tmp/toolbin/ffprobe E2E_XWININFO=/tmp/toolbin/xwininfo \
  dbus-run-session -- /tmp/toolbin/node /tmp/repo/tests/e2e/run-e2e.js --mode real || FAILED=1
exit "$FAILED"
