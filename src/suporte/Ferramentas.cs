using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol.Protocol;

namespace AgentCode.Suporte;

/// <summary>
/// Uma ferramenta que o exe declara por MCP. <paramref name="Recurso"/> é a chave da
/// janela que a libera (nula = sempre disponível). <paramref name="EntradaNaTela"/>
/// marca as que mexem no mouse/teclado: ficam paradas enquanto houver uma pergunta
/// aberta para o cliente, para a IA nunca "responder" por ele.
/// </summary>
internal sealed record Ferramenta(
    string Nome,
    string Descricao,
    string Esquema,
    string? Recurso,
    bool SoLeitura,
    bool Destrutiva,
    Func<Args, CancellationToken, Task<CallToolResult>> Executar,
    Func<Args, string> Resumo,
    bool EntradaNaTela = false);

/// <summary>Parâmetros de uma chamada, validados na leitura (tipo, tamanho, faixa).</summary>
internal sealed class Args(JsonObject bruto)
{
    internal JsonObject Bruto => bruto;
    internal bool Tem(string nome) => bruto[nome] is not null;

    internal string Texto(string nome, int maximo, bool aceitaVazio = false)
    {
        var valor = TextoOpcional(nome, maximo) ?? throw new ArgumentException($"{nome} é obrigatório.");
        if (!aceitaVazio && string.IsNullOrWhiteSpace(valor)) throw new ArgumentException($"{nome} é obrigatório.");
        return valor;
    }

    internal string? TextoOpcional(string nome, int maximo)
    {
        if (bruto[nome] is not { } no) return null;
        if (no is not JsonValue valor || !valor.TryGetValue<string>(out var texto)) throw new ArgumentException($"{nome} deve ser texto.");
        if (texto.Length > maximo) throw new ArgumentException($"{nome} excede o limite de {maximo} caracteres.");
        return texto;
    }

    internal int Inteiro(string nome, int minimo, int maximo, int? padrao = null)
    {
        if (bruto[nome] is not { } no) return padrao ?? throw new ArgumentException($"{nome} é obrigatório.");
        if (no is not JsonValue valor || !valor.TryGetValue<double>(out var numero) || numero != Math.Floor(numero))
            throw new ArgumentException($"{nome} deve ser um número inteiro.");
        if (numero < minimo || numero > maximo) throw new ArgumentException($"{nome} deve estar entre {minimo} e {maximo}.");
        return (int)numero;
    }

    internal double Numero(string nome, double minimo, double maximo)
    {
        if (bruto[nome] is not JsonValue valor || !valor.TryGetValue<double>(out var numero) || !double.IsFinite(numero))
            throw new ArgumentException($"{nome} deve ser um número.");
        if (numero < minimo || numero > maximo) throw new ArgumentException($"{nome} deve estar entre {minimo} e {maximo}.");
        return numero;
    }

    internal bool Logico(string nome, bool padrao)
    {
        if (bruto[nome] is not { } no) return padrao;
        return no is JsonValue valor && valor.TryGetValue<bool>(out var logico)
            ? logico
            : throw new ArgumentException($"{nome} deve ser verdadeiro ou falso.");
    }

    internal string Opcao(string nome, string padrao, params string[] aceitas)
    {
        var valor = TextoOpcional(nome, 40) ?? padrao;
        return aceitas.Contains(valor) ? valor : throw new ArgumentException($"{nome} deve ser um de: {string.Join(", ", aceitas)}.");
    }
}

internal static class Resultado
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    internal static CallToolResult Texto(string texto, bool erro = false)
        => new() { Content = [new TextContentBlock { Text = texto }], IsError = erro };

    internal static CallToolResult Erro(string texto) => Texto(texto, true);

    internal static CallToolResult Objeto(object? valor)
        => Texto(valor is string texto ? texto : JsonSerializer.Serialize(valor, Json));

    internal static CallToolResult ComImagem(string texto, byte[] png)
        => new() { Content = [new TextContentBlock { Text = texto }, ImageContentBlock.FromBytes(png, "image/png")], IsError = false };

    internal static string Encurtar(string texto, int maximo)
    {
        var linha = texto.ReplaceLineEndings(" ").Trim();
        return linha.Length > maximo ? linha[..(maximo - 3)] + "..." : linha;
    }
}

/// <summary>
/// O catálogo de ferramentas e a porta por onde toda chamada passa: confere a chave
/// do recurso na janela do cliente, registra o que foi feito e nunca deixa uma
/// exceção virar erro genérico.
/// </summary>
internal sealed class Ferramentas
{
    private readonly Sessao sessao;
    private readonly Dictionary<string, Ferramenta> porNome;

    internal Ferramentas(Sessao sessao, IEnumerable<Ferramenta> todas)
    {
        this.sessao = sessao;
        Todas = [.. todas];
        porNome = Todas.ToDictionary((f) => f.Nome, StringComparer.Ordinal);
    }

    internal IReadOnlyList<Ferramenta> Todas { get; }

    /// <summary>A lista como o MCP a publica. Só leitura/destrutiva vão nas anotações.</summary>
    internal List<Tool> Declarar() => Todas.Select((f) => new Tool
    {
        Name = f.Nome,
        Description = f.Descricao,
        InputSchema = JsonDocument.Parse(f.Esquema).RootElement.Clone(),
        Annotations = new ToolAnnotations
        {
            ReadOnlyHint = f.SoLeitura,
            DestructiveHint = f.Destrutiva,
            OpenWorldHint = false
        }
    }).ToList();

    /// <summary>Por que a ferramenta não pode rodar agora, ou nulo se pode.</summary>
    internal string? Bloqueio(Ferramenta ferramenta)
    {
        if (ferramenta.EntradaNaTela && sessao.PedidoAberto)
            return "Há uma pergunta aberta na tela do cliente. Aguarde a resposta dele antes de mexer no mouse ou no teclado.";
        if (ferramenta.Recurso is not { } recurso) return null;
        return sessao.Recurso(recurso) switch
        {
            EstadoRecurso.Ligado => null,
            EstadoRecurso.Desligado =>
                $"O cliente desligou este recurso ({Sessao.Rotulo(recurso)}). Só ele religa, na janela do suporte.",
            _ when Contrato.RecursosExtras.Contains(recurso) =>
                $"Recurso \"{recurso}\" ainda não liberado: peça ao cliente com remoto_pedir_recurso.",
            _ => $"Recurso \"{recurso}\" indisponível nesta sessão."
        };
    }

    internal async Task<CallToolResult> Chamar(string nome, IDictionary<string, JsonElement>? argumentos, CancellationToken ct)
    {
        if (!porNome.TryGetValue(nome, out var ferramenta)) return Resultado.Erro($"Ferramenta desconhecida: {nome}");
        var bruto = new JsonObject();
        foreach (var (chave, valor) in argumentos ?? new Dictionary<string, JsonElement>())
            bruto[chave] = JsonNode.Parse(valor.GetRawText());
        var args = new Args(bruto);

        string resumo;
        try { resumo = ferramenta.Resumo(args); } catch { resumo = ferramenta.Nome; }
        // Resumo vazio: a ferramenta anota por conta própria no registro do cliente.
        void Anotar(string sufixo = "") { if (resumo.Length > 0) sessao.Registrar(resumo + sufixo); }

        if (Bloqueio(ferramenta) is { } motivo)
        {
            Anotar(" · não permitido");
            return Resultado.Erro(motivo);
        }
        if (ferramenta.EntradaNaTela) Automacao.EntradaComecou();
        try
        {
            var resultado = await ferramenta.Executar(args, ct);
            Anotar(resultado.IsError == true ? " · erro" : "");
            return resultado;
        }
        catch (OperationCanceledException)
        {
            Anotar(" · cancelado");
            return Resultado.Erro("Chamada cancelada.");
        }
        catch (Exception erro)
        {
            Anotar(" · erro");
            var mensagem = erro.GetBaseException().Message.Trim();
            return Resultado.Erro(mensagem.Length > 800 ? mensagem[..800] : mensagem);
        }
        finally
        {
            if (ferramenta.EntradaNaTela) Automacao.EntradaTerminou();
        }
    }
}

/// <summary>Monta o JSON Schema dos parâmetros de uma ferramenta.</summary>
internal static class Esquema
{
    internal static readonly string Vazio = Objeto([]);

    internal static string Objeto(string[] campos, params string[] obrigatorios)
        => $"{{\"type\":\"object\",\"properties\":{{{string.Join(",", campos)}}},\"required\":[{string.Join(",", obrigatorios.Select((nome) => $"\"{nome}\""))}],\"additionalProperties\":false}}";

    private static string Campo(string nome, string tipo, string descricao, string extra = "")
        => $"\"{nome}\":{{\"type\":\"{tipo}\",\"description\":{JsonSerializer.Serialize(descricao)}{extra}}}";

    internal static string Texto(string nome, string descricao) => Campo(nome, "string", descricao);
    internal static string Logico(string nome, string descricao) => Campo(nome, "boolean", descricao);
    internal static string Numero(string nome, string descricao) => Campo(nome, "number", descricao, ",\"minimum\":0");

    internal static string Inteiro(string nome, string descricao, int minimo, int maximo)
        => Campo(nome, "integer", descricao, $",\"minimum\":{minimo},\"maximum\":{maximo}");

    internal static string Opcoes(string nome, string descricao, params string[] valores)
        => Campo(nome, "string", descricao, $",\"enum\":[{string.Join(",", valores.Select((valor) => $"\"{valor}\""))}]");

    /// <summary>Campo com o esquema escrito à mão (listas e objetos).</summary>
    internal static string Bruto(string nome, string json) => $"\"{nome}\":{json}";
}
