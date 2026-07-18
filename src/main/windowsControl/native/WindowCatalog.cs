using System.Diagnostics;
using System.Text;
using System.Windows.Automation;

namespace AgentCode.WindowsControl;

internal sealed record WindowBounds(int X, int Y, int Width, int Height);
internal sealed record WindowEntry(
    string Id,
    string Title,
    int ProcessId,
    string ProcessName,
    string? ExecutablePath,
    bool IsMinimized,
    WindowBounds Bounds);
internal sealed record AppEntry(string Id, string DisplayName, string? ExecutablePath, WindowEntry[] Windows);

internal static class WindowCatalog
{
    internal static WindowEntry[] ListWindows()
    {
        var windows = new List<WindowEntry>();
        NativeMethods.EnumWindows((hwnd, _) =>
        {
            var entry = Describe(hwnd);
            if (entry is not null) windows.Add(entry);
            return true;
        }, 0);
        return windows.OrderBy((window) => window.ProcessName).ThenBy((window) => window.Title).ToArray();
    }

    internal static AppEntry[] ListApps()
    {
        return ListWindows()
            .GroupBy((window) => window.ExecutablePath ?? window.ProcessName, StringComparer.OrdinalIgnoreCase)
            .Select((group) =>
            {
                var first = group.First();
                var displayName = first.ProcessName;
                if (first.ExecutablePath is { } path)
                {
                    try
                    {
                        displayName = FileVersionInfo.GetVersionInfo(path).FileDescription?.Trim() ?? displayName;
                    }
                    catch { }
                }
                return new AppEntry(group.Key, displayName, first.ExecutablePath, group.ToArray());
            })
            .OrderBy((app) => app.DisplayName)
            .ToArray();
    }

    internal static object LaunchApp(string app, string[] arguments)
    {
        var info = new ProcessStartInfo
        {
            FileName = app,
            UseShellExecute = true
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        var process = Process.Start(info) ?? throw new InvalidOperationException($"O Windows não conseguiu iniciar {app}.");
        return new { ok = true, processId = process.Id };
    }

    internal static object Activate(nint hwnd)
    {
        EnsureWindow(hwnd);
        if (NativeMethods.IsIconic(hwnd)) NativeMethods.ShowWindowAsync(hwnd, NativeMethods.SW_RESTORE);

        if (!TryActivate(hwnd))
        {
            // Windows restricts foreground changes. A synthesized Alt press is the
            // documented-style recovery used by desktop automation tools; retry once.
            InputController.PressKey("Alt");
            if (!TryActivate(hwnd) && !ForceActivate(hwnd))
                throw new InvalidOperationException(
                    $"O Windows recusou ativar a janela (alvo={hwnd.ToInt64()}, atual={NativeMethods.GetForegroundWindow().ToInt64()}); " +
                    "tente novamente com a área de trabalho desbloqueada.");
        }
        Thread.Sleep(40);
        return new { ok = true };
    }

    private static bool TryActivate(nint hwnd)
    {
        var foreground = NativeMethods.GetForegroundWindow();
        if (foreground == hwnd) return true;

        var foregroundThread = foreground == 0 ? 0 : NativeMethods.GetWindowThreadProcessId(foreground, 0);
        var targetThread = NativeMethods.GetWindowThreadProcessId(hwnd, 0);
        var currentThread = NativeMethods.GetCurrentThreadId();
        var attachedForeground = false;
        var attachedTarget = false;
        try
        {
            if (foregroundThread != 0 && foregroundThread != currentThread)
                attachedForeground = NativeMethods.AttachThreadInput(currentThread, foregroundThread, true);
            if (targetThread != 0 && targetThread != currentThread)
                attachedTarget = NativeMethods.AttachThreadInput(currentThread, targetThread, true);
            NativeMethods.BringWindowToTop(hwnd);
            NativeMethods.SetActiveWindow(hwnd);
            NativeMethods.SetFocus(hwnd);
            NativeMethods.SetForegroundWindow(hwnd);
        }
        finally
        {
            if (attachedTarget) NativeMethods.AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) NativeMethods.AttachThreadInput(currentThread, foregroundThread, false);
        }
        Thread.Sleep(25);
        return NativeMethods.GetForegroundWindow() == hwnd;
    }

    private static bool ForceActivate(nint hwnd)
    {
        const uint flags = NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_SHOWWINDOW;
        NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_TOPMOST, 0, 0, 0, 0, flags);
        NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_NOTOPMOST, 0, 0, 0, 0, flags);
        NativeMethods.SwitchToThisWindow(hwnd, true);
        try { AutomationElement.FromHandle(hwnd)?.SetFocus(); } catch { }
        Thread.Sleep(40);
        return NativeMethods.GetForegroundWindow() == hwnd;
    }

    internal static System.Drawing.Point ToScreenPoint(nint hwnd, double x, double y)
    {
        var bounds = Bounds(hwnd);
        var px = bounds.Left + (int)Math.Round(x);
        var py = bounds.Top + (int)Math.Round(y);
        if (px < bounds.Left || py < bounds.Top || px >= bounds.Right || py >= bounds.Bottom)
            throw new ArgumentOutOfRangeException(nameof(x), "As coordenadas estão fora da janela.");
        return new System.Drawing.Point(px, py);
    }

    internal static NativeMethods.Rect Bounds(nint hwnd)
    {
        EnsureWindow(hwnd);
        if (!NativeMethods.GetWindowRect(hwnd, out var rect) || rect.Width <= 0 || rect.Height <= 0)
            throw new InvalidOperationException("Não foi possível ler o tamanho da janela.");
        return rect;
    }

    internal static void EnsureWindow(nint hwnd)
    {
        if (!NativeMethods.IsWindow(hwnd))
            throw new ArgumentException("A janela não existe mais; liste as janelas novamente.");
    }

    private static WindowEntry? Describe(nint hwnd)
    {
        if (!NativeMethods.IsWindowVisible(hwnd)) return null;
        var titleBuffer = new StringBuilder(1024);
        NativeMethods.GetWindowText(hwnd, titleBuffer, titleBuffer.Capacity);
        var title = titleBuffer.ToString().Trim();
        if (title.Length == 0) return null;
        if (!NativeMethods.GetWindowRect(hwnd, out var rect) || rect.Width < 2 || rect.Height < 2) return null;

        NativeMethods.GetWindowThreadProcessId(hwnd, out var pidRaw);
        var processId = unchecked((int)pidRaw);
        var processName = "unknown";
        string? executablePath = null;
        try
        {
            using var process = Process.GetProcessById(processId);
            processName = process.ProcessName;
            try { executablePath = process.MainModule?.FileName; } catch { }
        }
        catch { }

        return new WindowEntry(
            hwnd.ToInt64().ToString(),
            title,
            processId,
            processName,
            executablePath,
            NativeMethods.IsIconic(hwnd),
            new WindowBounds(rect.Left, rect.Top, rect.Width, rect.Height));
    }
}
