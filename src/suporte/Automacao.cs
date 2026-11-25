using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentCode.WindowsControl;

namespace AgentCode.Suporte;

/// <summary>
/// A automação de tela do controle local (<see cref="CommandDispatcher"/>), rodando numa
/// thread STA própria — fora da thread da janela, para um programa travado do cliente
/// nunca congelar o botão Encerrar. Guarda também a relação captura → janela, que
/// converte a coordenada da imagem em ponto da janela (no controle local isso fica no
/// TypeScript).
/// </summary>
internal sealed class Automacao : IDisposable
{
    private sealed record Captura(string Janela, int LarguraImagem, int AlturaImagem, int LarguraJanela, int AlturaJanela);

    private sealed class Trabalhador
    {
        internal BlockingCollection<Action<CommandDispatcher>> Fila { get; } = new();

        internal Trabalhador()
        {
            var thread = new Thread(() =>
            {
                var dispatcher = new CommandDispatcher();
                foreach (var tarefa in Fila.GetConsumingEnumerable()) tarefa(dispatcher);
            }) { IsBackground = true, Name = "automacao" };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
        }
    }

    private static int entradas;
    private static long ultimaEntrada = -10_000;

    /// <summary>
    /// Há mouse ou teclado sendo enviado pela IA (ou acabou de ser). Enquanto isso as
    /// janelas do suporte ignoram o teclado e nenhuma pergunta nova é aberta — uma tecla
    /// que errou de janela nunca vira resposta do cliente.
    /// </summary>
    internal static bool Injetando
        => Volatile.Read(ref entradas) > 0 || Environment.TickCount64 - Volatile.Read(ref ultimaEntrada) < 400;

    internal static void EntradaComecou() => Interlocked.Increment(ref entradas);

    internal static void EntradaTerminou()
    {
        Volatile.Write(ref ultimaEntrada, Environment.TickCount64);
        Interlocked.Decrement(ref entradas);
    }

    private readonly object trava = new();
    private readonly Dictionary<string, Captura> capturas = new();
    private Trabalhador trabalhador = new();

    /// <summary>
    /// Chama um método do <see cref="CommandDispatcher"/> e devolve o resultado já em JSON.
    /// Estourou o tempo (programa do cliente que não responde): a thread presa é abandonada
    /// e outra assume, para a próxima chamada não ficar na fila atrás dela.
    /// </summary>
    internal async Task<JsonNode?> ChamarAsync(string metodo, JsonObject args, int tempoLimiteMs, CancellationToken ct)
    {
        var pronto = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        Trabalhador atual;
        lock (trava) atual = trabalhador;
        atual.Fila.Add((dispatcher) =>
        {
            if (ct.IsCancellationRequested) { pronto.TrySetCanceled(ct); return; }
            try
            {
                var resultado = dispatcher.ExecuteAsync(metodo, args).GetAwaiter().GetResult();
                pronto.TrySetResult(JsonSerializer.SerializeToNode(resultado, Resultado.Json));
            }
            catch (Exception erro) { pronto.TrySetException(erro); }
        });
        var primeiro = await Task.WhenAny(pronto.Task, Task.Delay(tempoLimiteMs, ct));
        if (primeiro == pronto.Task) return await pronto.Task;
        ct.ThrowIfCancellationRequested();
        lock (trava)
        {
            if (ReferenceEquals(trabalhador, atual))
            {
                atual.Fila.CompleteAdding();
                trabalhador = new Trabalhador();
            }
        }
        throw new TimeoutException("O programa do cliente não respondeu a tempo. Observe a janela de novo antes de continuar.");
    }

    // ---- Capturas e escala do clique ----------------------------------------

    /// <summary>Registra uma captura de janela e devolve o id que as ações por coordenada exigem.</summary>
    internal string Guardar(string janela, int larguraImagem, int alturaImagem, int larguraJanela, int alturaJanela)
    {
        var id = Guid.NewGuid().ToString();
        lock (capturas)
        {
            Esquecer(janela);
            capturas[id] = new Captura(janela, larguraImagem, alturaImagem, larguraJanela, alturaJanela);
            while (capturas.Count > 25) capturas.Remove(capturas.Keys.First());
        }
        return id;
    }

    /// <summary>Converte uma coordenada da captura em coordenada da janela (pixels reais).</summary>
    internal (double X, double Y) Escalar(string janela, string capturaId, double x, double y)
    {
        Captura? captura;
        lock (capturas) capturas.TryGetValue(capturaId, out captura);
        if (captura is null || captura.Janela != janela)
            throw new ArgumentException("screenshotId expirou ou pertence a outra janela; capture o estado novamente.");
        if (x < 0 || y < 0 || x >= captura.LarguraImagem || y >= captura.AlturaImagem)
            throw new ArgumentException("As coordenadas estão fora da captura informada.");
        return (x * captura.LarguraJanela / captura.LarguraImagem, y * captura.AlturaJanela / captura.AlturaImagem);
    }

    /// <summary>Depois de qualquer ação numa janela, a captura antiga dela não vale mais.</summary>
    internal void Esquecer(string janela)
    {
        lock (capturas)
        {
            foreach (var id in capturas.Where((par) => par.Value.Janela == janela).Select((par) => par.Key).ToList())
                capturas.Remove(id);
        }
    }

    // ---- As janelas do próprio exe ficam fora do alcance -------------------

    /// <summary>
    /// Valida o windowId de uma chamada. Janela deste processo (a do suporte, a barra
    /// pequena, o registro) responde como se não existisse: a IA não clica em Permitir,
    /// nas chaves nem em Encerrar.
    /// </summary>
    internal static nint Janela(string windowId)
    {
        if (!long.TryParse(windowId, out var valor) || valor == 0) throw new ArgumentException("windowId inválido.");
        var hwnd = new nint(valor);
        if (!NativeMethods.IsWindow(hwnd) || Nativo.EhNossa(hwnd))
            throw new ArgumentException("A janela não existe mais; liste as janelas novamente.");
        return hwnd;
    }

    /// <summary>Recusa o ponto que cai numa janela do suporte (ela fica à frente das outras).</summary>
    internal static void ConferirPonto(nint hwnd, double x, double y)
    {
        if (Nativo.PontoEhNosso(WindowCatalog.ToScreenPoint(hwnd, x, y)))
            throw new InvalidOperationException("Esse ponto está coberto pela janela do suporte, que só o cliente opera. Peça a ele para movê-la.");
    }

    /// <summary>A lista de janelas do Windows, sem as deste processo.</summary>
    internal static JsonArray SemAsNossas(JsonNode? lista)
    {
        var limpa = new JsonArray();
        if (lista is not JsonArray janelas) return limpa;
        foreach (var janela in janelas)
        {
            if (janela is JsonObject objeto && objeto["processId"]?.GetValue<int>() == Environment.ProcessId) continue;
            limpa.Add(janela?.DeepClone());
        }
        return limpa;
    }

    public void Dispose()
    {
        lock (trava) trabalhador.Fila.CompleteAdding();
    }
}
