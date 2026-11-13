/* Run in the Linux player builder: gcc -std=gnu11 tests/fixtures/camera-pose-test.c -lm -o /tmp/camera-pose-test && /tmp/camera-pose-test */
#define main camera_plugin_main
#include "../../plugins/osc/osc.c"
#undef main
#include <assert.h>

int main(void)
{
    g_sock = socket(AF_INET, SOCK_DGRAM, 0);
    assert(g_sock != INVALID_SOCKET);
    note_pose(10, 20, 10000);
    long long until = g_pose_until;
    assert(do_move_to(-20, -10));
    assert(g_pose_until == until);
    int tilt, pan;
    assert(current_pose(&tilt, &pan));
    assert(tilt == 10 && pan == 20);
    g_cam.sin_family = AF_INET;
    g_cam.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    g_cam.sin_port = htons(9);
    assert(do_move_to(-21, -10));
    assert(g_pose_until >= until);
    until = g_pose_until;
    assert(do_nudge(0, 0));
    assert(g_pose_until == until);
    close(g_sock);
    return 0;
}
