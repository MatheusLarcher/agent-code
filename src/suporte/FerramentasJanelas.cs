using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol.Protocol;

namespace AgentCode.Suporte;

/// <summary>
/// As 16 ferramentas de automação de tela do controle local, com o prefixo
/// <c>remoto_</c>. Os nomes, os parâmetros e as respostas são os de
/// <c>src/main/windowsControl/tools.ts</c>; o que muda é que rodam no PC do cliente e
/// nunca enxergam as janelas do próprio suporte.
/// </summary>
internal sealed class FerramentasJanelas(Automacao automacao)
{
    private const string R = Contrato.RecursoTela;
    private const int Prazo = 30_000;
    private const int PrazoPassos = 125_000;
    private const int TextoMaximo = 100_000;

    private static readonly string Janela = Esquema.Bruto("windowId",
        """{"type":"string","pattern":"^[0-9]+$","description":"Id devolvido por remoto_list_windows."}""");
    private static readonly string Foto = Esquema.Texto("screenshotId", "Id da captura mais recente desta janela (remoto_get_state).");
    private static readonly string Indice = Esquema.Inteiro("elementIndex", "Índice do elemento no último estado lido desta janela.", 0, 9999);

    private static Ferramenta F(
        string nome, string descricao, string esquema,
        Func<Args, CancellationToken, Task<CallToolResult>> executar, Func<Args, string> resumo,
        bool soLeitura = false, bool entrada = true)
        => new(Contrato.PrefixoFerramenta + nome, descricao, esquema, R, soLeitura, false, executar, resumo, entrada && !soLeitura);

    internal IEnumerable<Ferramenta> Criar() =>
    [
        F("list_windows",
            "Lista as janelas abertas no computador do cliente: windowId estável, título, programa, posição e se está minimizada.",
            Esquema.Vazio,
            async (_, ct) => Resultado.Objeto(Automacao.SemAsNossas(await automacao.ChamarAsync("list_windows", new JsonObject(), Prazo, ct))),
            (_) => "Listou as janelas", soLeitura: true),

        F("list_apps",
            "Lista os programas em execução que têm janela.",
            Esquema.Vazio,
            async (_, ct) => Resultado.Objeto(ProgramasSemONosso(await automacao.ChamarAsync("list_apps", new JsonObject(), Prazo, ct))),
            (_) => "Listou os programas", soLeitura: true),

        F("launch_app",
            "Abre um programa instalado, pelo nome ou caminho do executável ou por um identificador do shell. Depois chame remoto_list_windows e escolha a janela.",
            Esquema.Objeto(
                [
                    Esquema.Texto("app", "Nome ou caminho do executável, ou identificador de app do Windows."),
                    Esquema.Bruto("arguments", """{"type":"array","maxItems":40,"items":{"type":"string","maxLength":2000},"description":"Argumentos do programa (opcional)."}""")
                ], "app"),
            (a, ct) => Agir("launch_app", null, new JsonObject { ["app"] = a.Texto("app", 32_000), ["arguments"] = Argumentos(a) }, ct),
            (a) => $"Abriu o programa {Resultado.Encurtar(a.Texto("app", 32_000), 80)}", entrada: false),

        F("activate_window",
            "Traz uma janela para a frente.",
            Esquema.Objeto([Janela], "windowId"),
            (a, ct) => Agir("activate_window", Id(a), new JsonObject { ["windowId"] = Id(a) }, ct),
            (_) => "Trouxe uma janela para a frente"),

        F("get_state",
            "Observa uma janela: captura (com screenshotId para as ações por coordenada) e/ou a árvore de acessibilidade com os índices dos elementos. Observe de novo depois de ações que abrem ou fecham janelas, e depois de erro.",
            Esquema.Objeto(
                [
                    Janela,
                    Esquema.Logico("includeScreenshot", "Capturar a imagem da janela (padrão: sim)."),
                    Esquema.Logico("includeText", "Ler a árvore de acessibilidade (padrão: sim)."),
                    Esquema.Inteiro("maxDepth", "Profundidade máxima da árvore.", 1, 20),
                    Esquema.Inteiro("maxElements", "Máximo de elementos.", 1, 1000)
                ], "windowId"),
            Observar,
            (_) => "Observou uma janela", soLeitura: true),

        F("click_element",
            "Aciona ou clica um elementIndex do último estado lido desta janela. O índice vale enquanto o elemento não mudar; senão, observe de novo.",
            Esquema.Objeto([Janela, Indice], "windowId", "elementIndex"),
            (a, ct) => Agir("click_element", Id(a), new JsonObject { ["windowId"] = Id(a), ["elementIndex"] = a.Inteiro("elementIndex", 0, 9999) }, ct),
            (_) => "Clicou num controle"),

        F("click",
            "Clica numa coordenada da captura de uma janela. screenshotId vem do remoto_get_state mais recente dela.",
            Esquema.Objeto(
                [
                    Janela, Foto, Esquema.Numero("x", "X na captura."), Esquema.Numero("y", "Y na captura."),
                    Esquema.Opcoes("button", "Botão do mouse (padrão: left).", "left", "right", "middle"),
                    Esquema.Inteiro("clickCount", "Quantos cliques (padrão: 1).", 1, 3)
                ], "windowId", "screenshotId", "x", "y"),
            (a, ct) =>
            {
                var id = Id(a);
                var (x, y) = Ponto(a, id, "x", "y");
                return Agir("click", id, new JsonObject
                {
                    ["windowId"] = id, ["x"] = x, ["y"] = y,
                    ["button"] = a.Opcao("button", "left", "left", "right", "middle"),
                    ["clickCount"] = a.Inteiro("clickCount", 1, 3, 1)
                }, ct);
            },
            (_) => "Clicou na tela"),

        F("type_text",
            "Digita texto no controle com foco de uma janela. Confira o foco antes. Se a janela estiver bloqueada por um diálogo modal, o texto vai para ele; a resposta traz targetWindowId (a janela que recebeu).",
            Esquema.Objeto([Janela, Esquema.Texto("text", "Texto a digitar.")], "windowId", "text"),
            (a, ct) => Agir("type_text", Id(a), new JsonObject { ["windowId"] = Id(a), ["text"] = a.Texto("text", TextoMaximo, aceitaVazio: true) }, ct),
            (a) => $"Digitou texto ({a.Texto("text", TextoMaximo, aceitaVazio: true).Length} caracteres)"),

        F("press_key",
            "Pressiona uma tecla ou combinação separada por +, como Return, Tab, Control+a, Shift+F10 ou KP_0. Com diálogo modal aberto, a tecla vai para ele; a resposta traz targetWindowId.",
            Esquema.Objeto([Janela, Esquema.Texto("key", "Tecla ou combinação.")], "windowId", "key"),
            (a, ct) => Agir("press_key", Id(a), new JsonObject { ["windowId"] = Id(a), ["key"] = a.Texto("key", 200) }, ct),
            (a) => $"Pressionou {Resultado.Encurtar(a.Texto("key", 200), 40)}"),

        F("scroll",
            "Rola a partir de uma coordenada da captura. scrollY positivo desce; negativo sobe. Envie sempre scrollX e scrollY (0 no eixo que não rola).",
            Esquema.Objeto(
                [
                    Janela, Foto, Esquema.Numero("x", "X na captura."), Esquema.Numero("y", "Y na captura."),
                    Esquema.Inteiro("scrollX", "Rolagem horizontal.", -50_000, 50_000),
                    Esquema.Inteiro("scrollY", "Rolagem vertical.", -50_000, 50_000)
                ], "windowId", "screenshotId", "x", "y", "scrollX", "scrollY"),
            (a, ct) =>
            {
                var id = Id(a);
                var (x, y) = Ponto(a, id, "x", "y");
                return Agir("scroll", id, new JsonObject
                {
                    ["windowId"] = id, ["x"] = x, ["y"] = y,
                    ["scrollX"] = a.Inteiro("scrollX", -50_000, 50_000),
                    ["scrollY"] = a.Inteiro("scrollY", -50_000, 50_000)
                }, ct);
            },
            (_) => "Rolou a tela"),

        F("drag",
            "Arrasta entre dois pontos da captura de uma janela.",
            Esquema.Objeto(
                [
                    Janela, Foto, Esquema.Numero("fromX", "X inicial."), Esquema.Numero("fromY", "Y inicial."),
                    Esquema.Numero("toX", "X final."), Esquema.Numero("toY", "Y final.")
                ], "windowId", "screenshotId", "fromX", "fromY", "toX", "toY"),
            (a, ct) =>
            {
                var id = Id(a);
                var (deX, deY) = Ponto(a, id, "fromX", "fromY");
                var (ateX, ateY) = Ponto(a, id, "toX", "toY");
                return Agir("drag", id, new JsonObject { ["windowId"] = id, ["fromX"] = deX, ["fromY"] = deY, ["toX"] = ateX, ["toY"] = ateY }, ct);
            },
            (_) => "Arrastou na tela"),

        F("set_value",
            "Troca o valor de um elementIndex editável do último estado lido desta janela. Pode ser encadeada sem novo remoto_get_state.",
            Esquema.Objeto([Janela, Indice, Esquema.Texto("value", "Novo valor.")], "windowId", "elementIndex", "value"),
            (a, ct) => Agir("set_value", Id(a), new JsonObject
            {
                ["windowId"] = Id(a), ["elementIndex"] = a.Inteiro("elementIndex", 0, 9999),
                ["value"] = a.Texto("value", TextoMaximo, aceitaVazio: true)
            }, ct),
            (_) => "Preencheu um campo"),

        F("fill",
            "Escreve texto num campo e confere. Tenta o valor por acessibilidade, depois colar (a área de transferência do cliente é restaurada), depois digitar, relendo o campo a cada tentativa; ok só quando o valor final confere. Sem elementIndex, preenche o controle com foco da janela (ou do modal dela). mode=append mantém o valor atual. verified=false quer dizer que o campo não pôde ser relido: observe para confirmar.",
            Esquema.Objeto(
                [
                    Janela, Esquema.Texto("text", "Texto a escrever."), Indice,
                    Esquema.Opcoes("mode", "replace (padrão) ou append.", "replace", "append")
                ], "windowId", "text"),
            (a, ct) =>
            {
                var p = new JsonObject
                {
                    ["windowId"] = Id(a), ["text"] = a.Texto("text", TextoMaximo, aceitaVazio: true),
                    ["mode"] = a.Opcao("mode", "replace", "replace", "append")
                };
                if (a.Tem("elementIndex")) p["elementIndex"] = a.Inteiro("elementIndex", 0, 9999);
                return Agir("fill", Id(a), p, ct);
            },
            (_) => "Preencheu um campo"),

        F("secondary_action",
            "Executa uma ação de acessibilidade num elementIndex do último estado lido: invoke, expand, collapse, select, toggle, scroll_into_view ou focus. toggle, select e focus podem ser encadeadas; invoke, expand e collapse mudam a tela — observe de novo depois.",
            Esquema.Objeto(
                [
                    Janela, Indice,
                    Esquema.Opcoes("action", "Ação.", "invoke", "expand", "collapse", "select", "toggle", "scroll_into_view", "focus")
                ], "windowId", "elementIndex", "action"),
            (a, ct) => Agir("secondary_action", Id(a), new JsonObject
            {
                ["windowId"] = Id(a), ["elementIndex"] = a.Inteiro("elementIndex", 0, 9999),
                ["action"] = a.Opcao("action", "", "invoke", "expand", "collapse", "select", "toggle", "scroll_into_view", "focus")
            }, ct),
            (_) => "Acionou um controle"),

        F("form_fields",
            "Lê uma janela de forma compacta, sem captura: uma linha por controle útil como `índice Tipo[*] \"Nome\" (AutomationId) = \"valor\" [opções]`, uma seção `# janela` por janela/popup/diálogo e a última linha `ativo:` com a janela ativa. Os índices servem em remoto_click_element, remoto_fill, remoto_set_value, remoto_secondary_action e em target.index de remoto_run_steps. Use antes de remoto_run_steps; se vier vazio ou inútil (sem acessibilidade, canvas), use remoto_get_state.",
            Esquema.Objeto([Janela, Esquema.Inteiro("maxElements", "Máximo de controles listados (padrão: 300).", 1, 1000)], "windowId"),
            async (a, ct) =>
            {
                var p = new JsonObject { ["windowId"] = Id(a) };
                if (a.Tem("maxElements")) p["maxElements"] = a.Inteiro("maxElements", 1, 1000);
                var lido = await automacao.ChamarAsync("form_fields", p, Prazo, ct);
                return Resultado.Texto(lido?["text"]?.GetValue<string>() ?? "");
            },
            (_) => "Leu os campos de uma janela", soLeitura: true),

        F("run_steps",
            "Executa uma sequência inteira de passos numa janela, numa chamada só. Cada alvo é resolvido na hora, na janela e nos popups/diálogos que abrirem no meio, então uma chamada atravessa menu, diálogo, campos e confirmação. Prefira target.name (sem diferenciar maiúsculas nem acentos, exato antes de contém; some type para desambiguar) a index. Para no primeiro alvo ausente ou ambíguo (com os candidatos) e sempre devolve o estado compacto final: continue a partir dele. Ações: fill (value), click, toggle (value on/off opcional), select (value = nome do item), expand, focus, press (value = tecla ou combinação; só quando nenhum controle resolver), wait_for (target.name aparecer ou target.gone sumir). Espera padrão de 5 s por passo, 120 s por chamada. expect: texto conferido no estado final (expectFound).",
            Esquema.Objeto(
                [
                    Janela,
                    Esquema.Bruto("steps", Passos),
                    Esquema.Texto("expect", "Texto esperado no estado final.")
                ], "windowId", "steps"),
            async (a, ct) =>
            {
                var id = Id(a);
                if (a.Bruto["steps"] is not JsonArray passos || passos.Count is < 1 or > 500)
                    throw new ArgumentException("steps deve ter de 1 a 500 passos.");
                var p = new JsonObject { ["windowId"] = id, ["steps"] = passos.DeepClone() };
                if (a.Tem("expect")) p["expect"] = a.Texto("expect", 500);
                try
                {
                    var saida = await automacao.ChamarAsync("run_steps", p, PrazoPassos, ct) as JsonObject ?? new JsonObject();
                    var estado = saida["state"]?.GetValue<string>();
                    saida.Remove("state");
                    var resumo = saida.ToJsonString(Compacto);
                    return Resultado.Texto(string.IsNullOrEmpty(estado) ? resumo : $"{resumo}\n\n{estado}");
                }
                finally { automacao.Esquecer(id); }
            },
            (a) => $"Executou {(a.Bruto["steps"] as JsonArray)?.Count ?? 0} passos numa janela")
    ];

    private const string Passos = """
        {"type":"array","minItems":1,"maxItems":500,"items":{"type":"object","properties":{
        "action":{"type":"string","enum":["fill","click","toggle","select","expand","focus","press","wait_for"]},
        "target":{"type":"object","properties":{
        "index":{"type":"integer","minimum":0,"maximum":9999,"description":"Índice de remoto_form_fields/remoto_get_state."},
        "name":{"type":"string","maxLength":500,"description":"Nome do controle, sem diferenciar maiúsculas nem acentos."},
        "automationId":{"type":"string","maxLength":500},
        "type":{"type":"string","maxLength":80,"description":"Tipo do controle para desambiguar: Button, Edit, MenuItem."},
        "gone":{"type":"string","maxLength":500,"description":"Só em wait_for: nome que deve sumir."}}},
        "value":{"type":"string","maxLength":100000,"description":"fill: texto; select: nome do item; press: tecla ou combinação; toggle: on/off opcional."},
        "timeoutMs":{"type":"integer","minimum":100,"maximum":30000,"description":"Espera do passo (padrão: 5000)."}},
        "required":["action"]}}
        """;

    private static readonly JsonSerializerOptions Compacto = new(Resultado.Json) { WriteIndented = false };

    // ---- Apoio -------------------------------------------------------------------

    /// <summary>O windowId da chamada, já conferido (existe e não é janela do suporte).</summary>
    private static string Id(Args a)
    {
        var id = a.Texto("windowId", 32);
        Automacao.Janela(id);
        return id;
    }

    /// <summary>Coordenada da captura → ponto da janela, recusando o que cai sobre o suporte.</summary>
    private (double X, double Y) Ponto(Args a, string id, string nomeX, string nomeY)
    {
        var ponto = automacao.Escalar(id, a.Texto("screenshotId", 64), a.Numero(nomeX, 0, 100_000), a.Numero(nomeY, 0, 100_000));
        Automacao.ConferirPonto(Automacao.Janela(id), ponto.X, ponto.Y);
        return ponto;
    }

    private async Task<CallToolResult> Agir(string metodo, string? janela, JsonObject parametros, CancellationToken ct)
    {
        try { return Resultado.Objeto(await automacao.ChamarAsync(metodo, parametros, Prazo, ct)); }
        finally { if (janela is not null) automacao.Esquecer(janela); }
    }

    private static JsonArray Argumentos(Args a)
    {
        var lista = new JsonArray();
        if (a.Bruto["arguments"] is not { } bruto) return lista;
        if (bruto is not JsonArray itens || itens.Count > 40) throw new ArgumentException("arguments deve ser uma lista de até 40 textos.");
        foreach (var item in itens)
        {
            if (item is not JsonValue valor || !valor.TryGetValue<string>(out var texto) || texto.Length > 2000)
                throw new ArgumentException("arguments deve ser uma lista de textos de até 2000 caracteres.");
            lista.Add(texto);
        }
        return lista;
    }

    private static JsonArray ProgramasSemONosso(JsonNode? lista)
    {
        var limpa = new JsonArray();
        if (lista is not JsonArray programas) return limpa;
        foreach (var programa in programas)
        {
            if (programa?.DeepClone() is not JsonObject copia) continue;
            var janelas = Automacao.SemAsNossas(copia["windows"]);
            if (janelas.Count == 0) continue;
            copia["windows"] = janelas;
            limpa.Add(copia);
        }
        return limpa;
    }

    private async Task<CallToolResult> Observar(Args a, CancellationToken ct)
    {
        var id = Id(a);
        var hwnd = Automacao.Janela(id);
        automacao.Esquecer(id);
        JsonNode? acessibilidade = null;
        if (a.Logico("includeText", true))
        {
            acessibilidade = await automacao.ChamarAsync("get_accessibility", new JsonObject
            {
                ["windowId"] = id,
                ["maxDepth"] = a.Inteiro("maxDepth", 1, 20, 7),
                ["maxElements"] = a.Inteiro("maxElements", 1, 1000, 350)
            }, Prazo, ct);
        }
        var janela = Automacao.SemAsNossas(await automacao.ChamarAsync("list_windows", new JsonObject(), Prazo, ct))
            .FirstOrDefault((item) => item?["id"]?.GetValue<string>() == id)
            ?? throw new ArgumentException("A janela não existe mais; liste as janelas novamente.");
        var resumo = new JsonObject { ["window"] = janela.DeepClone(), ["accessibility"] = acessibilidade };
        if (!a.Logico("includeScreenshot", true)) return Resultado.Objeto(resumo);

        var imagem = await Task.Run(() => Captura.Janela(hwnd), ct);
        resumo["screenshot"] = new JsonObject
        {
            ["id"] = automacao.Guardar(id, imagem.Largura, imagem.Altura, imagem.LarguraOriginal, imagem.AlturaOriginal),
            ["width"] = imagem.Largura,
            ["height"] = imagem.Altura
        };
        return Resultado.ComImagem(JsonSerializer.Serialize(resumo, Resultado.Json), imagem.Png);
    }
}
