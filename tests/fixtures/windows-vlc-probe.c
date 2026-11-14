/* Headless integration probe for the production Windows libVLC loader. No camera or window. */
#define main recorder_player_main
#include "../../native/vlc-rec-player.c"
#undef main
int main(int argc, char **argv)
{
    InitializeCriticalSection(&g_out_lock);
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
    lib_t lib = load_libvlc();
    if (!lib) { fprintf(stderr, "VLC loading failed: %lu\n", GetLastError()); return 3; }
    if (!bind_libvlc(lib)) return 4;
    wchar_t wide[2048]; char utf8[8192], escaped[16384];
    GetModuleFileNameW(lib, wide, 2048);
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, utf8, sizeof utf8, NULL, NULL);
    json_escape(escaped, sizeof escaped, utf8);
    int decoded = 0;
    if (argc > 1) {
        const char *args[] = {"--quiet", "--no-audio", "--vout=dummy", "--no-video-title-show", "--no-osd", "--stats", "--avcodec-hw=none"};
        libvlc_instance_t *instance = vlc.new_instance(7, args);
        if (!instance) return 5;
        libvlc_media_t *media = vlc.media_new_location(instance, argv[1]);
        if (!media) return 8;
        apply_media_hardware(media, "--avcodec-hw=none");
        libvlc_media_player_t *player = vlc.player_new_from_media(media);
        if (!player) return 9;
        if (vlc.player_play(player) != 0) return 6;
        for (int i = 0; i < 100; i++) {
            Sleep(100);
            vlc_stats_t stats = {0};
            vlc.media_get_stats(media, &stats);
            if (stats.i_decoded_video > decoded) decoded = stats.i_decoded_video;
            int state = vlc.player_get_state(player);
            if (state == VLC_STATE_ENDED || state == VLC_STATE_ERROR) break;
        }
        vlc.player_stop(player);
        vlc.player_release(player); vlc.media_release(media); vlc.release(instance);
        if (!decoded) return 7;
    }
    printf("{\"version\":\"%s\",\"dll\":\"%s\",\"decoded\":%d}\n", vlc.get_version(), escaped, decoded);
    return 0;
}
