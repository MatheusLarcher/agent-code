using System.Text.Json.Nodes;

namespace AgentCode.WindowsControl;

internal sealed class CommandDispatcher
{
    private readonly AutomationSession automation = new();

    public Task<object?> ExecuteAsync(string method, JsonObject args)
    {
        var invalidatesSnapshot = method is "click" or "click_element" or "type_text" or "press_key"
            or "scroll" or "drag" or "set_value" or "secondary_action";
        try
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
            "secondary_action" => automation.SecondaryAction(
                RequiredWindow(args),
                RequiredInt(args, "elementIndex", 0, 9999),
                RequiredString(args, "action", 80)),
            _ => throw new ArgumentException($"Método não suportado: {method}")
            };
            return Task.FromResult<object?>(result);
        }
        finally
        {
            if (invalidatesSnapshot) automation.Invalidate();
        }
    }

    private static object Click(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        WindowCatalog.Activate(hwnd);
        InputController.Click(
            WindowCatalog.ToScreenPoint(hwnd, RequiredDouble(args, "x"), RequiredDouble(args, "y")),
            OptionalString(args, "button", "left"),
            OptionalInt(args, "clickCount", 1, 1, 3));
        return new { ok = true };
    }

    private static object TypeText(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        WindowCatalog.Activate(hwnd);
        InputController.TypeText(RawString(args, "text", 100_000));
        return new { ok = true };
    }

    private static object PressKey(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        WindowCatalog.Activate(hwnd);
        InputController.PressKey(RequiredString(args, "key", 200));
        return new { ok = true };
    }

    private static object Scroll(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        WindowCatalog.Activate(hwnd);
        var point = WindowCatalog.ToScreenPoint(hwnd, RequiredDouble(args, "x"), RequiredDouble(args, "y"));
        InputController.Scroll(point, RequiredInt(args, "scrollX", -50_000, 50_000), RequiredInt(args, "scrollY", -50_000, 50_000));
        return new { ok = true };
    }

    private static object Drag(JsonObject args)
    {
        var hwnd = RequiredWindow(args);
        WindowCatalog.Activate(hwnd);
        InputController.Drag(
            WindowCatalog.ToScreenPoint(hwnd, RequiredDouble(args, "fromX"), RequiredDouble(args, "fromY")),
            WindowCatalog.ToScreenPoint(hwnd, RequiredDouble(args, "toX"), RequiredDouble(args, "toY")));
        return new { ok = true };
    }

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
