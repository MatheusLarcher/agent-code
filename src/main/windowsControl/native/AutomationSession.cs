using System.Text;
using System.Windows.Automation;

namespace AgentCode.WindowsControl;

internal sealed record AccessibilitySnapshot(string Tree, string? FocusedElement, string? DocumentText, int ElementCount);

internal sealed class AutomationSession
{
    private sealed record CachedSnapshot(nint Window, List<AutomationElement> Elements);
    private readonly Dictionary<long, CachedSnapshot> snapshots = new();

    internal void Invalidate()
    {
        snapshots.Clear();
    }

    internal AccessibilitySnapshot Observe(nint hwnd, int maxDepth, int maxElements)
    {
        WindowCatalog.EnsureWindow(hwnd);
        var root = AutomationElement.FromHandle(hwnd)
            ?? throw new InvalidOperationException("A janela não expôs uma árvore de acessibilidade.");
        var elements = new List<AutomationElement>();
        var lines = new StringBuilder();
        Visit(root, 0, maxDepth, maxElements, elements, lines);
        var key = hwnd.ToInt64();
        if (!snapshots.ContainsKey(key) && snapshots.Count >= 64)
            snapshots.Remove(snapshots.Keys.First());
        snapshots[key] = new CachedSnapshot(hwnd, elements);

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

    internal object ClickElement(nint hwnd, int index)
    {
        var element = Element(hwnd, index);
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var invokeRaw))
        {
            ((InvokePattern)invokeRaw).Invoke();
            return new { ok = true, method = "invoke" };
        }

        System.Windows.Point point;
        if (!element.TryGetClickablePoint(out point))
        {
            var rect = element.Current.BoundingRectangle;
            if (rect.IsEmpty) throw new InvalidOperationException("O elemento não possui um ponto clicável.");
            point = new System.Windows.Point(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2);
        }
        WindowCatalog.Activate(hwnd);
        InputController.Click(new System.Drawing.Point((int)Math.Round(point.X), (int)Math.Round(point.Y)), "left", 1);
        return new { ok = true, method = "input" };
    }

    internal object SetValue(nint hwnd, int index, string value)
    {
        var element = Element(hwnd, index);
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var valueRaw))
        {
            var pattern = (ValuePattern)valueRaw;
            if (pattern.Current.IsReadOnly) throw new InvalidOperationException("O elemento é somente leitura.");
            pattern.SetValue(value);
            return new { ok = true, method = "value-pattern" };
        }

        WindowCatalog.Activate(hwnd);
        element.SetFocus();
        InputController.PressKey("Control+a");
        InputController.TypeText(value);
        return new { ok = true, method = "keyboard" };
    }

    internal object SecondaryAction(nint hwnd, int index, string action)
    {
        var element = Element(hwnd, index);
        switch (action.Trim().ToLowerInvariant())
        {
            case "invoke":
                Pattern<InvokePattern>(element, InvokePattern.Pattern).Invoke();
                break;
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
        List<AutomationElement> elements,
        StringBuilder lines)
    {
        if (elements.Count >= maxElements || depth > maxDepth) return;
        var index = elements.Count;
        elements.Add(element);
        lines.Append(' ', depth * 2).Append('[').Append(index).Append("] ").AppendLine(Describe(element, index));
        if (depth == maxDepth) return;

        AutomationElement? child = null;
        try { child = TreeWalker.ControlViewWalker.GetFirstChild(element); } catch { }
        while (child is not null && elements.Count < maxElements)
        {
            Visit(child, depth + 1, maxDepth, maxElements, elements, lines);
            try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
            catch { child = null; }
        }
    }

    private static string Describe(AutomationElement element, int? index)
    {
        try
        {
            var current = element.Current;
            var type = current.ControlType?.ProgrammaticName.Replace("ControlType.", "") ?? "Element";
            var name = Clean(current.Name, 240);
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

    private AutomationElement Element(nint hwnd, int index)
    {
        WindowCatalog.EnsureWindow(hwnd);
        if (!snapshots.TryGetValue(hwnd.ToInt64(), out var snapshot))
            throw new InvalidOperationException("Capture o estado de acessibilidade da janela antes de usar elementIndex.");
        if (index < 0 || index >= snapshot.Elements.Count)
            throw new ArgumentOutOfRangeException(nameof(index), "elementIndex não pertence ao último estado capturado.");
        return snapshot.Elements[index];
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
