using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;
using Application = System.Windows.Application;
using Brush = System.Windows.Media.Brush;

namespace AgentCode.Suporte;

/// <summary>
/// A janela do cliente (mockup v2). Mostra o estado da <see cref="Sessao"/> e leva os
/// cliques dele de volta; é o único lugar onde uma sessão é aceita, um recurso é
/// ligado e o suporte é encerrado.
/// </summary>
public partial class Janela : Window
{
    private readonly Sessao sessao;
    private readonly Nucleo nucleo;
    private readonly Dictionary<string, (ToggleButton Chave, TextBlock Nome)> chaves = new();
    private readonly DispatcherTimer relogio = new() { Interval = TimeSpan.FromSeconds(10) };
    private readonly DispatcherTimer copiado = new() { Interval = TimeSpan.FromSeconds(2) };
    private Pilula? pilula;
    private Registro? registro;
    private bool saindo;
    private bool sincronizando;

    internal Janela(Nucleo nucleo)
    {
        this.nucleo = nucleo;
        sessao = nucleo.Sessao;
        InitializeComponent();
        MontarRecursos();

        sessao.Mudou += () => Dispatcher.BeginInvoke(Atualizar);
        sessao.PedidoNovo += () => Dispatcher.BeginInvoke(ChamarAtencao);
        nucleo.Sair += () => Dispatcher.BeginInvoke(SairSemAvisar);
        relogio.Tick += (_, _) => AtualizarTempo();
        copiado.Tick += (_, _) => { copiado.Stop(); TextoCopiar.Text = "Copiar"; };
        // Enquanto a IA envia mouse ou teclado a outro programa, esta janela não aceita
        // teclado: uma tecla que errou de destino nunca responde pelo cliente.
        PreviewKeyDown += (_, evento) => { if (Automacao.Injetando) evento.Handled = true; };
        SourceInitialized += (_, _) => Nativo.Arredondar(new WindowInteropHelper(this).Handle);
        StateChanged += (_, _) => AtualizarPilula();
        Atualizar();
    }

    // ---- Recursos (as seis chaves) --------------------------------------------

    private static readonly Dictionary<string, string> Icones = new()
    {
        [Contrato.RecursoTela] = "IconeTela",
        [Contrato.RecursoComandos] = "IconeComandos",
        [Contrato.RecursoArquivos] = "IconeArquivos",
        [Contrato.RecursoChrome] = "IconeChrome",
        [Contrato.RecursoCelular] = "IconeCelular",
        [Contrato.RecursoAdministrador] = "IconeAdministrador"
    };

    private void MontarRecursos()
    {
        foreach (var recurso in Contrato.Recursos)
        {
            var linha = new DockPanel { MinHeight = 44, Margin = new Thickness(12, 0, 12, 0), LastChildFill = true };
            var chave = new ToggleButton { Style = (Style)FindResource("Chave"), VerticalAlignment = VerticalAlignment.Center };
            AutomationProperties.SetName(chave, Sessao.Rotulo(recurso));
            var nomeDoRecurso = recurso;
            // Checked/Unchecked (e não Click): a chave também muda por teclado e por leitor de tela.
            chave.Checked += (_, _) => AoAlternar(nomeDoRecurso, true);
            chave.Unchecked += (_, _) => AoAlternar(nomeDoRecurso, false);
            DockPanel.SetDock(chave, Dock.Right);
            linha.Children.Add(chave);

            var icone = new Viewbox
            {
                Width = 18, Height = 18, VerticalAlignment = VerticalAlignment.Center,
                Child = new Path { Data = (Geometry)FindResource(Icones[recurso]), Style = (Style)FindResource("Icone") }
            };
            DockPanel.SetDock(icone, Dock.Left);
            linha.Children.Add(icone);

            var nome = new TextBlock { Text = Sessao.Rotulo(recurso), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 10, 0) };
            linha.Children.Add(nome);

            if (Recursos.Children.Count > 0)
                Recursos.Children.Add(new Border { Height = 1, Background = (Brush)FindResource("Linha") });
            Recursos.Children.Add(linha);
            chaves[recurso] = (chave, nome);
        }
    }

    private void AoAlternar(string recurso, bool ligar)
    {
        if (sincronizando) return;
        sessao.Alternar(recurso, ligar);
        Atualizar(); // a chave mostra sempre o estado real, mesmo quando a troca não valeu
    }

    // ---- Estado → tela ------------------------------------------------------------

    private void Atualizar()
    {
        if (saindo) return;
        var fase = sessao.Fase;
        var recursoPedido = sessao.RecursoPedido;
        UIElement painel = fase switch
        {
            Fase.PedidoAcesso => PainelPedido,
            Fase.Ativa when recursoPedido is not null => PainelRecurso,
            Fase.Ativa => PainelAtivo,
            Fase.Expirado or Fase.Indisponivel or Fase.Atualizar => PainelAviso,
            _ => PainelCodigo
        };
        foreach (var cada in new UIElement[] { PainelCodigo, PainelPedido, PainelAtivo, PainelRecurso, PainelAviso })
            cada.Visibility = ReferenceEquals(cada, painel) ? Visibility.Visible : Visibility.Collapsed;

        switch (fase)
        {
            case Fase.Conectando:
            case Fase.Aguardando:
                var pronto = fase == Fase.Aguardando && sessao.Codigo.Length == Contrato.CodigoDigitos;
                SituacaoCodigo.Text = pronto ? "Aguardando o técnico" : "Conectando…";
                Codigo1.Text = pronto ? sessao.Codigo[..3] : "···";
                Codigo2.Text = pronto ? sessao.Codigo[3..6] : "···";
                Codigo3.Text = pronto ? sessao.Codigo[6..] : "···";
                AutomationProperties.SetName(Codigo, pronto ? $"Código {Codigo1.Text} {Codigo2.Text} {Codigo3.Text}" : "Código ainda não disponível");
                BotaoCopiar.IsEnabled = pronto;
                break;
            case Fase.PedidoAcesso:
                TituloPedido.Text = $"{sessao.Tecnico} Quer Acessar Este Computador";
                break;
            case Fase.Ativa when recursoPedido is not null:
                (TituloRecurso.Text, DetalheRecurso.Text) = recursoPedido switch
                {
                    Contrato.RecursoAdministrador => ("Permitir Acesso de Administrador?", "O Windows vai pedir a sua confirmação."),
                    Contrato.RecursoChrome => ("Permitir o Controle do Chrome?", "Instala uma extensão, removida ao encerrar."),
                    Contrato.RecursoCelular => ("Permitir o Controle do Celular?", "Vale só para o celular ligado a este computador."),
                    _ => ($"Permitir {Sessao.Rotulo(recursoPedido)}?", "")
                };
                break;
            case Fase.Ativa:
                SituacaoAtivo.Text = $"Suporte ativo · {sessao.Tecnico}";
                AtualizarTempo();
                foreach (var (recurso, (chave, nome)) in chaves)
                {
                    var estado = sessao.Recurso(recurso);
                    sincronizando = true;
                    chave.IsChecked = estado == EstadoRecurso.Ligado;
                    sincronizando = false;
                    // Já elevado, não há como "desligar" o administrador sem encerrar.
                    chave.IsEnabled = estado != EstadoRecurso.Travado && !(recurso == Contrato.RecursoAdministrador && sessao.Admin);
                    nome.Foreground = (Brush)FindResource(estado == EstadoRecurso.Ligado ? "Texto" : "Mudo");
                }
                break;
            case Fase.Expirado:
                Aviso("Código expirado", "O Código Venceu", "Ninguém usou o código em 15 minutos.", "Novo Código");
                break;
            case Fase.Indisponivel:
                Aviso("Sem conexão", "Não Foi Possível Conectar", "Confira a internet. O suporte tenta de novo sozinho.", null);
                break;
            case Fase.Atualizar:
                Aviso("Versão antiga", "Baixe a Versão Nova do Suporte", "Esta versão não conecta mais.", "Baixar");
                break;
        }

        if (fase == Fase.Ativa) relogio.Start(); else relogio.Stop();
        if (fase != Fase.Ativa && registro is not null && sessao.LerRegistro().Count == 0) registro.Close();
        Topmost = sessao.PedidoAberto;
        AtualizarPilula();
    }

    private void Aviso(string situacao, string titulo, string detalhe, string? botao)
    {
        SituacaoAviso.Text = situacao;
        TituloAviso.Text = titulo;
        DetalheAviso.Text = detalhe;
        BotaoAviso.Content = botao;
        BotaoAviso.Visibility = botao is null ? Visibility.Collapsed : Visibility.Visible;
    }

    private void AtualizarTempo()
    {
        if (sessao.Fase != Fase.Ativa) return;
        var tempo = DateTime.Now - sessao.Inicio;
        Tempo.Text = tempo.TotalHours >= 1 ? $"{(int)tempo.TotalHours} h {tempo.Minutes:00} min" : $"{Math.Max(0, (int)tempo.TotalMinutes)} min";
    }

    /// <summary>Uma pergunta nova: a janela vem para a frente e pisca até ele olhar.</summary>
    private void ChamarAtencao()
    {
        if (saindo) return;
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Show();
        Topmost = true;
        Activate();
        Nativo.Piscar(new WindowInteropHelper(this).Handle);
    }

    /// <summary>Minimizada durante o suporte: fica a barra pequena, sempre à frente.</summary>
    private void AtualizarPilula()
    {
        var mostrar = !saindo && sessao.Fase == Fase.Ativa && WindowState == WindowState.Minimized;
        if (mostrar && pilula is null)
        {
            pilula = new Pilula(Restaurar, Encerrar);
            pilula.Show();
        }
        else if (!mostrar && pilula is not null)
        {
            pilula.Close();
            pilula = null;
        }
    }

    private void Restaurar()
    {
        WindowState = WindowState.Normal;
        Activate();
    }

    // ---- Cliques do cliente -------------------------------------------------------

    private void AoPermitir(object sender, RoutedEventArgs e) => sessao.Responder(true);
    private void AoRecusar(object sender, RoutedEventArgs e) => sessao.Responder(false);
    private void AoEncerrar(object sender, RoutedEventArgs e) => Encerrar();
    private void AoMinimizar(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void AoFechar(object sender, RoutedEventArgs e) => Close();

    private void AoCopiar(object sender, RoutedEventArgs e)
    {
        if (sessao.Fase != Fase.Aguardando) return;
        var copiou = Nativo.CopiarTexto(new WindowInteropHelper(this).Handle, sessao.Codigo);
        TextoCopiar.Text = copiou ? "Copiado" : "Não Foi Possível Copiar";
        copiado.Stop();
        copiado.Start();
    }

    private void AoVerRegistro(object sender, RoutedEventArgs e)
    {
        if (registro is null)
        {
            registro = new Registro(sessao) { Owner = this };
            registro.Closed += (_, _) => registro = null;
            registro.Show();
        }
        else registro.Activate();
    }

    private void AoBotaoAviso(object sender, RoutedEventArgs e)
    {
        if (sessao.Fase == Fase.Expirado)
        {
            sessao.DefinirFase(Fase.Conectando);
            nucleo.Elo.Reconectar();
        }
        else if (sessao.Fase == Fase.Atualizar)
        {
            // Sempre o endereço fixo do contrato, nunca um que tenha vindo pela rede.
            try { Process.Start(new ProcessStartInfo(Contrato.DownloadUrl) { UseShellExecute = true }); } catch { /* sem navegador */ }
        }
    }

    // ---- Sair -----------------------------------------------------------------------

    /// <summary>Encerrar (botão, barra pequena ou fechar a janela): acaba a sessão e o programa.</summary>
    private async void Encerrar()
    {
        if (saindo) return;
        saindo = true;
        Fechar();
        await nucleo.EncerrarAsync();
        Application.Current.Shutdown();
    }

    /// <summary>O exe reaberto como administrador assumiu a sessão: este sai sem avisar "encerrado".</summary>
    private void SairSemAvisar()
    {
        if (saindo) return;
        saindo = true;
        Fechar();
        Application.Current.Shutdown();
    }

    private void Fechar()
    {
        relogio.Stop();
        pilula?.Close();
        pilula = null;
        registro?.Close();
        Hide();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!saindo)
        {
            e.Cancel = true;
            Encerrar();
        }
        base.OnClosing(e);
    }
}
