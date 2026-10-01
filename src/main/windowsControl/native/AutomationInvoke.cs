using System.Runtime.ExceptionServices;
using System.Windows.Automation;

namespace AgentCode.WindowsControl;

// An invoke only returns after the control's click handler does, so a button that opens a modal
// (Save As, Options…) would block the caller until the dialog closes. Worse, a UIA provider that
// invokes synchronously (WinForms) serves no other UIA request meanwhile. So:
// - HWND buttons (Win32, WinForms) get BM_CLICK through SendMessageTimeout, outside UIA;
// - other elements get InvokePattern.Invoke on an abandoned background thread.
// Neither is ever waited on again past InvokeWait.
internal sealed partial class AutomationSession
{
    private static readonly TimeSpan InvokeWait = TimeSpan.FromMilliseconds(1200);

    // "invoke" / "button-message": returned in time (an Invoke exception is rethrown).
    // "invoke-async": still running, accepted only because a new popup/menu of the window family
    // is now open, i.e. the app sits in that modal loop. Anything else fails.
    private static string InvokeGuarded(AutomationElement element, InvokePattern pattern, nint window)
    {
        if (!NativeMethods.IsWindowEnabled(window))
            throw new InvalidOperationException(
                "A janela do elemento está bloqueada por um diálogo modal; aja no diálogo primeiro.");
        var before = FamilyWindows(window);
        var button = NativeButton(element);
        bool returned;
        if (button != 0)
        {
            if (!NativeMethods.IsWindowEnabled(button)) throw new InvalidOperationException("O botão está desabilitado.");
            returned = NativeMethods.SendMessageTimeout(button, NativeMethods.BM_CLICK, 0, 0,
                NativeMethods.SMTO_ABORTIFHUNG, (uint)InvokeWait.TotalMilliseconds, out _) != 0;
        }
        else returned = InvokeOnThread(pattern);

        if (returned) return button != 0 ? "button-message" : "invoke";
        if (NativeMethods.IsWindow(window) && FamilyWindows(window).Any((hwnd) => !before.Contains(hwnd)))
            return "invoke-async";
        throw new InvalidOperationException(
            $"O botão não respondeu em {InvokeWait.TotalSeconds:0.#} s e nenhum diálogo da janela apareceu; " +
            "o aplicativo pode estar ocupado. Observe a janela antes de repetir.");
    }

    // false = still running after InvokeWait; the thread is left to finish on its own.
    private static bool InvokeOnThread(InvokePattern pattern)
    {
        var finished = new ManualResetEventSlim(false);
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try { pattern.Invoke(); }
            catch (Exception exception) { error = exception; }
            finally { finished.Set(); }
        })
        {
            IsBackground = true,
            Name = "uia-invoke",
        };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        if (!finished.Wait(InvokeWait)) return false;
        finished.Dispose();
        if (error is not null) ExceptionDispatchInfo.Capture(error).Throw();
        return true;
    }

    // The element's own HWND when it is a push button window (class "Button" or WinForms'
    // "WindowsForms10.BUTTON…"); 0 otherwise.
    private static nint NativeButton(AutomationElement element)
    {
        try
        {
            if (element.Current.ControlType != ControlType.Button) return 0;
            var hwnd = new nint(element.Current.NativeWindowHandle);
            if (hwnd == 0 || !NativeMethods.IsWindow(hwnd)) return 0;
            return ClassName(hwnd).Contains("BUTTON", StringComparison.OrdinalIgnoreCase) ? hwnd : 0;
        }
        catch (ElementNotAvailableException) { return 0; }
    }

    private static HashSet<nint> FamilyWindows(nint window)
    {
        if (!NativeMethods.IsWindow(window)) return [];
        var (owned, menus) = OwnedWindows(window);
        return owned.Select((entry) => entry.Window).Concat(menus).ToHashSet();
    }
}
