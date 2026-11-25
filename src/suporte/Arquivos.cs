using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace AgentCode.Suporte;

/// <summary>Caminhos que chegam do técnico: sempre completos, nunca um dispositivo.</summary>
internal static class Caminhos
{
    internal static string Resolver(string texto)
    {
        var limpo = Environment.ExpandEnvironmentVariables(texto.Trim().Trim('"'));
        if (limpo == "~" || limpo.StartsWith("~\\", StringComparison.Ordinal) || limpo.StartsWith("~/", StringComparison.Ordinal))
            limpo = Comandos.PastaPadrao + limpo[1..];
        if (limpo.Length is 0 or > 32_000 || limpo.Contains('\0')) throw new ArgumentException("Caminho inválido.");
        if (limpo.StartsWith(@"\\.\", StringComparison.Ordinal) || limpo.StartsWith(@"\\?\", StringComparison.Ordinal))
            throw new ArgumentException("Caminho de dispositivo não é aceito.");
        if (!Path.IsPathFullyQualified(limpo))
            throw new ArgumentException($"Informe o caminho completo (ex.: C:\\Users\\Nome\\arquivo.txt). Recebido: {limpo}");
        return Path.GetFullPath(limpo);
    }

    internal static string Tamanho(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} bytes",
        < 1024 * 1024 => $"{bytes / 1024.0:0.#} KB",
        _ => $"{bytes / 1048576.0:0.#} MB"
    };
}

internal sealed record TextoLido(string Conteudo, Encoding Codificacao);

/// <summary>Leitura e gravação de texto preservando a codificação que o arquivo já tinha.</summary>
internal static class Textos
{
    private static readonly Encoding Ansi = CriarAnsi();

    private static Encoding CriarAnsi()
    {
        // Arquivos antigos do Windows em português: Windows-1252.
        try
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            return Encoding.GetEncoding(1252);
        }
        catch { return Encoding.Latin1; }
    }

    internal static byte[] LerBytes(string caminho)
    {
        if (Directory.Exists(caminho)) throw new ArgumentException($"É uma pasta, não um arquivo: {caminho}");
        var info = new FileInfo(caminho);
        if (!info.Exists) throw new FileNotFoundException($"Arquivo não encontrado: {caminho}");
        if (info.Length > Contrato.ArquivoBytes)
            throw new InvalidOperationException($"Arquivo grande demais ({Caminhos.Tamanho(info.Length)}; o limite é {Caminhos.Tamanho(Contrato.ArquivoBytes)}).");
        using var fluxo = new FileStream(caminho, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var bytes = new byte[fluxo.Length];
        fluxo.ReadExactly(bytes);
        return bytes;
    }

    internal static TextoLido Ler(string caminho)
        => Decodificar(LerBytes(caminho))
            ?? throw new InvalidOperationException("O arquivo não é texto. Use remoto_arquivo_baixar para trazê-lo inteiro.");

    /// <summary>Nulo quando o conteúdo é binário.</summary>
    internal static TextoLido? Decodificar(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            return new TextoLido(Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3), new UTF8Encoding(true));
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
            return new TextoLido(Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2), Encoding.Unicode);
        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
            return new TextoLido(Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2), Encoding.BigEndianUnicode);
        if (Binario(bytes)) return null;
        try { return new TextoLido(new UTF8Encoding(false, true).GetString(bytes), new UTF8Encoding(false)); }
        catch (DecoderFallbackException) { return new TextoLido(Ansi.GetString(bytes), Ansi); }
    }

    internal static bool Binario(ReadOnlySpan<byte> bytes) => bytes[..Math.Min(bytes.Length, 8192)].Contains((byte)0);

    /// <summary>Grava com a marca de ordem de bytes própria da codificação (se ela tiver).</summary>
    internal static long Gravar(string caminho, string conteudo, Encoding codificacao)
    {
        if (Path.GetDirectoryName(caminho) is { Length: > 0 } pasta) Directory.CreateDirectory(pasta);
        File.WriteAllText(caminho, conteudo, codificacao);
        return new FileInfo(caminho).Length;
    }
}

/// <summary>Busca de arquivos por padrão (glob) sem seguir atalhos de pasta.</summary>
internal static class Busca
{
    internal const int MaximoVarridos = 300_000;

    /// <summary>
    /// Converte um glob em expressão regular sobre o caminho relativo com "/".
    /// <c>*</c> não atravessa pasta, <c>**</c> atravessa, <c>?</c> é um caractere,
    /// <c>{a,b}</c> são alternativas.
    /// </summary>
    internal static Regex Glob(string padrao)
    {
        var glob = padrao.Replace('\\', '/').TrimStart('/');
        var regex = new StringBuilder("^");
        var chaves = 0;
        for (var i = 0; i < glob.Length; i++)
        {
            var c = glob[i];
            if (c == '*' && i + 1 < glob.Length && glob[i + 1] == '*')
            {
                i++;
                if (i + 1 < glob.Length && glob[i + 1] == '/') { i++; regex.Append("(?:.*/)?"); }
                else regex.Append(".*");
            }
            else if (c == '*') regex.Append("[^/]*");
            else if (c == '?') regex.Append("[^/]");
            else if (c == '{') { chaves++; regex.Append("(?:"); }
            else if (c == '}' && chaves > 0) { chaves--; regex.Append(')'); }
            else if (c == ',' && chaves > 0) regex.Append('|');
            else regex.Append(Regex.Escape(c.ToString()));
        }
        while (chaves-- > 0) regex.Append(')');
        regex.Append('$');
        return new Regex(regex.ToString(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    }

    /// <summary>O padrão desce em subpastas?</summary>
    internal static bool Recursivo(string padrao) => padrao.Contains("**") || padrao.Replace('\\', '/').Contains('/');

    /// <summary>Arquivos de uma pasta que casam com o padrão, como (caminho completo, relativo).</summary>
    internal static IEnumerable<(string Completo, string Relativo)> Arquivos(string pasta, string padrao, CancellationToken ct)
    {
        if (!Directory.Exists(pasta)) throw new ArgumentException($"A pasta não existe: {pasta}");
        var regex = Glob(padrao);
        var opcoes = new EnumerationOptions
        {
            RecurseSubdirectories = Recursivo(padrao),
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint,
            ReturnSpecialDirectories = false
        };
        var varridos = 0;
        foreach (var completo in Directory.EnumerateFiles(pasta, "*", opcoes))
        {
            ct.ThrowIfCancellationRequested();
            if (++varridos > MaximoVarridos) yield break;
            var relativo = Path.GetRelativePath(pasta, completo).Replace('\\', '/');
            if (regex.IsMatch(relativo)) yield return (completo, relativo);
        }
    }
}
