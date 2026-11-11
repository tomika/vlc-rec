# VLC Stream Recorder (NeutralinoJS)

This is a NeutralinoJS port of the Python VLC Stream Recorder app.

## Features

- Preview SRT stream
- Record SRT stream to `mkv` or `mp4`
- Persist parameters in `vlc_rec_params.json`
- Simulation mode via `srt_mode: "simulation"` in params file
- File size + elapsed time updates every second
- Button state/label transitions for preview and recording
- Optional automatic VLC reconnect after a stream stall, with a new numbered recording file
- Scan dialog for discovering reachable `IP:port` endpoints on local networks
- Preview embedded in the app window on Windows and Linux x64 through libVLC
- The preview gets the largest area its aspect ratio allows; while streaming, the controls collapse to a compact bar when they would cost the video too much room. The panel is a bar that is always there (time, status line, camera controls with a camera, record and preview buttons) and a drawer with everything else (stream address, folder, file name, the two options, the camera's web page); the settings button beside the buttons folds the drawer away and opens it again. The drawer is above the bar when the panel is below the video, and beside it when the panel is next to the video. The status line is plain text with a coloured edge for a warning (amber) or an error (red)
- Optional camera control through camera adapters (one for the OBSBOT Tail 2 is included, others can be added without changing the app): click the preview to turn the camera so that the clicked point ends up in the middle, mouse wheel and `+`/`-` buttons zoom, arrow keys pan and tilt. See [Camera control](#camera-control).

## Requirements

- Linux x64 AppImage: no VLC needed, see [Linux AppImage](#linux-appimage). Everything below applies to the other packages.
- VLC 3 installed. On Debian and Ubuntu also install `vlc-plugin-access-extra`, which provides SRT.
- Snap and Flatpak installations of VLC do not expose libVLC to the embedded player.
- On platforms without a player binary (macOS, Linux on ARM), VLC in `PATH`; VLC then opens its own window.
- Linux: start the app with `run-vlc-rec.sh`. It selects X11 or XWayland, which embedding needs. In development use `GDK_BACKEND=x11 npm start`.
- Node.js 18+.
- Building the player needs podman or docker.

## When the preview stays black

The app writes `neutralinojs.log` into its folder (the settings folder in the AppImage). Besides its own lines it holds what the player reports:

- `Player playing: N bytes read, D pictures decoded, S shown, L lost`, when the state changes and a few times after the start. No bytes read: the stream does not arrive (address, firewall, a camera that serves one client). Bytes read but nothing decoded: the stream format, or a missing SRT or codec plugin. Decoded but not shown: the video output.
- `libVLC warning|error [module] text`: libVLC's own warnings and errors (repeats left out, 300 lines at most), for example from the `direct3d11` video output.
- On Windows `Player player window ...`, three seconds after the start: the child windows of the player. The picture window of libVLC is missing there when libVLC never made its video output.

`VLC_REC_VLC_ARGS` in the environment of the app adds libVLC options for a try, separated by spaces: `--verbose=2` puts all libVLC messages in the log, `--vout=direct3d9` or `--avcodec-hw=none` change the video output and the decoder. On Windows: `set VLC_REC_VLC_ARGS=--vout=direct3d9` in a command prompt, then start the app from it.

## Camera control

Off until a camera adapter is chosen in `vlc_rec_params.json`, for example `"camera_plugin": "obsbot-tail2"` and `"camera_config": { "host": "192.168.1.50" }`. An adapter is a small program for one camera model; the app starts it from a folder (`plugins/<id>/plugin.json` beside the player or in the settings folder) and talks to it in JSON, and it draws only the controls that the connected camera says it has. A camera other than the Tail 2 needs an adapter and no change of the app: [docs/camera-plugin-interface.md](docs/camera-plugin-interface.md) describes the interface and how to write one. The adapter that comes with the app, `obsbot-tail2`, talks to the camera's OSC server (UDP 57110; the camera answers to UDP 57120 on this computer, so close other camera software that uses that port, and on Windows allow it in the firewall if asked).

- **Click the preview**: the camera turns so that the clicked point ends up in the middle, at the speed of the **Turn speed** slider of the camera controls (1 to 90 degrees per second, whole degrees; the camera controls are part of the compact panel too). Choosing a stream in the **Scan** dialog also sets `host` in `camera_config` to that address and restarts the adapter (when one is chosen and it has a `host` setting), on the assumption that the stream comes from the camera. The turn is one command: the camera moves both axes at the same speed, so on a diagonal turn the axis with the shorter way arrives first (24 and 6 degrees at 10 degrees per second: after 2.4 s and 0.6 s). Making them arrive together is possible with a target every 100 ms along the straight line (measured: 0.2 s apart), but the targets are whole degrees, so the short axis then moves in steps of one degree and the picture is jerky; that was tried and dropped. The turn is an estimate (a pinhole model with the field of view below; lens distortion is ignored), and the picture lags behind the camera, so the next click is accepted one second later.
- **Mouse wheel** over the preview, or the `-` and `+` buttons of the camera controls: zoom out and in. A button press is `camera_zoom_step` percent of the zoom range, a wheel notch half of that.
- **Camera web page**: with a camera address set, the drawer has an **Open web page** button that opens `http://CAMERA/` in the system's web browser, where the camera's own control page lets you, for example, format the SD card. (The page can be framed, but the native video window would cover an in-app frame, and the system browser does not depend on how the page was written.)
- **Arrow keys** (when no text field has the focus): pan and tilt by `camera_arrow_step_deg` degrees per press and per key repeat; Shift makes the step five times larger.

Settings in `vlc_rec_params.json`:

- `camera_plugin`: id of the camera adapter (`obsbot-tail2` is included); empty (the default) switches the feature off. `camera_config`: the settings of the adapter, which its `plugin.json` declares (for `obsbot-tail2` below; the camera's address is `host`). Settings of earlier builds (`camera_ip` and its companions) are converted when the file is read.
- `camera_config` of `obsbot-tail2`: `hfov` (default `76`), `zoomMax` (default `36`) and `zoomRatio` (default `4.6`) are the horizontal field of view at zoom 0, the top of the camera's zoom range in the units it reports (the Tail 2 stops at 36 whatever it is asked for) and the zoom ratio there; `nudgeSpeed` (default `30`) is the speed of the arrow keys in degrees per second (key repeat piles up targets, and a slow camera would run on after the key is released); `oscPort` (57110) and `localPort` (57120) are the two UDP ports. The defaults were measured on one Tail 2 from its own picture (`tools/camera/calibrate-fov.js`): 75.7 degrees, and ratios 1.92, 3.52 and 4.61 at zoom 9, 24 and 36. They decide how far a click turns the camera: if clicked points end up short of the middle, raise the field of view; if they overshoot, lower it.
- `camera_turn_speed`: turning speed after a click, in degrees per second, 1-90 (default `10`; measured on a Tail 2: the speed value is about the speed it turns at, a 20 degree turn takes 0.7 s at 30 and 2 s at 10). The slider changes and saves it when it is let go (the number beside it follows while it is dragged; after a drag it gives the keyboard back, because the arrow keys turn the camera).
- `preview_caching_ms`: network cache of the player in ms, also the **Preview buffer** field of the drawer (default `500`; the field takes 0 to 10000, the file anything from 0; `-1` leaves VLC's own 1000). It applies when a preview or recording is **started**: the player takes it as an argument. While a running one has another value than the field, a note under the field says so, and for a preview a button restarts it with the new value (a recording is not cut; it takes the value at its next start or reconnect). VLC's default delays the picture by about a second. Too small a cache **freezes the picture**, and how small is too small depends on the network and the computer, so nothing is forced: the hint under the field says to lower it until the picture stutters and raise it a little. With the 4K stream of a Tail 2 over a LAN in a container, software decoding and a real window, 150 ms froze it, 250 ms and more moved (without a window 150 ms lost about 40 percent of the pictures, 300 ms about 10, 500 ms none). A smaller stream would allow less.
- `camera_zoom_step`: percent of the zoom range per button press (default `10`); a wheel notch is half of that.
- `camera_arrow_step_deg`: degrees per arrow key press (default `2`, whole degrees).

Notes from measuring a Tail 2: the position the camera reports is accurate to about 1 degree, which is also the accuracy of a turn; pan and tilt cannot be driven together by speed (the camera acts on the last direction command only), so every move here is a turn to an absolute angle. With the real camera, a click turned the clicked point to the middle within a few percent of the picture width (`tools/camera/verify-centering.js`, which compares the picture before and after). Messages from the camera adapter (for example an unreachable camera) appear after the status text for a few seconds. Tested: the adapter against a fake camera and against a real Tail 2, and the whole chain (click, wheel, keys through a real window with real libVLC) in the Linux end-to-end test, on X11 with openbox and on sway with XWayland. Not tested: the same chain on Windows, and on real GNOME or KDE desktops.

**Delay of the picture.** Measured on a Tail 2 (4K H.264 over SRT, pan command to the first changed picture): 720 to 790 ms, with the receiver's SRT latency at 20 and at 400 ms alike, so the receiver is not what limits it. About 150 ms of that is the camera starting to move, the rest is the camera's own encoding and its SRT delay, which can only be changed on the camera (its SRT settings: the delay, and a lower resolution or bitrate to decode faster). VLC adds its own network cache on top (1000 ms by default), which `preview_caching_ms` cuts. With the camera's **RTSP** output switched on (the camera's UVC, RTSP and SRT modes exclude each other) there are two streams without a password: `rtsp://CAMERA:554/stream1` (3840x2160 H.264, AAC) and `rtsp://CAMERA:554/stream2` (1280x720 H.265, AAC). Their delay is the same, 640 to 770 ms with TCP or UDP and at either resolution, so a second, smaller stream does not give a real time picture; it would only make decoding lighter. The camera did not serve `stream2` while another RTSP client was connected, and `stream2` failed with `500 Internal Server Error` after an interrupted test; switching RTSP off and on in the camera clears that. The VLC of the AppImage (Debian build) has no RTSP module. Measured with ffmpeg, not with VLC.

## Setup

```bash
npm install
npm start
```

`npm install` runs `neu update` automatically to fetch Neutralino binaries and the client library.

## Build

```bash
npm run build:player   # builds player/ (player, camera adapters in player/plugins) and the test stub in a container
npm run build
```

## Tests

```bash
npm test                 # unit tests
npm run test:e2e         # real app window with a libVLC stub, this OS
npm run test:e2e:real    # real app window with VLC 3 and ffmpeg, this OS
npm run test:e2e:linux   # Linux stub, X11 and Wayland runs in a container
npm run test:e2e:appimage # the built AppImage on several distributions, needs podman
node tests/e2e/camera-plugin.js   # the obsbot-tail2 adapter against a fake camera, in a container
E2E_ONLY=camera node tests/e2e/run-linux.js x11   # camera clicks, wheel and keys in a real window
E2E_HOST_NETWORK=1 E2E_ONLY=motion E2E_PARAMS='{"ip_address":"192.168.1.50:5000","preview_caching_ms":500}' node tests/e2e/run-linux.js x11   # does the picture of a real camera move? (screenshots compared)
```

The end-to-end tests open a window that stays on top for a few minutes. Screenshots go to `e2e-output/`.

This creates distributable binaries in `dist/vlc-rec`.

## Package Standalone (Windows + Linux)

```bash
npm run package
```
This runs `neu build --release --embed-resources`, which:

- builds binaries for all supported platforms, including Windows and Linux
- embeds resources into each binary (no external `resources.neu` file)
- generates Linux launcher bundles in `dist/vlc-rec/linux-*` with:
  - `vlc-rec` binary
  - `run-vlc-rec.sh` launcher
  - `vlc-rec.desktop` desktop entry
  - `vlc-rec.png` icon

Linux note: file managers usually show a generic icon for raw ELF binaries. Use the generated `.desktop` launcher (`linux-*/vlc-rec.desktop`) to get the custom app icon in Linux file explorers and launchers.

## Linux AppImage

```bash
npm run package:appimage   # creates dist/vlc-rec-x86_64.AppImage, needs podman or docker
```

One file of about 130 MB that contains the app, libVLC with SRT support and WebKitGTK. To run it:

```bash
chmod +x vlc-rec-x86_64.AppImage
./vlc-rec-x86_64.AppImage
```

- It needs glibc 2.36 or newer (Debian 12, Ubuntu 24.04 or later), x86-64, an X11 or XWayland session and FUSE. If FUSE is missing, run it with `--appimage-extract-and-run`.
- Settings and the log are stored in `~/.config/vlc-rec`.
- Hardware video decoding has not been tested with the bundled libVLC, so expect software decoding.
- The file contains third-party software under the GPL and LGPL. Their licenses and versions are inside the image, in `usr/share/doc/third-party`. Whoever distributes the file must also meet the source-code obligations of those licenses.

To try the AppImage from a Windows machine, `npm run run:appimage` runs it in a podman container and shows its window on the Windows desktop through WSLg. The stream and camera addresses come from `ip_address` and `camera_config.host` in `vlc_rec_params.json`, or from `npm run run:appimage -- --stream 192.168.1.50:5000 --camera 192.168.1.50`. The container uses the host network, so the camera is reachable; its settings and recordings stay inside the container and are gone when the window closes.

## CI and GitHub Releases

- Pull requests and pushes to `main` run CI build (`npm ci` + `npm run build`).
- Pushing a version tag matching `v*` (for example `v0.1.0`) runs `npm run package` and publishes a GitHub Release with `vlc-rec-release.zip`, `vlc-rec-linux-x64.tar.gz` and `SHA256SUMS.txt`.
- The AppImage is not built in CI because of its size, so build it locally with `npm run package:appimage`. The step is commented out in `.github/workflows/ci-release.yml`.
- To save storage, CI uploads no separate build artifacts, and the release zip has one macOS binary, `vlc-rec-mac_universal`, which runs on both Intel and Apple Silicon.

Release trigger example:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Notes

- Enable **Automatically reconnect if the stream stalls** to restart VLC when the recording file stops growing. At startup the app measures the intervals between file growth events. After three complete intervals, the timeout becomes three times the longest of the last eight intervals, with a 3-second minimum and a default 15-second maximum. For example, regular growth every second gives a 3-second timeout; every 2 seconds gives 6 seconds. Until enough samples exist (including an empty or missing file at startup), the timeout remains 15 seconds. Learning continues during recording and resets for every new segment or checkbox change. The checkbox is saved in `vlc_rec_params.json` and is off by default.
- Automatic recording restarts use incrementing suffixes (`name_001.mkv`, `name_002.mkv`, etc.), skipping existing files. An initial name such as `name_007.mkv` continues at `name_008.mkv`. Recovery retains the original stream address, folder and format even if the input fields are edited during recording.
- Preview monitoring checks VLC's input-byte counter every 5 seconds: from the player's `stats` events, or from VLC's RC interface when VLC runs as an external program. If VLC provides no usable statistics, the status reports that preview stall detection is unavailable. Unexpected VLC process exits are also recovered in either mode. [VLC RC statistics implementation](https://github.com/videolan/vlc/blob/3.0.x/modules/control/oldrc.c).
- Failed reconnects and unexpected process exits retry after 5 seconds. Stop Recording / Stop Preview, closing the app, or disabling the checkbox cancels pending retries. Recovery waits for the previous VLC to exit before opening the next connection; each successful restart resets the displayed file size and elapsed time for the new segment.
- Recovery tries to stop VLC gracefully before forcing it to exit. MKV is preferable for interrupted streams: an MP4 segment may be unusable if VLC cannot finalize it.
- The app reads the stream's size, including non-square pixels and rotation, and sizes the preview to its aspect ratio. The settings panel goes beside or below the preview, whichever leaves the larger picture. While a stream runs, the panel collapses to the essentials (elapsed time, file size, status, the start/stop buttons) when the full panel would leave the preview less than 80% of the area it gets with the compact controls, typically when the window has about the same aspect ratio as the stream. The sliders button next to the start/stop buttons hides or shows the settings; that choice lasts until the automatic choice changes, for example when the stream stops.
- Use the **Scan** button next to the SRT input to open the scanner dialog.
- Scanner supports explicit mask input (for example: `192.168.1.*`) and automatic local-network scan when mask is empty.
- Scan runs asynchronously with configurable concurrency (default 25) and can be aborted manually or by selecting a found endpoint. Aborting is immediate.
- The scan probes each address with a real **SRT handshake** rather than a raw port probe. SRT runs over UDP, which has no handshake of its own, so a raw UDP port probe cannot distinguish a live listener from a silently dropped packet. Only endpoints that actually complete the handshake are listed.
- The handshake is performed with the first available of `ffprobe`, `ffmpeg`, or `vlc`. `ffprobe`/`ffmpeg` are much faster; VLC is the fallback and is throttled to a lower concurrency because it is heavier.
- On Linux/macOS the app requires `bash` for VLC remote control and for the VLC scan fallback. It is preinstalled on virtually every desktop distribution; if it is missing or installed in a non-standard location, set `bash_path` in `vlc_rec_params.json` to the full path of the bash executable.
- Configurable parameters in `vlc_rec_params.json`:
  - `srt_mode`: set to `"simulation"` to run without a real VLC process.
  - `auto_reconnect`: saved checkbox state (default `false`). Simulation mode does not run stall detection.
  - `stall_timeout_sec`: upper limit and startup fallback for the adaptive recording timeout, and fixed timeout for preview input progress (default `15`, minimum `5`). Allow enough time for normal stream buffering.
  - `bash_path`: path or name of the bash executable (default `"bash"`).
  - `scan_concurrency`: number of concurrent endpoint probes during a scan (default `25`, range 1-256).
  - `scan_timeout_ms`: SRT connect timeout per address during a scan (default `300`, range 100-5000). Dead hosts cost exactly this much each, so it drives both total scan time and how fast an abort completes. Raise it only if the scan misses a known endpoint on a slow or wireless network.

```json
{
  "srt_mode": "simulation",
  "bash_path": "/usr/bin/bash",
  "scan_concurrency": 25,
  "scan_timeout_ms": 300
}
```
