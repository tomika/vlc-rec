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
- Optional camera control through capability-driven adapters, with camera preview, controls and status readouts when an adapter supports them. See [Camera control](#camera-control).

## Requirements

- Windows x64 release ZIP: includes a pinned portable VLC 3 runtime in `vlc/`; keep that folder beside the app executable when extracting. No separate VLC installation is needed.
- Linux x64 AppImage: no VLC needed, see [Linux AppImage](#linux-appimage). The remaining VLC installation requirements apply to packages without a bundled runtime.
- Other packages and development without a bundled runtime: VLC 3 installed. On Debian and Ubuntu also install `vlc-plugin-access-extra`, which provides SRT.
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

Camera adapters are optional programs discovered from their manifests. The app shows only controls supported by the connected adapter; see [the camera plugin interface](docs/camera-plugin-interface.md) to add an adapter.

- **Preview source:** when an adapter offers a browser preview, choose **SRT** or **Camera** beside the preview controls. Selecting a source while idle starts preview; changing source during preview restarts preview with the selected picture. The camera view uses a session-specific WebSocket bound to the local machine and a browser decoder; the camera transport stays inside its adapter. During local SRT recording, source changes affect only the displayed picture and do not stop or split the recording. If camera preview is unavailable, the app returns to SRT preview and reports the reason.
- **Center and Auto:** right-click the visible preview to center the camera immediately. Double-click with the left mouse button to toggle **Auto** tracking when the adapter supports it. A single left click does nothing. With the pointer over the visible video, press `C` to center or `A` to toggle Auto. These shortcuts ignore editable fields, modifiers, dialogs, and pointers outside the picture.
- **Speed:** the **Turn speed** slider displays 1–100%. New adapters use a normalized speed; adapters that advertise another speed unit keep their own range, with the percentage mapped across that range. The slider saves `camera_turn_speed_percent` in `vlc_rec_params.json`. Older `camera_turn_speed` values are migrated using the former 1–90 scale after adapter capabilities arrive.
- **Zoom and arrows:** use the mouse wheel or `-` / `+` buttons to zoom. Arrow keys pan or tilt; hold to drive continuously when supported, release to stop. Shift makes motion faster. Adapters without continuous drive use discrete steps.
- **Presets:** number keys 1–9 apply presets; `Alt+number` teaches one, `Alt+Shift+number` teaches position only, `Alt+Ctrl+number` teaches zoom only, and `Alt+Ctrl+Shift+number` deletes it. Preset 0 is the fixed centered, wide view. Applying a position preset stops Auto tracking before the camera moves. A zoom-only preset changes zoom and leaves tracking alone. With Camera preview, right-click a preset in either the compact bar or settings to open its menu over the picture. With native SRT video, use the settings row; its menu stays clear of the VLC window.
- **Camera information and storage:** capable adapters can show battery, card capacity/free space, estimated recording time, and camera recording status. One recording button changes between **Start camera recording** and **Stop camera recording** with the confirmed state. It controls the camera recorder independently of the app's SRT recording. If supported, **Format SD card** asks for explicit erase confirmation before sending the request. Formatting may take time; after adapter acceptance, the app waits for an observed completion transition and never treats a changed free-space value alone as success. Completion, failure, timeout, and lost-connection results appear in the visible status and drawer. One power button changes between **Power camera on** and **Power camera off**. Both buttons show progress while awaiting confirmation. Power-on remains available when status is unknown, while power-off needs a fresh known-on state and a fresh camera-recording-off status. Stop camera recording before powering off. If an SRT recording is active, the app asks before power-off because the camera may supply that stream. The camera's **Open web page** button also opens its advertised page in your system browser.

Settings in `vlc_rec_params.json`:

- `camera_plugin`: selected adapter id; empty selects the only available adapter automatically. `camera_config` contains that adapter's manifest-defined settings.
- `camera_turn_speed_percent`: turning speed from 1 to 100 percent (default `25`), mapped to the adapter's advertised speed range.
- `camera_zoom_step`: percent of the zoom range per button press (default `10`); a wheel notch is half of that.
- `camera_arrow_step_deg`: step in degrees for adapters without continuous drive (default `2`).
- `camera_presets`: presets saved by the app, for example `{ "1": { "pan": -20, "tilt": 5, "zoom": 0.5 } }` (angles in degrees; zoom is 0 to 1 of the adapter's range).

The old `camera_double_click_ms` setting is ignored. Auto gestures use the operating system's native left-button double-click detection; right-button centering has no delay.

**Preview SRT buffer** controls buffering of the SRT picture. It does not affect the **Camera (low latency)** preview.

After confirming SD formatting, a wait dialog shows progress until completion, failure, or timeout. It blocks camera controls and covers the preview while the operation is pending; Escape does not cancel formatting on the camera. The result remains visible in the camera status after the dialog closes.

A camera adapter with a `host` setting uses the saved stream IPv4 address if its configured host is empty. Editing the stream address or choosing a Scan result updates that setting and restarts the adapter.
## Setup

```bash
npm install
npm start
```

`npm install` runs `neu update` automatically to fetch Neutralino binaries and the client library.

## Build

```bash
npm run build:player   # builds players/adapters; prefers MSVC on Windows, container for Linux
npm run build:test-stubs # builds the libVLC test doubles needed for stub end-to-end tests
npm run build
```

Windows binaries use MSVC x64 when available on a Windows host. The build searches an initialized developer environment, Visual Studio Installer's `vswhere.exe`, `VSINSTALLDIR`, and standard Visual Studio directories under Program Files, then loads `vcvars64.bat` automatically. No PATH setup is needed. If MSVC is absent, it uses the existing MinGW-w64 container build. Set `VLC_REC_WINDOWS_COMPILER=auto|msvc|mingw` to choose explicitly. Compilation errors from a discovered MSVC toolchain stop the build. Linux builds still require podman or docker. Test-stub and Windows integration-probe builds follow the same compiler selection.

The optional browser HEVC fallback decoder is built from its pinned upstream source with `node scripts/build-preview-decoder.js` (podman or docker and network access required). Its source wrapper and worker are in `src/frontend/preview-decoder/`; the app first tries browser WebCodecs when the browser can decode the stream.

## Tests

```bash
npm test                 # unit tests
npm run test:e2e         # real app window with a libVLC stub, this OS
npm run test:e2e:real    # real app window with VLC 3 and ffmpeg, this OS
npm run test:e2e:linux   # Linux stub, X11 and Wayland runs in a container
npm run test:e2e:appimage # the built AppImage on several distributions, needs podman
node tests/e2e/camera-plugin.js   # the bundled camera adapter against an isolated camera simulator
E2E_ONLY=camera node tests/e2e/run-linux.js x11   # camera right-clicks, wheel and keys in a real window
E2E_ONLY=browser-preview node tests/e2e/run-linux.js x11   # browser HEVC, tracking overlay and uninterrupted SRT recording
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

### External camera implementations

The release builds contain only adapters listed in `packaging/public-plugins.txt`. See [plugin separation](docs/plugin-separation.md) for public-source boundaries, private development and installation. The generic app interface and AI controls do not implement a vendor protocol.

Windows runtime downloads, licensing/source files and DLL selection are documented in [Windows runtime packaging](docs/windows-runtime.md).


On Windows the embedded player matches its parent window's DPI awareness, maps browser pixels into the parent client coordinates, and applies resize/show commands on the window thread. When WebView2 exposes its input window, the video is parented there so mouse and keyboard input reaches the page.

On Windows, scan timeout and Abort terminate the verifier process tree, including VLC, before closing its launcher shell. Unreachable SRT hosts therefore cannot leave headless VLC processes running after a scan.
