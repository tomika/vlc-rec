# Camera adapter interface

The app can control the camera that produces the SRT stream: turn it by clicking the picture, zoom, and open the camera's own control page. The app knows nothing about any camera. It talks to an **adapter**, a small separate program written for one camera model (or one protocol: OSC, VISCA, HTTP, ...), through a fixed interface. Anyone can write an adapter for their own camera and drop it into a folder; the app does not change.

**Status.** Interface version 1 is implemented: discovery by manifest, the JSON Lines protocol, the `hello`/`connect` handshake with capabilities, click to centre, continuous arrow-key drive with lease expiry and discrete turns, turning speed, relative zoom, absolute moves with presets 1 to 9 kept by the app, the camera's web page, and optional AI tracking with state polling and a visual indicator. The app draws only the controls that the capabilities declare. The first adapter is `plugins/osc/` (OBSBOT Tail 2 over its OSC interface). Sections marked **Planned** are the designed rest of the interface (focus, presets kept in the camera, image settings, actions such as formatting the SD card) and are not built; an adapter and the app ignore what they do not know, so they can be added without breaking version 1.

## Goals and non-goals

Goals

- Camera-neutral interface. The app never knows about OSC, VISCA, HTTP or any vendor.
- The operations are the ones a person needs at the preview: turn, zoom, and later focus, presets and settings, expressed in plain units instead of protocol bytes.
- A declared extension part for what a standard does not cover (SD card formatting, recording, vendor features). The UI can show new extensions without app changes (**Planned**).
- The adapter is separate: own folder, own build, own licence. The app has no compile-time or load-time dependency on it.
- Testable without a camera: an adapter can be tried by typing JSON at it, and the e2e tests drive the real one against a fake camera.

Non-goals

- Video. The stream still comes through the SRT and libVLC path. An adapter only controls the camera.
- Several cameras at once. One adapter and one camera; the protocol keeps room for a `camera` field later.
- Auto-update, download or marketplace for adapters.

## Why a separate process

The frontend runs in Neutralino. Its allow list is `app`, `os`, `filesystem`, and it has no socket API. Everything network-related already goes through `os.spawnProcess` (the native player, `ffprobe`, VLC). An adapter follows the same pattern:

- It can use UDP, TCP, HTTP, USB or whatever the camera needs, in any language.
- A crash or hang in an adapter cannot take the app down.
- The app talks to separately installed programs through stdin and stdout; their source and distribution are managed separately.
- External adapters are installed through `VLC_REC_PLUGIN_DIR` or the settings-folder `plugins` directory. Public release payloads are restricted to `packaging/public-plugins.txt`; installing a local adapter does not include it in a release.

Trade-off: an adapter written in Python or Node needs that runtime on the user's machine. A compiled adapter does not. This is the author's choice and does not affect the interface.

## Installing and finding adapters

An adapter is a folder named after its id, with a `plugin.json` and the files it needs:

```
plugins/
  osc/
    plugin.json
    osc-linux_x64
    osc-win_x64.exe
```

The app looks for `<dir>/<id>/plugin.json` in these folders, the first match wins:

1. `VLC_REC_PLUGIN_DIR` (environment variable; development and tests).
2. `plugins` in the settings folder (`NL_PATH`; in the AppImage this is the writable settings folder). This is where a user installs an adapter.
3. `plugins` beside the player (`player/plugins`, or `$VLC_REC_PLAYER_DIR/plugins`). This is what the app ships with.

Adapters are never downloaded by the app. Installing one means copying a folder, which is an explicit act by the user. The app runs the adapter with the user's rights, so: install only adapters you trust.

### Manifest

```json
{
  "interface": 1,
  "id": "osc",
  "name": "OBSBOT OSC",
  "version": "0.1.0",
  "command": {
    "win_x64": ["osc-win_x64.exe"],
    "linux_x64": ["./osc-linux_x64"]
  },
  "config": [
    { "key": "host", "label": "Camera address", "type": "string", "required": true },
    { "key": "hfov", "label": "Horizontal field of view at zoom 0, degrees", "type": "number", "default": 76 }
  ]
}
```

- `interface`: the major interface version the adapter implements. The app ignores an adapter whose major version it does not support.
- `id`: lower case letters, digits, `-` and `_`; the same as the folder name.
- `command`: the program and its arguments. The key is the system and architecture (`win_x64`, `linux_x64`, `linux_arm64`, `mac_arm64`), then the system alone (`win`, `linux`, `mac`), then `default`; the first that exists is used. The program is a path inside the adapter's folder (no `..`, no absolute path), and the working directory is that folder. An adapter written in a scripting language ships a small launcher (a shell script or a `.cmd`) as that program.
- `config`: the settings the adapter takes. Types: `string`, `int`, `number`, `bool`, `enum` (`values`), with `default`, `required`, `label`, optional `secret: true`. The app does not interpret them beyond filling defaults: the adapter receives them in `connect`. A field named `host` also lets the app move the camera when the user picks another stream address in the Scan dialog.

### Settings in `vlc_rec_params.json`

```json
{
  "camera_plugin": "osc",
  "camera_config": { "host": "192.168.1.50" },
  "camera_turn_speed": 10,
  "camera_zoom_step": 10,
  "camera_arrow_step_deg": 2,
  "camera_presets": { "1": { "pan": -20, "tilt": 5, "zoom": 0.5 } }
}
```

- `camera_plugin`: the id of the adapter; empty (the default) selects the sole usable adapter automatically. When several are available, the settings offer a choice.
- `camera_config`: what `connect` gets. Fields the manifest declares are taken from here, missing ones from the manifest's defaults. Edit the file for now (**Planned:** a form made from the manifest).
- `camera_turn_speed`: the speed of a turn after a click, in the unit of `ptz.speed` (degrees per second). The slider changes it.
- `camera_zoom_step`: percent of the zoom range per button press; a wheel notch is half of that.
- `camera_arrow_step_deg`: degrees per arrow key press.
- `camera_presets`: the presets 1 to 9 that the app keeps, see [Presets](#presets).

## Wire protocol

Transport: the adapter's stdin and stdout, UTF-8, one JSON object per line (JSON Lines), lines end in `\n`. Stdout carries protocol only; anything else goes to stderr, which the app ignores. Unknown fields are ignored. Unknown methods get an `unsupported` error.

Three kinds of message:

```json
{"id": 7, "method": "zoom.by", "params": {"delta": 0.1}}
{"id": 7, "result": {}}
{"id": 7, "error": {"code": "invalid_params", "message": "zoom.by needs a delta from -1 to 1."}}
{"event": "turned", "moved": true, "toPan": -31, "toTilt": 6, "durationMs": 1100}
```

- Requests come from the app and carry an integer `id`. Exactly one response (`result` or `error`) per request, in any order. `message` of an error is shown to the user, so it should say what to do.
- Events come from the adapter, have no `id`, and need no answer. They are flat objects: `event` and its fields.
- The app may send requests without waiting. An adapter that cannot handle concurrency queues them in order (the Tail 2 adapter reads one line at a time).
- Timeouts in the app: 3 s for a request, 6 s for `connect`, 30 s for the first `hello` (a program that is new on the machine can take ten seconds to start on Windows). A timeout is shown as a note ("did not answer ...") and does not stop the adapter.

### Error codes

| code | meaning |
|---|---|
| `unsupported` | The adapter does not do this. Also for any method it does not know. |
| `invalid_params` | Wrong type or out of range, or a config value that is wrong (the app does not ask `connect` again then). |
| `not_connected` | `connect` has not succeeded, or the link is down. |
| `busy` | Another operation is running, or a resource (a port) is in use. |
| `timeout` | The camera did not answer in time. |
| `device_error` | The camera reported a failure, or a command could not be sent. |
| `confirmation_required` | **Planned:** a destructive action without `confirmed: true`. |
| `internal` | Adapter bug. |

## Conventions

- Pan and tilt in degrees. Positive pan is to the camera's right, positive tilt is up, 0, 0 is straight ahead. The adapter converts from the camera's own sign convention.
- Zoom is normalized `0.0 .. 1.0`, wide to tele, of the range the camera really has. `zoom.by` takes a fraction of that range.
- Speed is in the unit the adapter declares in `capabilities.ptz.speed` (the Tail 2 adapter: degrees per second, 1 to 90).
- Every property with a range is described in `capabilities`; the app takes no limits from anywhere else.

## Lifecycle

```
app                                  adapter
 |-- hello {interface, app} --------->|
 |<-- result {interface, plugin} -----|
 |-- connect {config} --------------->|     (repeated every 5 s while it fails, unless invalid_params)
 |<-- result {capabilities} ----------|
 |<-- event state {connected} --------|
 |   ... requests and events ...      |
 |-- shutdown ------------------------>|     (on a restart the app waits 3 s, then ends the process)
 |<-- event stopped ------------------|
```

- `hello` gives the adapter the interface version the app speaks. The adapter answers with its own and may refuse (`unsupported`); then the app does not go on.
- `connect` takes the user's `config`. It resolves when the camera is reachable and identified, so the capabilities can reflect the actual model. On failure: an `error` with a message the user can act on. The app shows it and asks again after 5 s, because the camera may be switched on after the app; `invalid_params` (a wrong setting) is not asked again.
- The app uses nothing before `connect` has succeeded: no controls exist, and clicks and keys do nothing.
- A lost link: the adapter sends `event state {state: "lost", reason}`; the app hides the controls. The adapter reconnects itself and sends `event capabilities` when the camera is back.
- If the adapter process exits, the app shows "the camera adapter stopped" and hides the controls. **Planned:** restart with backoff.
- The app never blocks recording, preview or stall recovery on the adapter. Camera failures are shown as a note after the status text, for a few seconds.

## Methods (version 1)

All of `ptz.*`, `zoom.*` and `ai.*` are optional: the adapter declares what it supports in `capabilities`, and the app only calls what is declared.

| method | params | result | notes |
|---|---|---|---|
| `hello` | `interface`, `app` | `{interface, plugin: {id, name, version}}` | |
| `connect` | `config` | `{capabilities}` | Opens the link to the camera. May be called again after a failure. |
| `shutdown` | none | `{}` | Then the adapter exits. End of stdin also means shutdown. |
| `ptz.centerOn` | `x`, `y` (0..1, origin top left of the visible picture), `aspect` (width / height) | `{}` | Turn the camera so that the clicked point ends up in the middle. Needs `ptz.centerOn`. See [Click to centre](#click-to-centre). Outcome in `event turned`. |
| `ai.trackPerson` | `x`, `y` (0..1, origin top left) | `{}` | Request tracking of the person at the point. Needs `ai.trackPerson`. An asynchronous adapter may accept the request before target acquisition; success must not be presented as confirmed acquisition. |
| `ai.get` | none | `{enabled: boolean}` | Read the camera's current tracking mode. Needs `ai.status`. |
| `ai.stop` | none | `{}` | Turn off tracking. Needs `ai.stop`. Before applying a preset, the app waits until `ai.get` confirms tracking is off. |
| `ptz.nudge` | `pan`, `tilt` (degrees, right and up positive) | `{}` | A small turn by this much, meant for key repeat: it builds on the last target while that is recent, so it neither waits for a readout nor lets the readout jitter in. Needs `ptz.nudge`. Outcome in `event nudged`. |
| `ptz.setSpeed` | `value` | `{}` | The speed of `ptz.centerOn`, in the unit and range of `ptz.speed`. The app sends its saved speed after `connect`. |
| `ptz.get` | none | `{pan, tilt}` | Degrees. While a turn that was asked for is still running, the position it is going to, not the one on the way: a preset taught right after a click is the point of the click. Needs `ptz.absolute`. |
| `zoom.by` | `delta` (-1..1) | `{}` | Zoom in (positive) or out by this fraction of the range, clamped to the range. Builds on the last target while a previous zoom is still running. Needs `zoom.by`. Outcome in `event zoom`. |
| `zoom.get` | none | `{value}` | 0..1. While a zoom that was asked for is still running, the target. Needs `zoom.absolute`. |
| `ptz.moveTo` | `pan`, `tilt` (degrees, right and up positive) | `{}` | An absolute turn at the speed of `ptz.centerOn` (`ptz.setSpeed`). Needs `ptz.absolute`, which also means that `ptz.get` works. Outcome in `event turned`. |
| `zoom.set` | `value` (0..1) | `{}` | An absolute zoom, clamped to the range. Needs `zoom.absolute`, which also means that `zoom.get` works. Outcome in `event zoom`. |

## Capabilities

The result of `connect`, and re-sent as `event capabilities` when something changes (a different model behind the same address, the camera back after a loss). The app rebuilds the controls from the latest one. A missing block means "not supported": the app never calls a method whose block is missing, and the UI for it does not exist. Unknown keys are ignored, so an adapter may declare more than the app uses.

```json
{
  "device": { "model": "OBSBOT Tail 2", "address": "192.168.1.50" },
  "ptz": { "centerOn": "estimated", "nudge": true, "absolute": true,
           "speed": { "min": 1, "max": 90, "default": 10, "unit": "deg/s" },
           "pan": { "min": -159, "max": 159 }, "tilt": { "min": -62, "max": 62 } },
  "zoom": { "by": true, "absolute": true },
  "webPage": { "url": "http://192.168.1.50/" }
}
```

| key | what the app does with it |
|---|---|
| `device.model`, `device.address` | Shown in the camera block of the drawer. |
| `ptz.centerOn` | `"native"` (the camera does it) or `"estimated"` (computed from the optics): a click on the picture turns the camera. |
| `ai.trackPerson` | Double-click a person to request tracking. The first click waits for the configured interval before centering; a later double-click does not issue a tracking request. |
| `ai.status` and `ai.stop` | Poll actual tracking state, show a blue preview edge while enabled, and stop tracking on the next double-click or before applying a preset. |
| `ptz.nudge` | Discrete arrow steps when continuous drive is unavailable. |
| `ptz.continuous` | Hold arrow keys to drive; release stops. `{axes:"single",defaultSpeed:0.2}` declares a single axis and the default normalized velocity. |
| `ptz.absolute` | `ptz.get` and `ptz.moveTo` work: position presets. |
| `zoom.absolute` | `zoom.get` and `zoom.set` work: zoom presets. |
| `ptz.speed` | The turning speed slider, with `min` and `max`. |
| `zoom.by` | The `-` and `+` buttons and the mouse wheel zoom the camera. |
| `webPage.url` | The **Open web page** button opens it in the system's web browser (a plain `http` or `https` address only). |

The bar below the video (zoom buttons, speed slider) is drawn when `zoom.by` or `ptz.speed` is declared. The preset buttons exist when `ptz.absolute` or `zoom.absolute` is. The drawer's camera block shows what the camera is, the web page button, and a hint that lists the controls that exist.

## Events (version 1)

Events report what happened, whoever asked for it. The response to a request only says whether it was accepted; the outcome of a movement comes as an event, because the app acts on the facts (for example how long a turn takes).

| event | fields |
|---|---|
| `state` | `state`: `"connected"`, `"lost"` or `"error"`, and `reason?`. `lost` and `error` hide the controls until a `capabilities` event. |
| `capabilities` | `capabilities`: the full object, replacing the previous one. |
| `turned` | After `ptz.centerOn`: `moved`, `fromPan`, `fromTilt`, `toPan`, `toTilt` (degrees), `zoom` (0..1), `durationMs` (how long the turn takes at the speed in use). The app does not accept the next click until the turn is over and the picture, which lags behind the camera, has caught up. |
| `nudged` | After `ptz.nudge`: `toPan`, `toTilt`. |
| `zoom` | After `zoom.by`: `from`, `to` (0..1). |
| `speed` | After `ptz.setSpeed`: `value`. |
| `error` | `code`, `message`: something that is not the answer to a request, shown as a note. |
| `stopped` | The adapter is about to exit. |

**Planned:** `position {pan?, tilt?, zoom?, focus?}` when the camera reports movement, `props {values}`, `progress {action, fraction?, message?}` and `log {level, message}`.

## Presets

The presets belong to the app, not to the camera. A preset is a position (pan and tilt, degrees) and/or a zoom (0..1 of the range), kept in `camera_presets` of the settings file, and applying one is an absolute move: `ptz.moveTo` and/or `zoom.set`. So every adapter that declares `ptz.absolute` and `zoom.absolute` (and answers `ptz.get` and `zoom.get` with where the camera is, or is going) gets nine presets without a memory in the camera.

- **Keys.** `1` to `9` apply the preset. `Alt+<number>` teaches it from the camera as it is now: position and zoom, as far as the camera can. `Alt+Shift+<number>` teaches the position only, so that applying it only turns. `Alt+Ctrl+<number>` teaches the zoom only, so that applying it only zooms. `Alt+Ctrl+Shift+<number>` deletes it. Teaching replaces the preset whole. The digit is taken from the physical key (`KeyboardEvent.code`, also the keypad), because with Alt+Ctrl (AltGr on many layouts) the character is not the digit. Keys typed into a field, and keys while a dialog is open, are not taken.
- **Preset 0 is fixed.** It is the wide shot: pan and tilt 0, the camera straight ahead, and zoom 0, fully out. It is not in the settings and nothing teaches, changes or deletes it (`Alt+0` in any form says that it is fixed, and its menu has only Apply). It uses the same moves as the others, so a camera that can only turn or only zoom does what it can.
- **Buttons.** Ten buttons, 1 to 9 and then 0 as on the keyboard, in a row. Gray: empty. Blue: a position. Amber: a zoom. Half blue and half amber: both. A click applies the preset; a right click opens a menu with Apply, Teach (position and zoom, position only, zoom only) and Delete, with the keys written next to them. The row is in the bar below the video when the window is at least 900 px wide; otherwise, and beside the video, it is in the drawer. The menu hides the video while it is open over it (a page cannot draw over the native video window).
- **What is stored.** `{ "pan": -20, "tilt": 5, "zoom": 0.5 }`, or only the pan and tilt, or only the zoom. The presets belong to the camera in use: they are not tied to an address, so another camera needs its own. Sensible values only are read back (pan and tilt within 360 degrees, zoom 0..1).

## Click to centre

The user clicks a point in the preview and the camera turns so that the point moves to the middle of the picture. The app only reports where the click was; how the camera turns is the adapter's business, so a camera that can do it natively wins over an estimate.

- **App side.** The video is a native child window of `vlc-rec-player` over `#videoHost`. The player switches libVLC mouse input off, and the window passes mouse and key input to the page (checked on X11 and on sway with XWayland in the `camera` e2e scenario; on Windows the child window is `WS_DISABLED` for the same effect, unverified). The page listens for `pointerdown` on `#videoHost`, converts the position to the visible picture (the aspect ratio is known from the player's `video` event; the box is already fitted to it, so there are no bars; top left is 0,0) and sends `ptz.centerOn {x, y, aspect}` when the camera declares it. A click in the middle, a click while a stream is not running, and a click while the previous turn has not finished are not sent.
- **Native implementation.** If the camera can do it itself, the adapter passes the point on.
- **Estimated implementation.** Otherwise the adapter computes the rotation from the optics, with the pinhole model. Let `u = 2x - 1` and `v = 1 - 2y` be the offsets from the centre in half-frame units, `t = tan(HFOV / 2) / zoom_ratio` the half-width tangent at the current zoom, and `aspect` = width / height:

  ```
  ray in camera frame = (u * t,  v * t / aspect,  1)
  rotate the ray around the horizontal axis by the current tilt (the camera is already tilted, so pan and tilt are coupled)
  pan_target  = pan_now  + atan2(ray.x, ray.z)
  tilt_target = asin(ray.y / |ray|)
  ```

  then it moves the camera to the target, clamped to the range in `capabilities`. The inputs are the current pan, tilt and zoom (read from the camera) and the horizontal field of view at zoom 0, which belongs to the camera model and is an adapter setting that the user can calibrate (`hfov`; `tools/camera/calibrate-fov.js` measures it from the camera's own picture).
- **Limits of the estimate.** Lens distortion makes it less exact at the edges. The preview is behind the camera by the SRT latency, so a click while the camera is still moving refers to an older position; that is why the app waits for the end of a turn. An adapter may also refuse while the camera is moving or tracking something (answer `busy`). One more click corrects the remaining error.

## Writing an adapter

1. Make a folder `<id>/` with a `plugin.json` (see above) and the program.
2. Read requests from stdin line by line, write one response per request to stdout, and flush after every line. Write nothing else to stdout.
3. Implement `hello`, `connect` and `shutdown`. In `connect`, open the link to the camera, check that it answers, and return the capabilities that this camera has. Fail with an error and a message that tells the user what to do.
4. Implement the operations you declared. Report outcomes with the events above.
5. Exit when stdin ends.

A complete adapter that only knows how to zoom (Node.js; the manifest names a program in the folder, so the folder also holds a launcher that runs `node adapter.js`):

```js
const readline = require("node:readline");
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let zoom = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "hello") return send({ id, result: { interface: 1, plugin: { id: "demo", name: "Demo", version: "0.1" } } });
  if (method === "connect") return send({ id, result: { capabilities: { device: { model: "Demo" }, zoom: { by: true } } } });
  if (method === "zoom.by") {
    const to = Math.min(1, Math.max(0, zoom + params.delta));
    send({ event: "zoom", from: zoom, to });
    zoom = to;
    return send({ id, result: {} });
  }
  if (method === "shutdown") { send({ id, result: {} }); process.exit(0); }
  send({ id, error: { code: "unsupported", message: "No such method." } });
});
```

Try an adapter by hand: `echo '{"id":1,"method":"hello","params":{"interface":1}}' | ./adapter`. `tests/e2e/camera-plugin.js` shows how the Tail 2 adapter is driven against a fake camera in a container.

## App side

The camera code is in `src/frontend/app.js` (the app is one script, so there is no separate module): finding the adapter (`findPlugin`, `pluginCommand`), the request layer (`cameraRequest`, ids and timeouts), the handshake (`startCamera`, `connectCamera`), capability gating (`cameraCan`, `showCameraControls`, `showCameraPage`), and the controls (`turnCameraTo`, `zoomCamera`, `handleArrowKey`, the speed slider). The unit tests in `tests/reconnect.test.js` (`camera:`) play the adapter by reading the requests the app wrote and feeding answers back.

- All camera calls fail soft. Errors go to a note after the status text, not into a modal. **Planned:** destructive actions always get a confirmation dialog.
- `nativeAllowList` already covers `os.*`, so no config change is needed.

## Continuous pan/tilt drive (implemented)

`ptz.continuous` declares `ptz.move {pan, tilt, ttl_ms?}` and `ptz.stop {}`. Velocities are normalized -1..1, positive right/up. TTL defaults to 1000 ms; the OSC adapter accepts 200-2000 ms. `{axes:"single",defaultSpeed:0.2}` means that only one nonzero axis is accepted and gives the default keyboard velocity. The app uses the most recently pressed arrow and sends a heartbeat every TTL/3 after acknowledgement; release, focus loss, Scan and shutdown stop the drive. Shift multiplies velocity by five, capped at one. Adapters must stop autonomously on expiry, shutdown and EOF, including when stdin contains an incomplete line. Identical renewals must not resend the hardware start command.

The OSC adapter maps velocity magnitude to the documented 1-100 direction speed, and stops with a single zero direction command. `camera_config.driveSpeed` defaults to 20 percent and supplies `defaultSpeed`. This is separate from the degree-per-second speed of absolute turns. Other device operations supersede and stop manual drive before blocking reads; AI status polling in the app pauses while a key is held.

## Planned: the rest of the interface

None of this exists in the app or in the Tail 2 adapter yet. It is the design that version 1 was cut from, kept so that adapters written now fit it later. Methods and capability blocks are added the same way as the ones above: an adapter declares them, the app offers them.

### Remaining drive methods

| method | params | notes |
|---|---|---|
| `ptz.home` | none | Back to the home position. |
| `zoom.move` | `speed` (-1..1), `ttl_ms?` | Continuous, positive is tele. 0 stops. |

An app side pad would start `ptz.move` on pointer down, send a heartbeat at a third of `ttl_ms`, and `ptz.stop` on pointer up, leave or window blur.

### Focus: `focus`

| method | params | notes |
|---|---|---|
| `focus.setMode` | `mode`: `"auto"` or `"manual"` | |
| `focus.move` | `speed` (-1..1), `ttl_ms?` | Continuous, positive is far. |
| `focus.set` | `value` (0..1) | Absolute, manual mode only. |
| `focus.get` | none | Returns `{mode, value}`. |

### Presets in the camera: `preset`

`preset.save {index}`, `preset.recall {index}`, `preset.clear {index}`. `capabilities.presets.count` tells how many exist; optional `labels` for named presets. These are for cameras that have a memory of their own; the presets 1 to 9 that the app has today are its own (see [Presets](#presets)) and need no such memory.

### Image settings: `props`

Everything else VISCA exposes (exposure mode, gain, shutter, brightness, backlight, white balance mode, red and blue gain) is described as a list of **properties** instead of a method per setting. This keeps the interface small, and the same mechanism carries vendor properties (AI tracking mode, auto zoom framing, and so on).

- `props.get {ids?}` returns `{values: {id: value}}`. Without `ids`, all properties.
- `props.set {values: {id: value}}` applies one or more. The response lists the values actually applied (the camera may clamp or snap, e.g. shutter speeds), so the UI shows the truth.

A property descriptor:

```json
{ "id": "exposure.mode", "label": "Exposure", "group": "exposure",
  "type": "enum", "values": [{"value": "auto", "label": "Auto"}, {"value": "manual", "label": "Manual"}] }
{ "id": "exposure.shutter", "label": "Shutter", "group": "exposure",
  "type": "enum", "values": [{"value": "1/50"}, {"value": "1/100"}], "enabledWhen": {"exposure.mode": "manual"} }
{ "id": "wb.temperature", "label": "Colour temperature", "group": "white balance",
  "type": "range", "min": 2000, "max": 10000, "step": 100, "unit": "K" }
{ "id": "tracking.enabled", "label": "AI tracking", "group": "tracking", "type": "bool" }
```

- Types: `bool`, `range` (`min`, `max`, `step`, `unit`), `enum` (`values` as `{value, label?}`), `text` (read-only status).
- `group`: UI section. `readOnly: true` for values that only report.
- `enabledWhen`: simple `{id: value}` condition so the UI can grey out the manual shutter in auto mode.
- Recommended ids so the app can place well-known ones sensibly: `exposure.mode`, `exposure.gain`, `exposure.shutter`, `exposure.compensation`, `exposure.backlight`, `wb.mode`, `wb.temperature`, `wb.red`, `wb.blue`, `image.mirror`, `tracking.enabled`, `tracking.mode`, `tracking.speed`, `tracking.framing`. A plugin may add any other id with its own prefix.

Property changes made on the camera itself (remote, menu, another controller) arrive as `event props {values}`.

### Extension part: actions

Actions are operations that are not settings and not motion: formatting a card, starting a camera-side recording, taking a snapshot, rebooting. They are declared, so the app renders them without knowing them.

```json
{ "id": "storage.format", "label": "Format SD card", "group": "storage",
  "destructive": true, "slow": true,
  "confirm": "All recordings on the camera's SD card will be erased.",
  "params": [] }
```

- `actions.invoke {id, params?, confirmed?}` runs one. The response is `{message?}` on success.
- `destructive: true`: the app **always** shows a confirmation dialog with the `confirm` text (default text if missing) and only then sends `confirmed: true`. The plugin **must** return `confirmation_required` when `confirmed` is not exactly `true`. Two independent checks, because the cost of getting this wrong is an erased card.
- Even confirmed, a plugin should refuse destructive actions while the camera reports it is recording, with `busy`.
- `slow: true`: longer timeout, and the app shows a "working..." state. Progress is optional: `event progress {action, fraction, message}`.
- `params`: same field descriptors as the manifest `config` (string, int, bool, enum), rendered as a small form.
- Actions can be `enabledWhen` like properties.

Well-known action ids. The app may show these in dedicated places. All others get generic buttons in their `group`.

| id | meaning |
|---|---|
| `storage.format` | Format the camera's storage. Destructive. |
| `storage.info` | Not an action, see below. |
| `record.start`, `record.stop` | Camera-side recording. |
| `snapshot` | Take a still picture. |

### Status values

Read-only values the camera reports are properties with `readOnly: true` (`type: "text"` or `range`). Recommended ids: `storage.state` (`none`, `ready`, `full`, `error`), `storage.total` and `storage.free` (bytes), `record.state`, `device.model`, `device.firmware`, `device.battery`. They update through `event props`. This avoids a second mechanism, and the camera panel can show them as a status line.

## Reference implementation

`plugins/osc/` is the first adapter: `plugin.json` and `osc.c` (C without dependencies: OSC over UDP, the geometry of the click, a small JSON reader). `native/build.sh` builds it for Linux and Windows into `player/plugins/osc/` together with its manifest, `neutralino.config.json` copies `player/` into the application, and the AppImage and Linux launcher packaging copy the folder for their architecture. Its config: `host` (required), `hfov`, `zoomRatio`, `zoomMax`, `nudgeSpeed`, `oscPort`, `localPort` (see its manifest). `tools/camera/fake_osc_camera.py` is a fake Tail 2 for the tests, and `tests/e2e/camera-plugin.js` runs the adapter against it.

## Measured on a real Tail 2 over OSC (2026-11-11)

These change how an OSC mapping has to be built:

- **The four `SetGimbal*` speed commands are not independent.** The camera acts on the last one received: `Right 20` followed by `Up 20` moves only tilt. A `0` on any of them is "gimbal stop moving". So `ptz.move` with both `pan` and `tilt` non-zero cannot be done with speeds. A diagonal drive has to be done with absolute targets (`ptz.moveTo` with the target at the limit in the wanted direction), or the plugin declares `ptz.continuous` as single axis only. Sending zeros for the unused directions right after a move command cancels the move; zeros belong only in `ptz.stop`.
- **`GetGimbalPosInfoResp` carries two values here, not three**: `A` = tilt (pitch), `B` = pan (yaw), degrees, in this order. The plugin has to accept two or three values (last two are pitch, yaw).
- **`SetGimMotorDegree (speed, pan, tilt)` uses the same numbers as that readout** and lands within about 1 degree (the readout itself jitters by 1). 10 degrees take about 0.4 s at speed 30.
- **Signs:** `Right` and `Up` make the readout values smaller, so pan and tilt angles grow towards left and down. The plugin hides this behind its `pan`/`tilt` convention (right and up positive in the interface). Inferred from the command names; to be confirmed against the picture.
- **One `SetGimMotorDegree` moves both axes at the same speed, so the axis with the shorter way arrives first** (24 and 6 degrees at 10 degrees per second: 2.4 s and 0.6 s). Cutting the move into targets 100 ms apart along the straight line, with the speed of each command only a ceiling a little above the wanted rate, made both axes arrive within 0.2 s of each other (measured through the helper on a real Tail 2, against 1.2 to 1.8 s with one command), **but the picture was jerky** (judged by eye): the targets are whole degrees, so the short axis moves in steps of one degree, and each new target restarts the motion. The camera has one speed per command and whole degree targets, so a smooth, simultaneous diagonal is not possible over this interface; the helper sends one command and accepts that the short axis stops first.
- **The `speed` of `SetGimMotorDegree` is about degrees per second** (3 gave 3.2, 10 gave 10.5, 30 gave 32, 60 gave 71); the turn starts 150 to 500 ms after the command.
- **Relative moves must not feed the jitter back**: a relative turn that sends the current reading as part of the target let the tilt of a pure pan creep by 1 degree per step. The median of three readings removed it. `ptz.centerOn` has the same issue and should compute from an averaged position and, for an axis that does not change, keep the last commanded value.
- Zoom commands behave as documented (`SetZoomMin/Max` move at about 12 percentage points per second; the reply carries `fov=-1`, i.e. no field of view value, so the horizontal field of view for click-to-centre has to come from the plugin setting).

## Open decisions

1. Interpreters in `command`. Today the first element is a program inside the adapter's folder, so an adapter written in Python or Node ships a small launcher script. Allowing `["python3", "adapter.py"]` would be simpler for authors and needs a rule for what may be started.
2. A form for `camera_config` made from the manifest's `config` fields. Until then the settings file is edited by hand.
3. Restarting an adapter that exits, with backoff.
4. Several cameras. Not in version 1. If needed: `camera` as an id string on every request and event, and `cameras` in the connect result.
5. Passwords for cameras that need one. The `secret: true` config flag exists, but where the app would store it (the settings file is plain text) is undecided.

## Public and external implementations

`plugins/osc` is the bundled public implementation of documented OSC PTZ and zoom operations. It does not implement AI selection or status. The `ai.trackPerson`, `ai.get` and `ai.stop` methods above belong to the app contract and can be implemented by independently installed adapters. AI tests use an in-memory JSON Lines fixture, without a device transport. No SDK packet layouts, endpoint paths or vendor SDK declarations are part of this specification. See [plugin separation](plugin-separation.md).
