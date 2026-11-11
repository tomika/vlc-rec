/*
 * obsbot-tail2: camera adapter for vlc-rec. Turns and zooms an OBSBOT Tail 2 over its documented
 * OSC interface (UDP). The adapter interface (JSON Lines on stdin and stdout, manifest, capabilities)
 * is described in docs/camera-plugin-interface.md; this is its first implementation. The app
 * has no socket API, so the adapter is a separate process that the app starts by the manifest
 * (plugin.json next to this file) and talks to through stdin and stdout.
 *
 * Requests, one JSON object per line on stdin:
 *   {"id":1,"method":"hello","params":{"interface":1}}
 *   {"id":2,"method":"connect","params":{"config":{"host":"192.168.1.50", ...}}}
 *   {"id":3,"method":"ptz.centerOn","params":{"x":0.8,"y":0.4,"aspect":1.7778}}
 *   {"id":4,"method":"ptz.nudge","params":{"pan":2,"tilt":0}}
 *   {"id":5,"method":"ptz.setSpeed","params":{"value":10}}
 *   {"id":6,"method":"zoom.by","params":{"delta":0.1}}
 *   ptz.get, zoom.get, shutdown
 * Every request gets one response line, {"id":N,"result":{...}} or
 * {"id":N,"error":{"code":"...","message":"..."}}. Events are lines with "event" and no id:
 *   {"event":"state","state":"connected"}
 *   {"event":"turned","moved":true,"fromPan":0,"fromTilt":0,"toPan":-31,"toTilt":6,"zoom":0.25,"durationMs":1100}
 *   {"event":"nudged","toPan":-2,"toTilt":0}
 *   {"event":"zoom","from":0.25,"to":0.36}
 *   {"event":"speed","value":10}
 *   {"event":"stopped"}
 * Angles are degrees, right and up positive, 0 straight ahead (the camera counts the other way
 * and this program converts). Zoom is 0..1 of the range the camera really has.
 *
 * Config of connect (see plugin.json): host (required), hfov (horizontal field of view at zoom
 * 0, default 76, measured on a Tail 2), zoomRatio (zoom ratio at the top of the range, 4.6),
 * zoomMax (top of the zoom range in the camera's percent units, 36: the Tail 2 stops there even
 * when asked for 100), nudgeSpeed (degrees per second of ptz.nudge, 30: key repeat piles up targets, and
 * a slow camera would keep running after the key is released), oscPort (57110), localPort (57120,
 * the port the camera answers to).
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
#define POSE_KEEP_MS 1500
#define MAX_SPEED 90

static sock_t g_sock = INVALID_SOCKET;
static int g_connected = 0;
static struct sockaddr_in g_cam;
static char g_host[64] = "";
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

/* Why the last operation failed: a code of the interface and a message for the user. */
static const char *g_err_code = "internal";
static const char *g_err_msg = "";

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

static int fail(const char *code, const char *message)
{
    g_err_code = code;
    g_err_msg = message;
    return 0;
}

/* ---- JSON out ---- */
static void emit(const char *line)
{
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

/* Text for inside a JSON string. */
static void json_escape(char *dst, size_t cap, const char *src)
{
    size_t o = 0;
    for (const char *p = src; *p && o + 3 < cap; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '"' || c == '\\') {
            dst[o++] = '\\';
            dst[o++] = (char)c;
        } else if (c >= 0x20) {
            dst[o++] = (char)c;
        } else {
            dst[o++] = ' ';
        }
    }
    dst[o] = 0;
}

static void respond_ok(long long id, const char *result)
{
    char line[2048];
    snprintf(line, sizeof line, "{\"id\":%lld,\"result\":%s}", id, result && result[0] ? result : "{}");
    emit(line);
}

static void respond_error(long long id, const char *code, const char *message)
{
    char escaped[512], line[768];
    json_escape(escaped, sizeof escaped, message);
    snprintf(line, sizeof line, "{\"id\":%lld,\"error\":{\"code\":\"%s\",\"message\":\"%s\"}}", id, code, escaped);
    emit(line);
}

/* ---- JSON in: a small parser, enough for the requests above ----
 * Nodes live in a fixed pool and strings are decoded in place in the line buffer, so a request
 * needs no allocation. */
enum { J_NULL = 0, J_BOOL, J_NUM, J_STR, J_OBJ, J_ARR };
#define JMAX 160
typedef struct {
    int type;
    double num;
    const char *str;
    const char *key;
    int child, next;
} jnode;
static jnode g_nodes[JMAX];
static int g_node_count;
static char *g_cursor;

static int jnew(int type)
{
    if (g_node_count >= JMAX) return -1;
    jnode *n = &g_nodes[g_node_count];
    memset(n, 0, sizeof *n);
    n->type = type;
    n->child = n->next = -1;
    return g_node_count++;
}

static void skip_space(void)
{
    while (*g_cursor == ' ' || *g_cursor == '\t' || *g_cursor == '\r' || *g_cursor == '\n') g_cursor++;
}

static char *parse_string(void)
{
    if (*g_cursor != '"') return NULL;
    g_cursor++;
    char *start = g_cursor, *w = g_cursor;
    while (*g_cursor && *g_cursor != '"') {
        if (*g_cursor == '\\') {
            g_cursor++;
            switch (*g_cursor) {
            case 'n': *w++ = '\n'; break;
            case 't': *w++ = '\t'; break;
            case 'r': *w++ = '\r'; break;
            case 'u':
                *w++ = '?';
                for (int i = 0; i < 4 && g_cursor[1]; i++) g_cursor++;
                break;
            case 0: return NULL;
            default: *w++ = *g_cursor; break;
            }
            g_cursor++;
        } else {
            *w++ = *g_cursor++;
        }
    }
    if (*g_cursor != '"') return NULL;
    g_cursor++;
    *w = 0;
    return start;
}

static int parse_value(int depth)
{
    skip_space();
    if (depth > 8) return -1;
    char c = *g_cursor;
    if (c == '{' || c == '[') {
        int object = c == '{';
        int node = jnew(object ? J_OBJ : J_ARR);
        if (node < 0) return -1;
        g_cursor++;
        skip_space();
        if (*g_cursor == (object ? '}' : ']')) {
            g_cursor++;
            return node;
        }
        int last = -1;
        for (;;) {
            skip_space();
            char *key = NULL;
            if (object) {
                key = parse_string();
                if (!key) return -1;
                skip_space();
                if (*g_cursor != ':') return -1;
                g_cursor++;
            }
            int value = parse_value(depth + 1);
            if (value < 0) return -1;
            g_nodes[value].key = key;
            if (last < 0) g_nodes[node].child = value;
            else g_nodes[last].next = value;
            last = value;
            skip_space();
            if (*g_cursor == ',') {
                g_cursor++;
                continue;
            }
            if (*g_cursor == (object ? '}' : ']')) {
                g_cursor++;
                return node;
            }
            return -1;
        }
    }
    if (c == '"') {
        char *s = parse_string();
        if (!s) return -1;
        int node = jnew(J_STR);
        if (node >= 0) g_nodes[node].str = s;
        return node;
    }
    if (strncmp(g_cursor, "true", 4) == 0 || strncmp(g_cursor, "false", 5) == 0) {
        int node = jnew(J_BOOL);
        if (node < 0) return -1;
        g_nodes[node].num = g_cursor[0] == 't';
        g_cursor += g_cursor[0] == 't' ? 4 : 5;
        return node;
    }
    if (strncmp(g_cursor, "null", 4) == 0) {
        g_cursor += 4;
        return jnew(J_NULL);
    }
    char *end = NULL;
    double number = strtod(g_cursor, &end);
    if (end == g_cursor) return -1;
    g_cursor = end;
    int node = jnew(J_NUM);
    if (node >= 0) g_nodes[node].num = number;
    return node;
}

static int jfield(int object, const char *key)
{
    if (object < 0 || g_nodes[object].type != J_OBJ) return -1;
    for (int i = g_nodes[object].child; i >= 0; i = g_nodes[i].next) {
        if (g_nodes[i].key && strcmp(g_nodes[i].key, key) == 0) return i;
    }
    return -1;
}

static int jis_number(int node) { return node >= 0 && g_nodes[node].type == J_NUM; }
static double jnumber(int node, double fallback) { return jis_number(node) ? g_nodes[node].num : fallback; }
static const char *jstring(int node) { return node >= 0 && g_nodes[node].type == J_STR ? g_nodes[node].str : NULL; }

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

/* tilt (pitch) and pan (yaw), degrees, as the camera counts them. The camera answers with two
 * numbers; the OSC definition lists three (roll, pitch, yaw), so the last two are taken. The
 * readout jitters by about one degree, and the median of three keeps that out of the target of a
 * move. */
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

static int read_zoom(int *units)
{
    osc_msg m;
    int zero = 0;
    drain();
    osc_send("/OBSBOT/WebCam/General/GetZoomInfo", &zero, 1);
    if (!osc_wait("ZoomInfo", &m, REPLY_WAIT_MS) || m.count < 1) return 0;
    *units = m.ints[0];
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
static double zoom_ratio(int units)
{
    if (units < 0) units = 0;
    if (units > g_zoom_max) units = g_zoom_max;
    return 1.0 + (g_zoom_ratio - 1.0) * units / g_zoom_max;
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

static double zoom_fraction(int units) { return (double)units / g_zoom_max; }

static void note_pose(int tilt, int pan)
{
    g_pose_valid = 1;
    g_pose_tilt = tilt;
    g_pose_pan = pan;
    g_pose_at = now_ms();
}

/* ---- operations ----
 * Each returns 1 when done, 0 with g_err_code and g_err_msg set. The events are written here; the
 * response follows from the caller. */
static int do_center(double x, double y, double aspect)
{
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1 && aspect >= 0.1 && aspect <= 10))
        return fail("invalid_params", "ptz.centerOn needs x and y in 0..1 and a sensible aspect.");
    int zoom = 0, tilt = 0, pan = 0;
    if (!read_zoom(&zoom)) zoom = g_zoom_target >= 0 ? g_zoom_target : 0;
    if (!read_gimbal(&tilt, &pan)) return fail("timeout", "The camera did not report its position.");
    double to_tilt, to_pan;
    centre_target(x, y, aspect, tilt, pan, zoom, &to_tilt, &to_pan);
    int tp = clamp_int(to_pan, -PAN_LIMIT, PAN_LIMIT);
    int tt = clamp_int(to_tilt, -TILT_LIMIT, TILT_LIMIT);
    int moved = (tp != pan || tt != tilt);
    int longest = abs(tp - pan) > abs(tt - tilt) ? abs(tp - pan) : abs(tt - tilt);
    long long duration = moved ? (long long)longest * 1000 / g_speed : 0;
    if (moved) {
        int args[3] = {g_speed, tp, tt};
        if (osc_send("/OBSBOT/WebCam/General/SetGimMotorDegree", args, 3) != 0)
            return fail("device_error", "The turn command could not be sent.");
    }
    note_pose(tt, tp);
    char line[320];
    snprintf(line, sizeof line,
             "{\"event\":\"turned\",\"moved\":%s,\"fromPan\":%d,\"fromTilt\":%d,\"toPan\":%d,\"toTilt\":%d,\"zoom\":%.4f,"
             "\"durationMs\":%lld}",
             moved ? "true" : "false", -pan, -tilt, -tp, -tt, zoom_fraction(zoom), duration);
    emit(line);
    return 1;
}

/* A small turn by dx degrees to the right and dy degrees up (negative: left, down). */
static int do_nudge(double dx, double dy)
{
    if (!(fabs(dx) <= 90 && fabs(dy) <= 90)) return fail("invalid_params", "ptz.nudge needs pan and tilt within 90 degrees.");
    int tilt = 0, pan = 0;
    long long now = now_ms();
    if (g_pose_valid && now - g_pose_at < POSE_KEEP_MS) {
        tilt = g_pose_tilt;
        pan = g_pose_pan;
    } else if (!read_gimbal(&tilt, &pan)) {
        return fail("timeout", "The camera did not report its position.");
    }
    /* Right and Up make the readout numbers smaller. */
    int tp = clamp_int(pan - dx, -PAN_LIMIT, PAN_LIMIT);
    int tt = clamp_int(tilt - dy, -TILT_LIMIT, TILT_LIMIT);
    if (tp != pan || tt != tilt) {
        int args[3] = {g_nudge_speed, tp, tt};
        if (osc_send("/OBSBOT/WebCam/General/SetGimMotorDegree", args, 3) != 0)
            return fail("device_error", "The turn command could not be sent.");
    }
    note_pose(tt, tp);
    char line[128];
    snprintf(line, sizeof line, "{\"event\":\"nudged\",\"toPan\":%d,\"toTilt\":%d}", -tp, -tt);
    emit(line);
    return 1;
}

/* delta: a fraction of the zoom range, negative zooms out. */
static int do_zoom_by(double delta)
{
    if (!(fabs(delta) <= 1)) return fail("invalid_params", "zoom.by needs a delta from -1 to 1.");
    int units = (int)lround(delta * g_zoom_max);
    if (units == 0 && delta != 0) units = delta > 0 ? 1 : -1;
    int base = 0;
    long long now = now_ms();
    if (g_zoom_target >= 0 && now - g_zoom_target_at < ZOOM_TARGET_KEEP_MS) base = g_zoom_target;
    else if (!read_zoom(&base)) return fail("timeout", "The camera did not report its zoom.");
    int target = base + units;
    if (target < 0) target = 0;
    if (target > g_zoom_max) target = g_zoom_max;
    if (target != base && osc_send("/OBSBOT/WebCam/General/SetZoom", &target, 1) != 0)
        return fail("device_error", "The zoom command could not be sent.");
    g_zoom_target = target;
    g_zoom_target_at = now;
    char line[128];
    snprintf(line, sizeof line, "{\"event\":\"zoom\",\"from\":%.4f,\"to\":%.4f}", zoom_fraction(base), zoom_fraction(target));
    emit(line);
    return 1;
}

static int do_set_speed(double value)
{
    if (!(value >= 1 && value <= MAX_SPEED)) return fail("invalid_params", "ptz.setSpeed needs a value from 1 to 90.");
    g_speed = (int)lround(value);
    char line[64];
    snprintf(line, sizeof line, "{\"event\":\"speed\",\"value\":%d}", g_speed);
    emit(line);
    return 1;
}

/* ---- connecting ---- */
static void close_socket(void)
{
    if (g_sock != INVALID_SOCKET) CLOSESOCK(g_sock);
    g_sock = INVALID_SOCKET;
    g_connected = 0;
}

static int open_socket(int osc_port, int local_port)
{
    close_socket();
#ifdef _WIN32
    static int started = 0;
    if (!started) {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return fail("internal", "Winsock could not start.");
        started = 1;
    }
#endif
    g_sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_sock == INVALID_SOCKET) return fail("internal", "Could not create a UDP socket.");
    int one = 1;
    setsockopt(g_sock, SOL_SOCKET, SO_REUSEADDR, (const char *)&one, sizeof one);
    struct sockaddr_in local;
    memset(&local, 0, sizeof local);
    local.sin_family = AF_INET;
    local.sin_addr.s_addr = htonl(INADDR_ANY);
    local.sin_port = htons((unsigned short)local_port);
    /* The camera answers to this fixed port, so without it only commands work, not readouts. */
    if (bind(g_sock, (struct sockaddr *)&local, sizeof local) != 0) {
        static char message[160];
        snprintf(message, sizeof message, "UDP port %d is in use. Close other camera software (OBSBOT Center, ...).", local_port);
        close_socket();
        return fail("busy", message);
    }
    memset(&g_cam, 0, sizeof g_cam);
    g_cam.sin_family = AF_INET;
    g_cam.sin_addr.s_addr = inet_addr(g_host);
    g_cam.sin_port = htons((unsigned short)osc_port);
    return 1;
}

/* config: the node of the connect config, or -1. */
static int do_connect(int config, char *capabilities, size_t cap)
{
    const char *host = jstring(jfield(config, "host"));
    if (!host || !host[0] || strlen(host) >= sizeof g_host || inet_addr(host) == INADDR_NONE)
        return fail("invalid_params", "config.host must be the IPv4 address of the camera.");
    for (const char *p = host; *p; p++) {
        if (!((*p >= '0' && *p <= '9') || *p == '.')) return fail("invalid_params", "config.host must be the IPv4 address of the camera.");
    }
    double hfov = jnumber(jfield(config, "hfov"), 76), ratio = jnumber(jfield(config, "zoomRatio"), 4.6);
    double zoom_max = jnumber(jfield(config, "zoomMax"), 36), nudge = jnumber(jfield(config, "nudgeSpeed"), 30);
    double osc_port = jnumber(jfield(config, "oscPort"), 57110), local_port = jnumber(jfield(config, "localPort"), 57120);
    if (!(hfov >= 10 && hfov <= 170)) return fail("invalid_params", "config.hfov must be from 10 to 170 degrees.");
    if (!(ratio >= 1 && ratio <= 100)) return fail("invalid_params", "config.zoomRatio must be from 1 to 100.");
    if (!(zoom_max >= 1 && zoom_max <= 100)) return fail("invalid_params", "config.zoomMax must be from 1 to 100.");
    if (!(nudge >= 1 && nudge <= MAX_SPEED)) return fail("invalid_params", "config.nudgeSpeed must be from 1 to 90.");
    if (!(osc_port >= 1 && osc_port <= 65535 && local_port >= 1 && local_port <= 65535))
        return fail("invalid_params", "config.oscPort and config.localPort must be port numbers.");
    strcpy(g_host, host);
    g_hfov = hfov;
    g_zoom_ratio = ratio;
    g_zoom_max = (int)lround(zoom_max);
    g_nudge_speed = (int)lround(nudge);
    g_zoom_target = -1;
    g_pose_valid = 0;
    if (!open_socket((int)osc_port, (int)local_port)) return 0;

    int zero = 0;
    osc_send("/OBSBOT/WebCam/General/Connected", &zero, 1);
    osc_msg reply;
    if (!osc_wait("ConnectedResp", &reply, 1500)) {
        close_socket();
        return fail("timeout", "The camera did not answer. Check the address and the network.");
    }
    g_connected = 1;
    snprintf(capabilities, cap,
             "{\"capabilities\":{\"device\":{\"model\":\"OBSBOT Tail 2\",\"address\":\"%s\"},"
             "\"ptz\":{\"centerOn\":\"estimated\",\"nudge\":true,"
             "\"speed\":{\"min\":1,\"max\":%d,\"default\":10,\"unit\":\"deg/s\"},"
             "\"pan\":{\"min\":%d,\"max\":%d},\"tilt\":{\"min\":%d,\"max\":%d}},"
             "\"zoom\":{\"by\":true},"
             "\"webPage\":{\"url\":\"http://%s/\"}}}",
             g_host, MAX_SPEED, -PAN_LIMIT, PAN_LIMIT, -TILT_LIMIT, TILT_LIMIT, g_host);
    return 1;
}

/* ---- requests ---- */
static int is_device_method(const char *method)
{
    static const char *const known[] = {"ptz.centerOn", "ptz.nudge", "ptz.setSpeed", "ptz.get", "zoom.by", "zoom.get"};
    for (size_t i = 0; i < sizeof known / sizeof known[0]; i++) {
        if (strcmp(method, known[i]) == 0) return 1;
    }
    return 0;
}

static int handle_request(char *line)
{
    g_node_count = 0;
    g_cursor = line;
    int root = parse_value(0);
    long long id = 0;
    int has_id = 0;
    if (root < 0 || g_nodes[root].type != J_OBJ) {
        emit("{\"id\":null,\"error\":{\"code\":\"invalid_params\",\"message\":\"A request is a JSON object.\"}}");
        return 1;
    }
    int id_node = jfield(root, "id");
    if (jis_number(id_node)) {
        id = (long long)g_nodes[id_node].num;
        has_id = 1;
    }
    const char *method = jstring(jfield(root, "method"));
    int params = jfield(root, "params");
    if (!method) {
        if (has_id) respond_error(id, "invalid_params", "A request needs a method.");
        return 1;
    }
    int ok = 1;
    char result[1536];
    result[0] = 0;

    if (strcmp(method, "hello") == 0) {
        snprintf(result, sizeof result,
                 "{\"interface\":1,\"plugin\":{\"id\":\"obsbot-tail2\",\"name\":\"OBSBOT Tail 2\",\"version\":\"0.1.0\"}}");
    } else if (strcmp(method, "shutdown") == 0) {
        if (has_id) respond_ok(id, "{}");
        return 0;
    } else if (strcmp(method, "connect") == 0) {
        ok = do_connect(jfield(params, "config"), result, sizeof result);
    } else if (!is_device_method(method)) {
        ok = fail("unsupported", "The adapter has no such method.");
    } else if (!g_connected) {
        ok = fail("not_connected", "The camera is not connected.");
    } else if (strcmp(method, "ptz.centerOn") == 0) {
        ok = do_center(jnumber(jfield(params, "x"), -1), jnumber(jfield(params, "y"), -1), jnumber(jfield(params, "aspect"), 0));
    } else if (strcmp(method, "ptz.nudge") == 0) {
        ok = do_nudge(jnumber(jfield(params, "pan"), 0), jnumber(jfield(params, "tilt"), 0));
    } else if (strcmp(method, "ptz.setSpeed") == 0) {
        ok = do_set_speed(jnumber(jfield(params, "value"), 0));
    } else if (strcmp(method, "zoom.by") == 0) {
        ok = do_zoom_by(jnumber(jfield(params, "delta"), 0));
    } else if (strcmp(method, "ptz.get") == 0) {
        int tilt = 0, pan = 0;
        ok = read_gimbal(&tilt, &pan) ? 1 : fail("timeout", "The camera did not report its position.");
        if (ok) snprintf(result, sizeof result, "{\"pan\":%d,\"tilt\":%d}", -pan, -tilt);
    } else if (strcmp(method, "zoom.get") == 0) {
        int units = 0;
        ok = read_zoom(&units) ? 1 : fail("timeout", "The camera did not report its zoom.");
        if (ok) snprintf(result, sizeof result, "{\"value\":%.4f}", zoom_fraction(units));
    } else {
        ok = fail("unsupported", "The adapter has no such method.");
    }

    if (!has_id) return 1;
    if (ok) respond_ok(id, result);
    else respond_error(id, g_err_code, g_err_msg);
    if (ok && strcmp(method, "connect") == 0) emit("{\"event\":\"state\",\"state\":\"connected\"}");
    return 1;
}

int main(void)
{
    static char line[8192];
    while (fgets(line, sizeof line, stdin)) {
        if (!handle_request(line)) break;
    }
    if (g_connected) {
        int zero = 0;
        osc_send("/OBSBOT/WebCam/General/Disconnected", &zero, 1);
    }
    close_socket();
    emit("{\"event\":\"stopped\"}");
    return 0;
}
