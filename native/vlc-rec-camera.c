/*
 * vlc-rec-camera: turns and zooms an OBSBOT Tail 2 over its documented OSC interface (UDP).
 * A helper process of the app: the frontend has no socket API, so it talks to this program
 * through stdin and stdout, as it does with vlc-rec-player. It is optional; without the
 * program, or without a camera address, the app simply has no camera controls.
 *
 * Arguments:
 *   --ip A.B.C.D        camera address (required)
 *   --hfov DEG          horizontal field of view at zoom 0 (default 76, measured on a Tail 2)
 *   --zoom-ratio R      zoom ratio at the top of the zoom range (default 4.6, measured)
 *   --zoom-max N        top of the zoom range in the camera's percent units (default 36: the
 *                       Tail 2 stops there even when asked for 100)
 *   --speed N           turning speed of CENTER in degrees per second, 1..90 (default 10); about
 *                       the speed the Tail 2 really turns at (measured: 10 gives 10.5, 30 gives 32)
 *   --nudge-speed N     the same for NUDGE (default 30): key repeat piles up targets, and a slow
 *                       camera would keep running after the key is released
 *   --osc-port N        camera's OSC port (default 57110)
 *   --local-port N      port the camera answers to (default 57120)
 *
 * stdin, one command per line, case-insensitive:
 *   CENTER X Y ASPECT   turn so that the image point (X, Y in 0..1, origin top left of the
 *                       visible picture) ends up in the middle; ASPECT is width / height
 *   ZOOM DELTA          change the zoom by DELTA percent (negative: out)
 *   NUDGE DX DY         turn by DX degrees to the right and DY degrees up (negative: left, down).
 *                       Meant for key repeat: it builds on the last target while that is recent,
 *                       so it neither waits for a readout nor lets the readout jitter in
 *   SPEED N             change the speed of CENTER (1..90)
 *   GET                 report the state
 *   STOP                exit; end of stdin also exits
 *
 * stdout, one JSON object per line:
 *   {"event":"ready","answered":true}
 *   {"event":"turned","moved":true,"fromPan":-20,"fromTilt":-4,"toPan":-31,"toTilt":-6,"zoom":9,"durationMs":1100}
 *                       durationMs: how long the longer axis takes at the speed of the turn
 *   {"event":"zoom","from":9,"to":19}
 *   {"event":"speed","value":10}
 *   {"event":"state","pan":-20,"tilt":-4,"zoom":9}
 *   {"event":"error","code":"no-reply","message":"..."}
 *   {"event":"stopped"}
 *
 * Measured on a Tail 2 (see docs/camera-plugin-interface.md): the position readout is two
 * numbers, tilt then pan, in degrees; "move to angle" uses the same numbers; Right and Up make
 * them smaller. The four speed commands are not used here: the camera obeys only the last one,
 * so a diagonal move needs an absolute target anyway.
 *
 * The camera moves both axes at the one speed of the command, so on a diagonal turn the axis with
 * the shorter way arrives first. Cutting the turn into targets every 100 ms along the straight line
 * makes them arrive together, but the picture is jerky then (the targets are whole degrees, so
 * the short axis moves in 1 degree steps), so it is one command.
 */
#ifdef _WIN32
#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
typedef SOCKET sock_t;
#define CLOSESOCK closesocket
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
typedef int sock_t;
#define CLOSESOCK close
#define INVALID_SOCKET (-1)
#endif

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PAN_LIMIT 159
#define TILT_LIMIT 62
#define REPLY_WAIT_MS 400
#define ZOOM_TARGET_KEEP_MS 3000

static sock_t g_sock = INVALID_SOCKET;
static struct sockaddr_in g_cam;
static double g_hfov = 76.0;
static double g_zoom_ratio = 4.6; /* at g_zoom_max */
static int g_zoom_max = 36;
static int g_speed = 10;
static int g_nudge_speed = 30;
/* A zoom command takes about a second to finish, and the readout is stale meanwhile. A second
 * press right after the first must build on the first target, not on the half-way reading. */
static int g_zoom_target = -1;
static long long g_zoom_target_at = 0;
/* The same for the gimbal: the last position that was asked for. */
static int g_pose_valid = 0;
static int g_pose_tilt = 0, g_pose_pan = 0;
static long long g_pose_at = 0;
#define POSE_KEEP_MS 1500

static long long now_ms(void)
{
#ifdef _WIN32
    return (long long)GetTickCount64();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
#endif
}

static void emit(const char *line)
{
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void emit_error(const char *code, const char *message)
{
    char line[512];
    snprintf(line, sizeof line, "{\"event\":\"error\",\"code\":\"%s\",\"message\":\"%s\"}", code, message);
    emit(line);
}

/* ---- OSC ---- */
typedef struct {
    char addr[96];
    int count;
    int32_t ints[8];
} osc_msg;

static size_t osc_pad(size_t n) { return (n + 4) & ~(size_t)3; } /* with the terminating zero */

static size_t osc_encode(char *out, size_t cap, const char *addr, const int32_t *ints, int count)
{
    size_t a = osc_pad(strlen(addr));
    size_t t = osc_pad((size_t)count + 1);
    size_t total = a + t + 4 * (size_t)count;
    if (total > cap) return 0;
    memset(out, 0, total);
    memcpy(out, addr, strlen(addr));
    out[a] = ',';
    for (int i = 0; i < count; i++) out[a + 1 + i] = 'i';
    for (int i = 0; i < count; i++) {
        uint32_t v = (uint32_t)ints[i];
        char *p = out + a + t + 4 * (size_t)i;
        p[0] = (char)(v >> 24);
        p[1] = (char)(v >> 16);
        p[2] = (char)(v >> 8);
        p[3] = (char)v;
    }
    return total;
}

static int osc_decode(const char *d, size_t n, osc_msg *m)
{
    memset(m, 0, sizeof *m);
    if (n < 4 || d[0] != '/') return 0;
    size_t e = 0;
    while (e < n && d[e]) e++;
    if (e >= n || e >= sizeof m->addr) return 0;
    memcpy(m->addr, d, e);
    size_t tag_pos = osc_pad(e); /* the type tag string follows the padded address */
    if (tag_pos >= n) return 1;  /* no arguments */
    if (d[tag_pos] != ',') return 0;
    size_t te = tag_pos;
    while (te < n && d[te]) te++;
    if (te >= n) return 0;
    size_t tags = te - tag_pos - 1;
    size_t arg = tag_pos + osc_pad(te - tag_pos); /* the arguments follow the padded type tags */
    for (size_t i = 0; i < tags; i++) {
        char t = d[tag_pos + 1 + i];
        if (t == 'i' || t == 'f') {
            if (arg + 4 > n) return 0;
            uint32_t v = ((uint32_t)(unsigned char)d[arg] << 24) | ((uint32_t)(unsigned char)d[arg + 1] << 16) |
                         ((uint32_t)(unsigned char)d[arg + 2] << 8) | (uint32_t)(unsigned char)d[arg + 3];
            if (t == 'f') {
                float f;
                memcpy(&f, &v, 4);
                if (m->count < 8) m->ints[m->count++] = (int32_t)lroundf(f);
            } else if (m->count < 8) {
                m->ints[m->count++] = (int32_t)v;
            }
            arg += 4;
        } else if (t == 's') {
            size_t se = arg;
            while (se < n && d[se]) se++;
            if (se >= n) return 0;
            arg += osc_pad(se - arg);
        } else {
            return 1; /* unknown argument type: what was read so far is kept */
        }
    }
    return 1;
}

static int osc_send(const char *addr, const int32_t *ints, int count)
{
    char buf[256];
    size_t n = osc_encode(buf, sizeof buf, addr, ints, count);
    if (!n) return -1;
    return sendto(g_sock, buf, (int)n, 0, (struct sockaddr *)&g_cam, sizeof g_cam) == (int)n ? 0 : -1;
}

/* Waits for a message whose address ends with `suffix`; anything else is dropped. */
static int osc_wait(const char *suffix, osc_msg *out, int timeout_ms)
{
    long long end = now_ms() + timeout_ms;
    size_t ls = strlen(suffix);
    for (;;) {
        long long left = end - now_ms();
        if (left <= 0) return 0;
        fd_set rs;
        FD_ZERO(&rs);
        FD_SET(g_sock, &rs);
        struct timeval tv;
        tv.tv_sec = (long)(left / 1000);
        tv.tv_usec = (long)(left % 1000) * 1000;
        if (select((int)g_sock + 1, &rs, NULL, NULL, &tv) <= 0) return 0;
        char buf[2048];
        int n = recv(g_sock, buf, sizeof buf, 0);
        if (n <= 0) continue;
        osc_msg m;
        if (!osc_decode(buf, (size_t)n, &m)) continue;
        size_t la = strlen(m.addr);
        if (la >= ls && strcmp(m.addr + la - ls, suffix) == 0) {
            *out = m;
            return 1;
        }
    }
}

static void drain(void)
{
    for (;;) {
        fd_set rs;
        FD_ZERO(&rs);
        FD_SET(g_sock, &rs);
        struct timeval tv = {0, 0};
        if (select((int)g_sock + 1, &rs, NULL, NULL, &tv) <= 0) return;
        char buf[2048];
        if (recv(g_sock, buf, sizeof buf, 0) <= 0) return;
    }
}

static int cmp_int(const void *a, const void *b) { return (*(const int *)a > *(const int *)b) - (*(const int *)a < *(const int *)b); }

/* tilt (pitch) and pan (yaw), degrees. The camera answers with two numbers; the OSC
 * definition lists three (roll, pitch, yaw), so the last two are taken. The readout jitters by
 * about one degree, and the median of three keeps that out of the target of a move. */
static int read_gimbal(int *tilt, int *pan)
{
    int tilts[3], pans[3], n = 0;
    for (int i = 0; i < 3; i++) {
        osc_msg m;
        drain();
        int zero = 0;
        osc_send("/OBSBOT/WebCam/General/GetGimbalPosInfo", &zero, 1);
        if (osc_wait("GetGimbalPosInfoResp", &m, REPLY_WAIT_MS) && m.count >= 2) {
            tilts[n] = m.ints[m.count - 2];
            pans[n] = m.ints[m.count - 1];
            n++;
        }
    }
    if (n == 0) return 0;
    qsort(tilts, (size_t)n, sizeof(int), cmp_int);
    qsort(pans, (size_t)n, sizeof(int), cmp_int);
    *tilt = tilts[n / 2];
    *pan = pans[n / 2];
    return 1;
}

static int read_zoom(int *percent)
{
    osc_msg m;
    int zero = 0;
    drain();
    osc_send("/OBSBOT/WebCam/General/GetZoomInfo", &zero, 1);
    if (!osc_wait("ZoomInfo", &m, REPLY_WAIT_MS) || m.count < 1) return 0;
    *percent = m.ints[0];
    return 1;
}

/* ---- geometry ----
 * Pinhole camera: the half width of the picture at depth 1 is tan(hfov / 2) / ratio. The clicked
 * point gives a ray in camera coordinates (X right, Y up, Z forward). The camera is pitched by its
 * current elevation, so the ray is rotated into the world frame; turning the gimbal so that its
 * axis lies along that ray is a pan by atan2(x, z) and an elevation of asin(y / |ray|). The
 * readout counts the other way for both axes (Right and Up make the numbers smaller). */
/* Measured on a Tail 2 (zoom 0, 9, 24, 36): ratios 1, 1.92, 3.52, 4.61, so linear in the
 * camera's percent within a few percent, and the zoom stops at 36. */
static double zoom_ratio(int percent)
{
    if (percent < 0) percent = 0;
    if (percent > g_zoom_max) percent = g_zoom_max;
    return 1.0 + (g_zoom_ratio - 1.0) * percent / g_zoom_max;
}

static void centre_target(double x, double y, double aspect, int tilt, int pan, int zoom, double *to_tilt, double *to_pan)
{
    const double rad = 3.14159265358979323846 / 180.0;
    double t = tan(g_hfov * rad / 2.0) / zoom_ratio(zoom);
    double rx = (2.0 * x - 1.0) * t;
    double ry = (1.0 - 2.0 * y) * t / aspect;
    double rz = 1.0;
    double phi = -tilt * rad; /* elevation, up positive */
    double dx = rx;
    double dy = ry * cos(phi) + rz * sin(phi);
    double dz = -ry * sin(phi) + rz * cos(phi);
    double yaw = atan2(dx, dz) / rad;                      /* right positive */
    double elevation = atan2(dy, sqrt(dx * dx + dz * dz)) / rad; /* up positive */
    *to_pan = pan - yaw;
    *to_tilt = -elevation;
}

static int clamp_int(double v, int lo, int hi)
{
    long r = lround(v);
    return r < lo ? lo : r > hi ? hi : (int)r;
}

/* ---- turns ---- */
static int send_target(int speed, int pan, int tilt)
{
    int args[3] = {speed, pan, tilt};
    return osc_send("/OBSBOT/WebCam/General/SetGimMotorDegree", args, 3);
}

static void note_pose(int tilt, int pan)
{
    g_pose_valid = 1;
    g_pose_tilt = tilt;
    g_pose_pan = pan;
    g_pose_at = now_ms();
}

/* ---- commands ---- */
static void do_center(double x, double y, double aspect)
{
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1 && aspect >= 0.1 && aspect <= 10)) {
        emit_error("bad-command", "CENTER needs X and Y in 0..1 and a sensible ASPECT.");
        return;
    }
    int zoom = 0, tilt = 0, pan = 0;
    if (!read_zoom(&zoom)) zoom = g_zoom_target >= 0 ? g_zoom_target : 0;
    if (!read_gimbal(&tilt, &pan)) {
        emit_error("no-reply", "The camera did not report its position.");
        return;
    }
    double to_tilt, to_pan;
    centre_target(x, y, aspect, tilt, pan, zoom, &to_tilt, &to_pan);
    int tp = clamp_int(to_pan, -PAN_LIMIT, PAN_LIMIT);
    int tt = clamp_int(to_tilt, -TILT_LIMIT, TILT_LIMIT);
    int moved = (tp != pan || tt != tilt);
    int longest = abs(tp - pan) > abs(tt - tilt) ? abs(tp - pan) : abs(tt - tilt);
    long long duration = moved ? (long long)longest * 1000 / g_speed : 0;
    if (moved) {
        if (send_target(g_speed, tp, tt) != 0) {
            emit_error("send-failed", "The turn command could not be sent.");
            return;
        }
    }
    note_pose(tt, tp);
    char line[256];
    snprintf(line, sizeof line,
             "{\"event\":\"turned\",\"moved\":%s,\"fromPan\":%d,\"fromTilt\":%d,\"toPan\":%d,\"toTilt\":%d,\"zoom\":%d,"
             "\"durationMs\":%lld}",
             moved ? "true" : "false", pan, tilt, tp, tt, zoom, duration);
    emit(line);
}

static void do_zoom(int delta)
{
    int base = 0;
    long long now = now_ms();
    if (g_zoom_target >= 0 && now - g_zoom_target_at < ZOOM_TARGET_KEEP_MS) base = g_zoom_target;
    else if (!read_zoom(&base)) {
        emit_error("no-reply", "The camera did not report its zoom.");
        return;
    }
    int target = base + delta;
    if (target < 0) target = 0;
    if (target > g_zoom_max) target = g_zoom_max;
    if (target != base) {
        if (osc_send("/OBSBOT/WebCam/General/SetZoom", &target, 1) != 0) {
            emit_error("send-failed", "The zoom command could not be sent.");
            return;
        }
    }
    g_zoom_target = target;
    g_zoom_target_at = now;
    char line[128];
    snprintf(line, sizeof line, "{\"event\":\"zoom\",\"from\":%d,\"to\":%d}", base, target);
    emit(line);
}

static void do_nudge(double dx, double dy)
{
    if (!(fabs(dx) <= 90 && fabs(dy) <= 90)) {
        emit_error("bad-command", "NUDGE needs DX and DY within 90 degrees.");
        return;
    }
    int tilt = 0, pan = 0;
    long long now = now_ms();
    if (g_pose_valid && now - g_pose_at < POSE_KEEP_MS) {
        tilt = g_pose_tilt;
        pan = g_pose_pan;
    } else if (!read_gimbal(&tilt, &pan)) {
        emit_error("no-reply", "The camera did not report its position.");
        return;
    }
    /* Right and Up make the readout numbers smaller. */
    int tp = clamp_int(pan - dx, -PAN_LIMIT, PAN_LIMIT);
    int tt = clamp_int(tilt - dy, -TILT_LIMIT, TILT_LIMIT);
    if (tp != pan || tt != tilt) {
        int args[3] = {g_nudge_speed, tp, tt};
        if (osc_send("/OBSBOT/WebCam/General/SetGimMotorDegree", args, 3) != 0) {
            emit_error("send-failed", "The turn command could not be sent.");
            return;
        }
    }
    g_pose_valid = 1;
    g_pose_tilt = tt;
    g_pose_pan = tp;
    g_pose_at = now_ms();
    char line[128];
    snprintf(line, sizeof line, "{\"event\":\"nudged\",\"toPan\":%d,\"toTilt\":%d}", tp, tt);
    emit(line);
}

static void do_speed(int speed)
{
    if (speed < 1 || speed > 90) {
        emit_error("bad-command", "SPEED needs a value from 1 to 90.");
        return;
    }
    g_speed = speed;
    char line[64];
    snprintf(line, sizeof line, "{\"event\":\"speed\",\"value\":%d}", speed);
    emit(line);
}

static void do_get(void)
{
    int tilt = 0, pan = 0, zoom = 0;
    if (!read_gimbal(&tilt, &pan) || !read_zoom(&zoom)) {
        emit_error("no-reply", "The camera did not report its state.");
        return;
    }
    char line[128];
    snprintf(line, sizeof line, "{\"event\":\"state\",\"pan\":%d,\"tilt\":%d,\"zoom\":%d}", pan, tilt, zoom);
    emit(line);
}

static int handle_line(char *line)
{
    size_t n = strlen(line);
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = 0;
    for (size_t i = 0; i < n && line[i] != ' '; i++)
        if (line[i] >= 'a' && line[i] <= 'z') line[i] = (char)(line[i] - 'a' + 'A');
    double a, b, c;
    int d;
    if (strcmp(line, "STOP") == 0) return 0;
    if (strcmp(line, "GET") == 0) do_get();
    else if (sscanf(line, "CENTER %lf %lf %lf", &a, &b, &c) == 3) do_center(a, b, c);
    else if (sscanf(line, "NUDGE %lf %lf", &a, &b) == 2) do_nudge(a, b);
    else if (sscanf(line, "ZOOM %d", &d) == 1) do_zoom(d);
    else if (sscanf(line, "SPEED %d", &d) == 1) do_speed(d);
    return 1;
}

int main(int argc, char **argv)
{
    const char *ip = NULL;
    int osc_port = 57110, local_port = 57120;
    for (int i = 1; i + 1 < argc; i += 2) {
        if (strcmp(argv[i], "--ip") == 0) ip = argv[i + 1];
        else if (strcmp(argv[i], "--hfov") == 0) g_hfov = atof(argv[i + 1]);
        else if (strcmp(argv[i], "--zoom-ratio") == 0) g_zoom_ratio = atof(argv[i + 1]);
        else if (strcmp(argv[i], "--zoom-max") == 0) g_zoom_max = atoi(argv[i + 1]);
        else if (strcmp(argv[i], "--speed") == 0) g_speed = atoi(argv[i + 1]);
        else if (strcmp(argv[i], "--nudge-speed") == 0) g_nudge_speed = atoi(argv[i + 1]);
        else if (strcmp(argv[i], "--osc-port") == 0) osc_port = atoi(argv[i + 1]);
        else if (strcmp(argv[i], "--local-port") == 0) local_port = atoi(argv[i + 1]);
    }
    if (g_hfov < 10 || g_hfov > 170) g_hfov = 76;
    if (g_zoom_ratio < 1 || g_zoom_ratio > 100) g_zoom_ratio = 4.6;
    if (g_zoom_max < 1 || g_zoom_max > 100) g_zoom_max = 36;
    if (g_speed < 1 || g_speed > 90) g_speed = 10;
    if (g_nudge_speed < 1 || g_nudge_speed > 90) g_nudge_speed = 30;
    if (!ip || inet_addr(ip) == INADDR_NONE) {
        emit_error("bad-arguments", "A camera address is required: --ip A.B.C.D");
        return 2;
    }
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        emit_error("socket", "Winsock could not start.");
        return 3;
    }
#endif
    g_sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_sock == INVALID_SOCKET) {
        emit_error("socket", "Could not create a UDP socket.");
        return 3;
    }
    int one = 1;
    setsockopt(g_sock, SOL_SOCKET, SO_REUSEADDR, (const char *)&one, sizeof one);
    struct sockaddr_in local;
    memset(&local, 0, sizeof local);
    local.sin_family = AF_INET;
    local.sin_addr.s_addr = htonl(INADDR_ANY);
    local.sin_port = htons((unsigned short)local_port);
    /* The camera answers to this fixed port, so without it only commands work, not readouts. */
    if (bind(g_sock, (struct sockaddr *)&local, sizeof local) != 0) {
        char message[160];
        snprintf(message, sizeof message, "UDP port %d is in use. Close other camera software (OBSBOT Center, ...).", local_port);
        emit_error("bind", message);
        return 3;
    }
    memset(&g_cam, 0, sizeof g_cam);
    g_cam.sin_family = AF_INET;
    g_cam.sin_addr.s_addr = inet_addr(ip);
    g_cam.sin_port = htons((unsigned short)osc_port);

    int zero = 0;
    osc_send("/OBSBOT/WebCam/General/Connected", &zero, 1);
    osc_msg reply;
    int answered = osc_wait("ConnectedResp", &reply, 1500);
    emit(answered ? "{\"event\":\"ready\",\"answered\":true}" : "{\"event\":\"ready\",\"answered\":false}");
    if (!answered) emit_error("no-reply", "The camera did not answer. Check the address and the network.");

    char line[256];
    while (fgets(line, sizeof line, stdin)) {
        if (!handle_line(line)) break;
    }
    osc_send("/OBSBOT/WebCam/General/Disconnected", &zero, 1);
    CLOSESOCK(g_sock);
    emit("{\"event\":\"stopped\"}");
    return 0;
}
