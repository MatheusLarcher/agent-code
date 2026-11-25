using System.Windows;
using Application = System.Windows.Application;

namespace AgentCode.Suporte;

/// <summary>
/// As peças do exe, ligadas entre si: sessão, comandos, automação, ferramentas,
/// servidor MCP e o elo com o relay.
/// </summary>
internal sealed class Nucleo : IDisposable
{
    private readonly CancellationTokenSource vida = new();
    private volatile bool encerrando;

    internal Sessao Sessao { get; } = new();
    internal Comandos Comandos { get; } = new();
    internal Automacao Automacao { get; } = new();
    internal Extras Extras { get; }
    internal Ferramentas Ferramentas { get; }
    internal Mcp Mcp { get; }
    internal Elo Elo { get; }

    /// <summary>O exe reaberto como administrador assumiu a sessão: este deve sair.</summary>
    internal event Action? Sair;
    /// <summary>Ficou no Chrome uma extensão que não pôde ser removida: avisar o cliente.</summary>
    internal event Action? SobrouExtensao;

    /// <param name="raizDosExtras">Só nos testes: onde os recursos extras gravam, no lugar da pasta do suporte.</param>
    /// <param name="portasDoChrome">Só nos testes: portas da ponte (0 = qualquer porta livre).</param>
    /// <param name="origemDoAdb">Só nos testes: de onde baixar o adb e quem o assina. No exe é sempre o endereço oficial do Google.</param>
    /// <param name="adbFalso">Só nos testes: um adb que anota os argumentos, no lugar do processo de verdade.</param>
    internal Nucleo(string? raizDosExtras = null, int[]? portasDoChrome = null, OrigemDoAdb? origemDoAdb = null, ExecutorAdb? adbFalso = null)
    {
        Extras = new Extras(raizDosExtras, portasDoChrome, origemDoAdb, adbFalso, (recurso) => Sessao.Recurso(recurso) == EstadoRecurso.Ligado);
        Ferramentas = new Ferramentas(Sessao,
        [
            .. new FerramentasSistema(Sessao, SairDepoisDeElevar, Extras.AoPermitirAsync).Criar(),
            .. new FerramentasJanelas(Automacao).Criar(),
            .. new FerramentasComando(Comandos).Criar(),
            .. FerramentasArquivos.Criar(),
            .. new FerramentasChrome(Extras.Chrome).Criar(),
            .. new FerramentasAndroid(Extras.Celular).Criar()
        ]);
        Mcp = new Mcp(Sessao, Ferramentas);
        Elo = new Elo(Sessao, Mcp.AtenderAsync);
        // Nada do que o técnico iniciou ou instalou sobrevive ao fim da sessão nem à chave desligada.
        Sessao.Acabou += Comandos.PararTudo;
        Sessao.Acabou += () => { if (!encerrando) Desfazer(null); };
        Sessao.RecursoMudou += (recurso, estado) =>
        {
            if (estado == EstadoRecurso.Ligado) return;
            if (recurso == Contrato.RecursoComandos) Comandos.PararTudo();
            if (Contrato.RecursosExtras.Contains(recurso)) Desfazer(recurso);
        };
    }

    internal void Iniciar() => _ = Task.Run(() => Elo.RodarAsync(vida.Token));

    /// <summary>Desfaz um recurso extra (ou todos) sem segurar quem chamou; avisa se sobrou algo.</summary>
    private void Desfazer(string? recurso) => _ = Task.Run(async () =>
    {
        if (!await Extras.LimparAsync(recurso)) return;
        Sessao.Registrar("Ficou no Chrome uma extensão sem função: pode ser removida em chrome://extensions");
        SobrouExtensao?.Invoke();
    });

    /// <summary>
    /// O cliente encerrou: avisa o técnico, derruba a sessão, para tudo e desfaz o que foi
    /// instalado, antes de o exe sair. Devolve verdadeiro se ficou uma extensão no Chrome.
    /// </summary>
    internal async Task<bool> EncerrarAsync()
    {
        encerrando = true;
        try { await Elo.EncerrarAsync(); } catch { /* sem conexão: encerra do mesmo jeito */ }
        Sessao.Encerrar("O cliente encerrou a sessão");
        var sobrou = false;
        try { sobrou = await Extras.LimparAsync().WaitAsync(TimeSpan.FromSeconds(15)); } catch { /* sai mesmo assim */ }
        vida.Cancel();
        return sobrou;
    }

    private void SairDepoisDeElevar() => _ = Task.Run(async () =>
    {
        await Task.Delay(1500); // a resposta da chamada sobe antes de este exe sair
        Extras.Largar(); // pastas, extensão e ponte passam para o exe elevado
        Elo.SairSemEncerrar();
        Sair?.Invoke();
    });

    public void Dispose()
    {
        vida.Cancel();
        Comandos.Dispose();
        Automacao.Dispose();
        Extras.Dispose();
    }
}

internal static class Program
{
    /// <summary>
    /// Só existem dois argumentos: <c>--self-test</c> (autoteste, sem rede e sem janela)
    /// e <c>--retomar</c>, usado pelo próprio exe ao se reabrir como administrador numa
    /// sessão que o cliente JÁ aceitou. Nenhum argumento e nenhuma variável aceita uma
    /// sessão: isso só acontece no clique do cliente.
    /// </summary>
    [STAThread]
    private static int Main(string[] args)
    {
        if (args is ["--self-test"]) return AutoTeste.Rodar();

        using var nucleo = new Nucleo();
        if (args is [Elevacao.Argumento, var canal])
        {
            if (!Retomar(nucleo, canal)) return 1;
        }
        else Extras.LimparSobras(); // sessão anterior derrubada sem o Encerrar

        var app = CriarApp();
        // Um erro de tela não pode tirar do cliente o botão Encerrar.
        app.DispatcherUnhandledException += (_, erro) => erro.Handled = true;
        var janela = new Janela(nucleo);
        janela.Show();
        nucleo.Iniciar();
        return app.Run();
    }

    /// <summary>O aplicativo WPF com o tema (cores, botões, chaves) carregado.</summary>
    internal static Application CriarApp()
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.Resources.MergedDictionaries.Add(new ResourceDictionary
        {
            Source = new Uri("/AgentCode.Suporte;component/Tema.xaml", UriKind.Relative)
        });
        return app;
    }

    /// <summary>Exe elevado: recebe a sessão do exe comum e a reassume no relay.</summary>
    private static bool Retomar(Nucleo nucleo, string canal)
    {
        var recebido = Task.Run(() => Elevacao.ReceberEstadoAsync(canal, CancellationToken.None)).GetAwaiter().GetResult();
        if (recebido is not { } entrega) return false;
        nucleo.Sessao.Assumir(entrega.Estado);
        nucleo.Extras.Retomar(nucleo.Sessao);
        nucleo.Elo.Retomada = entrega.Estado;
        nucleo.Elo.RetomadaConcluida += (ok) =>
        {
            _ = entrega.Responder(ok);
            // O relay não devolveu a sessão: o exe comum segue com ela, este sai.
            if (!ok) Application.Current?.Dispatcher.BeginInvoke(() => Application.Current.Shutdown(1));
        };
        return true;
    }
}
