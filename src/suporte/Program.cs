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

    internal Sessao Sessao { get; } = new();
    internal Comandos Comandos { get; } = new();
    internal Automacao Automacao { get; } = new();
    internal Ferramentas Ferramentas { get; }
    internal Mcp Mcp { get; }
    internal Elo Elo { get; }

    /// <summary>O exe reaberto como administrador assumiu a sessão: este deve sair.</summary>
    internal event Action? Sair;

    internal Nucleo()
    {
        Ferramentas = new Ferramentas(Sessao,
        [
            .. new FerramentasSistema(Sessao, SairDepoisDeElevar).Criar(),
            .. new FerramentasJanelas(Automacao).Criar(),
            .. new FerramentasComando(Comandos).Criar(),
            .. FerramentasArquivos.Criar()
        ]);
        Mcp = new Mcp(Sessao, Ferramentas);
        Elo = new Elo(Sessao, Mcp.AtenderAsync);
        // Nada do que o técnico iniciou sobrevive ao fim da sessão nem à chave desligada.
        Sessao.Acabou += Comandos.PararTudo;
        Sessao.RecursoMudou += (recurso, estado) =>
        {
            if (recurso == Contrato.RecursoComandos && estado != EstadoRecurso.Ligado) Comandos.PararTudo();
        };
    }

    internal void Iniciar() => _ = Task.Run(() => Elo.RodarAsync(vida.Token));

    /// <summary>O cliente encerrou: avisa o técnico, derruba a sessão e para tudo.</summary>
    internal async Task EncerrarAsync()
    {
        try { await Elo.EncerrarAsync(); } catch { /* sem conexão: encerra do mesmo jeito */ }
        Sessao.Encerrar("O cliente encerrou a sessão");
        vida.Cancel();
    }

    private void SairDepoisDeElevar() => _ = Task.Run(async () =>
    {
        await Task.Delay(1500); // a resposta da chamada sobe antes de este exe sair
        Elo.SairSemEncerrar();
        Sair?.Invoke();
    });

    public void Dispose()
    {
        vida.Cancel();
        Comandos.Dispose();
        Automacao.Dispose();
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
        if (args is [Elevacao.Argumento, var canal] && !Retomar(nucleo, canal)) return 1;

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
