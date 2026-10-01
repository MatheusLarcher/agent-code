using System.Text;

namespace AgentCode.WindowsControl;

// Decides which top-level window really receives synthesized input. A window disabled by a
// modal dialog silently drops keystrokes, so input goes to the enabled popup it owns and the
// foreground is verified before any SendInput call — never an "ok" for input that was lost.
internal static class InputTarget
{
    internal const int MaxModalDepth = 5;

    // Keyboard input: the requested window when enabled, otherwise its modal popup.
    internal static nint ActivateForKeyboard(nint hwnd)
    {
        var target = Resolve(hwnd);
        ActivateVerified(target);
        return target;
    }

    // Pointer input: coordinates stay relative to the requested window. A modal only takes the
    // input when every screen point falls inside it. screenPoints runs only when redirecting,
    // so callers compute the points they send after activation (a restore can move the window).
    // insideModal (element actions): a redirect also requires the element itself to belong to the
    // modal — a control of the disabled window hidden behind the modal must never be "hit".
    internal static nint ActivateForPointer(
        nint hwnd,
        Func<System.Drawing.Point[]> screenPoints,
        Func<nint, bool>? insideModal = null)
    {
        var target = Resolve(hwnd);
        if (target != hwnd)
        {
            if (insideModal is not null && !insideModal(target)) throw DisabledError(target);
            var bounds = WindowCatalog.Bounds(target);
            if (!screenPoints().All((point) => Contains(bounds, point)))
                throw new InvalidOperationException(
                    $"Há um diálogo modal aberto ('{Title(target)}', windowId {target.ToInt64()}); aja nele ou feche-o antes.");
        }
        ActivateVerified(target);
        return target;
    }

    internal static nint Resolve(nint hwnd)
    {
        WindowCatalog.EnsureWindow(hwnd);
        var target = WalkModalChain(hwnd, out var enabled);
        if (!enabled) throw DisabledError(target);
        return target;
    }

    private static void ActivateVerified(nint target)
    {
        WindowCatalog.Activate(target);
        EnsureReady(target);
    }

    // Re-check right before SendInput when something ran after activation (e.g. SetFocus).
    internal static void EnsureReady(nint target)
    {
        if (!NativeMethods.IsWindowEnabled(target))
        {
            var modal = WalkModalChain(target, out _);
            throw DisabledError(modal == target ? 0 : modal);
        }
        var foreground = NativeMethods.GetForegroundWindow();
        if (foreground != target)
            throw new InvalidOperationException(
                $"A entrada não foi enviada: a janela em primeiro plano (windowId {foreground.ToInt64()}) " +
                $"não é o alvo (windowId {target.ToInt64()}).");
    }

    // Follows disabled window -> popup -> nested popup. Returns the first enabled window
    // (enabled = true) or the deepest popup found (0 when there is none) with enabled = false.
    private static nint WalkModalChain(nint hwnd, out bool enabled)
    {
        var current = hwnd;
        for (var depth = 0; ; depth++)
        {
            if (NativeMethods.IsWindowEnabled(current))
            {
                enabled = true;
                return current;
            }
            var popup = depth < MaxModalDepth ? FindPopup(current) : 0;
            if (popup == 0)
            {
                enabled = false;
                return current == hwnd ? 0 : current;
            }
            current = popup;
        }
    }

    // Prefers an enabled popup; a disabled one is returned only so the caller can descend into
    // a nested modal. Popups from other processes or invisible ones are never candidates.
    private static nint FindPopup(nint owner)
    {
        var process = ProcessId(owner);
        var last = NativeMethods.GetLastActivePopup(owner);
        var lastIsCandidate = IsCandidate(last, owner, process);
        if (lastIsCandidate && NativeMethods.IsWindowEnabled(last)) return last;

        nint enabledOwned = 0;
        nint disabledOwned = 0;
        NativeMethods.EnumWindows((candidate, _) =>
        {
            if (NativeMethods.GetWindow(candidate, NativeMethods.GW_OWNER) != owner) return true;
            if (!IsCandidate(candidate, owner, process)) return true;
            if (NativeMethods.IsWindowEnabled(candidate))
            {
                enabledOwned = candidate;
                return false;
            }
            if (disabledOwned == 0) disabledOwned = candidate;
            return true;
        }, 0);

        if (enabledOwned != 0) return enabledOwned;
        if (lastIsCandidate) return last;
        return disabledOwned;
    }

    private static bool IsCandidate(nint candidate, nint owner, uint process)
        => candidate != 0
            && candidate != owner
            && NativeMethods.IsWindow(candidate)
            && NativeMethods.IsWindowVisible(candidate)
            && ProcessId(candidate) == process;

    internal static uint ProcessId(nint hwnd)
    {
        NativeMethods.GetWindowThreadProcessId(hwnd, out var processId);
        return processId;
    }

    private static bool Contains(NativeMethods.Rect bounds, System.Drawing.Point point)
        => point.X >= bounds.Left && point.X < bounds.Right && point.Y >= bounds.Top && point.Y < bounds.Bottom;

    private static InvalidOperationException DisabledError(nint modal) => modal != 0
        ? new InvalidOperationException(
            $"Janela desabilitada: o diálogo modal '{Title(modal)}' (windowId {modal.ToInt64()}) está aberto.")
        : new InvalidOperationException(
            "Janela desabilitada e nenhum diálogo modal identificável; liste as janelas com windows_list_windows.");

    private static string Title(nint hwnd)
    {
        var buffer = new StringBuilder(512);
        NativeMethods.GetWindowText(hwnd, buffer, buffer.Capacity);
        var title = buffer.ToString().Trim();
        return title.Length > 0 ? title : "sem título";
    }
}
