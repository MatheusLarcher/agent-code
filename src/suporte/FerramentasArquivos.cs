using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using ModelContextProtocol.Protocol;

namespace AgentCode.Suporte;

/// <summary>Ler, escrever, editar, buscar e transferir arquivos do PC do cliente.</summary>
internal static class FerramentasArquivos
{
    private const string R = Contrato.RecursoArquivos;
    private const int CaminhoMaximo = 32_000;
    private const int LinhaMaxima = 2000;
    private const int SaidaMaxima = 400_000;
    private const long ProcurarAte = 5 * 1024 * 1024;
    private const int Base64Maximo = Contrato.ArquivoBytes / 3 * 4 + 16;

    private static readonly string Caminho = Esquema.Texto("caminho", "Caminho completo no computador do cliente (aceita %VARIAVEL% e ~).");
    private static readonly string Pasta = Esquema.Texto("pasta", "Pasta onde procurar, caminho completo (padrão: a pasta do usuário).");

    private static Ferramenta F(
        string nome, string descricao, string esquema, bool soLeitura,
        Func<Args, CancellationToken, CallToolResult> executar, Func<Args, string> resumo)
        => new(Contrato.PrefixoFerramenta + nome, descricao, esquema, R, soLeitura, !soLeitura,
            (a, ct) => Task.Run(() => executar(a, ct), ct), resumo);

    private static string Onde(Args a) => Caminhos.Resolver(a.Texto("caminho", CaminhoMaximo));
    private static string OndeCurto(Args a) => Resultado.Encurtar(a.Texto("caminho", CaminhoMaximo), 110);
    private static string PastaDe(Args a) => a.TextoOpcional("pasta", CaminhoMaximo) is { Length: > 0 } pasta ? Caminhos.Resolver(pasta) : Comandos.PastaPadrao;

    internal static IEnumerable<Ferramenta> Criar() =>
    [
        F("arquivo_ler",
            "Lê um arquivo de texto com as linhas numeradas. Arquivo grande: leia por partes com inicio e limite. Binário: use remoto_arquivo_baixar.",
            Esquema.Objeto(
                [
                    Caminho,
                    Esquema.Inteiro("inicio", "Primeira linha a ler (padrão: 1).", 1, int.MaxValue),
                    Esquema.Inteiro("limite", "Quantas linhas ler (padrão: 2000).", 1, 5000)
                ], "caminho"),
            true, Ler, (a) => $"Leu o arquivo {OndeCurto(a)}"),

        F("arquivo_escrever",
            "Cria um arquivo de texto ou substitui o conteúdo inteiro de um existente (as pastas que faltarem são criadas). Para mudar só um trecho, use remoto_arquivo_editar.",
            Esquema.Objeto([Caminho, Esquema.Texto("conteudo", "Conteúdo completo do arquivo.")], "caminho", "conteudo"),
            false, Escrever, (a) => $"Escreveu o arquivo {OndeCurto(a)}"),

        F("arquivo_editar",
            "Troca um trecho exato de um arquivo de texto. O trecho antigo precisa aparecer uma única vez (ou use todas=true para trocar todas as ocorrências). Leia o arquivo antes.",
            Esquema.Objeto(
                [
                    Caminho,
                    Esquema.Texto("antigo", "Texto exato a substituir."),
                    Esquema.Texto("novo", "Texto que entra no lugar."),
                    Esquema.Logico("todas", "Trocar todas as ocorrências (padrão: não).")
                ], "caminho", "antigo", "novo"),
            false, Editar, (a) => $"Editou o arquivo {OndeCurto(a)}"),

        F("arquivo_buscar",
            "Procura arquivos pelo nome com um padrão: `*.log` olha só a pasta, `**/*.log` olha também as subpastas, `{a,b}` são alternativas. Devolve os caminhos, dos modificados mais recentemente para os mais antigos.",
            Esquema.Objeto(
                [
                    Esquema.Texto("padrao", "Padrão do nome, ex.: **/*.config"),
                    Pasta,
                    Esquema.Inteiro("limite", "Máximo de resultados (padrão: 200).", 1, 1000)
                ], "padrao"),
            true, Buscar, (a) => $"Buscou arquivos {Resultado.Encurtar(a.Texto("padrao", 500), 60)}"),

        F("arquivo_procurar",
            "Procura um texto dentro dos arquivos de uma pasta e devolve `caminho:linha: trecho`. Ignora binários e arquivos acima de 5 MB.",
            Esquema.Objeto(
                [
                    Esquema.Texto("texto", "Texto a procurar (ou expressão regular, com regex=true)."),
                    Pasta,
                    Esquema.Texto("padrao", "Quais arquivos olhar (padrão: **/*)."),
                    Esquema.Logico("regex", "Tratar o texto como expressão regular (padrão: não)."),
                    Esquema.Logico("diferenciarMaiusculas", "Diferenciar maiúsculas de minúsculas (padrão: não)."),
                    Esquema.Inteiro("limite", "Máximo de linhas encontradas (padrão: 100).", 1, 500)
                ], "texto"),
            true, Procurar, (a) => $"Procurou texto em {Resultado.Encurtar(a.TextoOpcional("pasta", CaminhoMaximo) ?? "pasta do usuário", 90)}"),

        F("arquivo_enviar",
            $"Grava no computador do cliente um arquivo enviado em base64 (qualquer tipo, até {Contrato.ArquivoBytes / 1048576} MB). Não substitui um arquivo existente sem sobrescrever=true.",
            Esquema.Objeto(
                [
                    Caminho,
                    Esquema.Texto("conteudoBase64", "Conteúdo do arquivo em base64."),
                    Esquema.Logico("sobrescrever", "Substituir se já existir (padrão: não).")
                ], "caminho", "conteudoBase64"),
            false, Enviar, (a) => $"Enviou o arquivo {OndeCurto(a)}"),

        F("arquivo_baixar",
            $"Traz um arquivo do computador do cliente inteiro, de qualquer tipo, como recurso anexado (até {Contrato.ArquivoBytes / 1048576} MB).",
            Esquema.Objeto([Caminho], "caminho"),
            true, Baixar, (a) => $"Baixou o arquivo {OndeCurto(a)}")
    ];

    private static CallToolResult Ler(Args a, CancellationToken ct)
    {
        var caminho = Onde(a);
        var inicio = a.Inteiro("inicio", 1, int.MaxValue, 1);
        var limite = a.Inteiro("limite", 1, 5000, 2000);
        var linhas = Textos.Ler(caminho).Conteudo.Split('\n');
        if (linhas.Length == 1 && linhas[0].Length == 0) return Resultado.Texto("(arquivo vazio)");
        if (inicio > linhas.Length) return Resultado.Texto($"O arquivo tem {linhas.Length} linhas; não há nada a partir da linha {inicio}.");

        var saida = new StringBuilder();
        var fim = (int)Math.Min(linhas.Length, (long)inicio - 1 + limite);
        var ultima = inicio - 1;
        for (var i = inicio - 1; i < fim && saida.Length < SaidaMaxima; i++)
        {
            ct.ThrowIfCancellationRequested();
            var linha = linhas[i].TrimEnd('\r');
            if (linha.Length > LinhaMaxima) linha = linha[..LinhaMaxima] + " [linha cortada]";
            saida.Append(i + 1).Append('\t').Append(linha).Append('\n');
            ultima = i + 1;
        }
        if (ultima < linhas.Length)
            saida.Append($"\n[... linhas {inicio} a {ultima} de {linhas.Length}; continue com inicio={ultima + 1} ...]");
        return Resultado.Texto(saida.ToString());
    }

    private static CallToolResult Escrever(Args a, CancellationToken ct)
    {
        var caminho = Onde(a);
        var conteudo = a.Texto("conteudo", Contrato.ArquivoBytes, aceitaVazio: true);
        if (Directory.Exists(caminho)) return Resultado.Erro($"É uma pasta, não um arquivo: {caminho}");
        var existia = File.Exists(caminho);
        Encoding codificacao = new UTF8Encoding(false);
        // Arquivo de texto que já existe mantém a codificação que tinha.
        if (existia && new FileInfo(caminho).Length <= Contrato.ArquivoBytes
            && Textos.Decodificar(Textos.LerBytes(caminho)) is { } atual) codificacao = atual.Codificacao;
        var bytes = Textos.Gravar(caminho, conteudo, codificacao);
        return Resultado.Texto($"Arquivo {(existia ? "substituído" : "criado")}: {caminho} ({Caminhos.Tamanho(bytes)})");
    }

    private static CallToolResult Editar(Args a, CancellationToken ct)
    {
        var caminho = Onde(a);
        var antigo = a.Texto("antigo", Contrato.ArquivoBytes);
        var novo = a.Texto("novo", Contrato.ArquivoBytes, aceitaVazio: true);
        if (antigo == novo) return Resultado.Erro("antigo e novo são iguais: nada a trocar.");
        var lido = Textos.Ler(caminho);
        var texto = lido.Conteudo;
        // O técnico manda "\n"; o arquivo do Windows costuma ter "\r\n".
        if (!texto.Contains(antigo, StringComparison.Ordinal) && texto.Contains("\r\n", StringComparison.Ordinal) && !antigo.Contains('\r'))
        {
            antigo = antigo.Replace("\n", "\r\n");
            novo = novo.Replace("\r\n", "\n").Replace("\n", "\r\n");
        }
        var ocorrencias = Contar(texto, antigo);
        if (ocorrencias == 0) return Resultado.Erro("O trecho antigo não foi encontrado no arquivo. Leia o arquivo de novo e copie o trecho exato.");
        var todas = a.Logico("todas", false);
        if (ocorrencias > 1 && !todas)
            return Resultado.Erro($"O trecho antigo aparece {ocorrencias} vezes. Inclua mais contexto para ficar único ou use todas=true.");
        Textos.Gravar(caminho, texto.Replace(antigo, novo, StringComparison.Ordinal), lido.Codificacao);
        return Resultado.Texto($"Arquivo editado: {caminho} ({ocorrencias} {(ocorrencias == 1 ? "troca" : "trocas")})");
    }

    private static int Contar(string texto, string trecho)
    {
        var total = 0;
        for (var i = texto.IndexOf(trecho, StringComparison.Ordinal); i >= 0; i = texto.IndexOf(trecho, i + trecho.Length, StringComparison.Ordinal))
            total++;
        return total;
    }

    private static CallToolResult Buscar(Args a, CancellationToken ct)
    {
        var pasta = PastaDe(a);
        var limite = a.Inteiro("limite", 1, 1000, 200);
        var achados = Busca.Arquivos(pasta, a.Texto("padrao", 500), ct)
            .Select((arquivo) => (arquivo.Completo, Quando: Modificado(arquivo.Completo)))
            .OrderByDescending((arquivo) => arquivo.Quando)
            .ToList();
        if (achados.Count == 0) return Resultado.Texto($"Nenhum arquivo encontrado em {pasta}.");
        var saida = new StringBuilder();
        foreach (var arquivo in achados.Take(limite)) saida.Append(arquivo.Completo).Append('\n');
        if (achados.Count > limite) saida.Append($"\n[... {achados.Count - limite} a mais; refine o padrão ou aumente o limite ...]");
        return Resultado.Texto(saida.ToString().TrimEnd());
    }

    private static DateTime Modificado(string caminho)
    {
        try { return File.GetLastWriteTimeUtc(caminho); } catch { return DateTime.MinValue; }
    }

    private static CallToolResult Procurar(Args a, CancellationToken ct)
    {
        var pasta = PastaDe(a);
        var texto = a.Texto("texto", 2000);
        var limite = a.Inteiro("limite", 1, 500, 100);
        var opcoes = RegexOptions.CultureInvariant | (a.Logico("diferenciarMaiusculas", false) ? RegexOptions.None : RegexOptions.IgnoreCase);
        Regex regex;
        try { regex = new Regex(a.Logico("regex", false) ? texto : Regex.Escape(texto), opcoes, TimeSpan.FromSeconds(1)); }
        catch (ArgumentException erro) { return Resultado.Erro($"Expressão regular inválida: {erro.Message}"); }

        var saida = new StringBuilder();
        var achados = 0;
        var arquivos = 0;
        foreach (var (completo, _) in Busca.Arquivos(pasta, a.TextoOpcional("padrao", 500) is { Length: > 0 } padrao ? padrao : "**/*", ct))
        {
            if (achados >= limite) break;
            TextoLido? lido;
            try
            {
                if (new FileInfo(completo).Length > ProcurarAte) continue;
                lido = Textos.Decodificar(Textos.LerBytes(completo));
            }
            catch { continue; } // em uso ou sem permissão
            if (lido is null) continue;
            arquivos++;
            var numero = 0;
            foreach (var bruta in lido.Conteudo.Split('\n'))
            {
                numero++;
                bool casa;
                try { casa = regex.IsMatch(bruta); } catch (RegexMatchTimeoutException) { break; }
                if (!casa) continue;
                saida.Append(completo).Append(':').Append(numero).Append(": ").Append(Resultado.Encurtar(bruta, 300)).Append('\n');
                if (++achados >= limite) break;
            }
        }
        if (achados == 0) return Resultado.Texto($"Nada encontrado em {pasta} ({arquivos} arquivos de texto olhados).");
        if (achados >= limite) saida.Append($"\n[... parou em {limite} linhas; refine a busca ou aumente o limite ...]");
        return Resultado.Texto(saida.ToString().TrimEnd());
    }

    private static CallToolResult Enviar(Args a, CancellationToken ct)
    {
        var caminho = Onde(a);
        byte[] bytes;
        try { bytes = Convert.FromBase64String(a.Texto("conteudoBase64", Base64Maximo, aceitaVazio: true)); }
        catch (FormatException) { return Resultado.Erro("conteudoBase64 não é base64 válido."); }
        if (bytes.Length > Contrato.ArquivoBytes)
            return Resultado.Erro($"Arquivo grande demais ({Caminhos.Tamanho(bytes.Length)}; o limite é {Caminhos.Tamanho(Contrato.ArquivoBytes)}).");
        if (Directory.Exists(caminho)) return Resultado.Erro($"É uma pasta, não um arquivo: {caminho}");
        if (File.Exists(caminho) && !a.Logico("sobrescrever", false))
            return Resultado.Erro($"O arquivo já existe: {caminho}. Use sobrescrever=true para substituir.");
        if (Path.GetDirectoryName(caminho) is { Length: > 0 } pasta) Directory.CreateDirectory(pasta);
        File.WriteAllBytes(caminho, bytes);
        return Resultado.Texto($"Arquivo gravado: {caminho} ({Caminhos.Tamanho(bytes.Length)})");
    }

    private static CallToolResult Baixar(Args a, CancellationToken ct)
    {
        var caminho = Onde(a);
        var bytes = Textos.LerBytes(caminho);
        return new CallToolResult
        {
            Content =
            [
                new TextContentBlock { Text = $"{caminho} · {Caminhos.Tamanho(bytes.Length)}" },
                new EmbeddedResourceBlock { Resource = BlobResourceContents.FromBytes(bytes, new Uri(caminho).AbsoluteUri, "application/octet-stream") }
            ],
            IsError = false
        };
    }
}
