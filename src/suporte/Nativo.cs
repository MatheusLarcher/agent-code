using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentCode.Suporte;

/// <summary>Chamadas do Windows que o exe usa além das do controle local.</summary>
internal static class Nativo
{
    internal const uint GA_ROOT = 2;
    internal const uint PW_RENDERFULLCONTENT = 2;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_ROUND = 2;
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

    [StructLayout(LayoutKind.Sequential)]
    internal struct Ponto { internal int X; internal int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        internal uint Size;
        internal nint Hwnd;
        internal uint Flags;
        internal uint Count;
        internal uint Timeout;
    }

    [DllImport("user32.dll")]
    private static extern nint WindowFromPoint(Ponto ponto);

    [DllImport("user32.dll")]
    private static extern nint GetAncestor(nint hwnd, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool PrintWindow(nint hwnd, nint hdc, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlashWindowEx(ref FlashInfo info);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, int attribute, ref int value, int size);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AttachConsole(int processId);

    [DllImport("shell32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsUserAnAdmin();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeClientProcessId(nint pipe, out uint processId);

    /// <summary>A janela (ou a raiz dela) pertence a este processo?</summary>
    internal static bool EhNossa(nint hwnd)
    {
        if (hwnd == 0) return false;
        AgentCode.WindowsControl.NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
        return pid == (uint)Environment.ProcessId;
    }

    /// <summary>O ponto da tela cai numa janela deste processo (janela, barra pequena, registro)?</summary>
    internal static bool PontoEhNosso(System.Drawing.Point ponto)
    {
        var hwnd = WindowFromPoint(new Ponto { X = ponto.X, Y = ponto.Y });
        if (hwnd == 0) return false;
        var raiz = GetAncestor(hwnd, GA_ROOT);
        return EhNossa(raiz == 0 ? hwnd : raiz);
    }

    /// <summary>Pisca o botão da janela na barra de tarefas até ela ganhar o foco.</summary>
    internal static void Piscar(nint hwnd)
    {
        const uint FLASHW_ALL = 3, FLASHW_TIMERNOFG = 12;
        var info = new FlashInfo
        {
            Size = (uint)Marshal.SizeOf<FlashInfo>(), Hwnd = hwnd, Flags = FLASHW_ALL | FLASHW_TIMERNOFG, Count = 6
        };
        FlashWindowEx(ref info);
    }

    /// <summary>Cantos arredondados e moldura escura (Windows 11; ignorado no 10).</summary>
    internal static void Arredondar(nint hwnd)
    {
        var redondo = DWMWCP_ROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref redondo, sizeof(int));
        var escuro = 1;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref escuro, sizeof(int));
    }

    internal static bool EhAdministrador()
    {
        try { return IsUserAnAdmin(); } catch { return false; }
    }

    // ---- Área de transferência ------------------------------------------------

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenClipboard(nint dono);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll")]
    private static extern nint SetClipboardData(uint formato, nint memoria);

    [DllImport("kernel32.dll")]
    private static extern nint GlobalAlloc(uint opcoes, nuint bytes);

    [DllImport("kernel32.dll")]
    private static extern nint GlobalLock(nint memoria);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalUnlock(nint memoria);

    [DllImport("kernel32.dll")]
    private static extern nint GlobalFree(nint memoria);

    /// <summary>
    /// Copia um texto. Usa a área de transferência direta do Windows, com novas
    /// tentativas: outro programa costuma segurá-la por alguns milissegundos.
    /// </summary>
    internal static bool CopiarTexto(nint janela, string texto)
    {
        const uint CF_UNICODETEXT = 13, GMEM_MOVEABLE = 2;
        for (var tentativa = 0; tentativa < 12; tentativa++)
        {
            if (!OpenClipboard(janela))
            {
                Thread.Sleep(25);
                continue;
            }
            try
            {
                EmptyClipboard();
                var memoria = GlobalAlloc(GMEM_MOVEABLE, (nuint)((texto.Length + 1) * sizeof(char)));
                if (memoria == 0) return false;
                var destino = GlobalLock(memoria);
                if (destino == 0)
                {
                    GlobalFree(memoria);
                    return false;
                }
                Marshal.Copy(texto.ToCharArray(), 0, destino, texto.Length);
                Marshal.WriteInt16(destino, texto.Length * sizeof(char), 0);
                GlobalUnlock(memoria);
                // Se o Windows aceitar, a memória passa a ser dele.
                if (SetClipboardData(CF_UNICODETEXT, memoria) != 0) return true;
                GlobalFree(memoria);
                return false;
            }
            finally { CloseClipboard(); }
        }
        return false;
    }

    // ---- Memória ------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        internal uint Length;
        internal uint MemoryLoad;
        internal ulong TotalPhys;
        internal ulong AvailPhys;
        internal ulong TotalPageFile;
        internal ulong AvailPageFile;
        internal ulong TotalVirtual;
        internal ulong AvailVirtual;
        internal ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx status);

    internal static (ulong Total, ulong Livre) Memoria()
    {
        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        return GlobalMemoryStatusEx(ref status) ? (status.TotalPhys, status.AvailPhys) : (0, 0);
    }

    // ---- Job: mata a árvore dos comandos quando o exe sai --------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicLimit
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal nuint MinimumWorkingSetSize;
        internal nuint MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal nuint Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobExtendedLimit
    {
        internal JobBasicLimit Basic;
        internal IoCounters Io;
        internal nuint ProcessMemoryLimit;
        internal nuint JobMemoryLimit;
        internal nuint PeakProcessMemoryUsed;
        internal nuint PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern nint CreateJobObject(nint attributes, string? name);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(nint job, int infoClass, ref JobExtendedLimit info, int length);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(nint job, nint process);

    /// <summary>
    /// Job que encerra tudo o que estiver nele quando o último identificador fecha —
    /// isto é, quando este exe termina, mesmo que seja derrubado.
    /// </summary>
    internal static nint CriarJob()
    {
        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        var job = CreateJobObject(0, null);
        if (job == 0) return 0;
        var info = new JobExtendedLimit { Basic = new JobBasicLimit { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } };
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf<JobExtendedLimit>());
        return job;
    }

    internal static void PorNoJob(nint job, Process processo)
    {
        if (job == 0) return;
        try { AssignProcessToJobObject(job, processo.Handle); } catch { /* já saiu */ }
    }

    // ---- Caminho do executável de outro processo ------------------------------

    [DllImport("kernel32.dll")]
    private static extern nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(nint process, uint flags, StringBuilder name, ref int size);

    /// <summary>Caminho do exe de um processo, inclusive elevado (acesso limitado basta).</summary>
    internal static string? CaminhoDoProcesso(uint pid)
    {
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == 0) return null;
        try
        {
            var buffer = new StringBuilder(1024);
            var tamanho = buffer.Capacity;
            return QueryFullProcessImageName(handle, 0, buffer, ref tamanho) ? buffer.ToString() : null;
        }
        finally { CloseHandle(handle); }
    }
}
