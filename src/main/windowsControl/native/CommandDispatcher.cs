using System.Text.Json.Nodes;

namespace AgentCode.WindowsControl;

internal sealed class CommandDispatcher
{
    private readonly AutomationSession automation = new();

    public Task<object?> ExecuteAsync(string method, JsonObject args)
    {
        object? result = method switch
        {
            "ping" => new { ok = true, platform = "windows" },
            "list_windows" => WindowCatalog.ListWindows(),
            "list_apps" => WindowCatalog.ListApps(),
            "launch_app" => WindowCatalog.LaunchApp(RequiredString(args, "app"), StringArray(args, "arguments")),
            "activate_window" => WindowCatalog.Activate(RequiredWindow(args)),
            "get_accessibility" => automation.Observe(
                RequiredWindow(args),
                OptionalInt(args, "maxDepth", 7, 1, 20),
                OptionalInt(args, "maxElements", 350, 1, 1000)),
            "click" => Click(args),
            "click_element" => automation.ClickElement(RequiredWindow(args), RequiredInt(args, "elementIndex", 0, 9999)),
            "type_text" => TypeText(args),
            "press_key" => PressKey(args),
            "scroll" => Scroll(args),
            "drag" => Drag(args),
            "set_value" => automation.SetValue(
                RequiredWindow(args),
                RequiredInt(args, "elementIndex", 0, 9999),
                RawString(args, "value", 100_000)),
            "fill" => automation.Fill(
                RequiredWindow(args),
                RawString(args, "text", 100_000),
                args["elementIndex"] is null ? null : RequiredInt(args, "elementIndex", 0, 9999),
                FillMode(args)),
            "secondary_action" => automation.SecondaryAction(
                RequiredWindow(args),
                RequiredInt(args, "elementIndex", 0, 9999),
                RequiredString(args, "action", 80)),
            "form_fields" => automation.FormFields(
                RequiredWindow(args),
                OptionalInt(args, "maxElements", 300, 1, 1000)),
            "run_steps" => automation.RunSteps(
                RequiredWindow(args),
                Steps(args),
                args["expect"] is null ? null : RequiredString(args, "expect", 500)),
            _ => throw new ArgumentException($"Método não suportado: {method}")
        };
        return Task.FromResult<object?>(result);
    }

    private static object Click(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        var x = RequiredDouble(args, "x");
        var y = RequiredDouble(args, "y");
        var button = OptionalString(args, "button", "left");
        var clickCount = OptionalInt(args, "clickCount", 1, 1, 3);
        System.Drawing.Point[] Points() => [WindowCatalog.ToScreenPoint(hwnd, x, y)];
        var target = InputTarget.ActivateForPointer(hwnd, Points);
        InputController.Click(Points()[0], button, clickCount);
        return Acted(target);
    }

    private static object TypeText(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        var text = RawString(args, "text", 100_000);
        var target = InputTarget.ActivateForKeyboard(hwnd);
        InputController.TypeText(text);
        return Acted(target);
    }

    private static object PressKey(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        var key = RequiredString(args, "key", 200);
        var target = InputTarget.ActivateForKeyboard(hwnd);
        InputController.PressKey(key);
        return Acted(target);
    }

    private static object Scroll(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        var x = RequiredDouble(args, "x");
        var y = RequiredDouble(args, "y");
        var scrollX = RequiredInt(args, "scrollX", -50_000, 50_000);
        var scrollY = RequiredInt(args, "scrollY", -50_000, 50_000);
        System.Drawing.Point[] Points() => [WindowCatalog.ToScreenPoint(hwnd, x, y)];
        var target = InputTarget.ActivateForPointer(hwnd, Points);
        InputController.Scroll(Points()[0], scrollX, scrollY);
        return Acted(target);
    }

    private static object Drag(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        var fromX = RequiredDouble(args, "fromX");
        var fromY = RequiredDouble(args, "fromY");
        var toX = RequiredDouble(args, "toX");
        var toY = RequiredDouble(args, "toY");
        System.Drawing.Point[] Points() =>
            [WindowCatalog.ToScreenPoint(hwnd, fromX, fromY), WindowCatalog.ToScreenPoint(hwnd, toX, toY)];
        var target = InputTarget.ActivateForPointer(hwnd, Points);
        var points = Points();
        InputController.Drag(points[0], points[1]);
        return Acted(target);
    }

    // true = append, false = replace.
    private static bool FillMode(JsonObject args) => OptionalString(args, "mode", "replace") switch
    {
        "replace" => false,
        "append" => true,
        _ => throw new ArgumentException("mode deve ser replace ou append.")
    };

    private static object Acted(nint target) => new { ok = true, targetWindowId = target.ToInt64().ToString() };

    private static List<AutomationStep> Steps(JsonObject args)
    {
        if (args["steps"] is not JsonArray array || array.Count is < 1 or > 500)
            throw new ArgumentException("steps deve ser uma lista de 1 a 500 passos.");
        var steps = new List<AutomationStep>(array.Count);
        for (var i = 0; i < array.Count; i++)
        {
            if (array[i] is not JsonObject raw) throw new ArgumentException($"steps[{i}] deve ser um objeto.");
            try { steps.Add(Step(raw)); }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or FormatException)
            {
                throw new ArgumentException($"steps[{i}]: {error.Message}");
            }
        }
        return steps;
    }

    private static readonly string[] TargetedActions = ["fill", "click", "toggle", "select", "expand", "focus"];

    private static AutomationStep Step(JsonObject raw)
    {
        var action = RequiredString(raw, "action", 20);
        if (!AutomationSession.StepActions.Contains(action))
            throw new ArgumentException($"action inválida: {action}. Use {string.Join(", ", AutomationSession.StepActions)}.");
        var target = raw["target"] is null ? null : Target(raw["target"]);
        var value = raw["value"] is null ? null : RawString(raw, "value", 100_000);
        var timeoutMs = OptionalInt(raw, "timeoutMs", 5000, 100, 30_000);

        if (TargetedActions.Contains(action) || (action == "press" && target is not null))
        {
            if (target is null) throw new ArgumentException($"{action} exige target.");
            if (target.Index is null && target.Name is null && target.AutomationId is null)
                throw new ArgumentException("target precisa de index, name ou automationId.");
        }
        if (action == "wait_for" && target?.Name is null && target?.Gone is null)
            throw new ArgumentException("wait_for exige target.name ou target.gone.");
        if (action == "fill" && value is null) throw new ArgumentException("fill exige value.");
        if (action is "select" or "press" && string.IsNullOrWhiteSpace(value))
            throw new ArgumentException($"{action} exige value.");
        if (action == "press" && value!.Length > 200) throw new ArgumentException("value de press excede 200 caracteres.");
        if (action == "toggle" && value is not null)
        {
            value = value.Trim().ToLowerInvariant();
            if (value is not ("on" or "off")) throw new ArgumentException("value de toggle deve ser on ou off.");
        }
        return new AutomationStep(action, target, value, timeoutMs);
    }

    private static StepTarget Target(JsonNode? node)
    {
        if (node is not JsonObject raw) throw new ArgumentException("target deve ser um objeto.");
        var type = OptionalTargetString(raw, "type", 40);
        if (type is not null && !AutomationSession.IsKnownControlType(type))
            throw new ArgumentException($"target.type desconhecido: {type} (use Button, Edit, CheckBox…).");
        return new StepTarget(
            raw["index"] is null ? null : RequiredInt(raw, "index", 0, 9999),
            OptionalTargetString(raw, "name", 500),
            OptionalTargetString(raw, "automationId", 500),
            type,
            OptionalTargetString(raw, "gone", 500));
    }

    private static string? OptionalTargetString(JsonObject raw, string name, int maxLength)
        => raw[name] is null ? null : RequiredString(raw, name, maxLength);

    private static nint RequiredWindow(JsonObject args)
    {
        var raw = RequiredString(args, "windowId", 32);
        if (!long.TryParse(raw, out var value) || value == 0) throw new ArgumentException("windowId inválido.");
        var hwnd = new nint(value);
        if (!NativeMethods.IsWindow(hwnd)) throw new ArgumentException("A janela não existe mais; liste as janelas novamente.");
        return hwnd;
    }

    private static string RequiredString(JsonObject args, string name, int maxLength = 32_000)
    {
        var value = args[name]?.GetValue<string>()?.TrimEnd();
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException($"{name} é obrigatório.");
        if (value.Length > maxLength) throw new ArgumentException($"{name} excede o limite de {maxLength} caracteres.");
        return value;
    }

    private static string OptionalString(JsonObject args, string name, string fallback)
        => args[name]?.GetValue<string>() ?? fallback;

    private static string RawString(JsonObject args, string name, int maxLength)
    {
        var value = args[name]?.GetValue<string>() ?? throw new ArgumentException($"{name} é obrigatório.");
        if (value.Length > maxLength) throw new ArgumentException($"{name} excede o limite de {maxLength} caracteres.");
        return value;
    }

    private static int RequiredInt(JsonObject args, string name, int min, int max)
    {
        var value = args[name]?.GetValue<int>() ?? throw new ArgumentException($"{name} é obrigatório.");
        if (value < min || value > max) throw new ArgumentException($"{name} deve estar entre {min} e {max}.");
        return value;
    }

    private static int OptionalInt(JsonObject args, string name, int fallback, int min, int max)
    {
        var value = args[name]?.GetValue<int>() ?? fallback;
        if (value < min || value > max) throw new ArgumentException($"{name} deve estar entre {min} e {max}.");
        return value;
    }

    private static double RequiredDouble(JsonObject args, string name)
    {
        var value = args[name]?.GetValue<double>() ?? throw new ArgumentException($"{name} é obrigatório.");
        if (!double.IsFinite(value) || value is < -100_000 or > 100_000)
            throw new ArgumentException($"{name} inválido.");
        return value;
    }

    private static string[] StringArray(JsonObject args, string name)
    {
        if (args[name] is not JsonArray array) return [];
        if (array.Count > 40) throw new ArgumentException($"{name} aceita no máximo 40 itens.");
        return array.Select((node) => node?.GetValue<string>() ?? "")
            .Select((value) => value.Length <= 2_000 ? value : throw new ArgumentException($"Item de {name} muito longo."))
            .ToArray();
    }
}
