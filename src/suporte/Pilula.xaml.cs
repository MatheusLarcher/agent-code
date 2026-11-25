using System.Windows;
using System.Windows.Input;

namespace AgentCode.Suporte;

/// <summary>
/// A barra pequena que fica à frente de tudo enquanto a janela está minimizada num
/// suporte ativo: o cliente sempre vê que há alguém no computador e encerra com um clique.
/// </summary>
public partial class Pilula : Window
{
    private readonly Action abrir;
    private readonly Action encerrar;

    internal Pilula(Action abrir, Action encerrar)
    {
        this.abrir = abrir;
        this.encerrar = encerrar;
        InitializeComponent();
        Loaded += (_, _) =>
        {
            var area = SystemParameters.WorkArea;
            Left = area.Right - ActualWidth - 12;
            Top = area.Bottom - ActualHeight - 12;
        };
        PreviewKeyDown += (_, evento) => { if (Automacao.Injetando) evento.Handled = true; };
        Corpo.MouseLeftButtonDown += AoPressionar;
    }

    private void AoPressionar(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount >= 2) abrir();
        else if (e.ButtonState == MouseButtonState.Pressed) DragMove();
    }

    private void AoEncerrar(object sender, RoutedEventArgs e) => encerrar();
}
