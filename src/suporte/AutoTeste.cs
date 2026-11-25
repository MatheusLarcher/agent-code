using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;

namespace AgentCode.Suporte;

/// <summary>
/// <c>--self-test</c>: confere, sem rede e sem janela, as peças do exe — as travas da
/// sessão, o catálogo, comandos, arquivos, captura, o servidor MCP e o canal da
/// elevação. Sai com código 0 só se tudo passar. O caminho com relay e janela de
/// verdade é o de <c>scripts/suporte-e2e.mjs</c>.
/// </summary>
internal static class AutoTeste
{
    [DllImport("kernel32.dll")]
    private static extern nint GetStdHandle(int handle);

    internal static int Rodar()
    {
        // Exe de janela: sem saída redirecionada, escreve no console de quem chamou.
        var saida = GetStdHandle(-11);
        if (saida == 0 || saida == -1) Nativo.AttachConsole(-1);
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { /* saída redirecionada: sem console */ }
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        return Task.Run(RodarAsync).GetAwaiter().GetResult();
    }

    private static async Task<int> RodarAsync()
    {
        (string Nome, Func<Task> Teste)[] testes =
        [
            ("relay fixo; variável de teste só aceita a própria máquina", RelayFixo),
            ("sessão só nasce no clique do cliente", SessaoSoNoClique),
            ("token: confere em tempo constante e morre ao encerrar", Token),
            ("recursos: desligado bloqueia, travado não liga pela chave", Recursos),
            ("catálogo: prefixo, nomes únicos e esquemas válidos", Catalogo),
            ("comando: acentos, código de saída e pasta", ComandoAcentos),
            ("comando: tempo limite encerra o processo", ComandoTempoLimite),
            ("comando: segundo plano, leitura e parada", ComandoSegundoPlano),
            ("comando: saída grande chega cortada no meio", SaidaCortada),
            ("arquivos: escrever, ler, editar, buscar e procurar", ArquivosTexto),
            ("arquivos: enviar e baixar binário", ArquivosBinario),
            ("janela: os cinco estados montam e os cliques chegam à sessão", AutoTesteJanela.Rodar),
            ("captura de tela não vazia", CapturaDeTela),
            ("janelas: lista sem as do suporte e escala do clique", Janelas),
            ("servidor MCP: token, tools/list e tools/call", ServidorMcp),
            ("elevação: canal entrega a sessão só ao próprio exe", CanalDaElevacao)
        ];
        var falhas = 0;
        foreach (var (nome, teste) in testes)
        {
            var relogio = Stopwatch.StartNew();
            try
            {
                await teste().WaitAsync(TimeSpan.FromSeconds(60));
                Console.WriteLine($"ok      {nome} ({relogio.ElapsedMilliseconds} ms)");
            }
            catch (Exception erro)
            {
                falhas++;
                Console.WriteLine($"FALHOU  {nome}: {erro.GetBaseException().Message}");
            }
        }
        Console.WriteLine(falhas == 0 ? $"\n{testes.Length} de {testes.Length} passaram" : $"\n{falhas} de {testes.Length} FALHARAM");
        return falhas == 0 ? 0 : 1;
    }

    // ---- Apoio -------------------------------------------------------------------

    private static void Confere(bool condicao, string oQue)
    {
        if (!condicao) throw new InvalidOperationException(oQue);
    }

    private static async Task<string> Ativar(Sessao sessao)
    {
        sessao.DefinirFase(Fase.Aguardando);
        var clique = sessao.PedirAcesso("pedido", "Teste");
        sessao.Responder(true);
        Confere(await clique, "o clique em Permitir não aceitou o pedido");
        return sessao.Ativar();
    }

    private static Dictionary<string, JsonElement> Arg(object valores)
        => JsonSerializer.SerializeToElement(valores).EnumerateObject().ToDictionary((p) => p.Name, (p) => p.Value.Clone());

    private static async Task<(string Texto, bool Erro, CallToolResult Bruto)> Chamar(Nucleo nucleo, string nome, object? argumentos = null)
    {
        var resultado = await nucleo.Ferramentas.Chamar(Contrato.PrefixoFerramenta + nome, Arg(argumentos ?? new { }), CancellationToken.None);
        var texto = string.Join("\n", resultado.Content.OfType<TextContentBlock>().Select((bloco) => bloco.Text));
        return (texto, resultado.IsError == true, resultado);
    }

    private static string PastaDeTeste()
    {
        var pasta = Path.Combine(Path.GetTempPath(), $"AgentCodeSuporte-teste-{Guid.NewGuid():N}");
        Directory.CreateDirectory(pasta);
        return pasta;
    }

    // ---- Travas ------------------------------------------------------------------

    private static Task RelayFixo()
    {
        var antes = Environment.GetEnvironmentVariable(Contrato.VariavelRelayTeste);
        try
        {
            foreach (var desvio in new[] { "ws://relay.exemplo.com:9", "wss://127.0.0.1.exemplo.com", "ws://alguem@localhost:9", "arquivo" })
            {
                Environment.SetEnvironmentVariable(Contrato.VariavelRelayTeste, desvio);
                Confere(Contrato.RelayUrl().ToString() == Contrato.RelayPadrao + Contrato.CaminhoWs, $"aceitou o desvio {desvio}");
            }
            Environment.SetEnvironmentVariable(Contrato.VariavelRelayTeste, "ws://127.0.0.1:4567");
            Confere(Contrato.RelayUrl().ToString() == "ws://127.0.0.1:4567" + Contrato.CaminhoWs, "não aceitou 127.0.0.1");
        }
        finally { Environment.SetEnvironmentVariable(Contrato.VariavelRelayTeste, antes); }
        return Task.CompletedTask;
    }

    private static async Task SessaoSoNoClique()
    {
        var sessao = new Sessao();
        sessao.DefinirFase(Fase.Aguardando);
        var semResposta = sessao.PedirAcesso("a", "Teste");
        Confere(sessao.Fase == Fase.PedidoAcesso && sessao.PedidoAberto, "o pedido não abriu a pergunta");
        sessao.FecharPedido("outro");
        Confere(sessao.PedidoAberto, "fechou o pedido pelo id errado");
        sessao.FecharPedido("a");
        Confere(!await semResposta && sessao.Fase == Fase.Aguardando, "pedido sem clique foi aceito");
        var recusado = sessao.PedirAcesso("b", "Teste");
        sessao.Responder(false);
        Confere(!await recusado && sessao.Fase == Fase.Aguardando, "recusa virou aceite");
        Confere(!sessao.ConfereToken("qualquer"), "aceitou token sem sessão");
        Confere(!await sessao.PedirRecurso(Contrato.RecursoAdministrador), "abriu pedido de recurso sem sessão ativa");
    }

    private static async Task Token()
    {
        var sessao = new Sessao();
        var token = await Ativar(sessao);
        Confere(token.Length >= 43 && sessao.Fase == Fase.Ativa, "token curto ou sessão não ativa");
        Confere(sessao.ConfereToken(token), "recusou o token certo");
        Confere(!sessao.ConfereToken(token + "x") && !sessao.ConfereToken("") && !sessao.ConfereToken(null), "aceitou token errado");
        Confere(await Ativar(new Sessao()) != token, "dois tokens iguais");
        sessao.Encerrar("teste");
        Confere(!sessao.ConfereToken(token) && sessao.Fase != Fase.Ativa, "token sobreviveu ao encerrar");
    }

    private static async Task Recursos()
    {
        using var nucleo = new Nucleo();
        await Ativar(nucleo.Sessao);
        foreach (var basico in Contrato.RecursosBasicos) Confere(nucleo.Sessao.Recurso(basico) == EstadoRecurso.Ligado, $"{basico} não começou ligado");
        foreach (var extra in Contrato.RecursosExtras) Confere(nucleo.Sessao.Recurso(extra) == EstadoRecurso.Travado, $"{extra} não começou travado");

        nucleo.Sessao.Alternar(Contrato.RecursoArquivos, false);
        var (texto, erro, _) = await Chamar(nucleo, "arquivo_ler", new { caminho = @"C:\Windows\win.ini" });
        Confere(erro && texto.Contains("O cliente desligou este recurso"), $"arquivos desligado não bloqueou: {texto}");
        nucleo.Sessao.Alternar(Contrato.RecursoArquivos, true);
        Confere(nucleo.Sessao.Recurso(Contrato.RecursoArquivos) == EstadoRecurso.Ligado, "o cliente não conseguiu religar");

        nucleo.Sessao.Alternar(Contrato.RecursoAdministrador, true);
        Confere(nucleo.Sessao.Recurso(Contrato.RecursoAdministrador) == EstadoRecurso.Travado, "recurso travado ligou pela chave");
        (texto, erro, _) = await Chamar(nucleo, "elevar");
        Confere(erro && texto.Contains("remoto_pedir_recurso"), $"elevar passou sem o recurso: {texto}");
        (texto, erro, _) = await Chamar(nucleo, "pedir_recurso", new { recurso = Contrato.RecursoChrome });
        Confere(erro && texto.Contains("não está disponível"), $"chrome deveria estar indisponível: {texto}");

        // Pergunta aberta: nada mexe no mouse nem no teclado, e só o clique responde.
        var pedido = Chamar(nucleo, "pedir_recurso", new { recurso = Contrato.RecursoAdministrador });
        for (var i = 0; i < 100 && !nucleo.Sessao.PedidoAberto; i++) await Task.Delay(20);
        Confere(nucleo.Sessao.RecursoPedido == Contrato.RecursoAdministrador, "o pedido de recurso não chegou à janela");
        (texto, erro, _) = await Chamar(nucleo, "press_key", new { windowId = "1", key = "Return" });
        Confere(erro && texto.Contains("pergunta aberta"), $"teclado liberado com pergunta aberta: {texto}");
        nucleo.Sessao.Responder(false);
        Confere((await pedido).Erro && nucleo.Sessao.Recurso(Contrato.RecursoAdministrador) == EstadoRecurso.Travado, "recusa liberou o recurso");
    }

    private static Task Catalogo()
    {
        using var nucleo = new Nucleo();
        var declaradas = nucleo.Ferramentas.Declarar();
        string[] esperadas =
        [
            "list_windows", "list_apps", "launch_app", "activate_window", "get_state", "click_element", "click", "type_text",
            "press_key", "scroll", "drag", "set_value", "fill", "secondary_action", "form_fields", "run_steps",
            "executar", "processo_ler", "processo_parar", "arquivo_ler", "arquivo_escrever", "arquivo_editar", "arquivo_buscar",
            "arquivo_procurar", "arquivo_enviar", "arquivo_baixar", "captura_tela", "info", "pedir_recurso", "elevar"
        ];
        Confere(declaradas.Count == esperadas.Length, $"{declaradas.Count} ferramentas, esperava {esperadas.Length}");
        foreach (var nome in esperadas)
            Confere(declaradas.Any((f) => f.Name == Contrato.PrefixoFerramenta + nome), $"falta remoto_{nome}");
        foreach (var ferramenta in declaradas)
        {
            Confere(ferramenta.Name.StartsWith(Contrato.PrefixoFerramenta, StringComparison.Ordinal), $"{ferramenta.Name} sem prefixo");
            Confere(ferramenta.InputSchema.GetProperty("type").GetString() == "object", $"{ferramenta.Name}: esquema não é objeto");
            Confere(!string.IsNullOrWhiteSpace(ferramenta.Description), $"{ferramenta.Name} sem descrição");
            Confere(ferramenta.Annotations?.ReadOnlyHint is not null && ferramenta.Annotations.DestructiveHint is not null, $"{ferramenta.Name} sem anotações");
        }
        string[] destrutivas = ["executar", "processo_parar", "arquivo_escrever", "arquivo_editar", "arquivo_enviar"];
        foreach (var ferramenta in declaradas)
        {
            var deveria = destrutivas.Contains(ferramenta.Name[Contrato.PrefixoFerramenta.Length..]);
            Confere(ferramenta.Annotations!.DestructiveHint == deveria, $"{ferramenta.Name}: anotação destrutiva errada");
        }
        return Task.CompletedTask;
    }

    // ---- Comandos ------------------------------------------------------------------

    private static async Task ComandoAcentos()
    {
        using var comandos = new Comandos();
        var pasta = PastaDeTeste();
        try
        {
            var feito = await comandos.ExecutarAsync("Write-Output 'ação, coração, À, ñ'; Write-Output (Get-Location).Path", pasta, 30_000, CancellationToken.None);
            Confere(feito.Codigo == 0, $"código de saída {feito.Codigo}: {feito.Saida}");
            Confere(feito.Saida.Contains("ação, coração, À, ñ"), $"acentos perdidos: {feito.Saida}");
            Confere(feito.Saida.Contains(Path.GetFileName(pasta)), "não rodou na pasta pedida");
            var codigo = await comandos.ExecutarAsync("cmd /c exit 3", null, 30_000, CancellationToken.None);
            Confere(codigo.Codigo == 3, $"código de saída {codigo.Codigo}, esperava 3");
            var erro = await comandos.ExecutarAsync("Get-Item 'Z:\\não existe'", null, 30_000, CancellationToken.None);
            Confere(erro.Codigo != 0 && erro.Saida.Contains("não existe"), $"erro do PowerShell não chegou: {erro.Codigo} {erro.Saida}");
        }
        finally { Directory.Delete(pasta, true); }
    }

    private static async Task ComandoTempoLimite()
    {
        using var comandos = new Comandos();
        var relogio = Stopwatch.StartNew();
        var feito = await comandos.ExecutarAsync("Write-Output 'antes'; Start-Sleep -Seconds 40", null, 1500, CancellationToken.None);
        Confere(feito.TempoEsgotado && feito.Codigo is null, "não acusou o tempo limite");
        Confere(relogio.ElapsedMilliseconds < 15_000, $"demorou {relogio.ElapsedMilliseconds} ms para encerrar");
        Confere(feito.Saida.Contains("antes"), "perdeu a saída anterior ao limite");
    }

    private static async Task ComandoSegundoPlano()
    {
        using var comandos = new Comandos();
        var id = comandos.IniciarEmFundo("1..3 | ForEach-Object { \"linha $_\" }; Start-Sleep -Seconds 40", null);
        var lido = "";
        for (var i = 0; i < 40 && !lido.Contains("linha 3"); i++) lido += (await comandos.Ler(id, 250, CancellationToken.None)).Saida;
        Confere(lido.Contains("linha 1") && lido.Contains("linha 3"), $"saída incremental não chegou: {lido}");
        Confere(!(await comandos.Ler(id, 0, CancellationToken.None)).Terminou, "terminou antes da hora");
        Confere(comandos.Parar(id), "não parou o processo");
        Confere((await comandos.Ler(id, 5000, CancellationToken.None)).Terminou, "o processo continuou depois de parar");
        Confere(!comandos.Parar("p0"), "parou um processo que não existe");
    }

    private static Task SaidaCortada()
    {
        var saida = new SaidaLimitada(1000);
        saida.Acrescentar(Encoding.UTF8.GetBytes("INICIO" + new string('ã', 3000) + "FIM"));
        var texto = saida.Texto();
        Confere(texto.StartsWith("INICIO") && texto.EndsWith("FIM"), "perdeu o começo ou o fim");
        Confere(texto.Contains("saída cortada") && !texto.Contains('\uFFFD'), "corte sem aviso ou com caractere quebrado");
        Confere(Encoding.UTF8.GetByteCount(texto) < 1200, "não respeitou o limite");
        return Task.CompletedTask;
    }

    // ---- Arquivos ------------------------------------------------------------------

    private static async Task ArquivosTexto()
    {
        using var nucleo = new Nucleo();
        await Ativar(nucleo.Sessao);
        var pasta = PastaDeTeste();
        try
        {
            var arquivo = Path.Combine(pasta, "sub", "anotação.txt");
            var (texto, erro, _) = await Chamar(nucleo, "arquivo_escrever", new { caminho = arquivo, conteudo = "linha um\nlinha dois çã\nlinha três\n" });
            Confere(!erro && File.Exists(arquivo), $"não escreveu: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "arquivo_ler", new { caminho = arquivo, inicio = 2, limite = 1 });
            Confere(!erro && texto.StartsWith("2\tlinha dois çã") && texto.Contains("inicio=3"), $"leitura por partes errada: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "arquivo_editar", new { caminho = arquivo, antigo = "linha", novo = "LINHA" });
            Confere(erro && texto.Contains("3 vezes"), $"trecho repetido deveria ser recusado: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "arquivo_editar", new { caminho = arquivo, antigo = "dois çã", novo = "2 é" });
            Confere(!erro && File.ReadAllText(arquivo).Contains("linha 2 é"), $"edição não aplicada: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "arquivo_buscar", new { padrao = "**/*.txt", pasta });
            Confere(!erro && texto.Contains("anotação.txt"), $"busca recursiva falhou: {texto}");
            (texto, _, _) = await Chamar(nucleo, "arquivo_buscar", new { padrao = "*.txt", pasta });
            Confere(texto.Contains("Nenhum arquivo"), $"padrão sem ** desceu em subpasta: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "arquivo_procurar", new { texto = "TRÊS", pasta });
            Confere(!erro && texto.Contains("anotação.txt:3: linha três"), $"procura falhou: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "arquivo_ler", new { caminho = "anotação.txt" });
            Confere(erro && texto.Contains("caminho completo"), $"caminho relativo deveria ser recusado: {texto}");

            // Arquivo antigo do Windows (ANSI, CRLF) mantém a codificação e as quebras ao editar.
            var antigo = Path.Combine(pasta, "antigo.ini");
            File.WriteAllBytes(antigo, Encoding.Latin1.GetBytes("[seção]\r\nopção=não\r\n"));
            (texto, erro, _) = await Chamar(nucleo, "arquivo_editar", new { caminho = antigo, antigo = "[seção]\nopção=não", novo = "[seção]\nopção=sim" });
            Confere(!erro, $"edição em arquivo ANSI falhou: {texto}");
            Confere(Encoding.Latin1.GetString(File.ReadAllBytes(antigo)) == "[seção]\r\nopção=sim\r\n", "mudou a codificação ou as quebras de linha");
        }
        finally { Directory.Delete(pasta, true); }
    }

    private static async Task ArquivosBinario()
    {
        using var nucleo = new Nucleo();
        await Ativar(nucleo.Sessao);
        var pasta = PastaDeTeste();
        try
        {
            var bytes = Enumerable.Range(0, 70_000).Select((i) => (byte)(i * 31 % 256)).ToArray();
            var arquivo = Path.Combine(pasta, "dados.bin");
            var (texto, erro, _) = await Chamar(nucleo, "arquivo_enviar", new { caminho = arquivo, conteudoBase64 = Convert.ToBase64String(bytes) });
            Confere(!erro && File.ReadAllBytes(arquivo).SequenceEqual(bytes), $"envio corrompido: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "arquivo_enviar", new { caminho = arquivo, conteudoBase64 = "AAAA" });
            Confere(erro && texto.Contains("já existe"), $"sobrescreveu sem pedir: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "arquivo_ler", new { caminho = arquivo });
            Confere(erro && texto.Contains("remoto_arquivo_baixar"), $"leu binário como texto: {texto}");
            var (_, falhou, bruto) = await Chamar(nucleo, "arquivo_baixar", new { caminho = arquivo });
            var json = JsonSerializer.SerializeToNode(bruto, McpJsonUtilities.DefaultOptions);
            var blob = json?["content"]?[1]?["resource"]?["blob"]?.GetValue<string>();
            Confere(!falhou && blob is not null && Convert.FromBase64String(blob).SequenceEqual(bytes), "download corrompido");
        }
        finally { Directory.Delete(pasta, true); }
    }

    // ---- Tela ----------------------------------------------------------------------

    private static Task CapturaDeTela()
    {
        var imagem = Captura.TelaInteira();
        Confere(imagem.Png.Length > 1000 && imagem.Png.AsSpan(0, 4).SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47 }), "a captura não é um PNG");
        Confere(imagem.Largura is > 0 and <= Captura.LarguraMaxima && imagem.Altura > 0, "tamanho da captura inválido");
        Confere(Captura.Monitores().Length >= 1, "nenhum monitor");
        return Task.CompletedTask;
    }

    private static async Task Janelas()
    {
        using var nucleo = new Nucleo();
        await Ativar(nucleo.Sessao);
        var (texto, erro, _) = await Chamar(nucleo, "list_windows");
        Confere(!erro && JsonNode.Parse(texto) is JsonArray, $"lista de janelas inválida: {texto}");

        var mistura = new JsonArray(
            new JsonObject { ["id"] = "1", ["processId"] = Environment.ProcessId },
            new JsonObject { ["id"] = "2", ["processId"] = 4 });
        var limpa = Automacao.SemAsNossas(mistura);
        Confere(limpa.Count == 1 && limpa[0]?["id"]?.GetValue<string>() == "2", "a janela do suporte apareceu na lista");

        var captura = nucleo.Automacao.Guardar("77", 960, 540, 1920, 1080);
        var (x, y) = nucleo.Automacao.Escalar("77", captura, 100, 50);
        Confere(x == 200 && y == 100, $"escala errada: {x},{y}");
        nucleo.Automacao.Esquecer("77");
        (texto, erro, _) = await Chamar(nucleo, "click", new { windowId = "0", screenshotId = captura, x = 1, y = 1 });
        Confere(erro, $"aceitou windowId inválido: {texto}");
    }

    // ---- Servidor MCP --------------------------------------------------------------

    private static async Task<(int Status, string Corpo)> Http(Nucleo nucleo, string metodo, string? token, object? corpo)
    {
        var frames = new List<JsonNode>();
        var resposta = new RespostaHttp((frame) =>
        {
            lock (frames) frames.Add(JsonSerializer.SerializeToNode(frame)!);
            return Task.CompletedTask;
        }, 1);
        var cabecalhos = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["content-type"] = "application/json", ["accept"] = "application/json, text/event-stream" };
        if (token is not null) cabecalhos["authorization"] = $"Bearer {token}";
        var pedido = new PedidoHttp { Rid = 1, Metodo = metodo, Url = $"{Contrato.CaminhoMcp}/sessao", Cabecalhos = cabecalhos, Resposta = resposta };
        if (corpo is not null) pedido.Corpo.Write(JsonSerializer.SerializeToUtf8Bytes(corpo));
        pedido.Corpo.Position = 0;
        await nucleo.Mcp.AtenderAsync(pedido);
        var status = frames.First((f) => f["type"]?.GetValue<string>() == "head")["status"]!.GetValue<int>();
        var bytes = frames.Where((f) => f["type"]?.GetValue<string>() == "data").SelectMany((f) => Convert.FromBase64String(f["b64"]!.GetValue<string>())).ToArray();
        Confere(frames[^1]["type"]?.GetValue<string>() == "end", "a resposta não foi fechada");
        return (status, Encoding.UTF8.GetString(bytes));
    }

    private static JsonNode Evento(string sse)
    {
        var linha = sse.Split('\n').LastOrDefault((l) => l.StartsWith("data: ", StringComparison.Ordinal))
            ?? throw new InvalidOperationException($"sem evento na resposta: {sse}");
        return JsonNode.Parse(linha[6..])!;
    }

    private static async Task ServidorMcp()
    {
        using var nucleo = new Nucleo();
        var lista = new { jsonrpc = "2.0", id = 1, method = "tools/list" };
        Confere((await Http(nucleo, "POST", "token", lista)).Status == 401, "atendeu sem sessão ativa");
        var token = await Ativar(nucleo.Sessao);
        Confere((await Http(nucleo, "POST", null, lista)).Status == 401, "atendeu sem token");
        Confere((await Http(nucleo, "POST", token[..^1] + "x", lista)).Status == 401, "atendeu com token errado");
        Confere((await Http(nucleo, "GET", token, null)).Status == 405, "GET deveria ser recusado");
        Confere((await Http(nucleo, "POST", token, "isto não é JSON-RPC")).Status == 400, "aceitou corpo inválido");

        var (status, corpo) = await Http(nucleo, "POST", token, new
        {
            jsonrpc = "2.0", id = 0, method = "initialize",
            @params = new { protocolVersion = "2025-06-18", capabilities = new { }, clientInfo = new { name = "autoteste", version = "1" } }
        });
        Confere(status == 200 && Evento(corpo)["result"]?["serverInfo"]?["name"]?.GetValue<string>() == "remoto", $"initialize falhou: {status} {corpo}");

        (status, corpo) = await Http(nucleo, "POST", token, lista);
        var ferramentas = Evento(corpo)["result"]?["tools"] as JsonArray;
        Confere(status == 200 && ferramentas?.Count == nucleo.Ferramentas.Todas.Count, $"tools/list incompleto: {status} {corpo}");

        (status, corpo) = await Http(nucleo, "POST", token, new
        {
            jsonrpc = "2.0", id = 2, method = "tools/call", @params = new { name = "remoto_info", arguments = new { } }
        });
        var texto = Evento(corpo)["result"]?["content"]?[0]?["text"]?.GetValue<string>() ?? "";
        Confere(status == 200 && texto.Contains(Environment.MachineName), $"remoto_info não respondeu: {status} {corpo}");

        Confere((await Http(nucleo, "POST", token, new { jsonrpc = "2.0", method = "notifications/initialized" })).Status == 202, "notificação deveria responder 202");
        nucleo.Sessao.Encerrar("teste");
        Confere((await Http(nucleo, "POST", token, lista)).Status == 401, "token valeu depois de encerrar");
    }

    // ---- Elevação ------------------------------------------------------------------

    private static async Task CanalDaElevacao()
    {
        Confere(await Elevacao.ReceberEstadoAsync("outro-nome", CancellationToken.None) is null, "aceitou nome de canal fora do padrão");
        var estado = new EstadoRetomada("sessao", "segredo", "token", "Teste", DateTime.Now,
            new Dictionary<string, string> { [Contrato.RecursoTela] = "Ligado" }, [new EntradaRegistro(DateTime.Now, "ação")]);
        var nome = Elevacao.NovoNome();
        await using var cano = Elevacao.CriarServidor(nome);
        var entrega = Elevacao.EntregarAsync(cano, (uint)Environment.ProcessId, estado, 10_000, CancellationToken.None);
        var recebido = await Elevacao.ReceberEstadoAsync(nome, CancellationToken.None)
            ?? throw new InvalidOperationException("o exe não recebeu o estado");
        Confere(recebido.Estado.Token == "token" && recebido.Estado.Registro.Count == 1, "estado chegou diferente");
        await recebido.Responder(true);
        Confere(await entrega, "a entrega não foi confirmada");

        // Processo que não é o esperado: nada é entregue.
        var outroNome = Elevacao.NovoNome();
        await using var outro = Elevacao.CriarServidor(outroNome);
        var recusa = Elevacao.EntregarAsync(outro, 4, estado, 10_000, CancellationToken.None);
        var semEstado = Elevacao.ReceberEstadoAsync(outroNome, CancellationToken.None);
        Confere(!await recusa, "entregou a sessão a um processo inesperado");
        outro.Disconnect();
        Confere(await semEstado is null, "recebeu estado de uma entrega recusada");
    }
}
