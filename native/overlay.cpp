#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <shellapi.h>
#include <mmsystem.h>
#include <algorithm>
#include <cwctype>
#include <string>
#include <vector>

namespace {

constexpr wchar_t kMutexName[] = L"Local\\DeepSeekHarness.TaskOverlay";
constexpr wchar_t kWindowClass[] = L"DeepSeekHarnessTaskOverlayWindow";
constexpr UINT_PTR kPollTimer = 1;
constexpr DWORD kPollIntervalMs = 150;
constexpr ULONGLONG kAlertIntervalMs = 30000;
constexpr int kCardWidth = 380;
constexpr int kPaddingX = 22;
constexpr int kMinHeight = 80;
constexpr int kMaxHeight = 156;
constexpr int kMaxDetailLines = 3;

struct OverlayState {
    std::wstring eventId;
    std::wstring kind;
    std::wstring title;
    std::wstring detail;
    std::wstring sessionTitle;
    std::wstring sessionId;
    std::wstring createdAt;
    std::wstring elapsed;
};

struct AppContext {
    HWND window = nullptr;
    HINSTANCE instance = nullptr;
    std::wstring statePath;
    OverlayState state;
    std::wstring currentEventId;
    bool dismissed = false;
    bool visible = false;
    UINT dpi = 96;
    ULONGLONG lastAlertAt = 0;
};

std::wstring utf8ToWide(const std::string& text) {
    if (text.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (size <= 0) return {};
    std::wstring result(static_cast<std::size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), size);
    return result;
}

std::vector<std::string> splitFields(const std::string& data) {
    std::vector<std::string> fields;
    std::size_t start = 0;
    while (start <= data.size()) {
        const std::size_t end = data.find('\0', start);
        fields.push_back(data.substr(start, end == std::string::npos ? std::string::npos : end - start));
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return fields;
}

bool readState(const std::wstring& path, OverlayState& state) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;

    LARGE_INTEGER size = {};
    if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > 1024 * 1024) {
        CloseHandle(file);
        return false;
    }

    std::string data(static_cast<std::size_t>(size.QuadPart), '\0');
    DWORD read = 0;
    const BOOL ok = ReadFile(file, data.data(), static_cast<DWORD>(data.size()), &read, nullptr);
    CloseHandle(file);
    if (!ok || read != data.size()) return false;

    const auto fields = splitFields(data);
    if (fields.size() < 8 || fields[0] != "DSH-TASK-OVERLAY-1") return false;

    state.eventId = utf8ToWide(fields[1]);
    state.kind = utf8ToWide(fields[2]);
    state.title = utf8ToWide(fields[3]);
    state.detail = utf8ToWide(fields[4]);
    state.sessionTitle = utf8ToWide(fields[5]);
    state.sessionId = utf8ToWide(fields[6]);
    state.createdAt = utf8ToWide(fields[7]);
    if (fields.size() > 8) state.elapsed = utf8ToWide(fields[8]);
    return !state.eventId.empty();
}

int scale(int value, UINT dpi) {
    return MulDiv(value, static_cast<int>(dpi), 96);
}

COLORREF accentColor(const std::wstring& kind) {
    if (kind == L"completed") return RGB(34, 197, 94);
    if (kind == L"approval") return RGB(245, 158, 11);
    if (kind == L"error") return RGB(239, 68, 68);
    if (kind == L"blocked" || kind == L"truncated" || kind == L"interrupted") return RGB(249, 115, 22);
    return RGB(96, 165, 250);
}

std::wstring windowTitle(const OverlayState& state) {
    if (!state.title.empty()) return state.title;
    if (state.kind == L"completed") return L"Tarefa concluída";
    if (state.kind == L"approval") return L"Aprovação necessária";
    if (state.kind == L"error") return L"A tarefa falhou";
    if (state.kind == L"blocked") return L"A tarefa foi bloqueada";
    if (state.kind == L"truncated") return L"Resposta truncada";
    if (state.kind == L"interrupted") return L"A tarefa foi interrompida";
    return L"Sua intervenção é necessária";
}

void positionWindow(AppContext& context) {
    HWND foreground = GetForegroundWindow();
    HMONITOR monitor = foreground != nullptr
        ? MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST)
        : MonitorFromPoint(POINT{ 0, 0 }, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO info = {};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) return;

    RECT window = {};
    GetWindowRect(context.window, &window);
    const int width = window.right - window.left;
    const int margin = scale(16, context.dpi);
    const int x = info.rcWork.right - width - margin;
    const int y = info.rcWork.top + margin;
    SetWindowPos(context.window, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
}

bool isDeepSeekHarnessForeground() {
    const HWND foreground = GetForegroundWindow();
    if (foreground == nullptr) return false;

    DWORD processId = 0;
    GetWindowThreadProcessId(foreground, &processId);
    if (processId == 0) return false;

    const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
    if (process == nullptr) return false;

    wchar_t path[32768] = {};
    DWORD size = static_cast<DWORD>(std::size(path));
    const BOOL ok = QueryFullProcessImageNameW(process, 0, path, &size);
    CloseHandle(process);
    if (!ok) return false;

    std::wstring executable(path, size);
    const std::size_t slash = executable.find_last_of(L"\\/");
    if (slash != std::wstring::npos) executable.erase(0, slash + 1);
    return _wcsicmp(executable.c_str(), L"DeepSeek Harness.exe") == 0;
}

void drawText(HDC dc, const std::wstring& text, RECT rect, UINT flags, COLORREF color, HFONT font) {
    const HGDIOBJ oldFont = SelectObject(dc, font);
    SetTextColor(dc, color);
    SetBkMode(dc, TRANSPARENT);
    DrawTextW(dc, text.c_str(), static_cast<int>(text.size()), &rect, flags);
    SelectObject(dc, oldFont);
}

/**
 * Fit the detail text to the allowed number of lines and return the card height it needs.
 * The detail is shortened with an ellipsis so a long answer can never fill the screen.
 */
int fitDetailAndHeight(AppContext& context) {
    const UINT dpi = context.dpi;
    const int detailWidth = scale(kCardWidth - 2 * kPaddingX, dpi);

    HDC screen = GetDC(nullptr);
    HDC dc = CreateCompatibleDC(screen);
    ReleaseDC(nullptr, screen);
    HFONT font = CreateFontW(
        -scale(13, dpi), 0, 0, 0, FW_NORMAL,
        FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    const HGDIOBJ oldFont = SelectObject(dc, font);
    TEXTMETRICW metrics{};
    GetTextMetricsW(dc, &metrics);
    const int lineHeight = metrics.tmHeight;

    int lines = 0;
    if (!context.state.detail.empty()) {
        RECT measured = { 0, 0, detailWidth, scale(1000, dpi) };
        DrawTextW(dc, context.state.detail.c_str(), -1, &measured, DT_CALCRECT | DT_WORDBREAK);
        lines = (measured.bottom - measured.top + lineHeight - 1) / lineHeight;
        if (lines > kMaxDetailLines) {
            SIZE extent{};
            GetTextExtentPoint32W(dc, context.state.detail.c_str(), -1, &extent);
            const double average = static_cast<double>(extent.cx) / static_cast<double>(context.state.detail.size());
            const int perLine = average > 0.0 ? static_cast<int>(detailWidth / average) : 40;
            const size_t keep = std::max<size_t>(1, static_cast<size_t>(perLine) * kMaxDetailLines - 1);
            context.state.detail = context.state.detail.substr(0, keep) + L"…";
            lines = kMaxDetailLines;
        }
    }

    SelectObject(dc, oldFont);
    DeleteObject(font);
    DeleteDC(dc);

    int height = scale(64, dpi) + lines * lineHeight + scale(12, dpi);
    if (!context.state.elapsed.empty()) height += scale(22, dpi);
    return std::min(std::max(height, scale(kMinHeight, dpi)), scale(kMaxHeight, dpi));
}

/** Lowercase extension of one file name, including the dot. */
std::wstring lowerExtension(const std::wstring& name) {
    const size_t dot = name.find_last_of(L'.');
    if (dot == std::wstring::npos) return {};
    std::wstring extension = name.substr(dot);
    for (wchar_t& character : extension) {
        character = static_cast<wchar_t>(towlower(character));
    }
    return extension;
}

/** Folder that holds the state file and the optional custom sound. */
std::wstring stateFolder(const std::wstring& statePath) {
    const size_t separator = statePath.find_last_of(L"\\/");
    return separator == std::wstring::npos ? std::wstring(L".") : statePath.substr(0, separator);
}

/** Find the first audio file dropped next to the state file. */
std::wstring findCustomSound(const std::wstring& folder) {
    WIN32_FIND_DATAW data{};
    const HANDLE handle = FindFirstFileW((folder + L"\\*").c_str(), &data);
    if (handle == INVALID_HANDLE_VALUE) return {};
    std::wstring found;
    do {
        if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) continue;
        const std::wstring extension = lowerExtension(data.cFileName);
        if (extension == L".wav" || extension == L".wave" || extension == L".mp3" ||
            extension == L".m4a" || extension == L".aac" || extension == L".wma") {
            if (found.empty()) found = folder + L"\\" + data.cFileName;
        }
    } while (FindNextFileW(handle, &data));
    FindClose(handle);
    return found;
}

/** Play the custom sound when one is available, otherwise use the system alert. */
void playAlertSound(const std::wstring& folder) {
    const std::wstring sound = findCustomSound(folder);
    if (sound.empty()) {
        MessageBeep(MB_ICONASTERISK);
        return;
    }
    const std::wstring extension = lowerExtension(sound);
    if (extension == L".wav" || extension == L".wave") {
        if (PlaySoundW(sound.c_str(), nullptr, SND_FILENAME | SND_ASYNC)) return;
        MessageBeep(MB_ICONASTERISK);
        return;
    }
    mciSendStringW(L"close dshTaskAlert", nullptr, 0, nullptr);
    const std::wstring open = L"open \"" + sound + L"\" type mpegvideo alias dshTaskAlert";
    if (mciSendStringW(open.c_str(), nullptr, 0, nullptr) != 0) {
        MessageBeep(MB_ICONASTERISK);
        return;
    }
    mciSendStringW(L"seek dshTaskAlert to start", nullptr, 0, nullptr);
    mciSendStringW(L"play dshTaskAlert", nullptr, 0, nullptr);
}

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* context = reinterpret_cast<AppContext*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    switch (message) {
    case WM_CREATE: {
        auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
        context = static_cast<AppContext*>(create->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(context));
        context->window = window;
        context->dpi = GetDpiForWindow(window);
        return 0;
    }
    case WM_PAINT: {
        PAINTSTRUCT paint = {};
        HDC dc = BeginPaint(window, &paint);
        RECT client = {};
        GetClientRect(window, &client);

        const HBRUSH background = CreateSolidBrush(RGB(21, 21, 23));
        FillRect(dc, &client, background);
        DeleteObject(background);

        const HBRUSH accent = CreateSolidBrush(accentColor(context->state.kind));
        RECT stripe = { 0, 0, scale(4, context->dpi), client.bottom };
        FillRect(dc, &stripe, accent);
        DeleteObject(accent);

        const HGDIOBJ oldPen = SelectObject(dc, GetStockObject(NULL_PEN));
        const HGDIOBJ oldBrush = SelectObject(dc, GetStockObject(NULL_BRUSH));
        const HPEN border = CreatePen(PS_SOLID, 1, RGB(55, 55, 60));
        SelectObject(dc, border);
        RoundRect(dc, 0, 0, client.right, client.bottom, scale(14, context->dpi), scale(14, context->dpi));
        DeleteObject(border);
        SelectObject(dc, oldBrush);
        SelectObject(dc, oldPen);

        HFONT sessionFont = CreateFontW(
            -scale(12, context->dpi), 0, 0, 0, FW_SEMIBOLD,
            FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        HFONT titleFont = CreateFontW(
            -scale(20, context->dpi), 0, 0, 0, FW_SEMIBOLD,
            FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        HFONT bodyFont = CreateFontW(
            -scale(13, context->dpi), 0, 0, 0, FW_NORMAL,
            FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");

        RECT session = { scale(kPaddingX, context->dpi), scale(14, context->dpi), client.right - scale(kPaddingX, context->dpi), scale(34, context->dpi) };
        drawText(dc, context->state.sessionTitle, session, DT_SINGLELINE | DT_END_ELLIPSIS, RGB(161, 161, 170), sessionFont);

        RECT title = { scale(kPaddingX, context->dpi), scale(36, context->dpi), client.right - scale(kPaddingX, context->dpi), scale(64, context->dpi) };
        drawText(dc, windowTitle(context->state), title, DT_SINGLELINE | DT_END_ELLIPSIS, RGB(250, 250, 250), titleFont);

        const int elapsedHeight = context->state.elapsed.empty() ? 0 : scale(22, context->dpi);
        const int detailBottom = client.bottom - elapsedHeight - (elapsedHeight > 0 ? scale(4, context->dpi) : scale(12, context->dpi));
        RECT detail = { scale(kPaddingX, context->dpi), scale(68, context->dpi), client.right - scale(kPaddingX, context->dpi), detailBottom };
        drawText(dc, context->state.detail, detail, DT_WORDBREAK, RGB(212, 212, 216), bodyFont);

        if (!context->state.elapsed.empty()) {
            RECT elapsed = { client.right - scale(kPaddingX, context->dpi) - scale(110, context->dpi), client.bottom - scale(32, context->dpi), client.right - scale(kPaddingX, context->dpi), client.bottom - scale(12, context->dpi) };
            drawText(dc, context->state.elapsed, elapsed, DT_SINGLELINE | DT_VCENTER | DT_RIGHT, RGB(212, 212, 216), bodyFont);
        }

        DeleteObject(sessionFont);
        DeleteObject(titleFont);
        DeleteObject(bodyFont);
        EndPaint(window, &paint);
        return 0;
    }
    case WM_TIMER: {
        OverlayState next;
        if (readState(context->statePath, next)) {
            if (next.eventId != context->currentEventId) {
                context->state = std::move(next);
                context->currentEventId = context->state.eventId;
                context->dismissed = false;
                const int height = fitDetailAndHeight(*context);
                SetWindowPos(window, HWND_TOPMOST, 0, 0, scale(kCardWidth, context->dpi), height, SWP_NOMOVE | SWP_NOACTIVATE);
                InvalidateRect(window, nullptr, FALSE);
                positionWindow(*context);
                ShowWindow(window, SW_SHOWNOACTIVATE);
                context->visible = true;
                context->lastAlertAt = GetTickCount64();
                playAlertSound(stateFolder(context->statePath));
            }
        }

        if (context->visible && !context->dismissed && isDeepSeekHarnessForeground()) {
            ShowWindow(window, SW_HIDE);
            context->visible = false;
            context->dismissed = true;
        }

        if (context->visible && !context->dismissed && GetTickCount64() - context->lastAlertAt >= kAlertIntervalMs) {
            context->lastAlertAt = GetTickCount64();
            playAlertSound(stateFolder(context->statePath));
        }
        SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        return 0;
    }
    case WM_NCHITTEST:
        return HTTRANSPARENT;
    case WM_MOUSEACTIVATE:
        return MA_NOACTIVATE;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProcW(window, message, wParam, lParam);
    }
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    int argumentCount = 0;
    LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    if (arguments == nullptr) return 1;

    AppContext context;
    context.instance = instance;
    for (int index = 1; index < argumentCount; ++index) {
        const std::wstring option = arguments[index];
        if (option == L"--state" && index + 1 < argumentCount) context.statePath = arguments[++index];
    }
    LocalFree(arguments);
    if (context.statePath.empty()) return 1;

    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    HANDLE mutex = CreateMutexW(nullptr, FALSE, kMutexName);
    if (mutex == nullptr || GetLastError() == ERROR_ALREADY_EXISTS) {
        if (mutex != nullptr) CloseHandle(mutex);
        return 0;
    }

    WNDCLASSEXW windowClass = {};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = windowProcedure;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
    windowClass.hbrBackground = nullptr;
    windowClass.lpszClassName = kWindowClass;
    if (RegisterClassExW(&windowClass) == 0) {
        CloseHandle(mutex);
        return 1;
    }

    const int width = scale(kCardWidth, 96);
    const int height = scale(kMinHeight, 96);
    HWND window = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        kWindowClass,
        L"DeepSeek Harness Task Overlay",
        WS_POPUP,
        0,
        0,
        width,
        height,
        nullptr,
        nullptr,
        instance,
        &context);
    if (window == nullptr) {
        CloseHandle(mutex);
        return 1;
    }

    SetTimer(window, kPollTimer, kPollIntervalMs, nullptr);
    MSG message = {};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    CloseHandle(mutex);
    return static_cast<int>(message.wParam);
}
