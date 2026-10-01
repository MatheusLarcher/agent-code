using System.Text.Json;
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

            ExpectFill(automation.Fill(hwnd, "teste de velocidade", textIndex, append: false), "value");
            if (testWindow.ReadText() != "teste de velocidade")
                throw new InvalidOperationException($"fill por elementIndex gravou \"{testWindow.ReadText()}\".");

            automation.ClickElement(hwnd, buttonIndex);
            await Task.Delay(100);
            if (!testWindow.WasClicked) throw new InvalidOperationException("InvokePattern não acionou o botão.");

            // Own session: form_fields rewrites the index cache the checks below still rely on.
            CheckFormFieldsAndSteps(new AutomationSession(), hwnd, testWindow);
            var modalSteps = CheckModalSteps(new AutomationSession(), hwnd, testWindow);

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
                    $"SELF_TEST_OK list_windows ui_automation fill_index invoke form_fields run_steps {modalSteps} " +
                    $"send_input_api=accepted hotkey_delivered={hotKeyDelivered.ToString().ToLowerInvariant()} " +
                    "fill_focused=skipped_foreground_lock unicode=skipped_foreground_lock");
                return 0;
            }
            ExpectFill(automation.Fill(hwnd, "campo focado", null, append: false), "value");
            ExpectFill(automation.Fill(hwnd, " de teste", null, append: true), "value");
            if (testWindow.ReadText() != "campo focado de teste")
                throw new InvalidOperationException($"fill no campo focado gravou \"{testWindow.ReadText()}\".");

            InputController.PressKey("Control+a");
            InputController.TypeText("texto via SendInput");
            await Task.Delay(150);
            if (testWindow.ReadText() != "texto via SendInput")
                throw new InvalidOperationException("SendInput não digitou no campo focado.");

            Console.WriteLine(
                $"SELF_TEST_OK list_windows ui_automation fill_index invoke form_fields run_steps {modalSteps} " +
                $"send_input_api=accepted hotkey_delivered={hotKeyDelivered.ToString().ToLowerInvariant()} " +
                "fill_focused send_input_unicode");
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

    // form_fields and run_steps by name. Fill, toggle and click resolve to ValuePattern,
    // TogglePattern and InvokePattern, so no focus or clipboard is needed.
    private static void CheckFormFieldsAndSteps(AutomationSession automation, nint hwnd, TestWindow window)
    {
        var fields = JsonSerializer.SerializeToElement(automation.FormFields(hwnd, 300));
        var text = fields.GetProperty("text").GetString() ?? "";
        foreach (var expected in new[]
        {
            "Edit \"Smoke text\" (SmokeText)",
            "Button \"Smoke button\" (SmokeButton)",
            "CheckBox \"Smoke check\" (SmokeCheck) = off",
        })
        {
            if (!text.Contains(expected, StringComparison.Ordinal))
                throw new InvalidOperationException($"form_fields sem a linha {expected}: {text}");
        }
        if (fields.GetProperty("count").GetInt32() < 3 || !text.Contains("ativo: ", StringComparison.Ordinal))
            throw new InvalidOperationException($"form_fields incompleto: {text}");

        var clicks = window.Clicks;
        var run = JsonSerializer.SerializeToElement(automation.RunSteps(hwnd,
        [
            new AutomationStep("fill", new StepTarget(null, "smoke text", null, null, null), "passos por nome", 5000),
            new AutomationStep("toggle", new StepTarget(null, "Smoke check", null, null, null), null, 5000),
            new AutomationStep("click", new StepTarget(null, "smoke button", null, null, null), null, 5000),
        ], null));
        if (!run.GetProperty("ok").GetBoolean() || run.GetProperty("done").GetInt32() != 3)
            throw new InvalidOperationException($"run_steps falhou: {run}");
        if (window.ReadText() != "passos por nome")
            throw new InvalidOperationException($"run_steps fill gravou \"{window.ReadText()}\".");
        if (!window.IsChecked) throw new InvalidOperationException("run_steps toggle não marcou a caixa.");
        if (window.Clicks <= clicks) throw new InvalidOperationException("run_steps click não acionou o botão.");

        var missing = JsonSerializer.SerializeToElement(automation.RunSteps(hwnd,
            [new AutomationStep("click", new StepTarget(null, "botão inexistente", null, null, null), null, 300)], null));
        if (missing.GetProperty("ok").GetBoolean()
            || !missing.TryGetProperty("failedStep", out var failed)
            || failed.GetProperty("i").GetInt32() != 0
            || string.IsNullOrWhiteSpace(missing.GetProperty("state").GetString()))
            throw new InvalidOperationException($"run_steps com alvo inexistente respondeu {missing}");

        // The returned state rewrites the index cache, so its indices work in the next call.
        var line = Regex.Match(missing.GetProperty("state").GetString() ?? "", "^(\\d+) Edit \"Smoke text\"", RegexOptions.Multiline);
        if (!line.Success) throw new InvalidOperationException("state do run_steps sem o campo de teste.");
        var byIndex = JsonSerializer.SerializeToElement(automation.RunSteps(hwnd,
            [new AutomationStep("fill", new StepTarget(int.Parse(line.Groups[1].Value), null, null, null, null), "por índice", 5000)],
            "por índice"));
        if (!byIndex.GetProperty("ok").GetBoolean() || window.ReadText() != "por índice")
            throw new InvalidOperationException($"run_steps por index respondeu {byIndex}");
    }

    // A button whose click handler runs ShowDialog blocks InvokePattern.Invoke until the dialog
    // closes. run_steps must come back quickly (invoke-async), fill the modal and close it with OK.
    private static string CheckModalSteps(AutomationSession automation, nint hwnd, TestWindow window)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var run = JsonSerializer.SerializeToElement(automation.RunSteps(hwnd,
        [
            new AutomationStep("click", new StepTarget(null, "Smoke modal", null, null, null), null, 5000),
            new AutomationStep("fill", new StepTarget(null, "Modal text", null, null, null), "no modal", 5000),
            new AutomationStep("click", new StepTarget(null, "OK", null, "Button", null), null, 5000),
        ], null));
        watch.Stop();
        try
        {
            if (!window.ModalShown) throw new InvalidOperationException($"run_steps click não abriu o modal: {run}");
            if (run.GetProperty("done").GetInt32() < 1)
                throw new InvalidOperationException($"run_steps click no botão do modal falhou: {run}");
            // A foreground-lock failure is immediate (no polling), so the bound holds on both paths.
            if (watch.Elapsed > TimeSpan.FromSeconds(3))
                throw new InvalidOperationException($"run_steps com modal levou {watch.ElapsedMilliseconds} ms: {run}");
            if (run.GetProperty("ok").GetBoolean())
            {
                var deadline = DateTime.UtcNow.AddSeconds(2);
                while (!window.ModalClosed && DateTime.UtcNow < deadline) Thread.Sleep(50);
                if (!window.ModalClosed) throw new InvalidOperationException("O OK do run_steps não fechou o modal.");
                if (window.ModalText != "no modal")
                    throw new InvalidOperationException($"run_steps fill no modal gravou \"{window.ModalText}\".");
                return "modal_steps";
            }
            // The click came back (done >= 1); only a later step may hit the foreground lock.
            var error = run.GetProperty("failedStep").GetProperty("error").GetString() ?? "";
            if (error.Contains("primeiro plano", StringComparison.Ordinal)) return "modal_steps=skipped_foreground_lock";
            throw new InvalidOperationException($"run_steps no modal falhou: {run}");
        }
        finally
        {
            window.CloseModal();
        }
    }

    // The self-test only accepts the clipboard-free ValuePattern path, so the user's clipboard is
    // never touched; a verified result with any other method would mean the fallback misfired.
    private static void ExpectFill(object result, string method)
    {
        var json = System.Text.Json.JsonSerializer.SerializeToElement(result);
        var actual = json.GetProperty("method").GetString();
        if (!json.GetProperty("verified").GetBoolean() || actual != method)
            throw new InvalidOperationException($"fill respondeu method={actual} verified={json.GetProperty("verified")}; esperado {method} verificado.");
    }

    private sealed class TestWindow : Form
    {
        private readonly TextBox textBox = new() { Name = "SmokeText", Width = 280 };
        private readonly Button button = new() { Name = "SmokeButton", Text = "Testar", Width = 100 };
        private readonly CheckBox checkBox = new() { Name = "SmokeCheck", Text = "Smoke check", AutoSize = true };
        private readonly Button modalButton = new() { Name = "SmokeModal", Text = "Abrir modal", Width = 120 };
        private volatile ModalWindow? modal;
        private volatile bool modalShown;
        private volatile bool modalClosed;
        private volatile string modalText = "";
        internal bool ModalShown => modalShown;
        internal bool ModalClosed => modalClosed;
        internal string ModalText => modalText;
        private readonly TaskCompletionSource hotKeyPressed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private const int HotKeyId = 91;
        private const int WmHotKey = 0x0312;
        private const uint VkF13 = 0x7C;
        private int clicks;
        internal int Clicks => Volatile.Read(ref clicks);
        internal bool WasClicked => Clicks > 0;

        internal TestWindow()
        {
            Text = "Agent Code Windows Control Self Test";
            Width = 420;
            Height = 280;
            StartPosition = FormStartPosition.CenterScreen;
            var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20) };
            textBox.AccessibleName = "Smoke text";
            button.AccessibleName = "Smoke button";
            button.Click += (_, _) => Interlocked.Increment(ref clicks);
            checkBox.AccessibleName = "Smoke check";
            modalButton.AccessibleName = "Smoke modal";
            modalButton.Click += (_, _) =>
            {
                using var dialog = new ModalWindow();
                modal = dialog;
                modalShown = true;
                var result = dialog.ShowDialog(this);
                modalText = result == DialogResult.OK ? dialog.Value : "";
                modal = null;
                modalClosed = true;
            };
            Shown += (_, _) =>
            {
                if (!NativeMethods.RegisterHotKey(Handle, HotKeyId, 0, VkF13))
                    hotKeyPressed.TrySetException(new InvalidOperationException("Não foi possível registrar a tecla de teste F13."));
            };
            panel.Controls.Add(textBox);
            panel.Controls.Add(button);
            panel.Controls.Add(checkBox);
            panel.Controls.Add(modalButton);
            Controls.Add(panel);
        }

        internal void CloseModal()
        {
            if (modal is { } open && !IsDisposed) BeginInvoke(() => { if (!open.IsDisposed) open.Close(); });
        }

        internal string ReadText() => InvokeRequired ? (string)Invoke(() => textBox.Text) : textBox.Text;
        internal bool IsChecked => InvokeRequired ? (bool)Invoke(() => checkBox.Checked) : checkBox.Checked;
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

    private sealed class ModalWindow : Form
    {
        private readonly TextBox textBox = new() { Name = "ModalText", Width = 200, AccessibleName = "Modal text" };
        internal string Value => textBox.Text;

        internal ModalWindow()
        {
            Text = "Agent Code Self Test Modal";
            Width = 300;
            Height = 150;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            var ok = new Button { Name = "ModalOk", Text = "OK", DialogResult = DialogResult.OK };
            var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(12) };
            panel.Controls.Add(textBox);
            panel.Controls.Add(ok);
            Controls.Add(panel);
            AcceptButton = ok;
        }
    }
}
