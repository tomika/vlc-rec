/* Offscreen host, real libVLC, production window code. No camera or visible UI. */
#define main recorder_player_main
#include "../../native/vlc-rec-player.c"
#undef main
#include <assert.h>
static void pump(void)
{
    MSG msg;
    while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
}
static void check_rect(int x, int y, int width, int height)
{
    RECT rect;
    GetWindowRect(g_child, &rect);
    MapWindowPoints(NULL, GetParent(g_child), (POINT *)&rect, 2);
    assert(abs(rect.left - x) <= 1 && abs(rect.top - y) <= 1);
    assert(abs((rect.right - rect.left) - width) <= 1 && abs((rect.bottom - rect.top) - height) <= 1);
    assert((GetWindowLongPtrW(g_child, GWL_STYLE) & WS_CHILD) != 0);
}
static DWORD player_pid;
static BOOL CALLBACK count_top(HWND hwnd, LPARAM param)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == player_pid && IsWindowVisible(hwnd)) (*(int *)param)++;
    return TRUE;
}
static BOOL CALLBACK find_video(HWND hwnd, LPARAM param)
{
    wchar_t name[128];
    GetClassNameW(hwnd, name, 128);
    if (wcscmp(name, L"VlcRecPlayerVideo") == 0) { *(HWND *)param = hwnd; return FALSE; }
    return TRUE;
}
static void command(HANDLE input, const char *line)
{
    DWORD count;
    assert(WriteFile(input, line, (DWORD)strlen(line), &count, NULL));
    for (int i = 0; i < 20; i++) { pump(); Sleep(10); }
}
int main(int argc, char **argv)
{
    assert(argc == 4);
    InitializeCriticalSection(&g_out_lock);
    g_main_thread = GetCurrentThreadId();
    typedef BOOL(WINAPI *set_dpi_t)(void *);
    set_dpi_t set_dpi = (set_dpi_t)(void *)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
    if (set_dpi) assert(set_dpi((void *)(LONG_PTR)atoi(argv[2])));
    WNDCLASSW cls = {0}; cls.lpfnWndProc = DefWindowProcW;
    cls.hInstance = GetModuleHandleW(NULL); cls.lpszClassName = L"RecorderOffscreenTest";
    assert(RegisterClassW(&cls));
    HWND host = CreateWindowExW(0, cls.lpszClassName, L"Recorder embedding test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                              -20000, -20000, 1000, 700, NULL, NULL, cls.hInstance, NULL);
    assert(host);
    ShowWindow(host, SW_SHOWNOACTIVATE);
    ShowWindow(host, SW_SHOWNOACTIVATE);
    pump();
    cls.lpszClassName = L"Chrome_RenderWidgetHostHWND"; assert(RegisterClassW(&cls));
    HWND browser = CreateWindowExW(0, cls.lpszClassName, L"", WS_CHILD | WS_VISIBLE,
                                 0, 0, 980, 660, host, NULL, cls.hInstance, NULL);
    assert(browser);
    SECURITY_ATTRIBUTES security = {sizeof security, NULL, TRUE};
    HANDLE input_read, input_write;
    assert(CreatePipe(&input_read, &input_write, &security, 0));
    assert(SetHandleInformation(input_write, HANDLE_FLAG_INHERIT, 0));
    char *hex = malloc(strlen(argv[1]) * 2 + 1); assert(hex);
    for (size_t i = 0; i < strlen(argv[1]); i++) sprintf(hex + i*2, "%02x", (unsigned char)argv[1][i]);
    wchar_t executable[32768], arguments[32768];
    MultiByteToWideChar(CP_UTF8, 0, argv[3], -1, executable, 32768);
    swprintf(arguments, 32768, L"\"%ls\" --parent-pid %lu --url-hex %hs --rect 60,90,480,270 --rect-scale 1.5", executable, GetCurrentProcessId(), hex);
    free(hex);
    STARTUPINFOW startup = {0}; startup.cb = sizeof startup;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = input_read;
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION process;
    assert(CreateProcessW(executable, arguments, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &startup, &process));
    CloseHandle(input_read); CloseHandle(process.hThread);
    player_pid = process.dwProcessId;
    for (int i = 0; i < 1500 && !g_child; i++) { pump(); EnumChildWindows(browser, find_video, (LPARAM)&g_child); Sleep(10); }
    assert(g_child && GetParent(g_child) == browser);
    typedef UINT(WINAPI *get_dpi_t)(HWND);
    get_dpi_t get_dpi = (get_dpi_t)(void *)GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow");
    double scale = (get_dpi ? get_dpi(browser) : 96) / 96.0;
    check_rect((int)(40*scale+.5), (int)(60*scale+.5), (int)(320*scale+.5), (int)(180*scale+.5));
    command(input_write, "RECT 150,75,600,300 1.5\n");
    check_rect((int)(100*scale+.5), (int)(50*scale+.5), (int)(400*scale+.5), (int)(200*scale+.5));
    command(input_write, "HIDE\n"); assert(!IsWindowVisible(g_child));
    command(input_write, "SHOW\n"); assert(IsWindowVisible(g_child));
    SetWindowPos(host, NULL, -19000, -19500, 800, 600, SWP_NOZORDER | SWP_NOACTIVATE);
    check_rect((int)(100*scale+.5), (int)(50*scale+.5), (int)(400*scale+.5), (int)(200*scale+.5));
    int saw_video = 0;
    for (int i = 0; i < 150; i++) {
        pump();
        if (GetWindow(g_child, GW_CHILD)) saw_video = 1;
        int count = 0; EnumWindows(count_top, (LPARAM)&count); assert(count == 0);
        if (WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0) break;
        Sleep(30);
    }
    if (WaitForSingleObject(process.hProcess, 0) != WAIT_OBJECT_0) command(input_write, "STOP\n");
    CloseHandle(input_write);
    for (int i = 0; i < 500 && WaitForSingleObject(process.hProcess, 0) != WAIT_OBJECT_0; i++) { pump(); Sleep(10); }
    DWORD code = 99;
    assert(GetExitCodeProcess(process.hProcess, &code));
    assert((code == 0 || code == 1) && saw_video);
    CloseHandle(process.hProcess); DestroyWindow(host);
    printf("PASS: offscreen cross-process Windows embedding, browser parent, DPI mode %s, resize, move, hide/show, real video stays a child\n", argv[2]);
    return 0;
}
