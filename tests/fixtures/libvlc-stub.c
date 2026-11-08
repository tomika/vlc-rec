/*
 * Minimal libVLC stand-in for testing vlc-rec-player without VLC. It exports what
 * the player loads, reports a growing byte counter, and when the media has a
 * :sout option it appends to the dst="..." file like a real recording would.
 * native/build.sh builds it into tests/fixtures/stub/.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#define API __declspec(dllexport)
#else
#define API __attribute__((visibility("default")))
#endif

typedef struct {
    int i_read_bytes;
    float pad_bitrate;
    int rest[12];
    float pad_send;
} stats_t;

static char g_out[1024];
static int g_bytes = 0;
static int g_state = 0;
static int g_token;

API void *libvlc_new(int argc, const char *const *argv) { (void)argc; (void)argv; return &g_token; }
API void libvlc_release(void *p) { (void)p; }
API const char *libvlc_get_version(void)
{
    const char *forced = getenv("LIBVLC_STUB_VERSION");
    return forced ? forced : "3.0.0 stub";
}
API const char *libvlc_errmsg(void) { return "stub"; }
API void *libvlc_media_new_location(void *i, const char *url) { (void)i; (void)url; return &g_token; }

API void libvlc_media_add_option(void *m, const char *opt)
{
    /* Copy dst="..." while removing the escaping the player applies. */
    const char *p = strstr(opt, "dst=\"");
    size_t o = 0;
    (void)m;
    if (!p) return;
    for (p += 5; *p && *p != '"' && o + 1 < sizeof g_out; p++) {
        if (*p == '\\' && p[1]) p++;
        g_out[o++] = *p;
    }
    g_out[o] = 0;
}

/* libVLC paths are UTF-8, which plain fopen does not understand on Windows. */
static FILE *open_utf8(const char *path)
{
#ifdef _WIN32
    wchar_t wide[1024];
    if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wide, 1024)) return NULL;
    return _wfopen(wide, L"ab");
#else
    return fopen(path, "ab");
#endif
}

API int libvlc_media_get_stats(void *m, stats_t *s)
{
    (void)m;
    g_bytes += 1000;
    s->i_read_bytes = g_bytes;
    if (g_out[0]) {
        FILE *f = open_utf8(g_out);
        if (f) {
            fputs("stub-recording-data\n", f);
            fclose(f);
        }
    }
    return 1;
}
API void libvlc_media_release(void *m) { (void)m; }
API void *libvlc_media_player_new_from_media(void *m) { (void)m; return &g_token; }
API void libvlc_media_player_release(void *p) { (void)p; }
API int libvlc_media_player_play(void *p) { (void)p; g_state = 3; return 0; }
API void libvlc_media_player_stop(void *p) { (void)p; g_state = 5; }
API int libvlc_media_player_get_state(void *p) { (void)p; return g_state; }
API void libvlc_video_set_mouse_input(void *p, unsigned on) { (void)p; (void)on; }
API void libvlc_video_set_key_input(void *p, unsigned on) { (void)p; (void)on; }
API void libvlc_media_player_set_hwnd(void *p, void *h) { (void)p; (void)h; }
API void libvlc_media_player_set_xwindow(void *p, unsigned int x) { (void)p; (void)x; }
