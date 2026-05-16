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

## Notes

- Use the **Scan** button next to the SRT input to open the scanner dialog.
- Scanner supports explicit mask input (for example: `192.168.1.*`) and automatic local-network scan when mask is empty.
- Scan runs asynchronously with concurrency 25 and can be aborted manually or by selecting a found endpoint.
- To use simulation mode, set this in `vlc_rec_params.json`:

```json
{
  "srt_mode": "simulation"
}
```
