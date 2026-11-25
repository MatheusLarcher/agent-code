using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AgentCode.Suporte;

/// <summary>A extensão não está ligada à ponte (não instalada, Chrome fechado ou reconectando).</summary>
internal sealed class ChromeDesconectadoException() : Exception("Chrome não conectado.");

/// <summary>
/// A ponte local a que a extensão do Chrome se liga, com o contrato de
/// <c>src/main/chromeBridge/protocol.ts</c> (<c>hello</c>, <c>welcome</c>,
/// <c>ping</c>/<c>pong</c>, <c>req</c>, <c>res</c>). Escuta só em <c>127.0.0.1</c>; quem
/// entra tem que ser uma extensão do Chrome (cabeçalho de origem) e saber o token da
/// sessão. Uma conexão por vez: a mais nova substitui a anterior.
/// </summary>
internal sealed partial class PonteChrome(string token, string versao, int[]? portas = null)
{
    internal const int HelloMs = 3000;
    internal const int PedidoMs = 30_000;
    internal const int FechoSemAcesso = 4001;
    private const int MaximoMensagem = 32 * 1024 * 1024;
    private const int MaximoCabecalho = 16 * 1024;
    private const string GuidDoProtocolo = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private sealed class Conexao(WebSocket socket)
    {
        internal WebSocket Socket { get; } = socket;
        internal SemaphoreSlim Envio { get; } = new(1, 1);
        internal TaskCompletionSource Caiu { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    [GeneratedRegex("^chrome-extension://[a-p]{32}$")]
    private static partial Regex OrigemDeExtensao();

    private readonly int[] portas = portas ?? ExtensaoChrome.Portas;
    private readonly byte[] tokenBytes = Encoding.UTF8.GetBytes(token);
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonNode?>> pendentes = new();
    private readonly CancellationTokenSource vida = new();
    private TcpListener? escuta;
    private volatile Conexao? ativa;
    private long proximoId;

    internal int? Porta { get; private set; }
    internal bool Conectada => ativa is { Socket.State: WebSocketState.Open };
    /// <summary>A extensão já se ligou alguma vez: está instalada no Chrome do cliente.</summary>
    internal bool JaConectou { get; private set; }
    internal string? VersaoDaExtensao { get; private set; }
    internal string? Navegador { get; private set; }

    /// <summary>Escuta na primeira porta livre da lista. Só <c>127.0.0.1</c>.</summary>
    internal int Iniciar()
    {
        if (Porta is { } atual) return atual;
        foreach (var porta in portas)
        {
            var tentativa = new TcpListener(IPAddress.Loopback, porta) { ExclusiveAddressUse = true };
            try { tentativa.Start(8); }
            catch (SocketException) { continue; }
            escuta = tentativa;
            Porta = ((IPEndPoint)tentativa.LocalEndpoint).Port;
            _ = Task.Run(() => AceitarAsync(tentativa, vida.Token));
            return Porta.Value;
        }
        throw new InvalidOperationException($"Nenhuma porta livre para a ponte do Chrome: {string.Join(", ", portas)}.");
    }

    internal async Task<JsonNode?> ChamarAsync(string metodo, JsonObject parametros, int prazoMs, CancellationToken ct)
    {
        var conexao = ativa;
        if (conexao is not { Socket.State: WebSocketState.Open }) throw new ChromeDesconectadoException();
        var id = Interlocked.Increment(ref proximoId);
        var espera = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pendentes[id] = espera;
        try
        {
            await EnviarAsync(conexao, new JsonObject { ["type"] = "req", ["id"] = id, ["method"] = metodo, ["params"] = parametros });
            return await espera.Task.WaitAsync(TimeSpan.FromMilliseconds(prazoMs), ct);
        }
        catch (TimeoutException) { throw new TimeoutException("Tempo esgotado aguardando o Chrome."); }
        finally { pendentes.TryRemove(id, out _); }
    }

    /// <summary>Espera a conexão atual cair (é o que acontece quando a extensão é removida).</summary>
    internal async Task<bool> EsperarQuedaAsync(int prazoMs)
    {
        var conexao = ativa;
        if (conexao is null) return true;
        try
        {
            await conexao.Caiu.Task.WaitAsync(TimeSpan.FromMilliseconds(prazoMs));
            return true;
        }
        catch (TimeoutException) { return false; }
    }

    internal async Task PararAsync()
    {
        vida.Cancel();
        try { escuta?.Stop(); } catch { /* já parada */ }
        Porta = null;
        var conexao = ativa;
        ativa = null;
        RecusarPendentes();
        if (conexao is not null) await FecharAsync(conexao, WebSocketCloseStatus.EndpointUnavailable, "encerrado");
    }

    // ---- Entrada ------------------------------------------------------------------

    private async Task AceitarAsync(TcpListener listener, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient cliente;
            try { cliente = await listener.AcceptTcpClientAsync(ct); }
            catch { return; }
            _ = Task.Run(() => AtenderAsync(cliente, ct), CancellationToken.None);
        }
    }

    private async Task AtenderAsync(TcpClient cliente, CancellationToken ct)
    {
        using var dono = cliente;
        try
        {
            cliente.NoDelay = true;
            var fluxo = cliente.GetStream();
            var chave = await ApertoDeMaoAsync(fluxo, ct);
            if (chave is null) return;

            using var socket = WebSocket.CreateFromStream(fluxo, new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = TimeSpan.FromSeconds(30) });
            var conexao = new Conexao(socket);
            if (!await ApresentacaoAsync(conexao, ct))
            {
                await FecharAsync(conexao, (WebSocketCloseStatus)FechoSemAcesso, "unauthorized");
                return;
            }
            try
            {
                while (await ReceberAsync(socket, ct) is { } mensagem)
                {
                    if (!ReferenceEquals(ativa, conexao)) break;
                    switch (Curto(mensagem["type"], 20))
                    {
                        case "ping": await EnviarAsync(conexao, new JsonObject { ["type"] = "pong" }); break;
                        case "res": Resposta(mensagem); break;
                    }
                }
            }
            finally
            {
                if (ReferenceEquals(ativa, conexao))
                {
                    ativa = null;
                    RecusarPendentes();
                }
                conexao.Caiu.TrySetResult();
            }
        }
        catch { /* conexão quebrada: a extensão tenta de novo sozinha */ }
    }

    /// <summary>Lê o pedido de upgrade e responde 101. Devolve nulo (e 403) se não for uma extensão do Chrome.</summary>
    private static async Task<string?> ApertoDeMaoAsync(NetworkStream fluxo, CancellationToken ct)
    {
        using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
        prazo.CancelAfter(5000);
        var lidos = new MemoryStream();
        var pedaco = new byte[2048];
        string texto;
        while (true)
        {
            var n = await fluxo.ReadAsync(pedaco, prazo.Token);
            if (n == 0) return null;
            lidos.Write(pedaco, 0, n);
            texto = Encoding.ASCII.GetString(lidos.GetBuffer(), 0, (int)lidos.Length);
            if (texto.Contains("\r\n\r\n", StringComparison.Ordinal)) break;
            if (lidos.Length > MaximoCabecalho) return null;
        }
        // Nada pode vir depois do cabeçalho antes do 101.
        var valido = texto.EndsWith("\r\n\r\n", StringComparison.Ordinal);
        var linhas = texto.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        var cabecalhos = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var linha in linhas.Skip(1))
        {
            var corte = linha.IndexOf(':');
            if (corte > 0) cabecalhos[linha[..corte].Trim()] = linha[(corte + 1)..].Trim();
        }
        valido = valido
            && linhas.Length > 0 && linhas[0].StartsWith("GET ", StringComparison.Ordinal)
            && cabecalhos.GetValueOrDefault("Upgrade", "").Equals("websocket", StringComparison.OrdinalIgnoreCase)
            && cabecalhos.GetValueOrDefault("Sec-WebSocket-Version") == "13"
            && cabecalhos.TryGetValue("Sec-WebSocket-Key", out var chaveLida) && chaveLida.Length is > 0 and <= 64
            && OrigemDeExtensao().IsMatch(cabecalhos.GetValueOrDefault("Origin", ""));
        if (!valido)
        {
            await fluxo.WriteAsync("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"u8.ToArray(), prazo.Token);
            return null;
        }
        var chave = cabecalhos["Sec-WebSocket-Key"];
        var aceite = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(chave + GuidDoProtocolo)));
        await fluxo.WriteAsync(Encoding.ASCII.GetBytes(
            $"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {aceite}\r\n\r\n"), prazo.Token);
        return chave;
    }

    /// <summary>A primeira mensagem tem que ser o <c>hello</c> com o token, em até 3 s.</summary>
    private async Task<bool> ApresentacaoAsync(Conexao conexao, CancellationToken ct)
    {
        JsonObject? hello;
        using (var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            prazo.CancelAfter(HelloMs);
            try { hello = await ReceberAsync(conexao.Socket, prazo.Token); }
            catch { return false; }
        }
        if (hello is null || Curto(hello["type"], 20) != "hello") return false;
        var recebido = hello["token"] is JsonValue valor && valor.TryGetValue<string>(out var textoToken) ? textoToken : "";
        if (recebido.Length > 128 || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(recebido), tokenBytes)) return false;

        var antiga = ativa;
        ativa = conexao;
        JaConectou = true;
        VersaoDaExtensao = Curto(hello["version"], 40);
        Navegador = Curto(hello["userAgent"], 300);
        if (antiga is not null)
        {
            RecusarPendentes();
            _ = FecharAsync(antiga, WebSocketCloseStatus.NormalClosure, "replaced");
        }
        await EnviarAsync(conexao, new JsonObject { ["type"] = "welcome", ["version"] = versao });
        return true;
    }

    private static string? Curto(JsonNode? no, int maximo)
        => no is JsonValue valor && valor.TryGetValue<string>(out var texto) ? (texto.Length > maximo ? texto[..maximo] : texto) : null;

    private void Resposta(JsonObject mensagem)
    {
        if (mensagem["id"] is not JsonValue numero || !numero.TryGetValue<long>(out var id)) return;
        if (!pendentes.TryRemove(id, out var espera)) return;
        if (mensagem["ok"] is JsonValue ok && ok.TryGetValue<bool>(out var deuCerto) && deuCerto)
        {
            espera.TrySetResult(mensagem["result"]?.DeepClone());
            return;
        }
        var erro = mensagem["error"] is JsonValue textoErro && textoErro.TryGetValue<string>(out var motivo) ? motivo : "Erro desconhecido";
        espera.TrySetException(new InvalidOperationException(erro.Length > 800 ? erro[..800] : erro));
    }

    private void RecusarPendentes()
    {
        foreach (var id in pendentes.Keys)
        {
            if (pendentes.TryRemove(id, out var espera)) espera.TrySetException(new ChromeDesconectadoException());
        }
    }

    // ---- Fio ------------------------------------------------------------------------

    private static async Task<JsonObject?> ReceberAsync(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var mensagem = new MemoryStream();
        while (true)
        {
            var lido = await socket.ReceiveAsync(buffer.AsMemory(), ct);
            if (lido.MessageType == WebSocketMessageType.Close) return null;
            mensagem.Write(buffer, 0, lido.Count);
            if (mensagem.Length > MaximoMensagem) return null;
            if (!lido.EndOfMessage) continue;
            try
            {
                // Mensagem que não é um objeto JSON é ignorada, como na ponte do Agent Code.
                if (JsonNode.Parse(mensagem.GetBuffer().AsSpan(0, (int)mensagem.Length)) is JsonObject objeto) return objeto;
            }
            catch (JsonException) { /* segue lendo */ }
            mensagem.SetLength(0);
        }
    }

    private static async Task EnviarAsync(Conexao conexao, JsonObject mensagem)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(mensagem);
        await conexao.Envio.WaitAsync();
        try
        {
            if (conexao.Socket.State == WebSocketState.Open)
                await conexao.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch { /* conexão caiu: o laço de leitura percebe */ }
        finally { conexao.Envio.Release(); }
    }

    private static async Task FecharAsync(Conexao conexao, WebSocketCloseStatus codigo, string motivo)
    {
        try
        {
            using var prazo = new CancellationTokenSource(1500);
            if (conexao.Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await conexao.Socket.CloseOutputAsync(codigo, motivo, prazo.Token);
        }
        catch { /* já caiu */ }
        try { conexao.Socket.Abort(); } catch { /* ignore */ }
    }
}
