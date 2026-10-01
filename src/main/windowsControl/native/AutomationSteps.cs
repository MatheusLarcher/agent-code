using System.Windows.Automation;

namespace AgentCode.WindowsControl;

internal sealed record StepTarget(int? Index, string? Name, string? AutomationId, string? Type, string? Gone);
internal sealed record AutomationStep(string Action, StepTarget? Target, string? Value, int TimeoutMs);

// windows_run_steps: a whole sequence in one call. Each target is resolved on the current screen
// right before its step, each action checks its own effect, and the first failure stops the run
// and reports where, plus the window state at that point. A failed step never throws out.
internal sealed partial class AutomationSession
{
    internal static readonly string[] StepActions =
        ["fill", "click", "toggle", "select", "expand", "focus", "press", "wait_for"];

    private static readonly TimeSpan RunBudget = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(100);
    private static readonly TimeSpan VerifyWindow = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan ExpectWindow = TimeSpan.FromSeconds(2);
    private const int StateElements = 300;
    private const string BudgetError = "Tempo total da chamada (120 s) esgotado.";

    private sealed class StepFailure(string message, IReadOnlyList<string>? candidates = null) : Exception(message)
    {
        internal IReadOnlyList<string>? Candidates { get; } = candidates;
    }

    internal object RunSteps(nint hwnd, IReadOnlyList<AutomationStep> steps, string? expect)
    {
        WindowCatalog.EnsureWindow(hwnd);
        var runDeadline = DateTime.UtcNow + RunBudget;
        var warnings = new List<string>();
        var done = 0;
        Dictionary<string, object?>? failed = null;
        for (var i = 0; i < steps.Count && failed is null; i++)
        {
            try
            {
                if (DateTime.UtcNow >= runDeadline) throw new StepFailure(BudgetError);
                RunStep(hwnd, steps[i], runDeadline, warnings);
                done++;
            }
            catch (Exception error)
            {
                failed = FailedStep(i, steps[i], error);
            }
        }

        var result = new Dictionary<string, object?> { ["ok"] = false, ["done"] = done, ["total"] = steps.Count };
        if (failed is not null) result["failedStep"] = failed;
        bool? expectFound = null;
        if (failed is null && expect is not null)
        {
            expectFound = WaitForExpect(hwnd, expect, runDeadline);
            result["expectFound"] = expectFound;
        }
        result["ok"] = failed is null && expectFound != false;
        var (state, targetWindowId) = FinalState(hwnd);
        result["targetWindowId"] = targetWindowId;
        result["state"] = state;
        if (warnings.Count > 0) result["warnings"] = warnings.Distinct().ToList();
        return result;
    }

    private void RunStep(nint hwnd, AutomationStep step, DateTime runDeadline, List<string> warnings)
    {
        var stepDeadline = Earliest(DateTime.UtcNow.AddMilliseconds(step.TimeoutMs), runDeadline);
        if (step.Action == "wait_for")
        {
            WaitFor(hwnd, step, stepDeadline, runDeadline);
            return;
        }
        if (step.Action == "press")
        {
            Press(hwnd, step, stepDeadline, runDeadline);
            Thread.Sleep(InputSettle);
            return;
        }

        var (element, window) = Locate(hwnd, step, stepDeadline, runDeadline);
        switch (step.Action)
        {
            case "fill":
                StepFill(element, window, step.Value ?? "", warnings);
                break;
            case "click":
                ClickCore(element, window);
                Thread.Sleep(InputSettle);
                break;
            case "toggle":
                StepToggle(element, step.Value);
                Thread.Sleep(InputSettle);
                break;
            case "select":
                StepSelect(element, window, step, stepDeadline, runDeadline);
                Thread.Sleep(InputSettle);
                break;
            case "expand":
                StepExpand(element);
                Thread.Sleep(InputSettle);
                break;
            case "focus":
                StepFocus(element);
                break;
            default:
                throw new StepFailure($"Ação desconhecida: {step.Action}.");
        }
    }

    // {index} comes from the cache (with its change check); anything else is looked up now,
    // polling until the step timeout. Ambiguity stops at once: waiting would not resolve it.
    private (AutomationElement Element, nint Window) Locate(
        nint hwnd, AutomationStep step, DateTime stepDeadline, DateTime runDeadline)
    {
        var target = step.Target ?? throw new StepFailure($"{step.Action} exige target.");
        if (target.Index is { } index)
        {
            var cached = CachedEntry(hwnd, index);
            return (cached.Element, cached.Window);
        }
        while (true)
        {
            var matches = FindTargets(hwnd, target);
            if (matches.Count == 1) return (matches[0].Element, matches[0].Root.Window);
            if (matches.Count > 1)
                throw new StepFailure(
                    $"Alvo ambíguo: {matches.Count} elementos correspondem a {TargetText(target)}; refine com type, automationId ou index.",
                    matches.Take(10).Select(CandidateText).ToList());
            WaitOrFail(stepDeadline, runDeadline, () => $"Alvo não encontrado em {step.TimeoutMs} ms: {TargetText(target)}.");
        }
    }

    private static void WaitOrFail(DateTime stepDeadline, DateTime runDeadline, Func<string> timeoutError)
    {
        var now = DateTime.UtcNow;
        if (now >= runDeadline) throw new StepFailure(BudgetError);
        if (now >= stepDeadline) throw new StepFailure(timeoutError());
        var remaining = stepDeadline - now;
        Thread.Sleep(remaining < PollInterval ? remaining : PollInterval);
    }

    private static void StepFill(AutomationElement element, nint window, string value, List<string> warnings)
    {
        var result = FillCore(element, window, null, value, append: false);
        if (result.TryGetValue("clipboardRestored", out var restored) && restored is false)
            warnings.Add(ClipboardLostWarning);
        if (result["verified"] is not true)
            throw new StepFailure(
                "O texto foi enviado ao campo, mas o campo não permite reler o valor; o preenchimento NÃO foi conferido.");
    }

    // Without value: one toggle that must change the state. With on/off: toggles (at most twice,
    // tri-state boxes pass through indeterminate) until the requested state is observed.
    private static void StepToggle(AutomationElement element, string? value)
    {
        var pattern = Pattern<TogglePattern>(element, TogglePattern.Pattern);
        ToggleState Current() => pattern.Current.ToggleState;
        if (value is null)
        {
            var before = Current();
            pattern.Toggle();
            if (!WaitUntil(() => Current() != before, VerifyWindow))
                throw new StepFailure($"O toggle foi enviado, mas o estado continuou {ToggleName(before)}.");
            return;
        }
        var desired = value == "on" ? ToggleState.On : ToggleState.Off;
        for (var attempt = 0; attempt < 2 && Current() != desired; attempt++)
        {
            var before = Current();
            pattern.Toggle();
            WaitUntil(() => Current() != before, VerifyWindow);
        }
        if (Current() != desired)
            throw new StepFailure($"O elemento ficou {ToggleName(Current())}, não {value}.");
    }

    // target is the ComboBox/List (expanded only if collapsed, and collapsed again afterwards) or
    // the item itself. The pick must show as IsSelected or as the container's value.
    private static void StepSelect(
        AutomationElement element, nint window, AutomationStep step, DateTime stepDeadline, DateTime runDeadline)
    {
        var itemName = step.Value ?? throw new StepFailure("select exige value (nome do item).");
        var query = NormalizeName(itemName);
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _)
            && NormalizeName(element.Current.Name) == query)
        {
            PickItem(element, null, window);
            return;
        }

        ExpandCollapsePattern? expander = element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var raw)
            ? (ExpandCollapsePattern)raw
            : null;
        var expandedHere = false;
        if (expander is not null && expander.Current.ExpandCollapseState == ExpandCollapseState.Collapsed)
        {
            expander.Expand();
            expandedHere = true;
            Thread.Sleep(InputSettle);
        }
        try
        {
            while (true)
            {
                var items = FindItems(element, query);
                if (items.Count == 1)
                {
                    PickItem(items[0], element, window);
                    return;
                }
                if (items.Count > 1)
                    throw new StepFailure(
                        $"Alvo ambíguo: {items.Count} itens correspondem a \"{Clean(itemName, 80)}\".",
                        items.Take(10).Select((item) => Quote(SafeName(item), 60)).ToList());
                WaitOrFail(stepDeadline, runDeadline,
                    () => $"O item \"{Clean(itemName, 80)}\" não apareceu na lista em {step.TimeoutMs} ms.");
            }
        }
        finally
        {
            if (expandedHere)
            {
                try
                {
                    if (expander!.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expander.Collapse();
                }
                catch { }
            }
        }
    }

    private static List<AutomationElement> FindItems(AutomationElement container, string query)
    {
        var condition = new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TreeItem),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.DataItem),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem));
        var tiered = new List<(AutomationElement Item, int Tier, bool Visible)>();
        foreach (AutomationElement item in container.FindAll(TreeScope.Descendants, condition))
        {
            var name = NormalizeName(SafeName(item));
            if (name.Length == 0) continue;
            var tier = name == query ? 1 : name.Contains(query, StringComparison.Ordinal) ? 2 : 0;
            if (tier == 0) continue;
            bool visible;
            try { visible = !item.Current.IsOffscreen; }
            catch { visible = false; }
            tiered.Add((item, tier, visible));
        }
        if (tiered.Count == 0) return [];
        var best = tiered.Min((entry) => entry.Tier);
        var matches = tiered.Where((entry) => entry.Tier == best).ToList();
        if (matches.Count > 1 && matches.Any((entry) => entry.Visible)) matches = matches.Where((entry) => entry.Visible).ToList();
        return matches.Select((entry) => entry.Item).ToList();
    }

    private static void PickItem(AutomationElement item, AutomationElement? container, nint window)
    {
        var itemName = NormalizeName(SafeName(item));
        if (item.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selectRaw))
            ((SelectionItemPattern)selectRaw).Select();
        else
            ClickCore(item, window);

        bool Selected()
        {
            try
            {
                if (item.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var raw)
                    && ((SelectionItemPattern)raw).Current.IsSelected)
                    return true;
            }
            catch (ElementNotAvailableException) { }
            return container is not null
                && container.TryGetCurrentPattern(ValuePattern.Pattern, out var valueRaw)
                && NormalizeName(((ValuePattern)valueRaw).Current.Value) == itemName;
        }
        if (!WaitUntil(Selected, VerifyWindow))
            throw new StepFailure("O item foi acionado, mas a seleção não se confirmou (nem IsSelected nem o valor da lista).");
    }

    private static string SafeName(AutomationElement element)
    {
        try { return element.Current.Name ?? ""; }
        catch { return ""; }
    }

    private static void StepExpand(AutomationElement element)
    {
        var pattern = Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern);
        var state = pattern.Current.ExpandCollapseState;
        if (state == ExpandCollapseState.LeafNode) throw new StepFailure("O elemento não tem conteúdo para expandir.");
        if (state != ExpandCollapseState.Collapsed) return;
        pattern.Expand();
        if (!WaitUntil(() => pattern.Current.ExpandCollapseState != ExpandCollapseState.Collapsed, VerifyWindow))
            throw new StepFailure("Expand foi enviado, mas o elemento continuou recolhido.");
    }

    private static void StepFocus(AutomationElement element)
    {
        element.SetFocus();
        if (!WaitUntil(() => element.Current.HasKeyboardFocus, TimeSpan.FromMilliseconds(500)))
            throw new StepFailure("SetFocus foi chamado, mas o elemento não ficou com o foco do teclado.");
    }

    // With a target the key goes to that control (focused like fill does); without one it goes to
    // the foreground window of this family, or the window/modal that takes keyboard input.
    private void Press(nint hwnd, AutomationStep step, DateTime stepDeadline, DateTime runDeadline)
    {
        var key = step.Value ?? throw new StepFailure("press exige value.");
        if (step.Target is not null)
        {
            var (element, window) = Locate(hwnd, step, stepDeadline, runDeadline);
            FocusForInput(window, element);
        }
        else
        {
            WindowCatalog.EnsureWindow(hwnd);
            var foreground = NativeMethods.GetForegroundWindow();
            var owned = foreground != 0 && (foreground == hwnd || OwnerDepth(foreground, hwnd) > 0);
            InputTarget.ActivateForKeyboard(owned ? foreground : hwnd);
        }
        InputController.PressKey(key);
    }

    // target.name: until a root title contains it or an element name matches (equal or
    // contains). target.gone: until no root title contains it and no element name equals it,
    // so a longer label elsewhere never keeps the wait alive; a closed window counts as gone.
    private static void WaitFor(nint hwnd, AutomationStep step, DateTime stepDeadline, DateTime runDeadline)
    {
        var target = step.Target ?? throw new StepFailure("wait_for exige target.name ou target.gone.");
        var gone = target.Name is null;
        var query = NormalizeName(target.Name ?? target.Gone);
        while (true)
        {
            if (!NativeMethods.IsWindow(hwnd))
            {
                if (gone) return;
                throw new StepFailure($"A janela fechou antes de \"{target.Name}\" aparecer.");
            }
            bool? present;
            try { present = IsPresent(hwnd, query, target.Type, exact: gone); }
            catch (Exception) when (!NativeMethods.IsWindow(hwnd)) { present = null; }
            catch (ElementNotAvailableException) { present = null; }
            if (present is { } value && value != gone) return;
            WaitOrFail(stepDeadline, runDeadline, () => gone
                ? $"\"{target.Gone}\" ainda está na tela após {step.TimeoutMs} ms."
                : $"\"{target.Name}\" não apareceu em {step.TimeoutMs} ms.");
        }
    }

    private static bool IsPresent(nint hwnd, string query, string? type, bool exact)
    {
        if (query.Length == 0) return false;
        var roots = FieldRoots(hwnd);
        var checkTitles = type is null || type.Equals("Window", StringComparison.OrdinalIgnoreCase);
        if (checkTitles && roots.Any((root) => NormalizeName(root.Title).Contains(query, StringComparison.Ordinal)))
            return true;
        IEnumerable<FieldItem> items = ScanFields(roots, visibleOnly: true, includeText: true).SelectMany((list) => list);
        if (type is not null) items = items.Where((item) => TypeMatches(item, type));
        return items.Any((item) => NameTier(item, query) is var tier && tier > 0 && (!exact || tier == 1));
    }

    // Searches root titles, element names/labels, values and document text, polling briefly.
    private static bool WaitForExpect(nint hwnd, string expect, DateTime runDeadline)
    {
        var query = NormalizeName(expect);
        var end = Earliest(DateTime.UtcNow + ExpectWindow, runDeadline);
        while (true)
        {
            try
            {
                if (ExpectPresent(hwnd, query)) return true;
            }
            catch { }
            if (DateTime.UtcNow >= end) return false;
            Thread.Sleep(PollInterval);
        }
    }

    private static bool ExpectPresent(nint hwnd, string query)
    {
        if (query.Length == 0 || !NativeMethods.IsWindow(hwnd)) return false;
        var roots = FieldRoots(hwnd);
        if (roots.Any((root) => NormalizeName(root.Title).Contains(query, StringComparison.Ordinal))) return true;
        foreach (var item in ScanFields(roots, visibleOnly: true, includeText: true).SelectMany((list) => list))
        {
            if (NameTier(item, query) > 0) return true;
            if (!item.Password && item.Value is { } value && NormalizeName(value).Contains(query, StringComparison.Ordinal))
                return true;
            if (item.Type == ControlType.Document
                && NormalizeName(DocumentText(item.Element, 8_000)).Contains(query, StringComparison.Ordinal))
                return true;
        }
        return false;
    }

    private (string State, string TargetWindowId) FinalState(nint hwnd)
    {
        var id = hwnd.ToInt64().ToString();
        if (!NativeMethods.IsWindow(hwnd)) return ($"A janela (windowId {id}) foi fechada; não há mais estado para ler.", id);
        try
        {
            var (text, _, active) = BuildFields(hwnd, StateElements);
            return (text, active.ToInt64().ToString());
        }
        catch (Exception error)
        {
            return NativeMethods.IsWindow(hwnd)
                ? ($"Não foi possível ler o estado da janela (windowId {id}): {ErrorText(error)}", id)
                : ($"A janela (windowId {id}) foi fechada; não há mais estado para ler.", id);
        }
    }

    private static Dictionary<string, object?> FailedStep(int index, AutomationStep step, Exception error)
    {
        var failed = new Dictionary<string, object?>
        {
            ["i"] = index,
            ["action"] = step.Action,
            ["target"] = TargetJson(step.Target),
            ["error"] = ErrorText(error),
        };
        if (error is StepFailure { Candidates: { Count: > 0 } candidates }) failed["candidates"] = candidates;
        return failed;
    }

    private static Dictionary<string, object>? TargetJson(StepTarget? target)
    {
        if (target is null) return null;
        var json = new Dictionary<string, object>();
        if (target.Index is { } index) json["index"] = index;
        if (target.Name is { } name) json["name"] = name;
        if (target.AutomationId is { } automationId) json["automationId"] = automationId;
        if (target.Type is { } type) json["type"] = type;
        if (target.Gone is { } gone) json["gone"] = gone;
        return json;
    }

    private static string TargetText(StepTarget target)
    {
        var parts = new List<string>();
        if (target.Name is { } name) parts.Add($"name=\"{Clean(name, 80)}\"");
        if (target.AutomationId is { } automationId) parts.Add($"automationId=\"{Clean(automationId, 80)}\"");
        if (target.Type is { } type) parts.Add($"type={type}");
        return string.Join(' ', parts);
    }

    private static string ErrorText(Exception error)
    {
        var message = error.GetBaseException().Message.Trim();
        return message.Length > 800 ? message[..800] : message;
    }

    private static bool WaitUntil(Func<bool> condition, TimeSpan window)
    {
        var end = DateTime.UtcNow + window;
        while (true)
        {
            try
            {
                if (condition()) return true;
            }
            catch (ElementNotAvailableException) { }
            if (DateTime.UtcNow >= end) return false;
            Thread.Sleep(50);
        }
    }

    private static DateTime Earliest(DateTime first, DateTime second) => first < second ? first : second;
}
