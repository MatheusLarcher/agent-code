using System.IO;
using System.IO.Compression;
using System.Net.Http;

namespace AgentCode.Suporte;

/// <summary>
/// De onde vem o <c>adb</c> e quem o assina. Fixo no exe: nenhum argumento e nenhuma
/// variável troca isto. Só o autoteste passa outra origem, por código.
/// </summary>
internal sealed record OrigemDoAdb(string Url, string Organizacao)
{
    internal static readonly OrigemDoAdb Oficial =
        new("https://dl.google.com/android/repository/platform-tools-latest-windows.zip", "Google LLC");
}

/// <summary>
/// As ferramentas do Google (<c>platform-tools</c>) na pasta da sessão: baixa o zip
/// oficial, extrai só o <c>adb</c> e as duas bibliotecas dele, e confere a assinatura
/// digital de cada arquivo antes de qualquer uso.
/// </summary>
internal static class PlatformTools
{
    internal const string Adb = "adb.exe";
    internal static readonly string[] Arquivos = [Adb, "AdbWinApi.dll", "AdbWinUsbApi.dll"];
    private const string PastaNoZip = "platform-tools/";
    private const long ZipMaximo = 120L * 1024 * 1024;
    private const long ArquivoMaximo = 60L * 1024 * 1024;
    private static readonly TimeSpan PrazoDoDownload = TimeSpan.FromMinutes(4);

    internal static string PastaPadrao => Path.Combine(ExtensaoChrome.Raiz, "platform-tools");

    internal static bool Presentes(string pasta) => Arquivos.All((nome) => File.Exists(Path.Combine(pasta, nome)));

    /// <summary>Baixa o zip e deixa na pasta só os três arquivos. Nada é executado aqui.</summary>
    internal static async Task BaixarAsync(OrigemDoAdb origem, string pasta, CancellationToken ct)
    {
        Directory.CreateDirectory(pasta);
        var zip = Path.Combine(pasta, "baixado.zip");
        try
        {
            using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
            prazo.CancelAfter(PrazoDoDownload);
            try
            {
                using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
                using var resposta = await http.GetAsync(origem.Url, HttpCompletionOption.ResponseHeadersRead, prazo.Token);
                if (!resposta.IsSuccessStatusCode)
                    throw new InvalidOperationException($"O download das ferramentas do Google falhou (HTTP {(int)resposta.StatusCode}).");
                await using var entrada = await resposta.Content.ReadAsStreamAsync(prazo.Token);
                await using var saida = new FileStream(zip, FileMode.Create, FileAccess.Write, FileShare.None);
                await CopiarAsync(entrada, saida, ZipMaximo, "o download", prazo.Token);
            }
            catch (HttpRequestException erro)
            {
                throw new InvalidOperationException($"Sem acesso ao endereço das ferramentas do Google: {erro.Message}");
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new InvalidOperationException("O download das ferramentas do Google demorou demais e foi cancelado.");
            }

            try
            {
                using var arquivo = ZipFile.OpenRead(zip);
                foreach (var nome in Arquivos)
                {
                    // O destino é sempre um nome fixo: o caminho de dentro do zip nunca é usado.
                    var item = arquivo.Entries.FirstOrDefault((e) =>
                            e.FullName.Replace('\\', '/').Equals(PastaNoZip + nome, StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException($"O pacote baixado não traz {nome}.");
                    await using var origemDoItem = item.Open();
                    await using var destino = new FileStream(Path.Combine(pasta, nome), FileMode.Create, FileAccess.Write, FileShare.None);
                    await CopiarAsync(origemDoItem, destino, ArquivoMaximo, nome, ct);
                }
            }
            catch (InvalidDataException)
            {
                throw new InvalidOperationException("O arquivo baixado não é um pacote válido.");
            }
        }
        finally
        {
            try { File.Delete(zip); } catch { /* some com a pasta */ }
        }
    }

    private static async Task CopiarAsync(Stream origem, Stream destino, long maximo, string oQue, CancellationToken ct)
    {
        var buffer = new byte[81920];
        long total = 0;
        int lido;
        while ((lido = await origem.ReadAsync(buffer, ct)) > 0)
        {
            total += lido;
            if (total > maximo) throw new InvalidOperationException($"Tamanho inesperado em {oQue}: passou de {maximo / (1024 * 1024)} MB.");
            await destino.WriteAsync(buffer.AsMemory(0, lido), ct);
        }
    }

    /// <summary>
    /// Abre os três arquivos de um jeito que ninguém os troca nem apaga enquanto a sessão
    /// os usa e, com eles já presos, confere a assinatura digital de cada um. Se um não
    /// passar, solta todos e explica qual.
    /// </summary>
    internal static FileStream[] TravarEConferir(string pasta, string organizacao)
    {
        var presos = new List<FileStream>();
        try
        {
            foreach (var nome in Arquivos)
            {
                var caminho = Path.Combine(pasta, nome);
                presos.Add(new FileStream(caminho, FileMode.Open, FileAccess.Read, FileShare.Read));
                if (!Assinatura.Confere(caminho, organizacao, out var motivo))
                    throw new InvalidOperationException($"{nome} não passou na conferência da assinatura digital ({motivo}). Nada foi usado.");
            }
            return [.. presos];
        }
        catch
        {
            foreach (var preso in presos) preso.Dispose();
            throw;
        }
    }
}
