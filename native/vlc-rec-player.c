/*
 * vlc-rec-player: plays and optionally records one SRT stream with libVLC 3,
 * rendering into a child window of the Neutralino application window.
 *
 * One process handles one stream. The app starts a new process per segment.
 *
 * Arguments (all ASCII; text values are hex encoded UTF-8 so no shell or
 * code page can damage them):
 *   --parent-pid N   process id owning the application window (required)
 *   --url-hex H      stream URL (required)
 *   --rect X,Y,W,H   video area in physical pixels, relative to the client area
 *   --record-hex H   output file; preview only when omitted
 *   --mux mkv|mp4    output container, default mkv
 *   --srt-latency MS SRT latency of the input in ms (VLC's "latency" option of its SRT module), 1..60000;
 *                    without it VLC's own default is used. The app passes it for a preview only
 *   --caching MS     VLC's network and live caching in ms, 0..60000; VLC's own default is 1000,
 *                    which delays the picture by about that much. Lower it for a picture that
 *                    steers something; too low makes a jittery link stutter
 *
 * stdin, one command per line: RECT X,Y,W,H | HIDE | SHOW | STOP
 * Commands are case-insensitive and unknown lines are ignored, so "stop" works.
 * End of stdin also means STOP, so the player cannot outlive the app.
 *
 * stdout, one JSON object per line:
 *   {"event":"started","libvlc":"3.0.24"}
 *   {"event":"stats","state":3,"readBytes":123,"decoded":40,"displayed":38,"lost":2}
 *   {"event":"video","width":1920,"height":1080,"sarNum":1,"sarDen":1}
 *   {"event":"log","level":"warning","module":"direct3d11","text":"..."}
 *   {"event":"window","text":"..."}      (Windows only, once, 3 s after the start)
 *   {"event":"error","code":"...","message":"..."}
 *   {"event":"stopped"}
 *
 * readBytes is a 32-bit libVLC counter and can wrap: compare it for equality only.
 * decoded, displayed and lost count pictures: data that arrives but is not decoded points at the
 * stream, decoded but not displayed at the video output. "log" carries libVLC's own messages
 * (warnings and errors; at most 300 per process); "window" describes the child windows that exist.
 * "video" is sent when the size of the first video track becomes known or changes.
 * Width and height are already swapped for rotated video; the display aspect ratio
 * is width * sarNum / (height * sarDen).
 *
 * Environment: VLC_REC_LIBVLC_DIR selects the only folder libVLC is loaded from.
 *   VLC_REC_VLC_ARGS adds libVLC options, separated by spaces, for trying things out,
 *   for example "--verbose=2" or "--vout=direct3d9 --avcodec-hw=none".
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <process.h>
#else
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#endif

/* ---- libVLC 3 ABI, declared here so that building needs no VLC SDK ---- */
typedef struct libvlc_instance_t libvlc_instance_t;
typedef struct libvlc_media_t libvlc_media_t;
typedef struct libvlc_media_player_t libvlc_media_player_t;

typedef struct {
    int i_read_bytes;
    float f_input_bitrate;
    int i_demux_read_bytes;
    float f_demux_bitrate;
    int i_demux_corrupted;
    int i_demux_discontinuity;
    int i_decoded_video;
    int i_decoded_audio;
    int i_displayed_pictures;
    int i_lost_pictures;
    int i_played_abuffers;
    int i_lost_abuffers;
    int i_sent_packets;
    int i_sent_bytes;
    float f_send_bitrate;
} vlc_stats_t;

enum { VLC_STATE_ENDED = 6, VLC_STATE_ERROR = 7 };

/* libvlc_video_track_t; only the leading fields are read. */
typedef struct {
    unsigned i_height;
    unsigned i_width;
    unsigned i_sar_num;
    unsigned i_sar_den;
    unsigned i_frame_rate_num;
    unsigned i_frame_rate_den;
    int i_orientation;
} vlc_video_track_t;

/* libvlc_media_track_t */
typedef struct {
    unsigned int i_codec;
    unsigned int i_original_fourcc;
    int i_id;
    int i_type;
    int i_profile;
    int i_level;
    void *details; /* union of the audio, video and subtitle track pointers */
    unsigned int i_bitrate;
    char *psz_language;
    char *psz_description;
} vlc_media_track_t;

enum { VLC_TRACK_VIDEO = 1 };
/* libvlc_video_orient_t values from left_top on swap width and height. */
enum { VLC_ORIENT_TRANSPOSED_FIRST = 4, VLC_ORIENT_TRANSPOSED_LAST = 7 };

static struct {
    libvlc_instance_t *(*new_instance)(int, const char *const *);
    void (*release)(libvlc_instance_t *);
    const char *(*get_version)(void);
    const char *(*errmsg)(void);
    libvlc_media_t *(*media_new_location)(libvlc_instance_t *, const char *);
    void (*media_add_option)(libvlc_media_t *, const char *);
    int (*media_get_stats)(libvlc_media_t *, vlc_stats_t *);
    unsigned (*media_tracks_get)(libvlc_media_t *, vlc_media_track_t ***);
    void (*media_tracks_release)(vlc_media_track_t **, unsigned);
    void (*media_release)(libvlc_media_t *);
    libvlc_media_player_t *(*player_new_from_media)(libvlc_media_t *);
    void (*player_release)(libvlc_media_player_t *);
    int (*player_play)(libvlc_media_player_t *);
    void (*player_stop)(libvlc_media_player_t *);
    int (*player_get_state)(libvlc_media_player_t *);
    void (*video_set_mouse_input)(libvlc_media_player_t *, unsigned);
    void (*video_set_key_input)(libvlc_media_player_t *, unsigned);
    /* Optional: a libVLC without them (the test stub) just runs without log events. */
    void (*log_set)(libvlc_instance_t *, void (*)(void *, int, const void *, const char *, va_list), void *);
    void (*log_get_context)(const void *, const char **, const char **, unsigned *);
#ifdef _WIN32
    void (*player_set_hwnd)(libvlc_media_player_t *, void *);
#else
    void (*player_set_xwindow)(libvlc_media_player_t *, unsigned int);
#endif
} vlc;

/* ---- shared state ---- */
static volatile long g_stop = 0;
static long g_parent_pid = 0;
static char *g_url = NULL;
static char *g_record = NULL;
static const char *g_mux = "mkv";
static int g_caching = -1; /* ms; -1 leaves VLC's default */
static int g_srt_latency = -1; /* ms; -1 leaves VLC's default */
static int g_rect[4] = {0, 0, 640, 360};

#ifdef _WIN32
static HWND g_child = NULL;
static DWORD g_main_thread = 0;
static CRITICAL_SECTION g_out_lock;
#define OUT_LOCK() EnterCriticalSection(&g_out_lock)
#define OUT_UNLOCK() LeaveCriticalSection(&g_out_lock)
#else
static Display *g_dpy = NULL;
static Window g_child = 0;
static pthread_mutex_t g_out_lock = PTHREAD_MUTEX_INITIALIZER;
#define OUT_LOCK() pthread_mutex_lock(&g_out_lock)
#define OUT_UNLOCK() pthread_mutex_unlock(&g_out_lock)
#endif

static void sleep_ms(int ms)
{
#ifdef _WIN32
    Sleep((DWORD)ms);
#else
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
#endif
}

static void emit_raw(const char *line)
{
    OUT_LOCK();
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    OUT_UNLOCK();
}

/* Text for inside a JSON string: quotes and backslashes escaped, control characters become spaces. */
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

static void emit_error(const char *code, const char *fmt, ...)
{
    char message[512], escaped[1100], line[1300];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(message, sizeof message, fmt, ap);
    va_end(ap);
    json_escape(escaped, sizeof escaped, message);
    snprintf(line, sizeof line, "{\"event\":\"error\",\"code\":\"%s\",\"message\":\"%s\"}", code, escaped);
    emit_raw(line);
}

/* libVLC's own messages, so that a black picture or a failing stream says why. libVLC calls this
 * from any of its threads. */
enum { MAX_LOG_LINES = 300 };
static volatile long g_log_lines = 0;
/* A log callback gets every message whatever --verbose says, so it filters itself:
 * warnings and errors, unless VLC_REC_VLC_ARGS has --verbose=1 (notices too) or 2 (everything). */
static int g_log_min_level = 3;
/* Hashes of the messages already sent: an audio device that fails repeats its warning for every
 * buffer, and that would use up the lines before the video output says anything. No locking:
 * a race costs a repeated line at worst, and the index is bounded. */
enum { MAX_SEEN = 256 };
static unsigned g_seen[MAX_SEEN];
static volatile int g_seen_count = 0;

static void log_callback(void *data, int level, const void *ctx, const char *fmt, va_list args)
{
    (void)data;
    if (level < g_log_min_level || g_log_lines > MAX_LOG_LINES) return;
    char text[600], text_escaped[1300], module_escaped[100], line[1500];
    const char *module = NULL;
    vsnprintf(text, sizeof text, fmt, args);
    size_t len = strlen(text);
    while (len > 0 && (text[len - 1] == '\n' || text[len - 1] == '\r')) text[--len] = 0;
    if (ctx && vlc.log_get_context) vlc.log_get_context(ctx, &module, NULL, NULL);

    unsigned hash = 2166136261u;
    for (const char *p = module ? module : ""; *p; p++) hash = (hash ^ (unsigned char)*p) * 16777619u;
    for (const char *p = text; *p; p++) hash = (hash ^ (unsigned char)*p) * 16777619u;
    int known = g_seen_count < MAX_SEEN ? g_seen_count : MAX_SEEN;
    for (int i = 0; i < known; i++) {
        if (g_seen[i] == hash) return;
    }
    if (g_seen_count < MAX_SEEN) g_seen[g_seen_count++] = hash;

    long n = ++g_log_lines;
    if (n > MAX_LOG_LINES) return;
    if (n == MAX_LOG_LINES) {
        snprintf(text, sizeof text, "libVLC messages are not shown any more.");
        module = NULL;
    }
    json_escape(text_escaped, sizeof text_escaped, text);
    json_escape(module_escaped, sizeof module_escaped, module ? module : "");
    /* LIBVLC_DEBUG 0, LIBVLC_NOTICE 2, LIBVLC_WARNING 3, LIBVLC_ERROR 4 */
    const char *name = level >= 4 ? "error" : level == 3 ? "warning" : level == 2 ? "notice" : "debug";
    snprintf(line, sizeof line, "{\"event\":\"log\",\"level\":\"%s\",\"module\":\"%s\",\"text\":\"%s\"}",
             name, module_escaped, text_escaped);
    emit_raw(line);
}

static char *hex_decode(const char *hex)
{
    size_t n = strlen(hex);
    if (n % 2 != 0) return NULL;
    char *out = malloc(n / 2 + 1);
    if (!out) return NULL;
    for (size_t i = 0; i < n; i += 2) {
        unsigned value;
        if (sscanf(hex + i, "%2x", &value) != 1) {
            free(out);
            return NULL;
        }
        out[i / 2] = (char)value;
    }
    out[n / 2] = 0;
    return out;
}

static int parse_rect(const char *text, int rect[4])
{
    int x, y, w, h;
    if (sscanf(text, "%d,%d,%d,%d", &x, &y, &w, &h) != 4) return 0;
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    rect[0] = x;
    rect[1] = y;
    rect[2] = w;
    rect[3] = h;
    return 1;
}

/* ---- loading libVLC ---- */
#ifdef _WIN32
typedef HMODULE lib_t;

/* Set when a libvlc.dll was found but is not a 64-bit one (error 193): a portable 32-bit VLC
 * is the usual cause of "not found" on a machine that has VLC. */
static int g_libvlc_wrong_bitness = 0;

static lib_t try_load_dir(const wchar_t *dir)
{
    wchar_t path[1024], normalized[1024];
    if (!dir || !dir[0]) return NULL;
    DWORD full_length = GetFullPathNameW(dir, 1024, normalized, NULL);
    if (!full_length || full_length >= 1024) return NULL;
    dir = normalized;
    _snwprintf(path, 1024, L"%ls\\libvlc.dll", dir);
    path[1023] = 0;
    /* The altered search path lets libvlc.dll find libvlccore.dll beside it. */
    lib_t lib = LoadLibraryExW(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!lib && GetLastError() == ERROR_BAD_EXE_FORMAT) g_libvlc_wrong_bitness = 1;
    return lib;
}

static lib_t load_libvlc(void)
{
    wchar_t dir[1024];
    lib_t lib;
    DWORD n = GetEnvironmentVariableW(L"VLC_REC_LIBVLC_DIR", dir, 1024);
    if (n > 0 && n < 1024) return try_load_dir(dir);

    /* This helper lives in player/, while the portable VLC directory is beside player/. */
    wchar_t executable[1024], bundled[1024], dll[1024];
    DWORD length = GetModuleFileNameW(NULL, executable, 1024);
    if (length > 0 && length < 1024) {
        wchar_t *slash = wcsrchr(executable, L'\\');
        if (slash) {
            *slash = 0;
            _snwprintf(bundled, 1024, L"%ls\\..\\vlc", executable);
            bundled[1023] = 0;
            _snwprintf(dll, 1024, L"%ls\\libvlc.dll", bundled);
            dll[1023] = 0;
            /* An invalid bundled DLL is a package error; do not silently use another version. */
            if (GetFileAttributesW(dll) != INVALID_FILE_ATTRIBUTES) return try_load_dir(bundled);
        }
    }

    HKEY key;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\VideoLAN\\VLC", 0,
                      KEY_READ | KEY_WOW64_64KEY, &key) == ERROR_SUCCESS) {
        DWORD size = sizeof dir - sizeof(wchar_t), type = 0;
        LONG rc = RegQueryValueExW(key, L"InstallDir", NULL, &type, (LPBYTE)dir, &size);
        RegCloseKey(key);
        if (rc == ERROR_SUCCESS && type == REG_SZ) {
            dir[size / sizeof(wchar_t)] = 0;
            if ((lib = try_load_dir(dir))) return lib;
        }
    }
    if ((lib = try_load_dir(L"C:\\Program Files\\VideoLAN\\VLC"))) return lib;
    lib = LoadLibraryW(L"libvlc.dll");
    if (!lib && GetLastError() == ERROR_BAD_EXE_FORMAT) g_libvlc_wrong_bitness = 1;
    return lib;
}

static void *lib_symbol(lib_t lib, const char *name)
{
    return (void *)GetProcAddress(lib, name);
}
#else
typedef void *lib_t;

static lib_t load_libvlc(void)
{
    const char *dir = getenv("VLC_REC_LIBVLC_DIR");
    if (dir && dir[0]) {
        char path[1024];
        snprintf(path, sizeof path, "%s/libvlc.so.5", dir);
        return dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    }
    return dlopen("libvlc.so.5", RTLD_NOW | RTLD_GLOBAL);
}

static void *lib_symbol(lib_t lib, const char *name)
{
    return dlsym(lib, name);
}
#endif

static int bind_libvlc(lib_t lib)
{
    int ok = 1;
#define BIND(field, name)                                                  \
    do {                                                                   \
        *(void **)(&vlc.field) = lib_symbol(lib, name);                    \
        if (!vlc.field) {                                                  \
            emit_error("libvlc-symbol", "libVLC has no symbol %s.", name); \
            ok = 0;                                                        \
        }                                                                  \
    } while (0)
    BIND(new_instance, "libvlc_new");
    BIND(release, "libvlc_release");
    BIND(get_version, "libvlc_get_version");
    BIND(errmsg, "libvlc_errmsg");
    BIND(media_new_location, "libvlc_media_new_location");
    BIND(media_add_option, "libvlc_media_add_option");
    BIND(media_get_stats, "libvlc_media_get_stats");
    BIND(media_tracks_get, "libvlc_media_tracks_get");
    BIND(media_tracks_release, "libvlc_media_tracks_release");
    BIND(media_release, "libvlc_media_release");
    BIND(player_new_from_media, "libvlc_media_player_new_from_media");
    BIND(player_release, "libvlc_media_player_release");
    BIND(player_play, "libvlc_media_player_play");
    BIND(player_stop, "libvlc_media_player_stop");
    BIND(player_get_state, "libvlc_media_player_get_state");
    BIND(video_set_mouse_input, "libvlc_video_set_mouse_input");
    BIND(video_set_key_input, "libvlc_video_set_key_input");
    *(void **)(&vlc.log_set) = lib_symbol(lib, "libvlc_log_set");
    *(void **)(&vlc.log_get_context) = lib_symbol(lib, "libvlc_log_get_context");
#ifdef _WIN32
    BIND(player_set_hwnd, "libvlc_media_player_set_hwnd");
#else
    BIND(player_set_xwindow, "libvlc_media_player_set_xwindow");
#endif
#undef BIND
    return ok;
}

/* ---- platform window code ---- */
#ifdef _WIN32
typedef struct {
    DWORD pid;
    HWND best;
    LONG best_area;
} find_ctx_t;

static BOOL CALLBACK find_window_cb(HWND hwnd, LPARAM param)
{
    find_ctx_t *ctx = (find_ctx_t *)param;
    DWORD pid = 0;
    RECT rc;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != ctx->pid || !IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
    if (!GetClientRect(hwnd, &rc)) return TRUE;
    LONG area = (rc.right - rc.left) * (rc.bottom - rc.top);
    if (area > ctx->best_area) {
        ctx->best = hwnd;
        ctx->best_area = area;
    }
    return TRUE;
}

static LRESULT CALLBACK child_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static int window_create(void)
{
    find_ctx_t ctx = {(DWORD)g_parent_pid, NULL, 0};
    for (int i = 0; i < 100 && !ctx.best; i++) {
        EnumWindows(find_window_cb, (LPARAM)&ctx);
        if (!ctx.best) sleep_ms(100);
    }
    if (!ctx.best) {
        emit_error("no-parent-window", "No visible window found for process %ld.", g_parent_pid);
        return 0;
    }

    WNDCLASSW wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = child_proc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    wc.lpszClassName = L"VlcRecPlayerVideo";
    RegisterClassW(&wc);

    /* WS_CLIPCHILDREN is required by libVLC. WS_DISABLED sends clicks to the app. */
    g_child = CreateWindowExW(0, wc.lpszClassName, L"",
                              WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_DISABLED,
                              g_rect[0], g_rect[1], g_rect[2], g_rect[3],
                              ctx.best, NULL, wc.hInstance, NULL);
    if (!g_child) {
        emit_error("window-create", "CreateWindowEx failed with code %lu.", GetLastError());
        return 0;
    }
    SetWindowPos(g_child, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    return 1;
}

static void window_set_rect(const int r[4])
{
    SetWindowPos(g_child, HWND_TOP, r[0], r[1], r[2], r[3], SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
}

static void window_show(int show)
{
    ShowWindowAsync(g_child, show ? SW_SHOWNOACTIVATE : SW_HIDE);
}

static int parent_alive(void)
{
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)g_parent_pid);
    if (!h) return 0;
    DWORD rc = WaitForSingleObject(h, 0);
    CloseHandle(h);
    return rc == WAIT_TIMEOUT;
}

typedef struct {
    char text[700];
    size_t len;
    int count;
} child_list_t;

static BOOL CALLBACK child_list_cb(HWND hwnd, LPARAM param)
{
    child_list_t *list = (child_list_t *)param;
    char cls[80] = "";
    RECT rc = {0, 0, 0, 0};
    GetClassNameA(hwnd, cls, sizeof cls);
    GetClientRect(hwnd, &rc);
    list->count++;
    if (list->len + 120 < sizeof list->text) {
        list->len += (size_t)snprintf(list->text + list->len, sizeof list->text - list->len,
                                      "; %s %ldx%ld %s", cls, (long)rc.right, (long)rc.bottom,
                                      IsWindowVisible(hwnd) ? "visible" : "hidden");
    }
    return TRUE;
}

/* What the window tree looks like a few seconds into the playback: a black picture with no window
 * of libVLC's below the player's own means libVLC never made its video output. */
static void report_window(void)
{
    child_list_t list;
    RECT rc = {0, 0, 0, 0}, parent_rc = {0, 0, 0, 0};
    HWND parent = GetParent(g_child);
    memset(&list, 0, sizeof list);
    GetClientRect(g_child, &rc);
    if (parent) GetClientRect(parent, &parent_rc);
    EnumChildWindows(g_child, child_list_cb, (LPARAM)&list);
    char head[160], text[sizeof list.text + sizeof head];
    snprintf(head, sizeof head, "player window %ldx%ld %s, parent %ldx%ld, %d child windows",
             (long)rc.right, (long)rc.bottom, IsWindowVisible(g_child) ? "visible" : "hidden",
             (long)parent_rc.right, (long)parent_rc.bottom, list.count);
    snprintf(text, sizeof text, "%s%s", head, list.text);
    char escaped[1500], line[1600];
    json_escape(escaped, sizeof escaped, text);
    snprintf(line, sizeof line, "{\"event\":\"window\",\"text\":\"%s\"}", escaped);
    emit_raw(line);
}
#else
static int ignore_x_error(Display *dpy, XErrorEvent *ev)
{
    (void)dpy;
    (void)ev;
    return 0;
}

static void find_window_rec(Window win, Atom pid_atom, Window *best, long *best_area)
{
    Atom type;
    int format;
    unsigned long count = 0, after = 0;
    unsigned char *data = NULL;
    if (XGetWindowProperty(g_dpy, win, pid_atom, 0, 1, False, XA_CARDINAL, &type, &format,
                           &count, &after, &data) == Success && data) {
        long pid = count == 1 ? (long)*(unsigned long *)data : 0;
        XFree(data);
        if (pid == g_parent_pid) {
            XWindowAttributes attr;
            if (XGetWindowAttributes(g_dpy, win, &attr) && attr.map_state == IsViewable) {
                long area = (long)attr.width * attr.height;
                if (area > *best_area) {
                    *best = win;
                    *best_area = area;
                }
            }
        }
    }
    Window root, parent, *children = NULL;
    unsigned int n = 0;
    if (XQueryTree(g_dpy, win, &root, &parent, &children, &n)) {
        for (unsigned int i = 0; i < n; i++) find_window_rec(children[i], pid_atom, best, best_area);
        if (children) XFree(children);
    }
}

static int window_create(void)
{
    g_dpy = XOpenDisplay(NULL);
    if (!g_dpy) {
        emit_error("no-x11-display",
                   "Embedded video needs X11 or XWayland. Start the app with run-vlc-rec.sh.");
        return 0;
    }
    XSetErrorHandler(ignore_x_error);
    Atom pid_atom = XInternAtom(g_dpy, "_NET_WM_PID", False);
    Window parent = 0;
    long area = 0;
    for (int i = 0; i < 100 && !parent; i++) {
        find_window_rec(DefaultRootWindow(g_dpy), pid_atom, &parent, &area);
        if (!parent) sleep_ms(100);
    }
    if (!parent) {
        emit_error("no-parent-window",
                   "No X11 window found for process %ld. On Wayland start the app with run-vlc-rec.sh.",
                   g_parent_pid);
        return 0;
    }
    g_child = XCreateSimpleWindow(g_dpy, parent, g_rect[0], g_rect[1], (unsigned)g_rect[2],
                                  (unsigned)g_rect[3], 0, 0, BlackPixel(g_dpy, DefaultScreen(g_dpy)));
    XMapRaised(g_dpy, g_child);
    XSync(g_dpy, False);
    return 1;
}

static void window_set_rect(const int r[4])
{
    XMoveResizeWindow(g_dpy, g_child, r[0], r[1], (unsigned)r[2], (unsigned)r[3]);
    XRaiseWindow(g_dpy, g_child);
    XFlush(g_dpy);
}

static void window_show(int show)
{
    if (show) XMapRaised(g_dpy, g_child);
    else XUnmapWindow(g_dpy, g_child);
    XFlush(g_dpy);
}

static int parent_alive(void)
{
    return kill((pid_t)g_parent_pid, 0) == 0 || errno != ESRCH;
}
#endif

/* ---- stdin commands ---- */
static void handle_command(char *line)
{
    size_t n = strlen(line);
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = 0;
    for (size_t i = 0; i < n && line[i] != ' '; i++) {
        if (line[i] >= 'a' && line[i] <= 'z') line[i] = (char)(line[i] - 'a' + 'A');
    }
    if (strcmp(line, "STOP") == 0) {
        g_stop = 1;
    } else if (strcmp(line, "HIDE") == 0) {
        window_show(0);
    } else if (strcmp(line, "SHOW") == 0) {
        window_show(1);
    } else if (strncmp(line, "RECT ", 5) == 0) {
        int rect[4];
        if (parse_rect(line + 5, rect)) window_set_rect(rect);
    }
}

static void stdin_loop(void)
{
    char line[256];
    while (fgets(line, sizeof line, stdin)) handle_command(line);
    g_stop = 1;
}

/* ---- playback ---- */
static char *build_sout(void)
{
    /* Inside a quoted sout value only backslash and quotes need escaping. */
    size_t cap = strlen(g_record) * 2 + 128;
    char *escaped = malloc(cap), *sout = malloc(cap + 64);
    size_t o = 0;
    if (!escaped || !sout) return NULL;
    for (const char *p = g_record; *p; p++) {
        if (*p == '\\' || *p == '"' || *p == '\'') escaped[o++] = '\\';
        escaped[o++] = *p;
    }
    escaped[o] = 0;
    snprintf(sout, cap + 64, ":sout=#duplicate{dst=std{access=file,mux=%s,dst=\"%s\"},dst=display}",
             g_mux, escaped);
    free(escaped);
    return sout;
}

/* The size appears once the decoder or packetizer has parsed the stream headers,
 * in preview and in recording alike, so it is polled together with the stats. */
static void report_video_size(libvlc_media_t *media, unsigned last[4])
{
    vlc_media_track_t **tracks = NULL;
    unsigned count = vlc.media_tracks_get(media, &tracks);
    unsigned size[4] = {0, 0, 1, 1};
    for (unsigned i = 0; i < count; i++) {
        const vlc_video_track_t *video = tracks[i]->details;
        if (tracks[i]->i_type != VLC_TRACK_VIDEO || !video || !video->i_width || !video->i_height) continue;
        int transposed = video->i_orientation >= VLC_ORIENT_TRANSPOSED_FIRST &&
                         video->i_orientation <= VLC_ORIENT_TRANSPOSED_LAST;
        size[0] = transposed ? video->i_height : video->i_width;
        size[1] = transposed ? video->i_width : video->i_height;
        if (video->i_sar_num && video->i_sar_den) {
            size[2] = transposed ? video->i_sar_den : video->i_sar_num;
            size[3] = transposed ? video->i_sar_num : video->i_sar_den;
        }
        break;
    }
    if (count) vlc.media_tracks_release(tracks, count);
    if (!size[0] || memcmp(size, last, sizeof size) == 0) return;
    memcpy(last, size, sizeof size);
    char line[160];
    snprintf(line, sizeof line, "{\"event\":\"video\",\"width\":%u,\"height\":%u,\"sarNum\":%u,\"sarDen\":%u}",
             size[0], size[1], size[2], size[3]);
    emit_raw(line);
}

/* libVLC's media-player settings can override instance-level decoder options.
 * Keep the user's existing explicit hardware selection effective on the media too. */
static void apply_media_hardware(libvlc_media_t *media, const char *arguments)
{
    if (!arguments) return;
    char *copy = strdup(arguments);
    if (!copy) return;
    for (char *token = strtok(copy, " "); token; token = strtok(NULL, " ")) {
        if (strncmp(token, "--avcodec-hw=", 13) == 0) {
            token[1] = ':';
            vlc.media_add_option(media, token + 1);
        }
    }
    free(copy);
}

/* Runs on its own thread: libVLC calls can block, and on Windows a blocked
 * window thread would freeze the parent process through the shared input queue. */
static int run_player(void)
{
    /* With a log callback libVLC's messages become "log" events; without one they are silenced. */
    const char *args[24] = {"--stats", "--no-video-title-show", "--no-osd", vlc.log_set ? "--verbose=0" : "--quiet"};
    int argc = 4;
    const char *extra_env = getenv("VLC_REC_VLC_ARGS");
    char *extra = extra_env ? strdup(extra_env) : NULL;
    if (extra) {
        for (char *token = strtok(extra, " "); token && argc < 24; token = strtok(NULL, " ")) {
            args[argc++] = token;
            if (strncmp(token, "--verbose=", 10) == 0) {
                int verbose = atoi(token + 10);
                g_log_min_level = verbose >= 2 ? 0 : verbose == 1 ? 2 : 3;
            }
        }
    }
    libvlc_instance_t *inst = vlc.new_instance(argc, args);
    free(extra); /* libVLC has copied the options */
    if (!inst) {
        const char *err = vlc.errmsg();
        emit_error("libvlc-init", "libVLC could not start: %s", err ? err : "unknown error");
        return 1;
    }
    if (vlc.log_set) vlc.log_set(inst, log_callback, NULL);
    libvlc_media_t *media = vlc.media_new_location(inst, g_url);
    if (!media) {
        emit_error("bad-url", "libVLC rejected the stream address.");
        vlc.release(inst);
        return 1;
    }
    apply_media_hardware(media, extra_env);
    if (g_caching >= 0) {
        char option[64];
        snprintf(option, sizeof option, ":network-caching=%d", g_caching);
        vlc.media_add_option(media, option);
        snprintf(option, sizeof option, ":live-caching=%d", g_caching);
        vlc.media_add_option(media, option);
    }
    if (g_srt_latency >= 0) {
        char option[64];
        snprintf(option, sizeof option, ":latency=%d", g_srt_latency);
        vlc.media_add_option(media, option);
    }
    if (g_record) {
        char *sout = build_sout();
        if (!sout) return 1;
        vlc.media_add_option(media, sout);
        free(sout);
    }
    libvlc_media_player_t *player = vlc.player_new_from_media(media);
    if (!player) {
        emit_error("libvlc-player", "libVLC could not create a media player.");
        vlc.media_release(media);
        vlc.release(inst);
        return 1;
    }
#ifdef _WIN32
    vlc.player_set_hwnd(player, g_child);
#else
    vlc.player_set_xwindow(player, (unsigned int)g_child);
#endif
    vlc.video_set_mouse_input(player, 0);
    vlc.video_set_key_input(player, 0);

    if (vlc.player_play(player) != 0) {
        emit_error("libvlc-play", "libVLC could not start playback.");
        vlc.player_release(player);
        vlc.media_release(media);
        vlc.release(inst);
        return 1;
    }
    {
        char line[128];
        snprintf(line, sizeof line, "{\"event\":\"started\",\"libvlc\":\"%.40s\"}", vlc.get_version());
        emit_raw(line);
    }

    int exit_code = 0;
    unsigned video_size[4] = {0, 0, 0, 0};
    for (int tick = 0; !g_stop; tick++) {
        sleep_ms(200);
#ifdef _WIN32
        if (tick == 14) report_window();
#endif
        /* For the first 10 s, until the size is known, it is polled every tick so the
         * layout settles quickly; a stream without video size falls back to once a second. */
        if ((!video_size[0] && tick < 50) || tick % 5 == 4) report_video_size(media, video_size);
        if (tick % 5 != 4) continue;
        if (!parent_alive()) break;
        int state = vlc.player_get_state(player);
        if (state == VLC_STATE_ERROR || state == VLC_STATE_ENDED) {
            emit_error("stream-ended", "VLC reported that the stream %s.",
                       state == VLC_STATE_ERROR ? "failed" : "ended");
            exit_code = 1;
            break;
        }
        vlc_stats_t stats;
        memset(&stats, 0, sizeof stats);
        vlc.media_get_stats(media, &stats);
        char line[200];
        snprintf(line, sizeof line,
                 "{\"event\":\"stats\",\"state\":%d,\"readBytes\":%d,\"decoded\":%d,\"displayed\":%d,\"lost\":%d}",
                 state, stats.i_read_bytes, stats.i_decoded_video, stats.i_displayed_pictures,
                 stats.i_lost_pictures);
        emit_raw(line);
    }

    /* Stopping is what finalizes the output file, so it must always run. */
    vlc.player_stop(player);
    vlc.player_release(player);
    vlc.media_release(media);
    vlc.release(inst);
    emit_raw("{\"event\":\"stopped\"}");
    return exit_code;
}

#ifdef _WIN32
static volatile int g_exit_code = 0;

static unsigned __stdcall player_thread(void *arg)
{
    (void)arg;
    g_exit_code = run_player();
    PostThreadMessageW(g_main_thread, WM_QUIT, 0, 0);
    return 0;
}

static unsigned __stdcall stdin_thread(void *arg)
{
    (void)arg;
    stdin_loop();
    return 0;
}
#else
static void *stdin_thread(void *arg)
{
    (void)arg;
    stdin_loop();
    return NULL;
}
#endif

int main(int argc, char **argv)
{
    const char *url_hex = NULL, *record_hex = NULL;
    for (int i = 1; i + 1 < argc; i += 2) {
        if (strcmp(argv[i], "--parent-pid") == 0) g_parent_pid = atol(argv[i + 1]);
        else if (strcmp(argv[i], "--url-hex") == 0) url_hex = argv[i + 1];
        else if (strcmp(argv[i], "--record-hex") == 0) record_hex = argv[i + 1];
        else if (strcmp(argv[i], "--mux") == 0) g_mux = argv[i + 1];
        else if (strcmp(argv[i], "--caching") == 0) g_caching = atoi(argv[i + 1]);
        else if (strcmp(argv[i], "--srt-latency") == 0) g_srt_latency = atoi(argv[i + 1]);
        else if (strcmp(argv[i], "--rect") == 0) parse_rect(argv[i + 1], g_rect);
    }
#ifdef _WIN32
    InitializeCriticalSection(&g_out_lock);
    g_main_thread = GetCurrentThreadId();
    /* Match the per-monitor awareness of WebView2 so pixels mean the same on both sides. */
    {
        typedef BOOL(WINAPI * set_ctx_t)(void *);
        set_ctx_t set_ctx = (set_ctx_t)(void *)GetProcAddress(GetModuleHandleW(L"user32.dll"),
                                                              "SetProcessDpiAwarenessContext");
        if (set_ctx) set_ctx((void *)(LONG_PTR)-4);
    }
#else
    XInitThreads();
#endif
    if (g_parent_pid <= 0 || !url_hex || !(g_url = hex_decode(url_hex))) {
        emit_error("bad-arguments", "Required arguments are missing or invalid.");
        return 2;
    }
    if (g_caching > 60000) g_caching = 60000;
    if (g_srt_latency > 60000) g_srt_latency = 60000;
    if (g_srt_latency < 1) g_srt_latency = -1;
    if (strcmp(g_mux, "mkv") != 0 && strcmp(g_mux, "mp4") != 0) {
        emit_error("bad-arguments", "Unsupported container.");
        return 2;
    }
    if (record_hex && !(g_record = hex_decode(record_hex))) {
        emit_error("bad-arguments", "Invalid output path.");
        return 2;
    }

    lib_t lib = load_libvlc();
    if (!lib) {
#ifdef _WIN32
        if (g_libvlc_wrong_bitness) {
            emit_error("libvlc-not-found", "libVLC was not found: the libvlc.dll that exists is 32-bit, "
                       "and this player is 64-bit. Install VLC 3 for 64-bit Windows, or point "
                       "VLC_REC_LIBVLC_DIR at one.");
            return 3;
        }
#endif
        emit_error("libvlc-not-found", "libVLC was not found. Install VLC 3.");
        return 3;
    }
    if (!bind_libvlc(lib)) return 3;
    if (strncmp(vlc.get_version(), "3.", 2) != 0) {
        emit_error("libvlc-version", "VLC 3 is required, found %s.", vlc.get_version());
        return 3;
    }
    if (!window_create()) return 4;

#ifdef _WIN32
    _beginthreadex(NULL, 0, stdin_thread, NULL, 0, NULL);
    _beginthreadex(NULL, 0, player_thread, NULL, 0, NULL);
    /* This thread owns the child window and must keep pumping until playback ends. */
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    DestroyWindow(g_child);
    fflush(stdout);
    ExitProcess((UINT)g_exit_code);
#else
    pthread_t tid;
    pthread_create(&tid, NULL, stdin_thread, NULL);
    pthread_detach(tid);
    int code = run_player();
    fflush(stdout);
    _exit(code);
#endif
}
