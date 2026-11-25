using System.Text;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;

namespace AgentCode.Suporte;

/// <summary>"Ver o Que Foi Feito": tudo o que o técnico fez nesta sessão, na ordem, com a hora.</summary>
public partial class Registro : Window
{
    private readonly Sessao sessao;
    private readonly DispatcherTimer copiado = new() { Interval = TimeSpan.FromSeconds(2) };
    private bool pendente;

    internal Registro(Sessao sessao)
    {
        this.sessao = sessao;
        InitializeComponent();
        SourceInitialized += (_, _) => Nativo.Arredondar(new WindowInteropHelper(this).Handle);
        PreviewKeyDown += (_, evento) => { if (Automacao.Injetando) evento.Handled = true; };
        copiado.Tick += (_, _) => { copiado.Stop(); BotaoCopiar.Content = "Copiar"; };
        sessao.RegistroMudou += AoMudar;
        Closed += (_, _) => sessao.RegistroMudou -= AoMudar;
        Atualizar();
    }

    /// <summary>Várias ações seguidas viram uma atualização só.</summary>
    private void AoMudar()
    {
        if (pendente) return;
        pendente = true;
        Dispatcher.BeginInvoke(DispatcherPriority.Background, Atualizar);
    }

    private void Atualizar()
    {
        pendente = false;
        var entradas = sessao.LerRegistro();
        var texto = new StringBuilder();
        foreach (var entrada in entradas) texto.Append(entrada.Hora.ToString("HH:mm:ss")).Append("  ").Append(entrada.Texto).Append('\n');
        var noFim = Lista.VerticalOffset + Lista.ViewportHeight >= Lista.ExtentHeight - 4;
        Lista.Text = texto.ToString().TrimEnd();
        if (noFim) Lista.ScrollToEnd();
        Vazio.Visibility = entradas.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        Contagem.Text = entradas.Count == 1 ? "1 registro" : $"{entradas.Count} registros";
        BotaoCopiar.IsEnabled = entradas.Count > 0;
    }

    private void AoCopiar(object sender, RoutedEventArgs e)
    {
        var copiou = Nativo.CopiarTexto(new WindowInteropHelper(this).Handle, Lista.Text);
        BotaoCopiar.Content = copiou ? "Copiado" : "Não Foi Possível Copiar";
        copiado.Stop();
        copiado.Start();
    }
}
