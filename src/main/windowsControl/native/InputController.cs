using System.Drawing;
using System.Runtime.InteropServices;

namespace AgentCode.WindowsControl;

internal static class InputController
{
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_SHIFT = 0x10;
    private const ushort VK_MENU = 0x12;
    private const ushort VK_LWIN = 0x5B;

    private static readonly Dictionary<string, ushort> NamedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ctrl"] = VK_CONTROL, ["control"] = VK_CONTROL, ["control_l"] = VK_CONTROL,
        ["shift"] = VK_SHIFT, ["shift_l"] = VK_SHIFT,
        ["alt"] = VK_MENU, ["alt_l"] = VK_MENU,
        ["win"] = VK_LWIN, ["windows"] = VK_LWIN, ["meta"] = VK_LWIN,
        ["return"] = 0x0D, ["enter"] = 0x0D, ["tab"] = 0x09,
        ["escape"] = 0x1B, ["esc"] = 0x1B, ["space"] = 0x20,
        ["backspace"] = 0x08, ["delete"] = 0x2E, ["insert"] = 0x2D,
        ["left"] = 0x25, ["up"] = 0x26, ["right"] = 0x27, ["down"] = 0x28,
        ["home"] = 0x24, ["end"] = 0x23, ["pageup"] = 0x21, ["pagedown"] = 0x22,
        ["period"] = 0xBE, ["comma"] = 0xBC, ["slash"] = 0xBF,
        ["minus"] = 0xBD, ["equal"] = 0xBB
    };

    internal static void Click(Point point, string button, int count)
    {
        Move(point);
        var (down, up) = button.ToLowerInvariant() switch
        {
            "left" or "l" => (NativeMethods.MOUSEEVENTF_LEFTDOWN, NativeMethods.MOUSEEVENTF_LEFTUP),
            "right" or "r" => (NativeMethods.MOUSEEVENTF_RIGHTDOWN, NativeMethods.MOUSEEVENTF_RIGHTUP),
            "middle" or "m" => (NativeMethods.MOUSEEVENTF_MIDDLEDOWN, NativeMethods.MOUSEEVENTF_MIDDLEUP),
            _ => throw new ArgumentException("button deve ser left, right ou middle.")
        };
        var inputs = new List<NativeMethods.Input>();
        for (var i = 0; i < count; i++)
        {
            inputs.Add(Mouse(0, 0, 0, down));
            inputs.Add(Mouse(0, 0, 0, up));
        }
        Send(inputs);
    }

    internal static void Scroll(Point point, int horizontal, int vertical)
    {
        Move(point);
        var inputs = new List<NativeMethods.Input>();
        if (vertical != 0) inputs.Add(Mouse(0, 0, unchecked((uint)-ClampWheel(vertical)), NativeMethods.MOUSEEVENTF_WHEEL));
        if (horizontal != 0) inputs.Add(Mouse(0, 0, unchecked((uint)ClampWheel(horizontal)), NativeMethods.MOUSEEVENTF_HWHEEL));
        Send(inputs);
    }

    internal static void Drag(Point from, Point to)
    {
        Move(from);
        Send([Mouse(0, 0, 0, NativeMethods.MOUSEEVENTF_LEFTDOWN)]);
        const int steps = 16;
        for (var step = 1; step <= steps; step++)
        {
            var x = from.X + (to.X - from.X) * step / steps;
            var y = from.Y + (to.Y - from.Y) * step / steps;
            Move(new Point(x, y));
        }
        Send([Mouse(0, 0, 0, NativeMethods.MOUSEEVENTF_LEFTUP)]);
    }

    internal static void TypeText(string text)
    {
        if (text.Length > 100_000) throw new ArgumentException("Texto excede o limite de 100000 caracteres.");
        const int batchSize = 500;
        for (var offset = 0; offset < text.Length; offset += batchSize)
        {
            var end = Math.Min(text.Length, offset + batchSize);
            var inputs = new List<NativeMethods.Input>((end - offset) * 2);
            for (var index = offset; index < end; index++)
            {
                inputs.Add(Key(0, text[index], NativeMethods.KEYEVENTF_UNICODE));
                inputs.Add(Key(0, text[index], NativeMethods.KEYEVENTF_UNICODE | NativeMethods.KEYEVENTF_KEYUP));
            }
            Send(inputs);
        }
    }

    internal static void PressKey(string chord)
    {
        var tokens = chord.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Length is < 1 or > 8) throw new ArgumentException("Atalho de teclado inválido.");
        var keys = tokens.Select(ParseKey).ToList();
        var inputs = new List<NativeMethods.Input>(keys.Count * 2);
        foreach (var key in keys) inputs.Add(Key(key, '\0', 0));
        for (var index = keys.Count - 1; index >= 0; index--) inputs.Add(Key(keys[index], '\0', NativeMethods.KEYEVENTF_KEYUP));
        Send(inputs);
    }

    private static ushort ParseKey(string raw)
    {
        if (NamedKeys.TryGetValue(raw, out var named)) return named;
        if (raw.Length == 1)
        {
            var mapped = NativeMethods.VkKeyScan(raw[0]);
            if (mapped == -1) throw new ArgumentException($"Tecla não reconhecida: {raw}");
            return unchecked((ushort)(mapped & 0xFF));
        }
        if (raw.Length is >= 2 and <= 3 && raw.StartsWith("f", StringComparison.OrdinalIgnoreCase)
            && int.TryParse(raw[1..], out var number) && number is >= 1 and <= 24)
            return (ushort)(0x70 + number - 1);
        if (raw.StartsWith("kp_", StringComparison.OrdinalIgnoreCase)
            && int.TryParse(raw[3..], out var keypad) && keypad is >= 0 and <= 9)
            return (ushort)(0x60 + keypad);
        throw new ArgumentException($"Tecla não reconhecida: {raw}");
    }

    private static void Move(Point point)
    {
        var left = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
        var top = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
        var width = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN);
        var height = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN);
        if (width <= 1 || height <= 1) throw new InvalidOperationException("Área virtual do Windows inválida.");
        var dx = (int)Math.Round((point.X - left) * 65535d / (width - 1));
        var dy = (int)Math.Round((point.Y - top) * 65535d / (height - 1));
        Send([Mouse(dx, dy, 0, NativeMethods.MOUSEEVENTF_MOVE | NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK)]);
    }

    private static int ClampWheel(int value)
    {
        var magnitude = Math.Clamp(Math.Abs(value), 120, 1_200);
        return Math.Sign(value) * magnitude;
    }

    private static NativeMethods.Input Mouse(int dx, int dy, uint data, uint flags) => new()
    {
        Type = NativeMethods.INPUT_MOUSE,
        Data = new NativeMethods.InputUnion
        {
            Mouse = new NativeMethods.MouseInput { Dx = dx, Dy = dy, MouseData = data, Flags = flags }
        }
    };

    private static NativeMethods.Input Key(ushort virtualKey, char scanCode, uint flags) => new()
    {
        Type = NativeMethods.INPUT_KEYBOARD,
        Data = new NativeMethods.InputUnion
        {
            Keyboard = new NativeMethods.KeyboardInput { VirtualKey = virtualKey, ScanCode = scanCode, Flags = flags }
        }
    };

    private static void Send(IReadOnlyCollection<NativeMethods.Input> inputs)
    {
        if (inputs.Count == 0) return;
        var array = inputs.ToArray();
        var sent = NativeMethods.SendInput((uint)array.Length, array, Marshal.SizeOf<NativeMethods.Input>());
        if (sent != array.Length)
            throw new InvalidOperationException("O Windows bloqueou a entrada. Janelas elevadas exigem que o Agent Code também esteja elevado.");
    }
}
