using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace AgentCode.Suporte;

/// <summary>
/// Guarda a saída de um comando até o limite combinado: o começo e o fim, com aviso
/// do que foi cortado no meio. Em bytes, como o limite do contrato.
/// </summary>
internal sealed class SaidaLimitada(int limite)
{
    private readonly int metade = limite / 2;
    private readonly MemoryStream inicio = new();
    private byte[] fim = [];
    private long total;

    internal void Acrescentar(ReadOnlySpan<byte> dados)
    {
        lock (inicio)
        {
            total += dados.Length;
            var cabe = (int)Math.Min(dados.Length, metade - inicio.Length);
            if (cabe > 0) inicio.Write(dados[..cabe]);
            var resto = dados[cabe..];
            if (resto.Length == 0) return;
            var junto = new byte[Math.Min(metade, fim.Length + resto.Length)];
            var doFim = junto.Length - Math.Min(junto.Length, resto.Length);
            fim.AsSpan(fim.Length - doFim).CopyTo(junto);
            resto[^(junto.Length - doFim)..].CopyTo(junto.AsSpan(doFim));
            fim = junto;
        }
    }

    internal bool Vazia { get { lock (inicio) return total == 0; } }

    /// <summary>O texto guardado; <paramref name="esvaziar"/> zera para a próxima leitura.</summary>
    internal string Texto(bool esvaziar = false)
    {
        lock (inicio)
        {
            var cabeca = Encoding.UTF8.GetString(inicio.GetBuffer(), 0, (int)inicio.Length);
            var cortado = total - inicio.Length - fim.Length;
            // O fim pode começar no meio de um caractere: pula os bytes de continuação.
            var pulo = 0;
            if (cortado > 0) while (pulo < fim.Length && (fim[pulo] & 0xC0) == 0x80) pulo++;
            var cauda = Encoding.UTF8.GetString(fim, pulo, fim.Length - pulo);
            var texto = cortado > 0
                ? $"{cabeca}\n\n[... saída cortada: {cortado / 1024.0:0.#} KB omitidos do meio ...]\n\n{cauda}"
                : cabeca + cauda;
            if (esvaziar)
            {
                inicio.SetLength(0);
                fim = [];
                total = 0;
            }
            return texto;
        }
    }
}

internal sealed record ResultadoComando(int? Codigo, string Saida, bool TempoEsgotado, long DuracaoMs);

/// <summary>
/// Roda PowerShell no PC do cliente: saída em UTF-8, tempo limite, corte de saída e
/// encerramento da árvore de processos ao cancelar, ao desligar o recurso e ao fim da
/// sessão. Os processos ficam num job que o Windows encerra se este exe sair.
/// </summary>
internal sealed class Comandos : IDisposable
{
    private const int MaximoEmSegundoPlano = 8;
    // Uma linha só, para o número da linha de um erro ficar a 1 do que o técnico mandou.
    private const string Preambulo =
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$ProgressPreference='SilentlyContinue'";
    private const string Rodape =
        "$__ok=$?;if($null -ne $LASTEXITCODE){exit $LASTEXITCODE};if(-not $__ok){exit 1}";

    private sealed class EmFundo(Process processo, SaidaLimitada saida, string resumo)
    {
        internal Process Processo { get; } = processo;
        internal SaidaLimitada Saida { get; } = saida;
        internal string Resumo { get; } = resumo;
        internal Stopwatch Tempo { get; } = Stopwatch.StartNew();
    }

    private readonly nint job = Nativo.CriarJob();
    private readonly string pasta = Path.Combine(Path.GetTempPath(), $"AgentCodeSuporte-{Environment.ProcessId}");
    private readonly ConcurrentDictionary<string, EmFundo> emFundo = new();
    private readonly ConcurrentDictionary<int, Process> vivos = new();
    private int sequencia;

    internal string PastaTemporaria => pasta;

    internal static string PastaPadrao => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    private (Process Processo, Task Bombas, string Roteiro) Iniciar(string comando, string? onde, SaidaLimitada saida)
    {
        var trabalho = string.IsNullOrWhiteSpace(onde) ? PastaPadrao : Caminhos.Resolver(onde);
        if (!Directory.Exists(trabalho)) throw new ArgumentException($"A pasta não existe: {trabalho}");
        Directory.CreateDirectory(pasta);
        var roteiro = Path.Combine(pasta, $"c{Interlocked.Increment(ref sequencia)}.ps1");
        File.WriteAllText(roteiro, $"{Preambulo}\n{comando}\n{Rodape}\n", new UTF8Encoding(true));

        var info = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
            WorkingDirectory = trabalho,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var argumento in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-File", roteiro })
            info.ArgumentList.Add(argumento);

        var processo = Process.Start(info) ?? throw new InvalidOperationException("O Windows não iniciou o PowerShell.");
        Nativo.PorNoJob(job, processo);
        vivos[processo.Id] = processo;
        processo.StandardInput.Close(); // nada fica esperando digitação
        var bombas = Task.WhenAll(
            Bombear(processo.StandardOutput.BaseStream, saida),
            Bombear(processo.StandardError.BaseStream, saida));
        return (processo, bombas, roteiro);
    }

    private static async Task Bombear(Stream origem, SaidaLimitada destino)
    {
        var buffer = new byte[16 * 1024];
        try
        {
            int lido;
            while ((lido = await origem.ReadAsync(buffer)) > 0) destino.Acrescentar(buffer.AsSpan(0, lido));
        }
        catch { /* processo encerrado */ }
    }

    internal async Task<ResultadoComando> ExecutarAsync(string comando, string? onde, int tempoLimiteMs, CancellationToken ct)
    {
        var saida = new SaidaLimitada(Contrato.SaidaBytes);
        var relogio = Stopwatch.StartNew();
        var (processo, bombas, roteiro) = Iniciar(comando, onde, saida);
        var esgotou = false;
        try
        {
            using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
            prazo.CancelAfter(tempoLimiteMs);
            try { await processo.WaitForExitAsync(prazo.Token); }
            catch (OperationCanceledException)
            {
                Matar(processo);
                ct.ThrowIfCancellationRequested();
                esgotou = true;
            }
            // Um neto pode segurar o cano aberto depois de o PowerShell sair: não espera para sempre.
            await Task.WhenAny(bombas, Task.Delay(1500, CancellationToken.None));
            return new ResultadoComando(esgotou ? null : processo.ExitCode, saida.Texto(), esgotou, relogio.ElapsedMilliseconds);
        }
        finally
        {
            Matar(processo);
            vivos.TryRemove(processo.Id, out _);
            processo.Dispose();
            Apagar(roteiro);
        }
    }

    /// <summary>Inicia em segundo plano; a saída se lê aos poucos com <see cref="Ler"/>.</summary>
    internal string IniciarEmFundo(string comando, string? onde)
    {
        foreach (var (chave, velho) in emFundo)
        {
            if (velho.Processo.HasExited && velho.Saida.Vazia && emFundo.Count > MaximoEmSegundoPlano) Esquecer(chave);
        }
        if (emFundo.Values.Count((item) => !item.Processo.HasExited) >= MaximoEmSegundoPlano)
            throw new InvalidOperationException($"Já há {MaximoEmSegundoPlano} processos em segundo plano; pare algum com remoto_processo_parar.");
        var saida = new SaidaLimitada(Contrato.SaidaBytes);
        var (processo, _, roteiro) = Iniciar(comando, onde, saida);
        var id = $"p{processo.Id}";
        emFundo[id] = new EmFundo(processo, saida, Resultado.Encurtar(comando, 80));
        _ = processo.WaitForExitAsync().ContinueWith((_) => Apagar(roteiro), TaskScheduler.Default);
        return id;
    }

    /// <summary>Saída nova desde a última leitura e a situação do processo.</summary>
    internal async Task<(string Saida, string Situacao, bool Terminou)> Ler(string id, int aguardarMs, CancellationToken ct)
    {
        if (!emFundo.TryGetValue(id, out var item))
            throw new ArgumentException($"Processo desconhecido: {id}. Só existem os iniciados com segundoPlano nesta sessão.");
        if (aguardarMs > 0 && !item.Processo.HasExited)
        {
            using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
            prazo.CancelAfter(aguardarMs);
            try { await item.Processo.WaitForExitAsync(prazo.Token); }
            catch (OperationCanceledException) { ct.ThrowIfCancellationRequested(); }
        }
        var terminou = item.Processo.HasExited;
        if (terminou) await Task.Delay(150, ct); // deixa a última saída chegar
        var texto = item.Saida.Texto(esvaziar: true);
        var situacao = terminou
            ? $"terminou · código de saída {item.Processo.ExitCode}"
            : $"rodando há {item.Tempo.Elapsed.TotalSeconds:0} s";
        if (terminou) item.Tempo.Stop();
        return (texto, situacao, terminou);
    }

    internal bool Parar(string id)
    {
        if (!emFundo.TryGetValue(id, out var item)) return false;
        Matar(item.Processo);
        return true;
    }

    private void Esquecer(string id)
    {
        if (!emFundo.TryRemove(id, out var item)) return;
        vivos.TryRemove(item.Processo.Id, out _);
        item.Processo.Dispose();
    }

    /// <summary>Fim da sessão ou recurso desligado: nada do que o técnico iniciou continua rodando.</summary>
    internal void PararTudo()
    {
        foreach (var processo in vivos.Values) Matar(processo);
        foreach (var id in emFundo.Keys) Esquecer(id);
        vivos.Clear();
    }

    private static void Matar(Process processo)
    {
        try { if (!processo.HasExited) processo.Kill(entireProcessTree: true); } catch { /* já saiu */ }
    }

    private static void Apagar(string arquivo)
    {
        try { File.Delete(arquivo); } catch { /* em uso: a pasta temporária some ao sair */ }
    }

    public void Dispose()
    {
        PararTudo();
        try { if (Directory.Exists(pasta)) Directory.Delete(pasta, recursive: true); } catch { /* ignore */ }
    }
}
