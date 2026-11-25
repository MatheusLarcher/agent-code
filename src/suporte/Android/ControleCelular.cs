using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace AgentCode.Suporte;

internal sealed record SaidaAdb(int? Codigo, byte[] Saida, string Erro, bool TempoEsgotado, bool Cortada = false)
{
    internal string Texto => Encoding.UTF8.GetString(Saida);
}

/// <summary>Quem roda o <c>adb</c>. No exe é o processo de verdade; o autoteste passa um falso que anota os argumentos.</summary>
internal delegate Task<SaidaAdb> ExecutorAdb(IReadOnlyList<string> argumentos, int prazoMs, int limiteBytes, CancellationToken ct);

/// <summary>
/// O recurso "Celular" de uma sessão: no Permitir baixa as ferramentas do Google para
/// a pasta da sessão e confere a assinatura; ao encerrar (ou na chave desligada) para
/// o <c>adb</c> e apaga a pasta. O servidor do <c>adb</c> roda numa porta só desta
/// sessão. A chave de pareamento o <c>adb</c> grava sempre na pasta do usuário
/// (<c>.android</c>): se ela nasceu nesta sessão, some junto; se já existia, fica.
/// </summary>
internal sealed class ControleCelular(string? pasta = null, OrigemDoAdb? origem = null, ExecutorAdb? adbFalso = null, string? pastaDaChave = null, Func<bool>? liberado = null) : IDisposable
{
    private const string Marca = "chave-da-sessao";
    private static readonly string[] ArquivosDaChave = ["adbkey", "adbkey.pub"];
    private static readonly string[] VariaveisSoltas =
        ["ANDROID_SERIAL", "ADB_VENDOR_KEYS", "ADB_TRACE", "ADB_SERVER_SOCKET", "ADB_LIBUSB"];

    /// <summary>Onde o <c>adb</c> guarda a chave de pareamento no Windows (não há como mudar).</summary>
    internal static string ChavePadrao => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".android");

    // Com o adb falso do autoteste, a pasta do usuário de verdade nunca entra na conta.
    private readonly string? pastaDaChave = pastaDaChave ?? (adbFalso is null ? ChavePadrao : null);

    private readonly SemaphoreSlim trava = new(1, 1);
    private readonly OrigemDoAdb origem = origem ?? OrigemDoAdb.Oficial;
    private readonly ConcurrentDictionary<string, (int Largura, int Altura)> telas = new();
    private FileStream[] presos = [];
    private nint job;
    private int porta;
    private volatile bool pronto;
    private volatile bool servidor;

    internal string Pasta { get; } = pasta ?? PlatformTools.PastaPadrao;
    private string Temporaria => Path.Combine(Pasta, "tmp");
    internal bool Pronto => pronto;

    /// <summary>Ferramentas baixadas, conferidas e presas (uma vez por sessão). Nada é executado aqui.</summary>
    internal async Task GarantirAsync(CancellationToken ct)
    {
        if (pronto) return;
        await trava.WaitAsync(ct);
        try
        {
            if (pronto) return;
            // Uma chamada que chegou junto com a chave desligada ou com o Encerrar não prepara nada de novo.
            if (liberado is not null && !liberado()) throw new InvalidOperationException("O cliente desligou este recurso.");
            if (adbFalso is null)
            {
                try
                {
                    if (!PlatformTools.Presentes(Pasta)) await PlatformTools.BaixarAsync(origem, Pasta, ct);
                    presos = PlatformTools.TravarEConferir(Pasta, origem.Organizacao);
                }
                catch
                {
                    // Baixado pela metade ou sem a assinatura esperada: nada fica no PC.
                    ExtensaoChrome.Apagar(Pasta);
                    ExtensaoChrome.ApagarRaizSeVazia(Pasta);
                    throw;
                }
                job = Nativo.CriarJob();
                porta = PortaLivre();
            }
            pronto = true;
        }
        finally { trava.Release(); }
    }

    /// <summary>Roda o <c>adb</c> com estes argumentos (prepara e sobe o servidor no primeiro uso).</summary>
    internal async Task<SaidaAdb> AdbAsync(IReadOnlyList<string> argumentos, int prazoMs, int limiteBytes, CancellationToken ct)
    {
        await GarantirAsync(ct);
        if (!servidor)
        {
            await trava.WaitAsync(ct);
            try
            {
                if (!pronto) throw new InvalidOperationException("O controle do celular foi desligado.");
                if (!servidor)
                {
                    MarcarChave();
                    if (adbFalso is null) Directory.CreateDirectory(Temporaria); // o registro do adb fica na pasta da sessão
                    // À parte: o servidor que nasce aqui não fica segurando a saída de um comando.
                    var subiu = await Executar(["start-server"], 30_000, 64 * 1024, ct);
                    if (subiu.Codigo != 0)
                        throw new InvalidOperationException($"O adb não iniciou: {Resultado.Encurtar($"{subiu.Erro} {subiu.Texto}", 300)}");
                    servidor = true;
                }
            }
            finally { trava.Release(); }
        }
        return await Executar(argumentos, prazoMs, limiteBytes, ct);
    }

    private Task<SaidaAdb> Executar(IReadOnlyList<string> argumentos, int prazoMs, int limiteBytes, CancellationToken ct)
        => adbFalso is not null ? adbFalso(argumentos, prazoMs, limiteBytes, ct) : RodarAsync(argumentos, prazoMs, limiteBytes, ct);

    private async Task<SaidaAdb> RodarAsync(IReadOnlyList<string> argumentos, int prazoMs, int limiteBytes, CancellationToken ct)
    {
        var info = new ProcessStartInfo
        {
            FileName = Path.Combine(Pasta, PlatformTools.Adb),
            WorkingDirectory = Pasta,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argumento in argumentos) info.ArgumentList.Add(argumento);
        var ambiente = info.Environment;
        foreach (var solta in VariaveisSoltas) ambiente.Remove(solta);
        ambiente["ANDROID_ADB_SERVER_PORT"] = porta.ToString(CultureInfo.InvariantCulture); // nunca o servidor de outro programa
        ambiente["ADB_MDNS"] = "0"; // só USB: sem procurar aparelhos na rede
        ambiente["ADB_MDNS_OPENSCREEN"] = "0";
        ambiente["TEMP"] = Temporaria;
        ambiente["TMP"] = Temporaria;

        Process? iniciado;
        try { iniciado = Process.Start(info); }
        // A pasta sumiu no meio do caminho (chave desligada ou sessão encerrada): nada é recriado.
        catch (System.ComponentModel.Win32Exception) { throw new InvalidOperationException("O controle do celular foi desligado."); }
        using var processo = iniciado ?? throw new InvalidOperationException("O Windows não iniciou o adb.");
        Nativo.PorNoJob(job, processo);
        processo.StandardInput.Close();
        var saida = new MemoryStream();
        var cortada = false;
        var erro = new SaidaLimitada(16 * 1024);
        var bombas = Task.WhenAll(
            Task.Run(async () =>
            {
                var buffer = new byte[64 * 1024];
                try
                {
                    int lido;
                    while ((lido = await processo.StandardOutput.BaseStream.ReadAsync(buffer)) > 0)
                    {
                        lock (saida)
                        {
                            var cabe = (int)Math.Min(lido, limiteBytes - saida.Length);
                            if (cabe > 0) saida.Write(buffer, 0, cabe);
                            if (cabe < lido) cortada = true; // segue lendo, para o adb não travar no cano cheio
                        }
                    }
                }
                catch { /* processo encerrado */ }
            }),
            Task.Run(async () =>
            {
                var buffer = new byte[8 * 1024];
                try
                {
                    int lido;
                    while ((lido = await processo.StandardError.BaseStream.ReadAsync(buffer)) > 0) erro.Acrescentar(buffer.AsSpan(0, lido));
                }
                catch { /* processo encerrado */ }
            }));

        var esgotou = false;
        using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
        prazo.CancelAfter(prazoMs);
        try { await processo.WaitForExitAsync(prazo.Token); }
        catch (OperationCanceledException)
        {
            // Só o cliente do adb: o servidor é filho dele e segue para os próximos comandos.
            try { if (!processo.HasExited) processo.Kill(); } catch { /* já saiu */ }
            ct.ThrowIfCancellationRequested();
            esgotou = true;
        }
        await Task.WhenAny(bombas, Task.Delay(1500, CancellationToken.None));
        byte[] bytes;
        lock (saida) bytes = saida.ToArray();
        return new SaidaAdb(esgotou ? null : processo.ExitCode, bytes, erro.Texto().Trim(), esgotou, cortada);
    }

    private static int PortaLivre()
    {
        var escuta = new TcpListener(IPAddress.Loopback, 0);
        escuta.Start();
        try { return ((IPEndPoint)escuta.LocalEndpoint).Port; }
        finally { escuta.Stop(); }
    }

    // ---- Tela do aparelho: o tamanho da última captura, para as coordenadas 0..1 -----

    internal void GuardarTela(string serial, int largura, int altura) => telas[serial] = (largura, altura);

    internal (int Largura, int Altura)? Tela(string serial) => telas.TryGetValue(serial, out var tela) ? tela : null;

    /// <summary>Há um <c>adb</c> de outro programa aberto no PC: ele pode estar segurando o aparelho.</summary>
    internal bool HaOutroAdb() => DoAdb((caminho) => caminho is null || !DaPasta(caminho)).Count > 0;

    private bool DaPasta(string caminho)
        => caminho.StartsWith(Pasta.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);

    private static List<int> DoAdb(Func<string?, bool> filtro)
    {
        var achados = new List<int>();
        try
        {
            foreach (var processo in Process.GetProcessesByName("adb"))
            {
                using (processo)
                {
                    if (filtro(Nativo.CaminhoDoProcesso((uint)processo.Id))) achados.Add(processo.Id);
                }
            }
        }
        catch { /* sem acesso à lista de processos */ }
        return achados;
    }

    // ---- Chave de pareamento ----------------------------------------------------------

    /// <summary>
    /// Antes de o <c>adb</c> subir pela primeira vez: se o PC ainda não tem a chave de
    /// pareamento, a que nascer agora é desta sessão. A marca fica na pasta da sessão,
    /// para o exe reaberto como administrador também saber.
    /// </summary>
    private void MarcarChave()
    {
        if (pastaDaChave is null) return;
        try
        {
            if (ArquivosDaChave.Any((nome) => File.Exists(Path.Combine(pastaDaChave, nome)))) return;
            Directory.CreateDirectory(Pasta);
            File.WriteAllText(Path.Combine(Pasta, Marca), Directory.Exists(pastaDaChave) ? "arquivos" : "pasta");
        }
        catch { /* sem a marca, a chave é tratada como do cliente e fica */ }
    }

    /// <summary>
    /// Apaga a chave de pareamento que esta sessão fez o <c>adb</c> criar (e a pasta
    /// <c>.android</c>, se também nasceu aqui e ficou vazia). Sem a marca, não toca em nada.
    /// </summary>
    internal static void ApagarChaveDaSessao(string pasta, string pastaDaChave)
    {
        try
        {
            var marca = Path.Combine(pasta, Marca);
            if (!File.Exists(marca)) return;
            var criouAPasta = File.ReadAllText(marca).Trim() == "pasta";
            foreach (var nome in ArquivosDaChave)
            {
                try { File.Delete(Path.Combine(pastaDaChave, nome)); } catch { /* em uso: fica */ }
            }
            if (criouAPasta && Directory.Exists(pastaDaChave) && !Directory.EnumerateFileSystemEntries(pastaDaChave).Any()) Directory.Delete(pastaDaChave);
            File.Delete(marca);
        }
        catch { /* o que der para desfazer */ }
    }

    // ---- Desfazer ------------------------------------------------------------------

    /// <summary>Para o <c>adb</c> desta sessão e apaga a pasta. O <c>adb</c> de outros programas não é tocado.</summary>
    internal async Task LimparAsync()
    {
        await trava.WaitAsync();
        try
        {
            var estava = pronto;
            pronto = false;
            telas.Clear();
            if (!estava && !Directory.Exists(Pasta)) return; // o recurso nem chegou a ser usado
            if (estava && servidor)
            {
                try { await Executar(["kill-server"], 5000, 4096, CancellationToken.None); } catch { /* o job encerra o que sobrar */ }
            }
            servidor = false;
            Soltar(apagar: true);
        }
        finally { trava.Release(); }
    }

    /// <summary>O exe elevado assumiu a sessão: este para o próprio <c>adb</c> e deixa a pasta como está.</summary>
    internal void Largar()
    {
        pronto = false;
        servidor = false;
        Soltar(apagar: false);
    }

    private void Soltar(bool apagar)
    {
        Nativo.FecharJob(job); // encerra cliente e servidor do adb que ainda rodem
        job = 0;
        foreach (var preso in presos) preso.Dispose();
        presos = [];
        if (!apagar) return;
        // Um servidor que tenha escapado do job: só os que rodam de dentro desta pasta.
        foreach (var pid in adbFalso is null ? DoAdb((caminho) => caminho is not null && DaPasta(caminho)) : [])
        {
            try
            {
                using var processo = Process.GetProcessById(pid);
                processo.Kill();
                processo.WaitForExit(2000);
            }
            catch { /* já saiu */ }
        }
        if (pastaDaChave is not null) ApagarChaveDaSessao(Pasta, pastaDaChave);
        ExtensaoChrome.Apagar(Pasta);
        ExtensaoChrome.ApagarRaizSeVazia(Pasta);
    }

    public void Dispose()
    {
        if (!pronto && job == 0 && presos.Length == 0) return;
        pronto = false;
        servidor = false;
        Soltar(apagar: true);
    }
}
