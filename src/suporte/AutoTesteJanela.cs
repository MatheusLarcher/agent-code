using System.Windows;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using Botao = System.Windows.Controls.Button;
using ButtonBase = System.Windows.Controls.Primitives.ButtonBase;
using Size = System.Windows.Size;

namespace AgentCode.Suporte;

/// <summary>
/// Parte do <c>--self-test</c>: monta a janela de verdade (sem mostrá-la), passa pelos
/// estados do mockup e confere que cada clique do cliente chega à sessão. Pega erro de
/// XAML, de tema e de desenho de texto, que os outros testes não exercitam.
/// </summary>
internal static class AutoTesteJanela
{
    internal static Task Rodar()
    {
        var pronto = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                Testar();
                pronto.SetResult();
            }
            catch (Exception erro) { pronto.SetException(erro); }
            finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        }) { IsBackground = true };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return pronto.Task;
    }

    private static void Confere(bool condicao, string oQue)
    {
        if (!condicao) throw new InvalidOperationException(oQue);
    }

    private static IEnumerable<T> Todos<T>(DependencyObject raiz) where T : DependencyObject
    {
        foreach (var filho in LogicalTreeHelper.GetChildren(raiz).OfType<DependencyObject>())
        {
            if (filho is T achado) yield return achado;
            foreach (var neto in Todos<T>(filho)) yield return neto;
        }
    }

    private static void Clicar(DependencyObject painel, string texto)
    {
        var botao = Todos<Botao>(painel).FirstOrDefault((b) => b.Content as string == texto)
            ?? throw new InvalidOperationException($"não há botão \"{texto}\" neste estado");
        botao.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
    }

    private static void Testar()
    {
        Program.CriarApp();
        using var nucleo = new Nucleo();
        var sessao = nucleo.Sessao;
        var janela = new Janela(nucleo);
        var raiz = (FrameworkElement)janela.Content;

        // Deixa a janela reagir ao que a sessão avisou e refaz o desenho.
        void Assentar()
        {
            Dispatcher.CurrentDispatcher.Invoke(() => { }, DispatcherPriority.ApplicationIdle);
            raiz.Measure(new Size(340, double.PositiveInfinity));
            raiz.Arrange(new Rect(raiz.DesiredSize));
            raiz.UpdateLayout();
        }
        bool Visivel(UIElement painel) => painel.Visibility == Visibility.Visible;

        Assentar();
        Confere(Visivel(janela.PainelCodigo) && janela.SituacaoCodigo.Text == "Conectando…" && !janela.BotaoCopiar.IsEnabled, "estado inicial errado");
        Confere(raiz.DesiredSize.Height is > 150 and < 420, $"altura inesperada: {raiz.DesiredSize.Height}");

        // 1 · Ao abrir
        sessao.NovoCodigo();
        sessao.DefinirFase(Fase.Aguardando);
        Assentar();
        Confere(janela.SituacaoCodigo.Text == "Aguardando o técnico" && janela.BotaoCopiar.IsEnabled, "não mostrou \"Aguardando o técnico\"");
        Confere(janela.Codigo1.Text + janela.Codigo2.Text + janela.Codigo3.Text == sessao.Codigo, "o código da janela não é o da sessão");

        // 2 · Pedido de acesso
        var acesso = sessao.PedirAcesso("pedido", "Maria");
        Assentar();
        Confere(Visivel(janela.PainelPedido) && !Visivel(janela.PainelCodigo), "o pedido de acesso não apareceu");
        Confere(janela.TituloPedido.Text == "Maria Quer Acessar Este Computador", $"título do pedido: {janela.TituloPedido.Text}");
        Confere(janela.Topmost, "a pergunta não ficou à frente das outras janelas");
        Clicar(janela.PainelPedido, "Recusar");
        Confere(acesso.IsCompleted && !acesso.Result, "Recusar não recusou");
        acesso = sessao.PedirAcesso("pedido2", "Maria");
        Assentar();
        Clicar(janela.PainelPedido, "Permitir");
        Confere(acesso.IsCompleted && acesso.Result, "Permitir não permitiu");

        // 3 · Suporte ativo
        sessao.Ativar();
        Assentar();
        Confere(Visivel(janela.PainelAtivo) && janela.SituacaoAtivo.Text == "Suporte ativo · Maria" && janela.Tempo.Text == "0 min", "estado ativo errado");
        var chaves = Todos<ToggleButton>(janela.Recursos).ToList();
        Confere(chaves.Count == Contrato.Recursos.Length, $"{chaves.Count} chaves, esperava {Contrato.Recursos.Length}");
        Confere(chaves.Take(3).All((c) => c.IsChecked == true && c.IsEnabled), "Tela, Comandos e Arquivos deveriam vir ligados");
        Confere(chaves.Skip(3).All((c) => c.IsChecked == false && !c.IsEnabled), "Chrome, Celular e Administrador deveriam vir travados");
        chaves[1].IsChecked = false; // como faz o mouse, o teclado ou um leitor de tela
        Assentar();
        Confere(sessao.Recurso(Contrato.RecursoComandos) == EstadoRecurso.Desligado && chaves[1].IsEnabled, "a chave não desligou Comandos");
        Confere(sessao.LerRegistro().Any((entrada) => entrada.Texto == "Cliente desligou: Comandos"), "o registro não anotou a chave");

        // 4 · Pedido extra
        var extra = sessao.PedirRecurso(Contrato.RecursoAdministrador);
        Assentar();
        Confere(Visivel(janela.PainelRecurso) && janela.TituloRecurso.Text == "Permitir Acesso de Administrador?", "o pedido extra não apareceu");
        Clicar(janela.PainelRecurso, "Não");
        Assentar();
        Confere(extra.IsCompleted && !extra.Result && Visivel(janela.PainelAtivo) && !janela.Topmost, "\"Não\" não fechou o pedido extra");
        extra = sessao.PedirRecurso(Contrato.RecursoAdministrador);
        Assentar();
        Clicar(janela.PainelRecurso, "Permitir");
        Assentar();
        Confere(extra.Result && chaves[5].IsChecked == true, "Permitir não liberou o recurso extra");
        chaves[3].IsChecked = true; // recurso travado não liga pela chave, nem na tela
        Assentar();
        Confere(sessao.Recurso(Contrato.RecursoChrome) == EstadoRecurso.Travado && chaves[3].IsChecked == false, "chave travada ligou");

        // Avisos
        sessao.Encerrar("teste");
        Assentar();
        Confere(Visivel(janela.PainelCodigo), "depois de encerrar não voltou ao começo");
        sessao.DefinirFase(Fase.Expirado);
        Assentar();
        Confere(Visivel(janela.PainelAviso) && janela.BotaoAviso.Content as string == "Novo Código", "aviso de código vencido errado");
        sessao.DefinirFase(Fase.Indisponivel);
        Assentar();
        Confere(janela.BotaoAviso.Visibility == Visibility.Collapsed && janela.TituloAviso.Text.Length > 0, "aviso de sem conexão errado");
        sessao.DefinirFase(Fase.Atualizar);
        Assentar();
        Confere(janela.BotaoAviso.Content as string == "Baixar", "aviso de versão antiga errado");

        // Extensão que sobrou no Chrome: uma linha ao cliente, que some no "Entendi".
        sessao.DefinirFase(Fase.Aguardando);
        janela.AvisarSobra();
        Assentar();
        Confere(Visivel(janela.PainelAviso) && janela.TituloAviso.Text == "Ficou uma Extensão no Chrome" && janela.BotaoAviso.Content as string == "Entendi",
            "aviso de extensão que sobrou errado");
        Confere(janela.DetalheAviso.Text.Contains("chrome://extensions"), "o aviso não diz como tirar a extensão");
        Clicar(janela.PainelAviso, "Entendi");
        Assentar();
        Confere(Visivel(janela.PainelCodigo), "\"Entendi\" não fechou o aviso");

        // Pedidos dos recursos que instalam algo dizem, em uma linha, o que acontece no PC.
        sessao.DefinirFase(Fase.Aguardando);
        var deNovo = sessao.PedirAcesso("pedido3", "Maria");
        sessao.Responder(true);
        sessao.Ativar();
        foreach (var (recurso, titulo, detalhe) in new[]
        {
            (Contrato.RecursoChrome, "Permitir o Controle do Chrome?", "Instala uma extensão, removida ao encerrar."),
            (Contrato.RecursoCelular, "Permitir o Controle do Celular?", "Baixa ferramentas do Google (15 MB), apagadas ao encerrar.")
        })
        {
            var pergunta = sessao.PedirRecurso(recurso);
            Assentar();
            Confere(janela.TituloRecurso.Text == titulo && janela.DetalheRecurso.Text == detalhe, $"pedido de {recurso}: {janela.TituloRecurso.Text} / {janela.DetalheRecurso.Text}");
            Clicar(janela.PainelRecurso, "Não");
            Confere(pergunta.IsCompleted && !pergunta.Result, $"\"Não\" não recusou {recurso}");
        }
        sessao.Encerrar("teste");

        // As outras duas janelas também montam.
        var pilula = new Pilula(() => { }, () => { });
        ((FrameworkElement)pilula.Content).Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        var registro = new Registro(sessao);
        ((FrameworkElement)registro.Content).Measure(new Size(460, 520));
        Confere(registro.Lista.Text.Contains("Cliente desligou: Comandos"), "a janela do registro não mostra o que foi feito");
    }
}
