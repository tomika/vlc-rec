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

## Requirements

- Linux x64 AppImage: no VLC needed, see [Linux AppImage](#linux-appimage). Everything below applies to the other packages.
- VLC 3 installed. On Debian and Ubuntu also install `vlc-plugin-access-extra`, which provides SRT.
- Snap and Flatpak installations of VLC do not expose libVLC to the embedded player.
- On platforms without a player binary (macOS, Linux on ARM), VLC in `PATH`; VLC then opens its own window.
- Linux: start the app with `run-vlc-rec.sh`. It selects X11 or XWayland, which embedding needs. In development use `GDK_BACKEND=x11 npm start`.
- Node.js 18+.
- Building the player needs podman or docker.

## Setup

```bash
npm install
npm start
```

`npm install` runs `neu update` automatically to fetch Neutralino binaries and the client library.

## Build

```bash
npm run build:player   # builds player/ and the test stub in a container
npm run build
```

## Tests

```bash
npm test                 # unit tests
npm run test:e2e         # real app window with a libVLC stub, this OS
npm run test:e2e:real    # real app window with VLC 3 and ffmpeg, this OS
npm run test:e2e:linux   # Linux stub, X11 and Wayland runs in a container
npm run test:e2e:appimage # the built AppImage on several distributions, needs podman
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
