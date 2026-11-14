# Bundled and externally installed camera adapters

The bundled implementation is `plugins/osc`; its [source boundary](../plugins/osc/README.md) describes the documented OSC operations it uses. The application interface is independent of the adapter's device transport. It supports optional AI tracking through capabilities without implementing a device-specific AI protocol.

## Release contents

Only adapters listed in `packaging/public-plugins.txt` enter this project's releases. Native builds read that list, and package checks reject unexpected runtime files and unlisted adapters. AppImage and launcher packaging enforce the same boundary.

## External adapters

An external adapter is a folder named after its manifest id, containing its manifest and programs. Install it in the settings folder's `plugins` directory or set `VLC_REC_PLUGIN_DIR` to the directory containing those adapter folders. The app scans these locations at startup. A sole available adapter is selected automatically; settings offer a selector when several are available.

External implementations have their own source, build and distribution. They are not dependencies of this repository and are not included by the release commands. No particular external implementation or directory layout is required. See [the adapter interface](camera-plugin-interface.md) for all public capabilities, including AI tracking.

The AI UI tests use a generic JSON Lines fixture that keeps state in memory. It does not implement any device network protocol.
