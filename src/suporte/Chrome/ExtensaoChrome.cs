using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AgentCode.Suporte;

/// <summary>
/// A extensão do Chrome que o exe leva dentro dele: os mesmos arquivos de
/// <c>src/chromeExtension</c> (embutidos por referência), gravados numa pasta do
/// cliente só enquanto a sessão dura, com um <c>config.js</c> de token novo.
/// </summary>
internal static partial class ExtensaoChrome
{
    /// <summary>As portas de <c>src/main/chromeBridge/protocol.ts</c>.</summary>
    internal static readonly int[] Portas = [47831, 47832, 47833, 47834, 47835];

    /// <summary>Nome do cartão em chrome://extensions: o cliente reconhece de onde veio.</summary>
    internal const string Nome = "Agent Code Suporte";

    private const string Prefixo = "extensao/";
    private static readonly JsonSerializerOptions Legivel = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    [GeneratedRegex("\"token\"\\s*:\\s*\"([0-9a-f]{32})\"")]
    private static partial Regex TokenNoConfig();

    /// <summary>Pasta do suporte no PC do cliente; existe só durante a sessão.</summary>
    internal static string Raiz
        => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentCodeSuporte");

    internal static string PastaPadrao => Path.Combine(Raiz, "chrome-extension");

    /// <summary>Versão do manifest embutido; é a que a ponte devolve no <c>welcome</c>.</summary>
    internal static string Versao { get; } = LerVersao();

    internal static string NovoToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    internal static bool TokenValido(string? token)
        => token is { Length: 32 } && token.All((c) => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    /// <summary>Os arquivos embutidos, com o caminho relativo de cada um.</summary>
    internal static IEnumerable<(string Caminho, byte[] Bytes)> Arquivos()
    {
        var montagem = Assembly.GetExecutingAssembly();
        foreach (var recurso in montagem.GetManifestResourceNames())
        {
            if (!recurso.StartsWith(Prefixo, StringComparison.Ordinal)) continue;
            var relativo = recurso[Prefixo.Length..].Replace('\\', '/');
            // Nunca um config.js de origem: o token é sempre o desta sessão.
            if (relativo.Length == 0 || relativo.Equals("config.js", StringComparison.OrdinalIgnoreCase)) continue;
            using var fluxo = montagem.GetManifestResourceStream(recurso)!;
            using var copia = new MemoryStream();
            fluxo.CopyTo(copia);
            yield return (relativo, copia.ToArray());
        }
    }

    private static string LerVersao()
    {
        var manifest = Arquivos().FirstOrDefault((arquivo) => arquivo.Caminho == "manifest.json").Bytes
            ?? throw new InvalidOperationException("A extensão do Chrome não foi embutida no exe.");
        return JsonNode.Parse(manifest)?["version"]?.GetValue<string>()
            ?? throw new InvalidOperationException("manifest.json sem version.");
    }

    /// <summary>
    /// O manifest da cópia do suporte: sem a <c>key</c> (o Chrome dá a ela outro id, e
    /// ela não toma o lugar da extensão de quem também usa o Agent Code) e com nome
    /// próprio. Permissões e código são os mesmos.
    /// </summary>
    internal static byte[] ManifestDoSuporte(byte[] original)
    {
        var manifest = JsonNode.Parse(original) as JsonObject ?? throw new InvalidOperationException("manifest.json inválido.");
        manifest.Remove("key");
        manifest["name"] = $"{Nome} — Controle do Chrome";
        manifest["short_name"] = Nome;
        manifest["description"] = "Permite que o técnico do suporte controle este Chrome durante o atendimento. Fala só com este computador e se remove ao encerrar.";
        return Encoding.UTF8.GetBytes(manifest.ToJsonString(Legivel) + "\n");
    }

    /// <summary><c>config.js</c> da sessão. <c>suporte</c> é o que libera a extensão a se remover.</summary>
    internal static string ConfigJs(string token)
        => $"self.AGENT_CODE_CONFIG = {{\"ports\":[{string.Join(",", Portas)}],\"token\":\"{token}\",\"suporte\":true}}\n";

    /// <summary>Grava a pasta inteira, do zero.</summary>
    internal static void Gravar(string pasta, string token)
    {
        if (!TokenValido(token)) throw new ArgumentException("Token da ponte do Chrome inválido.");
        Apagar(pasta);
        Directory.CreateDirectory(pasta);
        var raiz = Path.GetFullPath(pasta) + Path.DirectorySeparatorChar;
        foreach (var (caminho, bytes) in Arquivos())
        {
            var destino = Path.GetFullPath(Path.Combine(pasta, caminho));
            if (!destino.StartsWith(raiz, StringComparison.OrdinalIgnoreCase)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(destino)!);
            File.WriteAllBytes(destino, caminho == "manifest.json" ? ManifestDoSuporte(bytes) : bytes);
        }
        File.WriteAllText(Path.Combine(pasta, "config.js"), ConfigJs(token), new UTF8Encoding(false));
    }

    /// <summary>O token de uma pasta já gravada (o exe reaberto como administrador a reaproveita).</summary>
    internal static string? TokenGravado(string pasta)
    {
        try
        {
            var config = Path.Combine(pasta, "config.js");
            if (!File.Exists(config) || !File.Exists(Path.Combine(pasta, "manifest.json"))) return null;
            var achado = TokenNoConfig().Match(File.ReadAllText(config));
            return achado.Success ? achado.Groups[1].Value : null;
        }
        catch { return null; }
    }

    /// <summary>Apaga a pasta; o Chrome pode segurar um arquivo por um instante, então insiste.</summary>
    internal static bool Apagar(string pasta)
    {
        for (var tentativa = 0; tentativa < 12; tentativa++)
        {
            try
            {
                if (!Directory.Exists(pasta)) return true;
                Directory.Delete(pasta, true);
                return true;
            }
            catch { Thread.Sleep(150); }
        }
        return !Directory.Exists(pasta);
    }

    /// <summary>Remove a pasta-mãe se ficou vazia.</summary>
    internal static void ApagarRaizSeVazia(string pasta)
    {
        try
        {
            var mae = Path.GetDirectoryName(Path.GetFullPath(pasta));
            if (mae is not null && Directory.Exists(mae) && !Directory.EnumerateFileSystemEntries(mae).Any()) Directory.Delete(mae);
        }
        catch { /* outra parte do suporte ainda usa a pasta */ }
    }
}
