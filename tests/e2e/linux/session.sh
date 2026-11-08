#!/bin/bash
# usage: session.sh x11|sway command...   Runs the command inside a virtual desktop.
set -eu
KIND=$1
shift
mkdir -p -m 1777 /tmp/.X11-unix
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
export NO_AT_BRIDGE=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1

if [ "$KIND" = "x11" ]; then
  Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &
  export DISPLAY=:99
  sleep 1
  openbox >/dev/null 2>&1 &
  sleep 1
else
  export WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 WLR_HEADLESS_OUTPUTS=1
  cat >/tmp/sway.cfg <<'EOF'
xwayland enable
output HEADLESS-1 resolution 1400x900
for_window [title="VLC Stream Recorder"] floating enable
EOF
  sway -c /tmp/sway.cfg >/tmp/sway.log 2>&1 &
  sleep 3
  export WAYLAND_DISPLAY=$(ls "$XDG_RUNTIME_DIR" | grep -E '^wayland-[0-9]+$' | head -1)
  export DISPLAY=:0
fi
exec dbus-run-session -- "$@"
