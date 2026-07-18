using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace AgentCode.WindowsControl;

internal static partial class SelfTest
{
    [GeneratedRegex("\\[(\\d+)\\].*id=\"(?<id>SmokeText|SmokeButton)\"")]
    private static partial Regex ElementRegex();

    internal static async Task<int> RunAsync(bool waitForFocus)
    {
        var ready = new TaskCompletionSource<TestWindow>(TaskCreationOptions.RunContinuationsAsynchronously);
        var uiThread = new Thread(() =>
        {
            var window = new TestWindow();
            window.Shown += (_, _) => ready.TrySetResult(window);
            Application.Run(window);
        });
        uiThread.SetApartmentState(ApartmentState.STA);
        uiThread.IsBackground = true;
        uiThread.Start();

        TestWindow? testWindow = null;
        try
        {
            testWindow = await ready.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var hwnd = testWindow.Handle;
            var listed = WindowCatalog.ListWindows().Any((window) => window.Id == hwnd.ToInt64().ToString());
            if (!listed) throw new InvalidOperationException("A janela de teste não apareceu no catálogo.");

            var automation = new AutomationSession();
            var snapshot = automation.Observe(hwnd, 8, 200);
            var indices = ElementRegex().Matches(snapshot.Tree)
                .ToDictionary((match) => match.Groups["id"].Value, (match) => int.Parse(match.Groups[1].Value));
            if (!indices.TryGetValue("SmokeText", out var textIndex))
                throw new InvalidOperationException("Campo de teste ausente da árvore de acessibilidade.");
            if (!indices.TryGetValue("SmokeButton", out var buttonIndex))
                throw new InvalidOperationException("Botão de teste ausente da árvore de acessibilidade.");

            automation.SetValue(hwnd, textIndex, "valor por UI Automation");
            await Task.Delay(100);
            if (testWindow.ReadText() != "valor por UI Automation")
                throw new InvalidOperationException("ValuePattern não alterou o campo.");

            automation.ClickElement(hwnd, buttonIndex);
            await Task.Delay(100);
            if (!testWindow.WasClicked) throw new InvalidOperationException("InvokePattern não acionou o botão.");

            InputController.PressKey("F13");
            var hotKeyDelivered = true;
            try { await testWindow.WaitForHotKeyAsync().WaitAsync(TimeSpan.FromSeconds(3)); }
            catch (TimeoutException) { hotKeyDelivered = false; }

            automation.SecondaryAction(hwnd, textIndex, "focus");
            testWindow.FocusText();
            await Task.Delay(100);
            try
            {
                WindowCatalog.Activate(hwnd);
            }
            catch when (waitForFocus)
            {
                Console.WriteLine("SELF_TEST_WAITING_FOR_FOCUS");
                var deadline = DateTime.UtcNow.AddSeconds(45);
                while (NativeMethods.GetForegroundWindow() != hwnd && DateTime.UtcNow < deadline)
                    await Task.Delay(100);
                if (NativeMethods.GetForegroundWindow() != hwnd)
                    throw new InvalidOperationException("A janela de teste não recebeu foco dentro do prazo.");
            }
            catch
            {
                Console.WriteLine(
                    $"SELF_TEST_OK list_windows ui_automation invoke send_input_api=accepted " +
                    $"hotkey_delivered={hotKeyDelivered.ToString().ToLowerInvariant()} unicode=skipped_foreground_lock");
                return 0;
            }
            InputController.PressKey("Control+a");
            InputController.TypeText("texto via SendInput");
            await Task.Delay(150);
            if (testWindow.ReadText() != "texto via SendInput")
                throw new InvalidOperationException("SendInput não digitou no campo focado.");

            Console.WriteLine(
                $"SELF_TEST_OK list_windows ui_automation invoke send_input_api=accepted " +
                $"hotkey_delivered={hotKeyDelivered.ToString().ToLowerInvariant()} send_input_unicode");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"SELF_TEST_FAILED {error.GetBaseException().Message}");
            return 1;
        }
        finally
        {
            testWindow?.CloseWindow();
            uiThread.Join(TimeSpan.FromSeconds(3));
        }
    }

    private sealed class TestWindow : Form
    {
        private readonly TextBox textBox = new() { Name = "SmokeText", Width = 280 };
        private readonly Button button = new() { Name = "SmokeButton", Text = "Testar", Width = 100 };
        private readonly TaskCompletionSource hotKeyPressed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private const int HotKeyId = 91;
        private const int WmHotKey = 0x0312;
        private const uint VkF13 = 0x7C;
        internal bool WasClicked { get; private set; }

        internal TestWindow()
        {
            Text = "Agent Code Windows Control Self Test";
            Width = 420;
            Height = 180;
            StartPosition = FormStartPosition.CenterScreen;
            var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20) };
            textBox.AccessibleName = "Smoke text";
            button.AccessibleName = "Smoke button";
            button.Click += (_, _) => WasClicked = true;
            Shown += (_, _) =>
            {
                if (!NativeMethods.RegisterHotKey(Handle, HotKeyId, 0, VkF13))
                    hotKeyPressed.TrySetException(new InvalidOperationException("Não foi possível registrar a tecla de teste F13."));
            };
            panel.Controls.Add(textBox);
            panel.Controls.Add(button);
            Controls.Add(panel);
        }

        internal string ReadText() => InvokeRequired ? (string)Invoke(() => textBox.Text) : textBox.Text;
        internal Task WaitForHotKeyAsync() => hotKeyPressed.Task;
        internal void FocusText()
        {
            void FocusCore()
            {
                WindowState = FormWindowState.Normal;
                TopMost = true;
                TopMost = false;
                Activate();
                BringToFront();
                textBox.Focus();
            }
            if (InvokeRequired) Invoke(FocusCore);
            else FocusCore();
        }
        internal void CloseWindow()
        {
            if (IsDisposed) return;
            if (InvokeRequired) BeginInvoke(Close);
            else Close();
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WmHotKey && message.WParam.ToInt32() == HotKeyId) hotKeyPressed.TrySetResult();
            base.WndProc(ref message);
        }

        protected override void OnFormClosed(FormClosedEventArgs eventArgs)
        {
            NativeMethods.UnregisterHotKey(Handle, HotKeyId);
            base.OnFormClosed(eventArgs);
        }
    }
}
