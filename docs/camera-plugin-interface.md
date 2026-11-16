# Camera adapter interface

The app can control the camera that produces the SRT stream: turn it by clicking the picture, zoom, and open the camera's own control page. The app knows nothing about any camera. It talks to an **adapter**, a small separate program written for one camera model (or one protocol: OSC, VISCA, HTTP, ...), through a fixed interface. Anyone can write an adapter for their own camera and drop it into a folder; the app does not change.

**Status.** Interface version 1 implements manifest discovery, JSON Lines, capability negotiation, Center/Auto image actions, continuous drive with lease expiry, percentage turning speed, zoom, app presets, and optional AI tracking. Optional extensions provide browser preview, battery/storage telemetry, confirmed card formatting, camera-side recording and remote power controls. The app draws only declared capabilities. The public `plugins/osc/` adapter implements documented OSC operations; other adapters may implement more. Sections marked **Planned** cover remaining general focus, camera presets, image properties and arbitrary actions, without changing interface major version 1.

## Goals and non-goals

Goals

- Camera-neutral interface. The app never knows about OSC, VISCA, HTTP or any vendor.
- The operations are the ones a person needs at the preview: turn, zoom, and later focus, presets and settings, expressed in plain units instead of protocol bytes.
- A declared extension part for what a standard does not cover (SD card formatting, recording, vendor features). The UI can show new extensions without app changes (**Planned**).
- The adapter is separate: own folder, own build, own licence. The app has no compile-time or load-time dependency on it.
- Testable without a camera: an adapter can be tried by typing JSON at it, and the e2e tests drive the real one against a fake camera.

Non-goals

- Recording transport. SRT recording stays on the existing player path. An optional adapter preview is an independent display source and never replaces the recording input.
- Several cameras at once. One adapter and one camera; the protocol keeps room for a `camera` field later.
- Auto-update, download or marketplace for adapters.

## Why a separate process

The frontend runs in Neutralino. Its native allow list covers app, process and filesystem APIs, not raw TCP/UDP. Device networking runs in a separately spawned adapter. A standard browser WebSocket to the adapter's loopback preview session carries video; it is separate from the native API allow list. An adapter follows this pattern:

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
  "camera_turn_speed_percent": 25,
  "camera_zoom_step": 10,
  "camera_arrow_step_deg": 2,
  "camera_presets": { "1": { "pan": -20, "tilt": 5, "zoom": 0.5 } }
}
```

- `camera_plugin`: the id of the adapter; empty (the default) selects the sole usable adapter automatically. When several are available, the settings offer a choice.
- `camera_config`: what `connect` gets. Fields the manifest declares are taken from here, missing ones from the manifest's defaults. Edit the file for now (**Planned:** a form made from the manifest).
- `camera_turn_speed_percent`: turn speed from 1 to 100; the app maps it to `ptz.speed`. Legacy `camera_turn_speed` settings migrate from the previous 1–90 scale when capabilities arrive.
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
| `confirmation_required` | A destructive action without `confirmed: true`. |
| `internal` | Adapter bug. |

## Conventions

- Pan and tilt in degrees. Positive pan is to the camera's right, positive tilt is up, 0, 0 is straight ahead. The adapter converts from the camera's own sign convention.
- Zoom is normalized `0.0 .. 1.0`, wide to tele, of the range the camera really has. `zoom.by` takes a fraction of that range.
- New adapters describe turn speed as `ptz.speed {min:0.01,max:1,default:0.25,unit:"normalized"}`. `ptz.setSpeed.value` then means a fraction of the usable turning speed, not a calibrated number of degrees per second. The app displays 1–100%. Legacy adapters advertising a different unit retain their original range; the app maps the percentage to that range.
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
| `ai.stop` | none | `{}` | Turn off tracking. Needs `ai.stop`. Before applying a position preset, the app waits until `ai.get` confirms tracking is off. |
| `ptz.nudge` | `pan`, `tilt` (degrees, right and up positive) | `{}` | A small turn by this much, meant for key repeat: it builds on the last target while that is recent, so it neither waits for a readout nor lets the readout jitter in. Needs `ptz.nudge`. Outcome in `event nudged`. |
| `ptz.setSpeed` | `value` | `{}` | The speed of `ptz.centerOn`, in the unit and range of `ptz.speed`. The app sends its saved speed after `connect`. |
| `ptz.get` | `actual?` (boolean) | `{pan, tilt}` | Degrees. By default an active turn reports its target, so a preset taught just after Center stores that target. `actual:true` requests measured feedback and requires `ptz.feedback`. Needs `ptz.absolute`. |
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
| `ai.trackPerson` | Left-double-click a person, or press A with the pointer over that person, to request tracking. |
| `ai.status` and `ai.stop` | Poll actual tracking state, show a blue preview edge while enabled, and stop tracking on the next Auto action or before applying a preset that changes position. Zoom-only presets preserve tracking. |
| `ptz.nudge` | Discrete arrow steps when continuous drive is unavailable. |
| `ptz.continuous` | Hold arrow keys to drive; release stops. `{axes:"single",defaultSpeed:0.2}` declares a single axis and the default normalized velocity. |
| `ptz.absolute` | `ptz.get` and `ptz.moveTo` work: position presets. |
| `ptz.feedback` | `ptz.get {actual:true}` returns the measured position while moving. Without it, callers use the default target-preserving `ptz.get` contract. |
| `zoom.absolute` | `zoom.get` and `zoom.set` work: zoom presets. |
| `ptz.speed` | The 1–100% turning speed slider, mapped to the advertised `min`, `max` and `unit`. |
| `preview.format` | Optional independent browser preview; currently `"hevc-annexb-v1"`. Enables the SRT / Camera preview selector. |
| `telemetry.battery`, `telemetry.storage` | Optional battery/card readouts from `telemetry.get`; absent or stale values are unknown. |
| `telemetry.recording`, `telemetry.power` | Optional camera recording and remote power state from `telemetry.get`. |
| `storage.format` | Enables explicit SD-format confirmation and `storage.format {confirmed:true}`. |
| `record.start`, `record.stop` | Enables independent camera-side recording controls. |
| `power.on`, `power.off` | Enables explicit remote camera power controls; `mode:"remote"` describes the operation without promising standby or wake-on-LAN. |
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

Applying a zoom-only preset calls `zoom.set` without calling `ai.stop` or changing AI mode. A preset containing position first stops tracking and waits for confirmation that it is off, then performs its position and optional zoom changes.

- **Keys.** `1` to `9` apply the preset. `Alt+<number>` teaches it from the camera as it is now: position and zoom, as far as the camera can. `Alt+Shift+<number>` teaches the position only, so that applying it only turns. `Alt+Ctrl+<number>` teaches the zoom only, so that applying it only zooms. `Alt+Ctrl+Shift+<number>` deletes it. Teaching replaces the preset whole. The digit is taken from the physical key (`KeyboardEvent.code`, also the keypad), because with Alt+Ctrl (AltGr on many layouts) the character is not the digit. Keys typed into a field, and keys while a dialog is open, are not taken.
- **Preset 0 is fixed.** It is the wide shot: pan and tilt 0, the camera straight ahead, and zoom 0, fully out. It is not in the settings and nothing teaches, changes or deletes it (`Alt+0` in any form says that it is fixed, and its menu has only Apply). It uses the same moves as the others, so a camera that can only turn or only zoom does what it can.
- **Buttons.** Ten buttons, 1 to 9 and then 0 as on the keyboard, in a row. Gray: empty. Blue: a position. Amber: a zoom. Half blue and half amber: both. A click applies the preset; a right click opens a menu with Apply, Teach (position and zoom, position only, zoom only) and Delete, with the keys written next to them. Full settings show the row in the drawer; compact mode uses the bar. During browser camera preview, both rows offer menus, which may overlay the video and remain within the viewport. During native SRT display, only the settings row offers a menu, bounded to the visible drawer so VLC stays visible. Switching back to SRT or falling back after a browser preview failure closes any HTML overlay before restoring the native video window.
- **What is stored.** `{ "pan": -20, "tilt": 5, "zoom": 0.5 }`, or only the pan and tilt, or only the zoom. The presets belong to the camera in use: they are not tied to an address, so another camera needs its own. Sensible values only are read back (pan and tilt within 360 degrees, zoom 0..1).

## Click to centre

The user right-clicks a point in the preview, or presses C while the pointer is over it, and the camera immediately turns so the point moves to the middle. A native left-button double-click or A requests/toggles automatic tracking there. A single left click has no camera action. Keyboard shortcuts ignore repeats, modifiers, editable controls, dialogs, and a pointer outside the visible picture or lost on blur. The app uses the operating system's native double-click detection for the left-button gesture; right-click centering has no delay. The app only reports picture coordinates; the adapter owns motion planning, including coordinated axis speeds and common arrival time.

- **App side.** SRT video uses the native child window over `#videoHost`; the optional browser preview uses a canvas inside the same fitted host. The native player passes input to the page. Right mouse release handles Center immediately; the browser's native `dblclick` event on the left button handles Auto. C/A use the last valid pointer position. Coordinates are relative to the visible picture, top left 0,0, with the aspect supplied by the active renderer. The page sends `ptz.centerOn {x,y,aspect}` only when supported. A point in the middle, an idle stream, a dialog or a still-busy turn prevents centering.
- **Native implementation.** If the camera can do it itself, the adapter passes the point on.
- **Estimated implementation.** Otherwise the adapter computes the rotation from the optics, with the pinhole model. Let `u = 2x - 1` and `v = 1 - 2y` be the offsets from the centre in half-frame units, `t = tan(HFOV / 2) / zoom_ratio` the half-width tangent at the current zoom, and `aspect` = width / height:

  ```
  ray in camera frame = (u * t,  v * t / aspect,  1)
  rotate the ray around the horizontal axis by the current tilt (the camera is already tilted, so pan and tilt are coupled)
  pan_target  = pan_now  + atan2(ray.x, ray.z)
  tilt_target = asin(ray.y / |ray|)
  ```

  then it moves the camera to the target, clamped to the range in `capabilities`. The inputs are the current pan, tilt and zoom (read from the camera) and the horizontal field of view at zoom 0, which belongs to the camera model and is an adapter setting that the user can calibrate (`hfov`; `tools/camera/calibrate-fov.js` measures it from the camera's own picture).
- **Limits of the estimate.** Lens distortion makes it less exact at the edges. Preview latency depends on the selected source; SRT buffering can make a click while the camera is moving refer to an older position. That is why the app waits for the end of a turn. An adapter may also refuse while the camera is moving or tracking something (answer `busy`). One more click corrects the remaining error.

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

- Camera errors appear in a note after the status text. Storage formatting requires an explicit erase confirmation dialog before the app sends the request.
- `nativeAllowList` already covers `os.*`, so no config change is needed.

## Continuous pan/tilt drive (implemented)

`ptz.continuous` declares `ptz.move {pan, tilt, ttl_ms?}` and `ptz.stop {}`. Velocities are normalized -1..1, positive right/up. TTL defaults to 1000 ms; the OSC adapter accepts 200-2000 ms. `{axes:"single",defaultSpeed:0.2}` means that only one nonzero axis is accepted and gives the default keyboard velocity. The app uses the most recently pressed arrow and sends a heartbeat every TTL/3 after acknowledgement; release, focus loss, Scan and shutdown stop the drive. Shift multiplies velocity by five, capped at one. Adapters must stop autonomously on expiry, shutdown and EOF, including when stdin contains an incomplete line. Identical renewals must not resend the hardware start command.

The OSC adapter maps velocity magnitude to the documented 1-100 direction speed, and stops with a single zero direction command. `camera_config.driveSpeed` defaults to 20 percent and supplies `defaultSpeed`. This is independent of the automatic-turn percentage slider; the adapter owns hardware speed units. Other device operations must preserve the drive watchdog during blocking reads; AI status polling in the app pauses while a key is held.

An adapter may instead advertise `axes:"both"` and accept different nonzero pan/tilt velocities in one request. The app then combines held horizontal and vertical arrows, using the newest held direction on each axis. An autonomous `ptz.centerOn` / `ptz.moveTo` owns its own bounded motion deadline; its duration is independent of the manual drive lease. Telemetry and preview requests must not cancel motion or renew its lease. New motion, explicit stop, shutdown and EOF cancel obsolete commands so a delayed start cannot restart the motor after a stop.

## Optional browser preview and telemetry (interface 1 extensions)

These capability-gated additions keep interface major version 1. Older adapters need not implement them; unknown methods still return `unsupported`. Camera-specific transport and message layouts stay inside the adapter.

| Method | Params | Result |
|---|---|---|
| `preview.open` | none | `{url,format:"hevc-annexb-v1",codec,width,height}` describing an adapter-owned loopback WebSocket session. |
| `preview.close` | none | `{}`; closes the session and remote preview. Repeat calls are safe. |
| `telemetry.get` | none | `{fresh,battery,storage,recording,power}`; example below. |
| `storage.format` | `{confirmed:true}` | `{accepted:true}` when the device accepts formatting. Completion must be checked from later telemetry. |
| `record.start`, `record.stop` | none | `{accepted:true}` when the camera accepts the command; camera recording telemetry confirms the resulting state. |
| `power.set` | `{on:boolean}` | `{accepted:true}` when the camera accepts the remote power command; power telemetry confirms the resulting state. |

`preview.open` returns a session-specific `ws://127.0.0.1:PORT/TOKEN` address (IPv6 loopback/localhost are also allowed by clients). The adapter binds only to loopback, protects each session with an unpredictable token and accepts local application origins. Device credentials and remote addresses are not exposed to the frontend. A new session invalidates the previous one; closing the adapter or stdin closes all sessions. No video is encoded into JSON Lines on stdout.

`hevc-annexb-v1` sends two consecutive WebSocket messages for each picture:

```json
{"type":"frame","timestamp":123456789,"key":true,"tracking":{"x":0.2,"y":0.1,"width":0.3,"height":0.6}}
```

The following binary message contains that picture's HEVC Annex B access unit, including parameter sets at stream start/keyframes as needed by the decoder. `timestamp` is a nonnegative safe integer in microseconds; `key` indicates a random access picture. `tracking` is a normalized, top-left-origin box or `null`. The box belongs only to that picture; missing/invalid targets clear it. All units and framing are camera-neutral. Errors may be sent as `{type:"error",message}` before the session closes. Messages are bounded to 8 MiB. Clients wait for a keyframe, bound decoder queues, and resume at a keyframe after dropping dependent pictures.

The frontend uses WebCodecs where a working HEVC configuration is available, otherwise a browser worker with a self-contained WASM decoder. Video and target boxes are rendered together on canvas. Selecting a source while idle starts preview, and changing source during preview restarts preview using the newly selected picture. During local SRT recording, selecting Camera hides its native video window and opens the camera display; selecting SRT closes that display and restores the SRT picture. These recording-time display switches preserve the same player and recording file. A failed camera preview falls back to SRT and reports the reason without changing the saved source preference.

Example telemetry, polled around `telemetry.pollMs` (default 1000 ms):

```json
{"fresh":true,"battery":{"present":true,"level":0.88,"charging":false},"storage":{"status":"ready","format":"exfat","totalBytes":127844614144,"freeBytes":74698326016,"remainingSeconds":11951,"formatting":null,"formatCompleted":false},"recording":false,"power":{"on":true}}
```

Battery level is 0–1. Storage sizes are bytes, remaining time is seconds, and status is `absent`, `preparing`, `ready`, `full`, `unsupported`, `error`, `initializing`, `readonly`, `unformatted` or `unknown`. Missing blocks and unknown recording state are `null`; unknown state never authorizes formatting. `fresh:false` means cached device data is no longer trustworthy: clients clear numerical readouts and disable destructive actions. Preview frame boxes are independent of this lower-frequency telemetry.

The app confirms formatting with explicit erase/cancel choices and passes `confirmed:true` only after approval. The adapter independently rejects missing confirmation, stale/unknown storage or recording status, active camera recording, absent/busy cards and service failures. `accepted:true` is not evidence that formatting completed. `storage.formatting` is `true` after the adapter has observed the card enter its formatting phase, `false` only after that operation reaches a terminal state, and otherwise `null`; `formatCompleted` and `formatFailed` are operation scoped signals for confirmed success or failure. The adapter clears these signals for each newly accepted format operation. A free-space change alone, or `formatting:false` without a previously observed formatting phase, never proves completion. The UI waits for request acceptance and a positive completion transition, reports completion/failure/timeout in the visible camera status and drawer, and reports when connection loss prevents confirmation. Generic `actions.invoke` remains a planned extension for arbitrary vendor actions; this implemented method is the fixed storage operation.

Storage state and format results remain available when capacity fields are unknown (`null`), for example after card removal. Telemetry reads begun before the current format request cannot confirm that operation's completion.

Both `formatCompleted` and `formatFailed` are false before an operation and while its outcome is pending; a confirmed result sets only its corresponding flag. These signals belong to the adapter's accepted format operation and reset for a new operation or adapter session. They do not report the outcome of a format started by another controller.

The app displays an indeterminate modal wait dialog after erase confirmation, updates its message after acceptance and while formatting, and closes it on success, failure, timeout, lost connection or removal of the required capabilities. Camera inputs are blocked and the native video stays hidden behind the dialog, including after player recovery. Closing the application does not cancel a format already accepted by the camera. The result remains in the visible camera status and drawer after the wait dialog closes.

Camera-side recording is independent of the app's SRT recording. The optional `record` capability block declares `start` and `stop`; `record.start` and `record.stop` change only camera recording. The UI uses one button labelled Start or Stop according to fresh confirmed recording state, and waits for later telemetry before changing to the opposite action. The power control likewise uses one button labelled Power camera on or off, with power-on as the recovery action when state is unknown. Pending operations display progress on the same button. When the adapter advertises `telemetry.recording`, telemetry includes `recording:boolean|null`.

The optional `power` capability block declares `on`, `off` and `mode:"remote"`. `power.set {on:true|false}` requests the camera's remote power transition; it does not promise standby, wake-on-LAN or any particular network availability. When `telemetry.power` is declared, telemetry includes `power:{on:boolean}|null`. The UI offers power-on as a recovery action when power state is unknown, but requires fresh known-on power and fresh known-off camera-recording state before power-off. Stop camera-side recording before powering off. Powering off during local SRT recording asks for explicit confirmation because the camera may supply that stream. Adapters must treat an accepted command as pending until telemetry confirms the new state.

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
