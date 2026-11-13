# Public and private camera plugins

## Public source and releases

The public implementation is `plugins/osc`. Its source provenance is described in [its README](../plugins/osc/README.md). The app and its public interface retain capability-driven PTZ, zoom, presets and optional AI controls. AI tests use a generic JSON Lines process with in-memory state; they do not simulate any vendor network protocol.

Only ids listed in `packaging/public-plugins.txt` can enter a public package. Native builds read that list. The package commands check the runtime tree and reject unexpected plugin payloads or private plugin settings before Neutralino copies `player`. AppImage and launcher packaging enforce the same boundary. A private adapter must not be built into `player/plugins` or `dist`.

`plugins/obsbot-tail2/`, `protocol/` and `private-artifacts/` are ignored by the parent repository. Previously generated local packages are preserved under `private-artifacts/before-plugin-split/`; they are not public release inputs. Ignoring a path does not remove previously committed history. Audit branch history before publication; do not merge a branch that contains private implementation commits.

## Recommended private Git workflow

Use a **separate sibling repository**, for example `../vlc-rec-obsbot-tail2-private`. Copy the preserved private folder there before initializing it. This keeps its Git history and files outside the public checkout, including when checking out an older branch that still tracked the original plugin path. No submodule is needed. Keeping a separate repository inside the ignored `plugins/obsbot-tail2` folder is an alternative after the public removal has been committed, but the sibling layout is recommended.

After copying and reviewing the private files in the sibling directory, initialize that separate repository explicitly:

```sh
git -C ../vlc-rec-obsbot-tail2-private init
git -C ../vlc-rec-obsbot-tail2-private add obsbot-tail2.c plugin.json build.sh .gitignore .gitattributes tests
git -C ../vlc-rec-obsbot-tail2-private commit -m "Keep enhanced camera adapter private"
```

Leave this repository without a remote for local-only history, or configure a separately created private remote. Push only from that repository. A private branch of the public repository is not an equivalent boundary: a branch/tag or mirror push can publish its objects. SDK material remains outside both repositories unless separately authorized.

The private `build.sh` writes its programs next to its manifest. The command below works with the currently preserved local folder; use the sibling path instead once migrated. With the native builder container already installed:

```sh
podman run --rm -v "$PWD/plugins/obsbot-tail2:/private" -w /private localhost/vlc-rec-player-builder:1 sh build.sh
```

Set `VLC_REC_PLUGIN_DIR` to the **parent directory** containing an installed `obsbot-tail2` id folder (for the currently preserved layout: the absolute path to `plugins`). For a sibling checkout with a different folder name, install its manifest and binaries in a separate runtime directory named `obsbot-tail2`, or use the settings-folder installation below. Choose that adapter in the app settings, or install its manifest and binaries into `<settings folder>/plugins/obsbot-tail2`. Existing enhanced-adapter settings remain valid when that adapter is installed. A legacy public id falls back to `osc` only when the external adapter is absent. The public AppImage finds externally installed adapters through the same interface; it never needs to bundle them.

This setup is opt-in: public build commands never initialize, commit or push an external repository.
