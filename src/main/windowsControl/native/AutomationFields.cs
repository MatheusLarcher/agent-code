using System.Globalization;
using System.Reflection;
using System.Text;
using System.Windows.Automation;

namespace AgentCode.WindowsControl;

// windows_form_fields: one compact line per useful control of a window and of the dialogs, popups
// and menus it owns, read in one UIA query per root. Indices go into the same cache as get_state,
// so every index action accepts them. Also hosts the name lookup used by run_steps.
internal sealed partial class AutomationSession
{
    private const int FieldValueLimit = 80;
    private const int DocumentPreviewLimit = 120;
    private const int OptionLimit = 15;
    private const string MenuClass = "#32768";
    private const string TooltipClass = "tooltips_class32";

    private sealed record FieldRoot(nint Window, AutomationElement Element, string Kind, string Title);

    private sealed record FieldItem(
        AutomationElement Element,
        FieldRoot Root,
        ControlType Type,
        string Name,
        string Label,
        string AutomationId,
        bool Enabled,
        bool Offscreen,
        bool EmptyBounds,
        bool Password,
        string? Value,
        ToggleState? Toggle,
        bool? Selected,
        ExpandCollapseState? Expand,
        int[]? RuntimeId)
    {
        internal bool Usable => Enabled && !Offscreen && !EmptyBounds;
        internal string DisplayName => Name.Length > 0 ? Name : Label;
    }

    private static readonly ControlType[] FieldTypes =
    [
        ControlType.Edit, ControlType.Document, ControlType.ComboBox, ControlType.List,
        ControlType.ListItem, ControlType.CheckBox, ControlType.RadioButton, ControlType.Button,
        ControlType.SplitButton, ControlType.MenuItem, ControlType.TabItem, ControlType.TreeItem,
        ControlType.Hyperlink, ControlType.Slider,
    ];

    private static readonly AutomationProperty[] FieldProperties =
    [
        AutomationElement.NameProperty, AutomationElement.ControlTypeProperty,
        AutomationElement.AutomationIdProperty, AutomationElement.IsEnabledProperty,
        AutomationElement.IsOffscreenProperty, AutomationElement.BoundingRectangleProperty,
        AutomationElement.LabeledByProperty, AutomationElement.IsPasswordProperty,
        AutomationElement.RuntimeIdProperty, ValuePattern.ValueProperty,
        TogglePattern.ToggleStateProperty, SelectionItemPattern.IsSelectedProperty,
        ExpandCollapsePattern.ExpandCollapseStateProperty,
    ];

    private static readonly HashSet<string> ControlTypeNames = typeof(ControlType)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where((field) => field.FieldType == typeof(ControlType))
        .Select((field) => field.Name)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    internal static bool IsKnownControlType(string name) => ControlTypeNames.Contains(name);

    internal object FormFields(nint hwnd, int maxElements)
    {
        var (text, count, active) = BuildFields(hwnd, maxElements);
        return new { text, count, targetWindowId = active.ToInt64().ToString() };
    }

    // Reads the window and rewrites the index cache; the returned text is also run_steps' state.
    private (string Text, int Count, nint Active) BuildFields(nint hwnd, int maxElements)
    {
        var roots = FieldRoots(hwnd);
        var scanned = ScanFields(roots, visibleOnly: true, includeText: false);
        var lines = new StringBuilder();
        var cached = new List<CachedElement>();
        var truncated = false;
        for (var r = 0; r < roots.Count; r++)
        {
            var root = roots[r];
            lines.Append("# ").Append(root.Kind).Append(" \"").Append(Clean(TitleOrDefault(root.Title), 160))
                .Append("\" (windowId ").Append(root.Window.ToInt64()).Append(")\n");
            foreach (var item in scanned[r])
            {
                if (item.EmptyBounds || IsPartButton(item)) continue;
                if (cached.Count >= maxElements)
                {
                    truncated = true;
                    break;
                }
                lines.Append(FieldLine(cached.Count, item)).Append('\n');
                var fingerprint = new ElementFingerprint(item.Name, item.Type.Id, item.RuntimeId);
                cached.Add(new CachedElement(item.Element, fingerprint, root.Element, root.Window));
            }
        }
        if (truncated)
            lines.Append($"… limite de {maxElements} elementos atingido; aumente maxElements para ver o resto.\n");
        var active = ActiveRoot(hwnd, roots);
        lines.Append("ativo: \"").Append(Clean(TitleOrDefault(WindowText(active)), 160))
            .Append("\" (windowId ").Append(active.ToInt64()).Append(')');
        StoreSnapshot(new CachedSnapshot(hwnd, roots[0].Element, cached));
        return (lines.ToString(), cached.Count, active);
    }

    // The root in the foreground, else the modal that takes input, else the window itself.
    private static nint ActiveRoot(nint hwnd, IReadOnlyList<FieldRoot> roots)
    {
        var foreground = NativeMethods.GetForegroundWindow();
        if (roots.Any((root) => root.Window == foreground)) return foreground;
        try { return InputTarget.Resolve(hwnd); }
        catch { return hwnd; }
    }

    // The window plus visible top-level windows of its process whose owner chain leads to it
    // (same depth bound as the modal walk). Menus are included only while this window family
    // holds the foreground, so another window of the same process never shows them.
    private static List<FieldRoot> FieldRoots(nint hwnd)
    {
        WindowCatalog.EnsureWindow(hwnd);
        var main = AutomationElement.FromHandle(hwnd)
            ?? throw new InvalidOperationException("A janela não expôs uma árvore de acessibilidade.");
        var roots = new List<FieldRoot> { new(hwnd, main, "janela", WindowText(hwnd)) };
        var (owned, menus) = OwnedWindows(hwnd);
        foreach (var (window, _) in owned.OrderBy((entry) => entry.Depth)) AddRoot(roots, window, null);
        var foreground = NativeMethods.GetForegroundWindow();
        if (foreground == hwnd || owned.Any((entry) => entry.Window == foreground))
            foreach (var menu in menus) AddRoot(roots, menu, "menu");
        return roots;
    }

    // Visible top-level windows of hwnd's process owned by it (with owner depth), plus the
    // process's popup menus. Win32 only, no UIA, so it is cheap to call around an action.
    private static (List<(nint Window, int Depth)> Owned, List<nint> Menus) OwnedWindows(nint hwnd)
    {
        var process = InputTarget.ProcessId(hwnd);
        var owned = new List<(nint Window, int Depth)>();
        var menus = new List<nint>();
        NativeMethods.EnumWindows((candidate, _) =>
        {
            if (candidate == hwnd || !NativeMethods.IsWindowVisible(candidate)) return true;
            if (InputTarget.ProcessId(candidate) != process) return true;
            var className = ClassName(candidate);
            if (className == MenuClass) menus.Add(candidate);
            else if (className != TooltipClass)
            {
                var depth = OwnerDepth(candidate, hwnd);
                if (depth > 0) owned.Add((candidate, depth));
            }
            return true;
        }, 0);
        return (owned, menus);
    }

    private static int OwnerDepth(nint candidate, nint owner)
    {
        var current = candidate;
        for (var depth = 1; depth <= InputTarget.MaxModalDepth; depth++)
        {
            current = NativeMethods.GetWindow(current, NativeMethods.GW_OWNER);
            if (current == 0) return 0;
            if (current == owner) return depth;
        }
        return 0;
    }

    private static void AddRoot(List<FieldRoot> roots, nint window, string? kind)
    {
        if (!NativeMethods.GetWindowRect(window, out var rect) || rect.Width <= 0 || rect.Height <= 0) return;
        AutomationElement? element;
        try { element = AutomationElement.FromHandle(window); }
        catch { return; }
        if (element is null) return;
        var title = WindowText(window);
        roots.Add(new FieldRoot(window, element, kind ?? (title.Length > 0 ? "diálogo" : "popup"), title));
    }

    // One FindAll per root with every needed property cached. An owned window can also appear
    // under its owner in the UIA tree, so roots are read deepest first and each element (by
    // RuntimeId) belongs to the first root that finds it. Result is parallel to roots.
    private static List<FieldItem>[] ScanFields(IReadOnlyList<FieldRoot> roots, bool visibleOnly, bool includeText)
    {
        var condition = FieldCondition(visibleOnly, includeText);
        var request = new CacheRequest { AutomationElementMode = AutomationElementMode.Full, TreeScope = TreeScope.Element };
        foreach (var property in FieldProperties) request.Add(property);
        var result = new List<FieldItem>[roots.Count];
        var claimed = new HashSet<string>();
        for (var r = roots.Count - 1; r >= 0; r--)
        {
            var items = new List<FieldItem>();
            result[r] = items;
            AutomationElementCollection found;
            try
            {
                using (request.Activate()) found = roots[r].Element.FindAll(TreeScope.Descendants, condition);
            }
            catch { continue; }
            foreach (AutomationElement element in found)
            {
                var item = ReadField(element, roots[r]);
                if (item is null) continue;
                if (item.RuntimeId is { } id && !claimed.Add(string.Join('.', id))) continue;
                items.Add(item);
            }
        }
        return result;
    }

    // Scroll bar arrows/pages and a combo box's own drop-down arrow: parts of another control,
    // left out of the listing only (an explicit automationId target still finds them).
    private static readonly HashSet<string> PartButtonIds =
        ["SmallDecrement", "SmallIncrement", "LargeDecrement", "LargeIncrement", "DropDown"];

    private static bool IsPartButton(FieldItem item)
        => item.Type == ControlType.Button && PartButtonIds.Contains(item.AutomationId);

    private static Condition FieldCondition(bool visibleOnly, bool includeText)
    {
        var types = includeText ? FieldTypes.Append(ControlType.Text) : FieldTypes;
        Condition condition = new OrCondition(types
            .Select((type) => (Condition)new PropertyCondition(AutomationElement.ControlTypeProperty, type))
            .ToArray());
        return visibleOnly
            ? new AndCondition(condition, new PropertyCondition(AutomationElement.IsOffscreenProperty, false))
            : condition;
    }

    private static FieldItem? ReadField(AutomationElement element, FieldRoot root)
    {
        if (Cached(element, AutomationElement.ControlTypeProperty) is not ControlType type) return null;
        var rect = Cached(element, AutomationElement.BoundingRectangleProperty) is System.Windows.Rect bounds
            ? bounds
            : System.Windows.Rect.Empty;
        var password = Cached(element, AutomationElement.IsPasswordProperty) is true;
        var label = "";
        if (Cached(element, AutomationElement.LabeledByProperty) is AutomationElement labeledBy)
        {
            try { label = labeledBy.Current.Name ?? ""; }
            catch { }
        }
        return new FieldItem(
            element,
            root,
            type,
            Cached(element, AutomationElement.NameProperty) as string ?? "",
            label,
            Cached(element, AutomationElement.AutomationIdProperty) as string ?? "",
            Cached(element, AutomationElement.IsEnabledProperty) is not false,
            Cached(element, AutomationElement.IsOffscreenProperty) is true,
            rect.IsEmpty || rect.Width < 1 || rect.Height < 1,
            password,
            password ? null : Cached(element, ValuePattern.ValueProperty) as string,
            Cached(element, TogglePattern.ToggleStateProperty) is ToggleState toggle ? toggle : null,
            Cached(element, SelectionItemPattern.IsSelectedProperty) is bool selected ? selected : null,
            Cached(element, ExpandCollapsePattern.ExpandCollapseStateProperty) is ExpandCollapseState expand ? expand : null,
            Cached(element, AutomationElement.RuntimeIdProperty) as int[]);
    }

    // null = unsupported or unreadable (e.g. a provider error on one property).
    private static object? Cached(AutomationElement element, AutomationProperty property)
    {
        try
        {
            var value = element.GetCachedPropertyValue(property, true);
            return value == AutomationElement.NotSupported ? null : value;
        }
        catch { return null; }
    }

    // `index Type[*] "Name" (AutomationId) = value [expandido] [opções: …]`; * = disabled.
    private static string FieldLine(int index, FieldItem item)
    {
        var line = new StringBuilder();
        line.Append(index).Append(' ').Append(TypeName(item.Type));
        if (!item.Enabled) line.Append('*');
        line.Append(" \"").Append(Clean(item.DisplayName, 120)).Append('"');
        if (item.AutomationId.Length > 0) line.Append(" (").Append(Clean(item.AutomationId, 80)).Append(')');
        if (FieldValue(item) is { } value) line.Append(" = ").Append(value);
        if (item.Expand == ExpandCollapseState.Expanded) line.Append(" [expandido]");
        if (item.Type == ControlType.ComboBox || item.Type == ControlType.List)
        {
            var options = Options(item.Element);
            if (options.Count > 0) line.Append(" [opções: ").Append(string.Join(", ", options)).Append(']');
        }
        return line.ToString();
    }

    private static string? FieldValue(FieldItem item)
    {
        if (item.Password) return "(senha)";
        if (item.Toggle is { } toggle) return ToggleName(toggle);
        if (item.Type == ControlType.Document)
        {
            var text = DocumentText(item.Element, DocumentPreviewLimit) ?? item.Value;
            return text is null ? null : Quote(text, DocumentPreviewLimit);
        }
        var value = item.Value;
        if (value is null && item.Type == ControlType.ComboBox) value = SelectedNames(item.Element);
        var input = item.Type == ControlType.Edit || item.Type == ControlType.ComboBox;
        // A value that only repeats the name (tree items, links) is noise.
        if (value is not null && (input || (value.Length > 0 && value != item.DisplayName)))
            return Quote(value, FieldValueLimit);
        return item.Selected == true ? "selected" : null;
    }

    // Win32 drop-down lists expose no ValuePattern; their selection carries the current value.
    private static string? SelectedNames(AutomationElement element)
    {
        try
        {
            if (!element.TryGetCurrentPattern(SelectionPattern.Pattern, out var raw)) return null;
            var selected = ((SelectionPattern)raw).Current.GetSelection();
            return selected.Length == 0 ? null : string.Join(", ", selected.Select((item) => item.Current.Name ?? ""));
        }
        catch { return null; }
    }

    private static string ToggleName(ToggleState state) => state switch
    {
        ToggleState.On => "on",
        ToggleState.Off => "off",
        _ => "indeterminate",
    };

    private static string? DocumentText(AutomationElement element, int limit)
    {
        try
        {
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out var raw))
                return ((TextPattern)raw).DocumentRange.GetText(limit + 1);
        }
        catch { }
        return null;
    }

    // Item names already present in the tree (a read never expands anything). A ComboBox keeps
    // its items under a List child, so one level of List is followed.
    private static List<string> Options(AutomationElement container)
    {
        var names = new List<string>();
        var more = false;
        void Walk(AutomationElement parent, bool nested)
        {
            AutomationElement? child = null;
            try { child = TreeWalker.ControlViewWalker.GetFirstChild(parent); }
            catch { }
            for (var visited = 0; child is not null && visited < 40 && !more; visited++)
            {
                try
                {
                    var type = child.Current.ControlType;
                    if (type == ControlType.ListItem)
                    {
                        if (names.Count >= OptionLimit) more = true;
                        else names.Add(Quote(child.Current.Name ?? "", 60));
                    }
                    else if (type == ControlType.List && !nested) Walk(child, true);
                }
                catch { }
                try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
                catch { child = null; }
            }
        }
        Walk(container, false);
        if (more) names.Add("…");
        return names;
    }

    // Candidates for a run_steps target on the current screen, after the legitimate tie-breaks.
    private static List<FieldItem> FindTargets(nint hwnd, StepTarget target)
    {
        var roots = FieldRoots(hwnd);
        IEnumerable<FieldItem> items = ScanFields(roots, visibleOnly: false, includeText: false).SelectMany((list) => list);
        if (target.Type is { } type) items = items.Where((item) => TypeMatches(item, type));
        if (target.AutomationId is { } automationId) items = items.Where((item) => item.AutomationId == automationId);
        var list = items.ToList();
        if (target.Name is { } rawName)
        {
            var query = NormalizeName(rawName);
            if (query.Length == 0) return [];
            var tiered = list.Select((item) => (Item: item, Tier: NameTier(item, query)))
                .Where((entry) => entry.Tier > 0)
                .ToList();
            if (tiered.Count == 0) return [];
            var best = tiered.Min((entry) => entry.Tier);
            list = tiered.Where((entry) => entry.Tier == best).Select((entry) => entry.Item).ToList();
        }
        return Disambiguate(list);
    }

    // Only tie-breaks that cannot pick the wrong control: a window blocked by a modal cannot take
    // the action, and an enabled on-screen control beats disabled or hidden twins.
    private static List<FieldItem> Disambiguate(List<FieldItem> items)
    {
        if (items.Count < 2) return items;
        var reachable = items.Where((item) => NativeMethods.IsWindowEnabled(item.Root.Window)).ToList();
        if (reachable.Count > 0) items = reachable;
        var usable = items.Where((item) => item.Usable).ToList();
        return usable.Count > 0 ? usable : items;
    }

    // 1 = equal, 2 = contains, 0 = no match; checks Name and the LabeledBy name.
    private static int NameTier(FieldItem item, string query)
    {
        var best = 0;
        foreach (var raw in new[] { item.Name, item.Label })
        {
            var name = NormalizeName(raw);
            if (name.Length == 0) continue;
            if (name == query) return 1;
            if (name.Contains(query, StringComparison.Ordinal)) best = 2;
        }
        return best;
    }

    // Case- and accent-insensitive; drops mnemonic '&' and a trailing ':' of labels.
    internal static string NormalizeName(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var decomposed = value.Replace("&", "").Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);
        foreach (var character in decomposed)
            if (CharUnicodeInfo.GetUnicodeCategory(character) != UnicodeCategory.NonSpacingMark)
                builder.Append(character);
        return builder.ToString().Normalize(NormalizationForm.FormC).ToLowerInvariant().Trim().TrimEnd(':').TrimEnd();
    }

    private static bool TypeMatches(FieldItem item, string type)
        => TypeName(item.Type).Equals(type, StringComparison.OrdinalIgnoreCase);

    private static string TypeName(ControlType type) => type.ProgrammaticName.Replace("ControlType.", "");

    private static string CandidateText(FieldItem item)
    {
        var text = new StringBuilder(TypeName(item.Type)).Append(" \"").Append(Clean(item.DisplayName, 60)).Append('"');
        if (item.AutomationId.Length > 0) text.Append(" (").Append(Clean(item.AutomationId, 60)).Append(')');
        text.Append(" em \"").Append(Clean(TitleOrDefault(item.Root.Title), 60))
            .Append("\" (windowId ").Append(item.Root.Window.ToInt64()).Append(')');
        if (!item.Enabled) text.Append(" desabilitado");
        if (item.Offscreen || item.EmptyBounds) text.Append(" fora da tela");
        return text.ToString();
    }

    // Drops U+FFFC (embedded-object placeholders in web documents) and collapses runs of spaces.
    private static string Quote(string value, int limit)
    {
        var compact = string.Join(' ', value.Replace('￼', ' ').Split(' ', StringSplitOptions.RemoveEmptyEntries));
        return "\"" + Clean(compact, limit) + "\"";
    }

    private static string TitleOrDefault(string title) => title.Length > 0 ? title : "sem título";

    private static string WindowText(nint hwnd)
    {
        var buffer = new StringBuilder(512);
        NativeMethods.GetWindowText(hwnd, buffer, buffer.Capacity);
        return buffer.ToString().Trim();
    }

    private static string ClassName(nint hwnd)
    {
        var buffer = new StringBuilder(256);
        NativeMethods.GetClassName(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }
}
