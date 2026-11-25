using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using ModelContextProtocol.Protocol;
using static AgentCode.Suporte.AutoTeste;

namespace AgentCode.Suporte;

/// <summary>
/// Parte do <c>--self-test</c>: o recurso Chrome sem Chrome. Uma extensão falsa (um
/// cliente WebSocket) fala com a ponte de verdade, com o contrato da extensão real.
/// O caminho com o Chrome de verdade é o de <c>scripts/suporte-e2e.mjs</c>.
/// </summary>
internal static class AutoTesteChrome
{
    private const string Origem = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    private static readonly byte[] JpegFalso = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8, 0xFF, 0xD9];

    /// <summary>O lado da extensão: liga, se apresenta e responde aos pedidos da ponte.</summary>
    private sealed class ExtensaoFalsa : IAsyncDisposable
    {
        private readonly ClientWebSocket socket = new();
        private readonly List<string> pedidos = [];
        private Task? laco;

        internal string[] Pedidos { get { lock (pedidos) return [.. pedidos]; } }
        internal string? Versao { get; private set; }
        internal WebSocketCloseStatus? Fecho => socket.CloseStatus;

        internal async Task<bool> LigarAsync(int porta, string token, string? origem = Origem)
        {
            if (origem is not null) socket.Options.SetRequestHeader("Origin", origem);
            try { await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{porta}/"), new CancellationTokenSource(5000).Token); }
            catch (WebSocketException) { return false; }
            await EnviarAsync(new JsonObject { ["type"] = "hello", ["token"] = token, ["version"] = "9.9.9", ["userAgent"] = "Extensão Falsa" });
            var resposta = await ReceberAsync();
            if (resposta?["type"]?.GetValue<string>() != "welcome") return false;
            Versao = resposta["version"]?.GetValue<string>();
            laco = Task.Run(AtenderAsync);
            return true;
        }

        private async Task AtenderAsync()
        {
            try
            {
                while (await ReceberAsync(Timeout.Infinite) is { } mensagem)
                {
                    if (mensagem["type"]?.GetValue<string>() != "req") continue;
                    var metodo = mensagem["method"]?.GetValue<string>() ?? "";
                    lock (pedidos) pedidos.Add($"{metodo} {mensagem["params"]?.ToJsonString()}");
                    JsonNode? resultado = metodo switch
                    {
                        "status" => new JsonObject { ["paused"] = false, ["userAgent"] = "Extensão Falsa" },
                        "listTabs" => new JsonObject { ["tabs"] = new JsonArray(new JsonObject { ["tabId"] = 7, ["windowId"] = 1, ["active"] = true, ["url"] = "https://exemplo.test/ação", ["title"] = "Página de Exemplo" }) },
                        "screenshot" => new JsonObject { ["data"] = Convert.ToBase64String(JpegFalso), ["tabId"] = 7, ["url"] = "https://exemplo.test/ação", ["title"] = "Página de Exemplo" },
                        "snapshot" => new JsonObject { ["text"] = "[e1] button \"Enviar\"", ["tabId"] = 7, ["url"] = "https://exemplo.test/ação", ["title"] = "Página de Exemplo" },
                        "click" => new JsonObject { ["tabId"] = mensagem["params"]?["tabId"]?.DeepClone(), ["url"] = "https://exemplo.test/ação", ["title"] = "Página de Exemplo" },
                        "uninstallSelf" => new JsonObject { ["removing"] = true },
                        _ => null
                    };
                    var resposta = new JsonObject { ["type"] = "res", ["id"] = mensagem["id"]?.DeepClone(), ["ok"] = resultado is not null };
                    if (resultado is not null) resposta["result"] = resultado;
                    else resposta["error"] = $"Método desconhecido: {metodo}";
                    await EnviarAsync(resposta);
                    if (metodo == "uninstallSelf")
                    {
                        // Removida de verdade, a extensão some e a conexão cai.
                        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "removida", CancellationToken.None);
                        return;
                    }
                }
            }
            catch { /* a ponte fechou */ }
        }

        internal Task EnviarAsync(JsonObject mensagem)
            => socket.SendAsync(Encoding.UTF8.GetBytes(mensagem.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);

        internal async Task<JsonObject?> ReceberAsync(int prazoMs = 5000)
        {
            var buffer = new byte[64 * 1024];
            using var mensagem = new MemoryStream();
            using var prazo = new CancellationTokenSource(prazoMs);
            while (true)
            {
                var lido = await socket.ReceiveAsync(buffer.AsMemory(), prazo.Token);
                if (lido.MessageType == WebSocketMessageType.Close) return null;
                mensagem.Write(buffer, 0, lido.Count);
                if (lido.EndOfMessage) return JsonNode.Parse(mensagem.ToArray()) as JsonObject;
            }
        }

        /// <summary>O Chrome fechou: a conexão some sem aviso.</summary>
        internal void Cair() => socket.Abort();

        public async ValueTask DisposeAsync()
        {
            try { socket.Abort(); } catch { /* já fechado */ }
            if (laco is not null) await laco;
            socket.Dispose();
        }
    }

    private static async Task Ate(Func<bool> condicao, string oQue, int prazoMs = 8000)
    {
        for (var espera = 0; !condicao(); espera += 25)
        {
            if (espera > prazoMs) throw new InvalidOperationException($"tempo esgotado esperando: {oQue}");
            await Task.Delay(25);
        }
    }

    // ---- Pasta ---------------------------------------------------------------------

    internal static Task Pasta()
    {
        var raiz = PastaDeTeste();
        var pasta = Path.Combine(raiz, "chrome-extension");
        try
        {
            var token = ExtensaoChrome.NovoToken();
            Confere(ExtensaoChrome.TokenValido(token) && token != ExtensaoChrome.NovoToken(), "token fora do formato ou repetido");
            ExtensaoChrome.Gravar(pasta, token);
            foreach (var arquivo in new[] { "manifest.json", "background.js", "cdp.js", "snapshot.js", "picker.js", "popup.html", "popup.js", "config.js", "icons/icon48.png" })
                Confere(File.Exists(Path.Combine(pasta, arquivo)), $"faltou {arquivo} na pasta da extensão");

            var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(pasta, "manifest.json")))!;
            Confere(manifest["key"] is null, "a cópia do suporte não pode levar a key (tomaria o lugar da extensão do Agent Code)");
            Confere(manifest["name"]!.GetValue<string>().StartsWith(ExtensaoChrome.Nome), "o cartão não diz que é do suporte");
            Confere(manifest["version"]!.GetValue<string>() == ExtensaoChrome.Versao && ExtensaoChrome.Versao.Split('.').Length == 3, "versão do manifest errada");
            var permissoes = (manifest["permissions"] as JsonArray)!.Select((p) => p!.GetValue<string>()).Order().ToArray();
            Confere(permissoes.SequenceEqual(new[] { "alarms", "debugger", "storage", "tabGroups", "tabs" }), $"permissões mudaram: {string.Join(",", permissoes)}");

            var config = File.ReadAllText(Path.Combine(pasta, "config.js"));
            Confere(config.Contains($"\"token\":\"{token}\"") && config.Contains("\"suporte\":true"), "config.js sem o token ou sem a marca do suporte");
            Confere(ExtensaoChrome.Portas.All((porta) => config.Contains(porta.ToString())), "config.js sem as portas do contrato");
            Confere(ExtensaoChrome.TokenGravado(pasta) == token, "não releu o token da pasta");
            Confere(File.ReadAllText(Path.Combine(pasta, "background.js")).Contains("uninstallSelf"), "a extensão embutida não sabe se remover");

            ExtensaoChrome.Gravar(pasta, ExtensaoChrome.NovoToken());
            Confere(ExtensaoChrome.TokenGravado(pasta) != token, "regravar não trocou o token");
            Confere(ExtensaoChrome.Apagar(pasta) && !Directory.Exists(pasta), "a pasta não foi apagada");
        }
        finally { Directory.Delete(raiz, true); }
        return Task.CompletedTask;
    }

    // ---- Ponte ---------------------------------------------------------------------

    internal static async Task Ponte()
    {
        var token = ExtensaoChrome.NovoToken();
        var ponte = new PonteChrome(token, "1.2.3", [0]);
        var porta = ponte.Iniciar();
        try
        {
            Confere(porta > 0 && !ponte.Conectada, "a ponte não subiu");
            await using (var intrusa = new ExtensaoFalsa())
                Confere(!await intrusa.LigarAsync(porta, token, "https://site.exemplo"), "aceitou uma página da web");
            await using (var semOrigem = new ExtensaoFalsa())
                Confere(!await semOrigem.LigarAsync(porta, token, null), "aceitou conexão sem origem");
            await using (var errada = new ExtensaoFalsa())
            {
                Confere(!await errada.LigarAsync(porta, ExtensaoChrome.NovoToken()), "aceitou token errado");
                Confere((int?)errada.Fecho == PonteChrome.FechoSemAcesso, $"fecho {errada.Fecho}, esperava {PonteChrome.FechoSemAcesso}");
            }
            Confere(!ponte.Conectada && !ponte.JaConectou, "conexão recusada contou como instalada");
            try
            {
                await ponte.ChamarAsync("listTabs", new JsonObject(), 1000, CancellationToken.None);
                Confere(false, "chamou sem extensão");
            }
            catch (ChromeDesconectadoException) { /* esperado */ }

            await using var extensao = new ExtensaoFalsa();
            Confere(await extensao.LigarAsync(porta, token) && extensao.Versao == "1.2.3", "a extensão certa não entrou");
            await Ate(() => ponte.Conectada, "a ponte ver a extensão");
            Confere(ponte.VersaoDaExtensao == "9.9.9" && ponte.Navegador == "Extensão Falsa" && ponte.JaConectou, "apresentação não registrada");
            var abas = await ponte.ChamarAsync("listTabs", new JsonObject(), 5000, CancellationToken.None);
            Confere(abas?["tabs"]?[0]?["title"]?.GetValue<string>() == "Página de Exemplo", "a resposta da extensão não chegou");
            try
            {
                await ponte.ChamarAsync("naoExiste", new JsonObject(), 5000, CancellationToken.None);
                Confere(false, "erro da extensão não virou erro");
            }
            catch (InvalidOperationException erro) { Confere(erro.Message.Contains("Método desconhecido"), erro.Message); }

            // Uma segunda extensão válida toma o lugar da primeira.
            await using var segunda = new ExtensaoFalsa();
            Confere(await segunda.LigarAsync(porta, token), "a segunda extensão não entrou");
            await ponte.ChamarAsync("status", new JsonObject(), 5000, CancellationToken.None);
            Confere(segunda.Pedidos.Length == 1 && extensao.Pedidos.Length == 2, "a chamada não foi para a conexão mais nova");
        }
        finally { await ponte.PararAsync(); }
        Confere(ponte.Porta is null, "a ponte não parou");
    }

    // ---- Ferramentas ---------------------------------------------------------------

    internal static async Task SemPermitir()
    {
        var raiz = PastaDeTeste();
        try
        {
            using var nucleo = new Nucleo(raiz, [0]);
            await Ativar(nucleo.Sessao);
            var doChrome = nucleo.Ferramentas.Todas.Where((f) => f.Nome.StartsWith(Contrato.PrefixoFerramenta + "chrome_", StringComparison.Ordinal)).ToList();
            Confere(doChrome.Count == 15 && doChrome.All((f) => f.Recurso == Contrato.RecursoChrome), $"{doChrome.Count} ferramentas do Chrome");
            foreach (var ferramenta in doChrome)
            {
                var (texto, erro, _) = await Chamar(nucleo, ferramenta.Nome[Contrato.PrefixoFerramenta.Length..]);
                Confere(erro && texto.Contains("peça ao cliente"), $"{ferramenta.Nome} passou sem o Permitir: {texto}");
            }
            Confere(nucleo.Extras.Chrome.Ponte is null && !Directory.Exists(nucleo.Extras.Chrome.Pasta), "preparou o Chrome sem o Permitir");
        }
        finally { Directory.Delete(raiz, true); }
    }

    /// <summary>O técnico pede o recurso e o cliente clica em Permitir.</summary>
    private static async Task<string> Permitir(Nucleo nucleo)
    {
        var pedido = Chamar(nucleo, "pedir_recurso", new { recurso = Contrato.RecursoChrome });
        await Ate(() => nucleo.Sessao.PedidoAberto, "o pedido chegar à janela");
        Confere(nucleo.Extras.Chrome.Ponte is null && !Directory.Exists(nucleo.Extras.Chrome.Pasta), "preparou antes do clique do cliente");
        nucleo.Sessao.Responder(true);
        var (texto, erro, _) = await pedido;
        Confere(!erro, $"o pedido de recurso falhou: {texto}");
        return texto;
    }

    private static async Task<ExtensaoFalsa> Instalar(Nucleo nucleo)
    {
        var chrome = nucleo.Extras.Chrome;
        var extensao = new ExtensaoFalsa();
        Confere(await extensao.LigarAsync(chrome.Ponte!.Porta!.Value, ExtensaoChrome.TokenGravado(chrome.Pasta)!), "a extensão não conectou com o token da pasta");
        await Ate(() => chrome.Ponte.Conectada, "a ponte ver a extensão");
        return extensao;
    }

    internal static async Task Ciclo()
    {
        var raiz = PastaDeTeste();
        try
        {
            using var nucleo = new Nucleo(raiz, [0]);
            await Ativar(nucleo.Sessao);
            var chrome = nucleo.Extras.Chrome;
            var orientacao = await Permitir(nucleo);
            Confere(orientacao.Contains(chrome.Pasta) && orientacao.Contains("Carregar sem compactação"), $"a resposta não ensina a instalar: {orientacao}");
            Confere(nucleo.Sessao.Recurso(Contrato.RecursoChrome) == EstadoRecurso.Ligado && File.Exists(Path.Combine(chrome.Pasta, "config.js")), "o Permitir não preparou a pasta");
            Confere(chrome.Ponte?.Porta is > 0, "o Permitir não subiu a ponte");

            var (texto, erro, _) = await Chamar(nucleo, "chrome_status");
            Confere(!erro && texto.Contains("\"conectada\": false") && texto.Contains("chrome-extension"), $"status antes de instalar: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "chrome_list_tabs");
            Confere(erro && texto.Contains("não está conectada") && texto.Contains(chrome.Pasta), $"sem extensão deveria ensinar a instalar: {texto}");

            await using var extensao = await Instalar(nucleo);
            (texto, erro, _) = await Chamar(nucleo, "chrome_status");
            Confere(!erro && texto.Contains("\"conectada\": true"), $"status depois de instalar: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "chrome_list_tabs");
            Confere(!erro && texto.Contains("Página de Exemplo") && texto.Contains("https://exemplo.test/ação"), $"lista de abas: {texto}");
            var (_, falhou, bruto) = await Chamar(nucleo, "chrome_screenshot");
            var imagem = bruto.Content.OfType<ImageContentBlock>().FirstOrDefault();
            Confere(!falhou && imagem?.MimeType == "image/jpeg", "a captura não veio como imagem JPEG");
            Confere(chrome.UltimaAba == 7, "não guardou a última aba");
            (texto, erro, _) = await Chamar(nucleo, "chrome_click", new { @ref = "e1" });
            Confere(!erro && extensao.Pedidos[^1] == "click {\"ref\":\"e1\",\"tabId\":7}", $"clique não usou a última aba: {extensao.Pedidos[^1]}");
            (texto, erro, _) = await Chamar(nucleo, "chrome_click", new { @ref = "botão" });
            Confere(erro && texto.Contains("ref"), $"aceitou ref inválida: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "chrome_open_tab", new { url = "exemplo sem esquema" });
            Confere(erro && texto.Contains("endereço completo"), $"aceitou url inválida: {texto}");
            (texto, erro, _) = await Chamar(nucleo, "chrome_evaluate", new { expression = "1+1" });
            Confere(erro && texto.Contains("Método desconhecido"), $"erro da extensão não chegou: {texto}");

            // O cliente desliga a chave: a extensão se remove, a ponte fecha, a pasta some.
            var pasta = chrome.Pasta;
            var sobrou = false;
            nucleo.SobrouExtensao += () => sobrou = true;
            nucleo.Sessao.Alternar(Contrato.RecursoChrome, false);
            await Ate(() => !Directory.Exists(pasta) && chrome.Ponte is null, "a limpeza da chave desligada");
            Confere(extensao.Pedidos[^1].StartsWith("uninstallSelf"), "a extensão não recebeu a ordem de se remover");
            Confere(!sobrou, "avisou de sobra com a extensão removida");
            (texto, erro, _) = await Chamar(nucleo, "chrome_list_tabs");
            Confere(erro && texto.Contains("O cliente desligou este recurso"), $"chave desligada não bloqueou: {texto}");
            var preparou = true;
            try { await chrome.GarantirAsync(); } catch (InvalidOperationException) { preparou = false; }
            Confere(!preparou && !Directory.Exists(pasta), "uma chamada atrasada preparou o Chrome com a chave desligada");

            // Religada, a sessão prepara tudo de novo, com outro token.
            nucleo.Sessao.Alternar(Contrato.RecursoChrome, true);
            (texto, erro, _) = await Chamar(nucleo, "chrome_status");
            Confere(!erro && texto.Contains("\"conectada\": false") && Directory.Exists(pasta), $"religar não preparou de novo: {texto}");
            nucleo.Sessao.Encerrar("teste");
            await Ate(() => !Directory.Exists(pasta), "a limpeza do fim da sessão");
        }
        finally { if (Directory.Exists(raiz)) Directory.Delete(raiz, true); }
    }

    internal static async Task Sobra()
    {
        var raiz = PastaDeTeste();
        try
        {
            using var nucleo = new Nucleo(raiz, [0]);
            await Ativar(nucleo.Sessao);
            await Permitir(nucleo);
            var extensao = await Instalar(nucleo);
            extensao.Cair(); // o cliente fechou o Chrome
            await Ate(() => !nucleo.Extras.Chrome.Ponte!.Conectada, "a ponte perceber a queda");
            await extensao.DisposeAsync();

            Confere(await nucleo.EncerrarAsync(), "encerrar com o Chrome fechado não avisou da extensão que ficou");
            Confere(!Directory.Exists(nucleo.Extras.Chrome.Pasta), "a pasta ficou depois de encerrar");
            Confere(nucleo.Sessao.Fase != Fase.Ativa, "a sessão não encerrou");
        }
        finally { if (Directory.Exists(raiz)) Directory.Delete(raiz, true); }
    }
}
