# Bundled Windows VLC runtime

`npm run build:vlc` downloads the official portable VLC 3.0.24 Windows x64 ZIP and the matching VLC source archive. Both SHA-256 values are pinned in `packaging/windows-vlc.json`; a checksum mismatch stops the build. Verified downloads are cached in the OS temporary directory (`vlc-rec-downloads`), or in `VLC_REC_DOWNLOAD_CACHE`. The generated `vlc/` directory is ignored by Git.

Build and package commands prepare this runtime automatically before Neutralino copies its payload. The release ZIP contains the upstream portable directory, its VLC modules, license notices, an LGPL text and the matching VLC source archive. `vlc/SOURCES.md` identifies the downloads and dependency-source locations; the source tarball includes the corresponding contrib recipes, URLs, checksums and patches. Upstream files retain their original licenses, including GPL-covered modules; this packaging does not assign a new license to the application.

The helper loads in this order: explicit `VLC_REC_LIBVLC_DIR`, `../vlc` relative to the helper executable, then the installed VLC registry/PATH fallbacks. A present but invalid bundled DLL is an error. Runtime plugin and dependency searches use the selected runtime directory. The scan also uses the bundled `vlc.exe` without needing it on PATH.

The Windows runtime is x64. The Linux launcher bundles and AppImage keep their existing runtime paths and do not copy Windows DLLs.

To request software decoding explicitly, set `VLC_REC_VLC_ARGS=--avcodec-hw=none`. This selection is applied to the media as well as the VLC instance; default hardware selection is unchanged. The Windows integration probe decodes a generated local video without a window or camera.

On Windows, `npm run test:windows-vlc` builds a headless integration probe and decodes a generated local MPEG-TS stream using the bundled DLLs from a path containing spaces. It also checks that the explicit runtime override takes precedence. No camera or app window is used.
