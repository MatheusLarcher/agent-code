using System.Text;
using System.Windows.Automation;

namespace AgentCode.WindowsControl;

internal sealed record AccessibilitySnapshot(string Tree, string? FocusedElement, string? DocumentText, int ElementCount);

internal sealed partial class AutomationSession
{
    // Identity captured at Observe time; an index is only reused while the element still matches.
    private sealed record ElementFingerprint(string Name, int ControlTypeId, int[]? RuntimeId);
    // Root/Window: the tree root and top-level hwnd the element was found in (the window itself
    // or one of its popups), so validation and activation use the element's own window.
    private sealed record CachedElement(
        AutomationElement Element, ElementFingerprint? Fingerprint, AutomationElement Root, nint Window);
    private sealed record CachedSnapshot(nint Window, AutomationElement Root, List<CachedElement> Elements);
    private readonly Dictionary<long, CachedSnapshot> snapshots = new();

    internal AccessibilitySnapshot Observe(nint hwnd, int maxDepth, int maxElements)
    {
        WindowCatalog.EnsureWindow(hwnd);
        var root = AutomationElement.FromHandle(hwnd)
            ?? throw new InvalidOperationException("A janela não expôs uma árvore de acessibilidade.");
        var elements = new List<CachedElement>();
        var lines = new StringBuilder();
        Visit(root, 0, maxDepth, maxElements, elements, lines, root, hwnd);
        StoreSnapshot(new CachedSnapshot(hwnd, root, elements));

        string? focused = null;
        try
        {
            var focusedElement = AutomationElement.FocusedElement;
            if (focusedElement is not null && BelongsToRoot(focusedElement, root))
                focused = Describe(focusedElement, null);
        }
        catch { }

        return new AccessibilitySnapshot(lines.ToString().TrimEnd(), focused, ReadDocument(root), elements.Count);
    }

    private void StoreSnapshot(CachedSnapshot snapshot)
    {
        var key = snapshot.Window.ToInt64();
        if (!snapshots.ContainsKey(key) && snapshots.Count >= 64)
            snapshots.Remove(snapshots.Keys.First());
        snapshots[key] = snapshot;
    }

    internal object ClickElement(nint hwnd, int index)
    {
        var cached = CachedEntry(hwnd, index);
        return ClickCore(cached.Element, cached.Window);
    }

    // window: top-level hwnd that holds the element (pointer input is verified against it).
    private static object ClickCore(AutomationElement element, nint window)
    {
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var invokeRaw))
            return new { ok = true, method = InvokeGuarded(element, (InvokePattern)invokeRaw, window) };

        System.Windows.Point point;
        if (!element.TryGetClickablePoint(out point))
        {
            var rect = element.Current.BoundingRectangle;
            if (rect.IsEmpty) throw new InvalidOperationException("O elemento não possui um ponto clicável.");
            point = new System.Windows.Point(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2);
        }
        var screen = new System.Drawing.Point((int)Math.Round(point.X), (int)Math.Round(point.Y));
        var target = InputTarget.ActivateForPointer(window, () => [screen], (modal) => InsideWindow(element, modal));
        InputController.Click(screen, "left", 1);
        return new { ok = true, method = "input", targetWindowId = target.ToInt64().ToString() };
    }

    internal object SetValue(nint hwnd, int index, string value)
    {
        var cached = CachedEntry(hwnd, index);
        var element = cached.Element;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var valueRaw))
        {
            var pattern = (ValuePattern)valueRaw;
            if (pattern.Current.IsReadOnly) throw new InvalidOperationException("O elemento é somente leitura.");
            pattern.SetValue(value);
            return new { ok = true, method = "value-pattern" };
        }

        // Keystrokes land on the focused control, so a modal only takes them when the element
        // itself lies inside the modal; otherwise the text would go to the wrong control.
        var target = InputTarget.ActivateForPointer(
            cached.Window, () => [CenterOf(element)], (modal) => InsideWindow(element, modal));
        element.SetFocus();
        InputTarget.EnsureReady(target);
        InputController.PressKey("Control+a");
        InputController.TypeText(value);
        return new { ok = true, method = "keyboard", targetWindowId = target.ToInt64().ToString() };
    }

    private static bool InsideWindow(AutomationElement element, nint window)
    {
        AutomationElement? root;
        try { root = AutomationElement.FromHandle(window); }
        catch { return false; }
        return root is not null && BelongsToRoot(element, root);
    }

    private static System.Drawing.Point CenterOf(AutomationElement element)
    {
        var rect = element.Current.BoundingRectangle;
        if (rect.IsEmpty) throw new InvalidOperationException("O elemento não possui posição na tela.");
        return new System.Drawing.Point(
            (int)Math.Round(rect.Left + rect.Width / 2),
            (int)Math.Round(rect.Top + rect.Height / 2));
    }

    internal object SecondaryAction(nint hwnd, int index, string action)
    {
        var cached = CachedEntry(hwnd, index);
        var element = cached.Element;
        switch (action.Trim().ToLowerInvariant())
        {
            case "invoke":
                var method = InvokeGuarded(element, Pattern<InvokePattern>(element, InvokePattern.Pattern), cached.Window);
                return new { ok = true, method };
            case "expand":
                Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern).Expand();
                break;
            case "collapse":
                Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern).Collapse();
                break;
            case "select":
                Pattern<SelectionItemPattern>(element, SelectionItemPattern.Pattern).Select();
                break;
            case "toggle":
                Pattern<TogglePattern>(element, TogglePattern.Pattern).Toggle();
                break;
            case "scroll into view":
            case "scroll_into_view":
                Pattern<ScrollItemPattern>(element, ScrollItemPattern.Pattern).ScrollIntoView();
                break;
            case "focus":
                element.SetFocus();
                break;
            default:
                throw new ArgumentException("Ação secundária inválida. Use invoke, expand, collapse, select, toggle, scroll_into_view ou focus.");
        }
        return new { ok = true };
    }

    private void Visit(
        AutomationElement element,
        int depth,
        int maxDepth,
        int maxElements,
        List<CachedElement> elements,
        StringBuilder lines,
        AutomationElement root,
        nint window)
    {
        if (elements.Count >= maxElements || depth > maxDepth) return;
        var index = elements.Count;
        var description = Describe(element, index, out var fingerprint);
        elements.Add(new CachedElement(element, fingerprint, root, window));
        lines.Append(' ', depth * 2).Append('[').Append(index).Append("] ").AppendLine(description);
        if (depth == maxDepth) return;

        AutomationElement? child = null;
        try { child = TreeWalker.ControlViewWalker.GetFirstChild(element); } catch { }
        while (child is not null && elements.Count < maxElements)
        {
            Visit(child, depth + 1, maxDepth, maxElements, elements, lines, root, window);
            try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
            catch { child = null; }
        }
    }

    private static string Describe(AutomationElement element, int? index) => Describe(element, index, out _);

    private static string Describe(AutomationElement element, int? index, out ElementFingerprint? fingerprint)
    {
        fingerprint = null;
        try
        {
            var current = element.Current;
            var controlType = current.ControlType;
            var rawName = current.Name ?? "";
            fingerprint = new ElementFingerprint(rawName, controlType?.Id ?? 0, RuntimeIdOf(element));
            var type = controlType?.ProgrammaticName.Replace("ControlType.", "") ?? "Element";
            var name = Clean(rawName, 240);
            var automationId = Clean(current.AutomationId, 120);
            var rect = current.BoundingRectangle;
            var fields = new List<string> { type };
            if (name.Length > 0) fields.Add($"name=\"{name}\"");
            if (automationId.Length > 0) fields.Add($"id=\"{automationId}\"");
            if (!rect.IsEmpty) fields.Add($"bounds=({Math.Round(rect.Left)},{Math.Round(rect.Top)},{Math.Round(rect.Width)},{Math.Round(rect.Height)})");
            if (current.HasKeyboardFocus) fields.Add("focused=true");
            if (!current.IsEnabled) fields.Add("enabled=false");
            if (current.IsOffscreen) fields.Add("offscreen=true");
            return string.Join(' ', fields);
        }
        catch
        {
            return index is null ? "Element indisponível" : "Element unavailable=true";
        }
    }

    private static string? ReadDocument(AutomationElement root)
    {
        try
        {
            var focused = AutomationElement.FocusedElement;
            if (focused is not null && !BelongsToRoot(focused, root)) focused = null;
            foreach (var candidate in new[] { focused, root })
            {
                if (candidate is null) continue;
                if (candidate.TryGetCurrentPattern(TextPattern.Pattern, out var textRaw))
                    return Clean(((TextPattern)textRaw).DocumentRange.GetText(8_000), 8_000);
                if (candidate.TryGetCurrentPattern(ValuePattern.Pattern, out var valueRaw))
                    return Clean(((ValuePattern)valueRaw).Current.Value, 8_000);
            }
        }
        catch { }
        return null;
    }

    private CachedElement CachedEntry(nint hwnd, int index)
    {
        WindowCatalog.EnsureWindow(hwnd);
        var key = hwnd.ToInt64();
        if (!snapshots.TryGetValue(key, out var snapshot))
            throw new InvalidOperationException("Capture o estado de acessibilidade da janela antes de usar elementIndex.");
        if (index < 0 || index >= snapshot.Elements.Count)
            throw new ArgumentOutOfRangeException(nameof(index), "elementIndex não pertence ao último estado capturado.");
        var cached = snapshot.Elements[index];
        if (!StillMatches(cached))
        {
            snapshots.Remove(key);
            throw new InvalidOperationException(
                $"O elemento [{index}] mudou ou não existe mais; capture o estado novamente com windows_get_state.");
        }
        return cached;
    }

    private static bool StillMatches(CachedElement cached)
    {
        if (!NativeMethods.IsWindow(cached.Window)) return false;
        if (cached.Fingerprint is not { } expected) return false;
        try
        {
            var current = cached.Element.Current;
            if ((current.Name ?? "") != expected.Name) return false;
            if ((current.ControlType?.Id ?? 0) != expected.ControlTypeId) return false;
        }
        catch (ElementNotAvailableException) { return false; }
        var runtimeId = RuntimeIdOf(cached.Element);
        if (runtimeId is not null && expected.RuntimeId is not null && !runtimeId.SequenceEqual(expected.RuntimeId))
            return false;
        return BelongsToRoot(cached.Element, cached.Root);
    }

    private static int[]? RuntimeIdOf(AutomationElement element)
    {
        try { return element.GetRuntimeId(); }
        catch { return null; }
    }

    private static T Pattern<T>(AutomationElement element, AutomationPattern pattern) where T : BasePattern
    {
        if (!element.TryGetCurrentPattern(pattern, out var value))
            throw new InvalidOperationException($"O elemento não oferece o padrão {typeof(T).Name}.");
        return (T)value;
    }

    private static string Clean(string? value, int limit)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var clean = value.Replace('\r', ' ').Replace('\n', ' ').Replace("\"", "'").Trim();
        return clean.Length > limit ? clean[..limit] + "…" : clean;
    }

    private static bool BelongsToRoot(AutomationElement element, AutomationElement root)
    {
        AutomationElement? current = element;
        for (var depth = 0; current is not null && depth < 100; depth++)
        {
            if (current.Equals(root)) return true;
            try { current = TreeWalker.RawViewWalker.GetParent(current); }
            catch { return false; }
        }
        return false;
    }
}
