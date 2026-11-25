using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using AgentCode.WindowsControl;
using Tela = System.Windows.Forms.Screen;

namespace AgentCode.Suporte;

internal sealed record Imagem(byte[] Png, int Largura, int Altura, int LarguraOriginal, int AlturaOriginal);

/// <summary>
/// Captura de tela em PNG, com largura máxima de 1920. O exe é ciente de DPI por
/// monitor (app.manifest), então tudo aqui está em pixels reais — os mesmos do clique.
/// </summary>
internal static class Captura
{
    internal const int LarguraMaxima = 1920;

    /// <summary>A área de trabalho inteira (todos os monitores).</summary>
    internal static Imagem TelaInteira()
    {
        var area = System.Windows.Forms.SystemInformation.VirtualScreen;
        return DaTela(area);
    }

    /// <summary>Um monitor, pelo número de <see cref="Monitores"/> (1 = principal).</summary>
    internal static Imagem Monitor(int numero)
    {
        var telas = Ordenadas();
        if (numero < 1 || numero > telas.Length)
            throw new ArgumentException($"monitor deve estar entre 1 e {telas.Length}.");
        return DaTela(telas[numero - 1].Bounds);
    }

    internal static object[] Monitores() => Ordenadas()
        .Select((tela, indice) => (object)new
        {
            monitor = indice + 1,
            principal = tela.Primary,
            x = tela.Bounds.X,
            y = tela.Bounds.Y,
            largura = tela.Bounds.Width,
            altura = tela.Bounds.Height
        })
        .ToArray();

    private static Tela[] Ordenadas()
        => Tela.AllScreens.OrderByDescending((tela) => tela.Primary).ThenBy((tela) => tela.Bounds.X).ThenBy((tela) => tela.Bounds.Y).ToArray();

    private static Imagem DaTela(Rectangle area)
    {
        if (area.Width <= 0 || area.Height <= 0) throw new InvalidOperationException("O Windows não informou o tamanho da tela.");
        using var bitmap = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb);
        using (var desenho = Graphics.FromImage(bitmap))
            desenho.CopyFromScreen(area.Location, Point.Empty, area.Size, CopyPixelOperation.SourceCopy);
        return Empacotar(bitmap);
    }

    /// <summary>
    /// Uma janela, mesmo coberta por outras (PrintWindow). Se o programa devolver uma
    /// imagem em branco, cai para o recorte da tela.
    /// </summary>
    internal static Imagem Janela(nint hwnd)
    {
        if (NativeMethods.IsIconic(hwnd))
            throw new InvalidOperationException("A janela está minimizada; use remoto_activate_window antes de capturar.");
        var limites = WindowCatalog.Bounds(hwnd);
        using var bitmap = new Bitmap(limites.Width, limites.Height, PixelFormat.Format32bppArgb);
        bool desenhou;
        using (var desenho = Graphics.FromImage(bitmap))
        {
            var hdc = desenho.GetHdc();
            try { desenhou = Nativo.PrintWindow(hwnd, hdc, Nativo.PW_RENDERFULLCONTENT); }
            finally { desenho.ReleaseHdc(hdc); }
        }
        if (!desenhou || Uniforme(bitmap))
        {
            using var desenho = Graphics.FromImage(bitmap);
            desenho.CopyFromScreen(new Point(limites.Left, limites.Top), Point.Empty, bitmap.Size, CopyPixelOperation.SourceCopy);
            if (Uniforme(bitmap)) throw new InvalidOperationException("O Windows retornou uma captura vazia para essa janela.");
        }
        return Empacotar(bitmap);
    }

    /// <summary>Todos os pontos amostrados têm a mesma cor: captura vazia.</summary>
    private static bool Uniforme(Bitmap bitmap)
    {
        var primeira = bitmap.GetPixel(bitmap.Width / 2, bitmap.Height / 2).ToArgb();
        const int passos = 16;
        for (var linha = 1; linha < passos; linha++)
        {
            for (var coluna = 1; coluna < passos; coluna++)
            {
                var cor = bitmap.GetPixel(bitmap.Width * coluna / passos, bitmap.Height * linha / passos).ToArgb();
                if (cor != primeira) return false;
            }
        }
        return true;
    }

    private static Imagem Empacotar(Bitmap original)
    {
        if (original.Width <= LarguraMaxima) return new Imagem(Png(original), original.Width, original.Height, original.Width, original.Height);
        var altura = Math.Max(1, (int)Math.Round(original.Height * (double)LarguraMaxima / original.Width));
        using var menor = new Bitmap(LarguraMaxima, altura, PixelFormat.Format32bppArgb);
        using (var desenho = Graphics.FromImage(menor))
        {
            desenho.InterpolationMode = InterpolationMode.HighQualityBicubic;
            desenho.PixelOffsetMode = PixelOffsetMode.HighQuality;
            desenho.DrawImage(original, new Rectangle(0, 0, menor.Width, menor.Height));
        }
        return new Imagem(Png(menor), menor.Width, menor.Height, original.Width, original.Height);
    }

    private static byte[] Png(Bitmap bitmap)
    {
        using var saida = new MemoryStream();
        bitmap.Save(saida, ImageFormat.Png);
        return saida.ToArray();
    }
}
