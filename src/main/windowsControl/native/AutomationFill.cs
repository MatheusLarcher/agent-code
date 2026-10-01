using System.Windows.Automation;

namespace AgentCode.WindowsControl;

// windows_fill: writes text into a field without relying on per-key typing when possible
// (ValuePattern, then clipboard paste, then SendInput keys) and re-reads the field after each
// method. It never reports a verified success it did not observe.
internal sealed partial class AutomationSession
{
    private const int ReportedValueLimit = 300;
    private static readonly TimeSpan InputSettle = TimeSpan.FromMilliseconds(150);

    internal object Fill(nint hwnd, string text, int? index, bool append)
    {
        var (element, focusTarget, window) = FillTarget(hwnd, index);
        return FillCore(element, window, focusTarget, text, append);
    }

    // window: top-level hwnd holding the element. focusTarget: already verified foreground
    // window when the field was taken from the keyboard focus (null = focus it here).
    private static Dictionary<string, object> FillCore(
        AutomationElement element, nint window, nint? focusTarget, string text, bool append)
    {
        var original = ReadValue(element);
        string? expected = append ? (original is null ? null : original + text) : text;
        var targetWindowId = focusTarget ?? window;
        string? found = null;
        var inputRan = false;

        // 1) ValuePattern: no focus, no keys, no clipboard.
        if (expected is not null && TryValuePattern(element, expected))
        {
            found = ReadValue(element);
            if (Matches(found, expected)) return FillResult("value", true, targetWindowId);
        }

        // Keyboard-based methods need the field focused in the verified foreground window.
        var target = focusTarget ?? FocusForInput(window, element);
        targetWindowId = target;

        // After a failed attempt the field may hold anything, so later methods rewrite the whole
        // expected value instead of appending again.
        var modified = found is not null;
        (string, bool) Plan() => append && (!modified || expected is null) ? (text, false) : (expected ?? text, true);
        var (chunk, replace) = Plan();

        // 2) Clipboard paste. ClipboardUnavailableException here means nothing was sent (save/set
        // failed); a restore failure comes back as clipboardRestored=false instead.
        bool? clipboardRestored = null;
        if (chunk.Length > 0)
        {
            try
            {
                clipboardRestored = ClipboardSwap.WithText(chunk, () =>
                {
                    InputTarget.EnsureReady(target);
                    inputRan = true;
                    InputController.PressKey(replace ? "Control+a" : "Control+End");
                    InputController.PressKey("Control+v");
                });
                Thread.Sleep(InputSettle);
                found = ReadValue(element);
                if (found is null) return FillResult("paste", false, target, clipboardRestored);
                if (expected is not null && Matches(found, expected))
                    return FillResult("paste", true, target, clipboardRestored);
            }
            catch (ClipboardUnavailableException) when (!inputRan) { }
        }

        // 3) SendInput keys, last resort. After a paste the field may already hold the text, so
        // only the whole expected value is rewritten (Ctrl+A); without it, repeating is blind.
        modified |= inputRan;
        if (inputRan && expected is null) return FillResult("paste", false, target, clipboardRestored);
        (chunk, replace) = Plan();
        InputTarget.EnsureReady(target);
        InputController.PressKey(replace ? "Control+a" : "Control+End");
        if (replace && chunk.Length == 0) InputController.PressKey("Delete");
        InputController.TypeText(chunk);
        Thread.Sleep(InputSettle);
        found = ReadValue(element);
        if (found is null || expected is null) return FillResult("keys", false, target, clipboardRestored);
        if (Matches(found, expected)) return FillResult("keys", true, target, clipboardRestored);

        throw new InvalidOperationException(
            $"O campo não ficou com o texto esperado após value, colagem e teclas. Valor encontrado: \"{Truncate(found)}\""
            + (clipboardRestored == false ? $" {ClipboardLostWarning}" : ""));
    }

    private (AutomationElement Element, nint? FocusTarget, nint Window) FillTarget(nint hwnd, int? index)
    {
        if (index is { } elementIndex)
        {
            var cached = CachedEntry(hwnd, elementIndex);
            return (cached.Element, null, cached.Window);
        }

        var target = InputTarget.ActivateForKeyboard(hwnd);
        var root = AutomationElement.FromHandle(target)
            ?? throw new InvalidOperationException("A janela não expôs uma árvore de acessibilidade.");
        AutomationElement? focused;
        try { focused = AutomationElement.FocusedElement; }
        catch { focused = null; }
        if (focused is null || !BelongsToRoot(focused, root))
            throw new InvalidOperationException(
                "Nenhum campo com foco na janela alvo; informe elementIndex ou foque o campo antes.");
        return (focused, target, target);
    }

    // Keystrokes land on the focused control, so a modal only takes them when the element itself
    // lies inside the modal (same rule as SetValue).
    private static nint FocusForInput(nint hwnd, AutomationElement element)
    {
        var target = InputTarget.ActivateForPointer(
            hwnd, () => [CenterOf(element)], (modal) => InsideWindow(element, modal));
        element.SetFocus();
        InputTarget.EnsureReady(target);
        return target;
    }

    private static bool TryValuePattern(AutomationElement element, string value)
    {
        try
        {
            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var raw)) return false;
            var pattern = (ValuePattern)raw;
            if (pattern.Current.IsReadOnly) return false;
            pattern.SetValue(value);
            return true;
        }
        catch { return false; }
    }

    // null = the field exposes no way to read its value.
    private static string? ReadValue(AutomationElement element)
    {
        try
        {
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var valueRaw))
                return ((ValuePattern)valueRaw).Current.Value ?? "";
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out var textRaw))
                return ((TextPattern)textRaw).DocumentRange.GetText(-1) ?? "";
        }
        catch { }
        return null;
    }

    internal static string NormalizeFillValue(string value)
        => value.Replace("\r\n", "\n").Replace('\r', '\n').TrimEnd('\n');

    private static bool Matches(string? found, string expected)
        => found is not null && NormalizeFillValue(found) == NormalizeFillValue(expected);

    private static string Truncate(string value)
    {
        var clean = NormalizeFillValue(value).Replace("\n", "\\n");
        return clean.Length > ReportedValueLimit ? clean[..ReportedValueLimit] + "…" : clean;
    }

    private const string UnverifiedWarning =
        "O campo não expõe leitura de valor; o texto foi enviado mas NÃO foi conferido. Observe a janela para confirmar.";
    private const string ClipboardLostWarning =
        "Não foi possível restaurar a área de transferência do usuário; ela ficou com o texto colado.";

    private static Dictionary<string, object> FillResult(
        string method, bool verified, nint target, bool? clipboardRestored = null)
    {
        var result = new Dictionary<string, object>
        {
            ["ok"] = true,
            ["method"] = method,
            ["verified"] = verified,
            ["targetWindowId"] = target.ToInt64().ToString(),
        };
        var warnings = new List<string>();
        if (!verified) warnings.Add(UnverifiedWarning);
        if (clipboardRestored == false)
        {
            result["clipboardRestored"] = false;
            warnings.Add(ClipboardLostWarning);
        }
        if (warnings.Count > 0) result["warning"] = string.Join(" ", warnings);
        return result;
    }
}
