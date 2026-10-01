using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace AgentCode.WindowsControl;

internal sealed class ClipboardUnavailableException(string message, Exception? inner = null)
    : Exception(message, inner);

// Temporarily puts text on the clipboard and always restores what the user had. The clipboard
// is an OLE API, so every access runs on a dedicated STA thread with a bounded wait.
internal static class ClipboardSwap
{
    private const int Attempts = 5;
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(60);
    private static readonly TimeSpan ThreadTimeout = TimeSpan.FromSeconds(5);
    // Apps read the clipboard asynchronously after Ctrl+V; restoring too early pastes the old data.
    private static readonly TimeSpan PasteSettle = TimeSpan.FromMilliseconds(200);

    // Runs paste() with the text on the clipboard. ClipboardUnavailableException is thrown only
    // before paste() runs (save or set failed), so the caller can fall back to keys without having
    // sent any input. An exception from paste() is rethrown unchanged. Returns false when the
    // user's clipboard could not be restored; that failure never replaces another error.
    internal static bool WithText(string text, Action paste)
    {
        var saved = RunSta(Save);
        try
        {
            RunSta(() =>
            {
                Retry(() => Clipboard.SetDataObject(new DataObject(DataFormats.UnicodeText, text), true));
                return true;
            });
        }
        catch (ClipboardUnavailableException)
        {
            TryRestore(saved);
            throw;
        }

        Exception? pasteError = null;
        try
        {
            paste();
            Thread.Sleep(PasteSettle);
        }
        catch (Exception error) { pasteError = error; }

        var restored = TryRestore(saved);
        if (pasteError is not null) ExceptionDispatchInfo.Capture(pasteError).Throw();
        return restored;
    }

    private static bool TryRestore(List<(string Format, object Data)> saved)
    {
        try
        {
            return RunSta(() =>
            {
                Restore(saved);
                return true;
            });
        }
        catch (ClipboardUnavailableException) { return false; }
    }

    private static List<(string Format, object Data)> Save()
    {
        var saved = new List<(string, object)>();
        var current = Retry(Clipboard.GetDataObject);
        if (current is null) return saved;
        foreach (var format in current.GetFormats(false))
        {
            try
            {
                var data = current.GetData(format, false);
                if (data is not null) saved.Add((format, data));
            }
            catch { } // Formats that cannot be read (delayed rendering, private handles) are skipped.
        }
        return saved;
    }

    private static void Restore(List<(string Format, object Data)> saved)
    {
        if (saved.Count == 0)
        {
            Retry(() => Clipboard.Clear());
            return;
        }
        var data = new DataObject();
        foreach (var (format, value) in saved)
        {
            try { data.SetData(format, false, value); }
            catch { }
        }
        Retry(() => Clipboard.SetDataObject(data, true));
    }

    private static void Retry(Action action) => Retry(() =>
    {
        action();
        return true;
    });

    private static T Retry<T>(Func<T> action)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { return action(); }
            catch (ExternalException) when (attempt < Attempts) { Thread.Sleep(RetryDelay); }
            catch (ExternalException error) { throw new ClipboardUnavailableException("A área de transferência está ocupada.", error); }
        }
    }

    private static T RunSta<T>(Func<T> action)
    {
        T result = default!;
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { result = action(); }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();
        if (!thread.Join(ThreadTimeout))
            throw new ClipboardUnavailableException("A área de transferência não respondeu a tempo.");
        if (failure is ClipboardUnavailableException) throw failure;
        if (failure is not null) throw new ClipboardUnavailableException("Falha ao acessar a área de transferência.", failure);
        return result;
    }
}
