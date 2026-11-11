#!/usr/bin/env python3
"""A fake OBSBOT camera speaking the documented OSC subset, to test the obsbot-tail2 adapter without hardware.

Listens on UDP 57110 and answers to the sender's address, port 57120 (the layout the
OSC definition describes). It keeps a gimbal position and a zoom value, moves the
gimbal for continuous-speed commands, and prints every message it receives.

    python3 fake_osc_camera.py [--bind 127.0.0.1] [--port 57110] [--reply-port 57120]
"""
import argparse
import socket
import struct
import time


def pad4(b):
    b += b"\0"
    while len(b) % 4:
        b += b"\0"
    return b


def encode(addr, ints):
    return pad4(addr.encode()) + pad4(("," + "i" * len(ints)).encode()) + b"".join(
        struct.pack(">i", v) for v in ints)


def read_str(d, p):
    e = d.index(b"\0", p)
    return d[p:e].decode(), p + ((e - p + 1 + 3) & ~3)


def decode(d):
    addr, p = read_str(d, 0)
    ints = []
    if p < len(d):
        tags, p = read_str(d, p)
        for t in tags[1:]:
            if t == "i":
                ints.append(struct.unpack(">i", d[p:p + 4])[0])
                p += 4
            elif t == "f":
                ints.append(round(struct.unpack(">f", d[p:p + 4])[0]))
                p += 4
            else:
                break
    return addr, ints


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=57110)
    ap.add_argument("--reply-port", type=int, default=57120)
    args = ap.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.bind, args.port))
    sock.settimeout(0.1)
    print(f"fake camera on {args.bind}:{args.port}", flush=True)

    pan = tilt = 0.0
    zoom = 0
    speed = {"Up": 0, "Down": 0, "Left": 0, "Right": 0}
    last = time.monotonic()

    while True:
        now = time.monotonic()
        dt, last = now - last, now
        # 1 speed unit = 0.5 degrees per second
        pan += (speed["Right"] - speed["Left"]) * 0.5 * dt
        tilt += (speed["Up"] - speed["Down"]) * 0.5 * dt
        try:
            data, src = sock.recvfrom(2048)
        except socket.timeout:
            continue
        addr, ints = decode(data)
        print(f"recv {addr} {ints}", flush=True)
        reply = (src[0], args.reply_port)
        name = addr.rsplit("/", 1)[-1]
        if name == "Connected":
            sock.sendto(encode("/OBSBOT/WebCam/General/ConnectedResp", [1]), reply)
        elif name == "GetGimbalPosInfo":
            sock.sendto(encode("/OBSBOT/WebCam/General/GetGimbalPosInfoResp",
                               [0, round(tilt), round(pan)]), reply)
        elif name == "GetZoomInfo":
            sock.sendto(encode("/OBSBOT/WebCam/General/ZoomInfo", [zoom, 0]), reply)
        elif name in ("SetGimbalUp", "SetGimbalDown", "SetGimbalLeft", "SetGimbalRight"):
            speed[name[len("SetGimbal"):]] = ints[0] if ints else 0
        elif name == "SetGimMotorDegree" and len(ints) == 3:
            pan, tilt = float(ints[1]), float(ints[2])
        elif name == "ResetGimbal":
            pan = tilt = 0.0
        elif name == "SetZoom" and ints:
            zoom = max(0, min(100, ints[0]))
        elif name == "SetZoomSpeed" and ints:
            zoom = max(0, min(100, ints[0]))
        elif name == "SetZoomMax":
            zoom = 100
        elif name == "SetZoomMin":
            zoom = 0


if __name__ == "__main__":
    main()
