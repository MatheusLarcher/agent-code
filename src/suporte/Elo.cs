using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentCode.Suporte;

/// <summary>Uma requisição HTTP do técnico, descida pelo relay em frames.</summary>
internal sealed class PedidoHttp
{
    internal required long Rid { get; init; }
    internal required string Metodo { get; init; }
    internal required string Url { get; init; }
    internal required Dictionary<string, string> Cabecalhos { get; init; }
    internal required RespostaHttp Resposta { get; init; }
    internal MemoryStream Corpo { get; } = new();
    internal CancellationTokenSource Cancelar { get; } = new();
}

/// <summary>A resposta sobe pelos frames <c>head</c>/<c>data</c>/<c>end</c> do relay.</summary>
internal sealed class RespostaHttp(Func<object, Task> enviar, long rid)
{
    private const int Pedaco = 192 * 1024;
    private int fim;
    internal bool CabecalhoEnviado { get; private set; }

    internal Task CabecalhoAsync(int status, Dictionary<string, string>? cabecalhos = null)
    {
        if (CabecalhoEnviado) return Task.CompletedTask;
        CabecalhoEnviado = true;
        return enviar(new { type = "head", rid, status, headers = cabecalhos ?? new Dictionary<string, string>() });
    }

    internal async Task DadosAsync(ReadOnlyMemory<byte> dados)
    {
        for (var inicio = 0; inicio < dados.Length; inicio += Pedaco)
        {
            var parte = dados.Slice(inicio, Math.Min(Pedaco, dados.Length - inicio));
            await enviar(new { type = "data", rid, b64 = Convert.ToBase64String(parte.Span) });
        }
    }

    internal Task FimAsync()
        => Interlocked.Exchange(ref fim, 1) == 0 ? enviar(new { type = "end", rid }) : Task.CompletedTask;

    internal async Task JsonAsync(int status, object corpo, Dictionary<string, string>? extras = null)
    {
        var cabecalhos = new Dictionary<string, string> { ["content-type"] = "application/json; charset=utf-8", ["cache-control"] = "no-store" };
        foreach (var (nome, valor) in extras ?? []) cabecalhos[nome] = valor;
        await CabecalhoAsync(status, cabecalhos);
        await DadosAsync(JsonSerializer.SerializeToUtf8Bytes(corpo));
        await FimAsync();
    }
}

/// <summary>
/// Liga o exe ao relay por um WebSocket DE SAÍDA (o exe nunca abre porta). Anuncia o
/// código, entrega os pedidos de acesso à janela, remonta as requisições HTTP que
/// descem em frames e devolve as respostas. Reconecta sozinho, sempre com código novo.
/// </summary>
internal sealed class Elo(Sessao sessao, Func<PedidoHttp, Task> atender)
{
    private const int MaximoMensagem = 64 * 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly SemaphoreSlim envio = new(1, 1);
    private readonly ConcurrentDictionary<long, PedidoHttp> pedidos = new();
    private ClientWebSocket? ws;
    private TaskCompletionSource manual = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private long ultimoSinal;
    private long aguardandoDesde;
    private int espera = 1000;
    private volatile bool encerrando;

    /// <summary>Preenchido quando o exe foi reaberto como administrador (<c>--retomar</c>).</summary>
    internal EstadoRetomada? Retomada { get; set; }
    /// <summary>Resultado da retomada: o relay aceitou reassumir a sessão?</summary>
    internal event Action<bool>? RetomadaConcluida;

    internal static string Versao => Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>Botão "Novo Código": sai da espera manual (código vencido).</summary>
    internal void Reconectar() => manual.TrySetResult();

    internal async Task RodarAsync(CancellationToken ct)
    {
        sessao.RecursoMudou += (recurso, estado) =>
            _ = EnviarAsync(new { type = "evento", evento = "recurso", recurso, estado = estado.ToString().ToLowerInvariant() });

        while (!ct.IsCancellationRequested && !encerrando)
        {
            if (sessao.Fase is Fase.Expirado or Fase.Atualizar)
            {
                await manual.Task.WaitAsync(ct);
                manual = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            }
            var pausa = espera;
            try { pausa = await ConexaoAsync(ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch { espera = Math.Min(espera * 2, 30_000); }
            Caiu();
            if (encerrando) break;
            if (sessao.Fase == Fase.Conectando && pausa > 3000) sessao.DefinirFase(Fase.Indisponivel);
            try { await Task.Delay(pausa, ct); } catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>Uma conexão inteira. Devolve quanto esperar antes da próxima.</summary>
    private async Task<int> ConexaoAsync(CancellationToken ct)
    {
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromMilliseconds(Contrato.BatimentoMs);
        if (Retomada is null) sessao.NovoCodigo();
        using (var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            prazo.CancelAfter(15_000);
            await socket.ConnectAsync(Contrato.RelayUrl(), prazo.Token);
        }
        ws = socket;
        ultimoSinal = Environment.TickCount64;
        using var vida = CancellationTokenSource.CreateLinkedTokenSource(ct);
        try
        {
            await EnviarAsync(new
            {
                type = "hello",
                v = Contrato.Protocolo,
                codigo = Retomada is null ? sessao.Codigo : null,
                retomar = Retomada is null ? null : new { sessao = Retomada.Sessao, segredo = Retomada.Segredo },
                pc = Environment.MachineName,
                sistema = "windows",
                versaoSistema = Environment.OSVersion.Version.ToString(),
                versao = Versao,
                capacidades = Sessao.Disponiveis,
                admin = sessao.Admin
            });
            _ = BatimentoAsync(socket, vida.Token);
            while (await ReceberAsync(socket, vida.Token) is { } texto)
            {
                ultimoSinal = Environment.TickCount64;
                JsonNode? frame;
                try { frame = JsonNode.Parse(texto); } catch { continue; }
                if (frame is JsonObject objeto && Tratar(objeto) is { } pausa) return pausa;
            }
            return espera;
        }
        finally
        {
            vida.Cancel();
            ws = null;
            try { socket.Abort(); } catch { /* já fechado */ }
        }
    }

    /// <summary>Trata um frame. Devolve um tempo de espera quando a conexão deve acabar.</summary>
    private int? Tratar(JsonObject frame)
    {
        var tipo = Texto(frame, "type");
        switch (tipo)
        {
            case "ready":
                espera = 1000;
                if (Retomada is not null)
                {
                    Retomada = null; // daqui em diante é um exe como outro qualquer, só que elevado
                    RetomadaConcluida?.Invoke(true);
                }
                else
                {
                    aguardandoDesde = Environment.TickCount64;
                    sessao.DefinirFase(Fase.Aguardando);
                }
                return null;
            case "negado":
                if (Retomada is not null) { RetomadaConcluida?.Invoke(false); return 0; }
                switch (Texto(frame, "motivo"))
                {
                    case "codigo": return 0; // código em uso por outro exe: sorteia outro já
                    case "ocioso": sessao.DefinirFase(Fase.Expirado); return 0;
                    default: sessao.DefinirFase(Fase.Indisponivel); return 30_000;
                }
            case "atualize":
                sessao.DefinirFase(Fase.Atualizar);
                return 0;
            case "pedido":
                _ = ResponderPedidoAsync(Texto(frame, "id"), Limpar(Texto(frame, "tecnico"), 40));
                return null;
            case "cancelado":
                sessao.FecharPedido(Texto(frame, "id"));
                return null;
            case "retomar":
                if (Texto(frame, "sessao") is { Length: > 0 } id && Texto(frame, "segredo") is { Length: > 0 } segredo)
                    sessao.GuardarRetomada(id, segredo);
                return null;
            case "encerrar":
                sessao.Encerrar("O técnico encerrou a sessão");
                return 500;
            case "open": Abrir(frame); return null;
            case "data": Dados(frame); return null;
            case "end":
                if (pedidos.TryRemove(Rid(frame), out var pronto)) _ = Task.Run(() => AtenderSeguro(pronto));
                return null;
            case "abort":
                if (pedidos.TryRemove(Rid(frame), out var largado)) largado.Cancelar.Cancel();
                else if (emCurso.TryGetValue(Rid(frame), out var rodando)) rodando.Cancelar.Cancel();
                return null;
            default:
                return null;
        }
    }

    private readonly ConcurrentDictionary<long, PedidoHttp> emCurso = new();

    private async Task ResponderPedidoAsync(string id, string tecnico)
    {
        if (id.Length == 0 || tecnico.Length == 0) return;
        var clique = sessao.PedirAcesso(id, tecnico);
        var primeiro = await Task.WhenAny(clique, Task.Delay(Contrato.PedidoAcessoMs));
        if (primeiro != clique) sessao.FecharPedido(id); // sem resposta no prazo = recusado
        if (await clique) await EnviarAsync(new { type = "aceite", id, ok = true, token = sessao.Ativar() });
        else await EnviarAsync(new { type = "aceite", id, ok = false });
    }

    private void Abrir(JsonObject frame)
    {
        var rid = Rid(frame);
        var cabecalhos = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (frame["headers"] is JsonObject brutos)
        {
            foreach (var (nome, valor) in brutos)
            {
                if (valor is JsonValue simples && simples.TryGetValue<string>(out var texto)) cabecalhos[nome] = texto;
                else if (valor is JsonArray lista) cabecalhos[nome] = string.Join(", ", lista.Select((item) => item?.ToString() ?? ""));
            }
        }
        pedidos[rid] = new PedidoHttp
        {
            Rid = rid,
            Metodo = Texto(frame, "method").ToUpperInvariant(),
            Url = Texto(frame, "url"),
            Cabecalhos = cabecalhos,
            Resposta = new RespostaHttp(EnviarAsync, rid)
        };
    }

    private void Dados(JsonObject frame)
    {
        var rid = Rid(frame);
        if (!pedidos.TryGetValue(rid, out var pedido)) return;
        byte[] pedaco;
        try { pedaco = Convert.FromBase64String(Texto(frame, "b64")); } catch { return; }
        if (pedido.Corpo.Length + pedaco.Length > Contrato.ChamadaBytes)
        {
            pedidos.TryRemove(rid, out _);
            _ = pedido.Resposta.JsonAsync(413, new { erro = "chamada grande demais" });
            return;
        }
        pedido.Corpo.Write(pedaco);
    }

    private async Task AtenderSeguro(PedidoHttp pedido)
    {
        emCurso[pedido.Rid] = pedido;
        try
        {
            pedido.Corpo.Position = 0;
            await atender(pedido);
        }
        catch
        {
            try
            {
                if (!pedido.Resposta.CabecalhoEnviado) await pedido.Resposta.JsonAsync(500, new { erro = "falha ao atender a chamada" });
                else await pedido.Resposta.FimAsync();
            }
            catch { /* conexão caiu */ }
        }
        finally { emCurso.TryRemove(pedido.Rid, out _); }
    }

    private async Task BatimentoAsync(ClientWebSocket socket, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(Contrato.BatimentoMs, ct);
                var agora = Environment.TickCount64;
                if (agora - ultimoSinal > Contrato.MortoMs) { socket.Abort(); return; }
                if (sessao.Fase == Fase.Aguardando && agora - aguardandoDesde > Contrato.SemTecnicoMs)
                {
                    sessao.DefinirFase(Fase.Expirado);
                    socket.Abort();
                    return;
                }
                await EnviarAsync(new { type = "ping" });
            }
        }
        catch { /* conexão acabou */ }
    }

    private static async Task<string?> ReceberAsync(ClientWebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var mensagem = new MemoryStream();
        while (true)
        {
            var lido = await socket.ReceiveAsync(buffer.AsMemory(), ct);
            if (lido.MessageType == WebSocketMessageType.Close) return null;
            mensagem.Write(buffer, 0, lido.Count);
            if (mensagem.Length > MaximoMensagem) return null;
            if (lido.EndOfMessage) return Encoding.UTF8.GetString(mensagem.GetBuffer(), 0, (int)mensagem.Length);
        }
    }

    internal async Task EnviarAsync(object frame)
    {
        var socket = ws;
        if (socket is null || socket.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame, Json);
        await envio.WaitAsync();
        try
        {
            if (socket.State == WebSocketState.Open)
                await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch { /* conexão caiu: o laço de leitura percebe */ }
        finally { envio.Release(); }
    }

    /// <summary>A conexão acabou: o que dependia dela acaba junto, e a sessão não sobrevive.</summary>
    private void Caiu()
    {
        foreach (var pedido in pedidos.Values) pedido.Cancelar.Cancel();
        pedidos.Clear();
        foreach (var pedido in emCurso.Values) pedido.Cancelar.Cancel();
        if (encerrando) return;
        if (sessao.Fase is Fase.Ativa or Fase.PedidoAcesso or Fase.Aguardando) sessao.Encerrar("A conexão caiu");
    }

    /// <summary>O cliente encerrou: avisa o relay e fecha. Depois disso o processo sai.</summary>
    internal async Task EncerrarAsync()
    {
        encerrando = true;
        var socket = ws;
        if (socket is null) return;
        await EnviarAsync(new { type = "encerrar", motivo = "cliente" });
        try
        {
            using var prazo = new CancellationTokenSource(1500);
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "encerrado", prazo.Token);
        }
        catch { /* já caiu */ }
    }

    /// <summary>Exe comum saindo depois de entregar a sessão ao exe elevado: sem avisar "encerrar".</summary>
    internal void SairSemEncerrar()
    {
        encerrando = true;
        try { ws?.Abort(); } catch { /* ignore */ }
    }

    private static string Texto(JsonObject frame, string nome)
        => frame[nome] is JsonValue valor ? valor.ToString() : "";

    private static long Rid(JsonObject frame)
        => frame["rid"] is JsonValue valor && valor.TryGetValue<long>(out var rid) ? rid : -1;

    private static string Limpar(string texto, int maximo)
    {
        var limpo = new string(texto.Where((c) => !char.IsControl(c)).ToArray()).Trim();
        return limpo.Length > maximo ? limpo[..maximo] : limpo;
    }
}
