# VLC Stream Recorder (NeutralinoJS)

This is a NeutralinoJS port of the Python VLC Stream Recorder app.

## Features

- Preview SRT stream
- Record SRT stream to `mkv` or `mp4`
- Persist parameters in `vlc_rec_params.json`
- Simulation mode via `srt_mode: "simulation"` in params file
- File size + elapsed time updates every second
- Button state/label transitions for preview and recording
- Scan dialog for discovering reachable `IP:port` endpoints on local networks

## Requirements

- VLC in `PATH` for real mode.
- Node.js 18+.

## Setup

```bash
npm install
npm start
```

`npm install` runs `neu update` automatically to fetch Neutralino binaries and the client library.

## Build

```bash
npm run build
```

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

## CI and GitHub Releases

- Pull requests and pushes to `main` run CI build (`npm ci` + `npm run build`).
- Pushing a version tag matching `v*` (for example `v0.1.0`) runs `npm run package` and publishes a GitHub Release with `vlc-rec-release.zip` and `SHA256SUMS.txt`.

Release trigger example:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Notes

- Use the **Scan** button next to the SRT input to open the scanner dialog.
- Scanner supports explicit mask input (for example: `192.168.1.*`) and automatic local-network scan when mask is empty.
- Scan runs asynchronously with configurable concurrency (default 25) and can be aborted manually or by selecting a found endpoint. Aborting is immediate.
- The scan probes each address with a real **SRT handshake** rather than a raw port probe. SRT runs over UDP, which has no handshake of its own, so a raw UDP port probe cannot distinguish a live listener from a silently dropped packet. Only endpoints that actually complete the handshake are listed.
- The handshake is performed with the first available of `ffprobe`, `ffmpeg`, or `vlc`. `ffprobe`/`ffmpeg` are much faster; VLC is the fallback and is throttled to a lower concurrency because it is heavier.
- On Linux/macOS the app requires `bash` for VLC remote control and for the VLC scan fallback. It is preinstalled on virtually every desktop distribution; if it is missing or installed in a non-standard location, set `bash_path` in `vlc_rec_params.json` to the full path of the bash executable.
- Configurable parameters in `vlc_rec_params.json`:
  - `srt_mode`: set to `"simulation"` to run without a real VLC process.
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
