# OSC camera adapter

This public adapter implements the documented OBSBOT OSC command set. Its default optical tuning was measured on a Tail 2; it is not a universal OSC schema for arbitrary cameras. It provides click-to-centre, continuous pan/tilt with start/stop and lease expiry, nudges and absolute moves, speed, relative/absolute zoom and the position readouts used by app-owned presets. It does not advertise or implement AI target selection, AI state polling or any SDK-derived transport.

## Source boundary

The implementation starts from the committed OSC-only adapter before AI work. The public command names come from the OBSBOT OSC definition v1.1 and Center OSC definition (2026-01-15):

| Operation | Documented OSC name |
|---|---|
| Connect/disconnect | `/OBSBOT/WebCam/General/Connected`, `ConnectedResp`, `Disconnected` |
| Read position | `/OBSBOT/WebCam/General/GetGimbalPosInfo`, `GetGimbalPosInfoResp` |
| Move to angle | `/OBSBOT/WebCam/General/SetGimMotorDegree` |
| Continuous move/stop | `/OBSBOT/WebCam/General/SetGimbalUp`, `SetGimbalDown`, `SetGimbalLeft`, `SetGimbalRight` (zero stops all axes) |
| Read zoom | `/OBSBOT/WebCam/General/GetZoomInfo`, `ZoomInfo` |
| Set zoom | `/OBSBOT/WebCam/General/SetZoom` |

Reply order, sign conventions, optical calibration and jitter handling were measured using documented OSC operations and video. Click projection, normalized coordinates, app presets and the JSON Lines interface are application code. VISCA documents are an available basis for a future adapter; this adapter does not implement VISCA. Vendor documents and SDK archives are not redistributed here.
