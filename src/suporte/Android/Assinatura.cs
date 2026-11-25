using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace AgentCode.Suporte;

/// <summary>
/// Assinatura digital (Authenticode) de um executável baixado: o Windows confere que o
/// arquivo não foi alterado e que a cadeia do certificado é confiável, e aqui se
/// confere QUEM assinou. Só depois disso o arquivo é usado.
/// </summary>
internal static class Assinatura
{
    private const string OidOrganizacao = "2.5.4.10";
    private static readonly Guid VerificacaoGenerica = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ArquivoInfo
    {
        public uint Tamanho;
        [MarshalAs(UnmanagedType.LPWStr)] public string Caminho;
        public nint Arquivo;
        public nint Assunto;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Dados
    {
        public uint Tamanho;
        public nint Politica;
        public nint Sip;
        public uint Interface;
        public uint Revogacao;
        public uint Escolha;
        public nint Info;
        public uint Acao;
        public nint Estado;
        public nint Url;
        public uint Opcoes;
        public uint Contexto;
        public nint Ajustes;
    }

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern int WinVerifyTrust(nint janela, ref Guid acao, ref Dados dados);

    /// <summary>
    /// Verdadeiro só se o arquivo tem assinatura válida e a organização do certificado é
    /// exatamente <paramref name="organizacao"/>. <paramref name="motivo"/> diz o que faltou.
    /// </summary>
    internal static bool Confere(string arquivo, string organizacao, out string motivo)
    {
        if (!Valida(arquivo))
        {
            motivo = "sem assinatura digital válida";
            return false;
        }
        var quem = Organizacao(arquivo);
        if (!string.Equals(quem, organizacao, StringComparison.Ordinal))
        {
            motivo = quem is null ? "não foi possível ler quem assinou" : $"assinado por \"{quem}\", e não por \"{organizacao}\"";
            return false;
        }
        motivo = "";
        return true;
    }

    /// <summary>O Windows aceita a assinatura embutida do arquivo (conteúdo íntegro, cadeia confiável).</summary>
    private static bool Valida(string arquivo)
    {
        const uint SemInterface = 2, SemRevogacaoOnline = 0, EscolhaArquivo = 1, Verificar = 1, Fechar = 2;
        const uint SoCacheDeRevogacao = 0x1000;
        var info = new ArquivoInfo { Tamanho = (uint)Marshal.SizeOf<ArquivoInfo>(), Caminho = arquivo };
        var ponteiro = Marshal.AllocHGlobal(Marshal.SizeOf<ArquivoInfo>());
        try
        {
            Marshal.StructureToPtr(info, ponteiro, false);
            var dados = new Dados
            {
                Tamanho = (uint)Marshal.SizeOf<Dados>(),
                Interface = SemInterface,
                Revogacao = SemRevogacaoOnline,
                Escolha = EscolhaArquivo,
                Info = ponteiro,
                Acao = Verificar,
                Opcoes = SoCacheDeRevogacao
            };
            var acao = VerificacaoGenerica;
            var resultado = WinVerifyTrust(0, ref acao, ref dados);
            dados.Acao = Fechar;
            WinVerifyTrust(0, ref acao, ref dados);
            return resultado == 0;
        }
        catch { return false; }
        finally
        {
            Marshal.DestroyStructure<ArquivoInfo>(ponteiro);
            Marshal.FreeHGlobal(ponteiro);
        }
    }

    /// <summary>A organização (O=) do certificado que assinou o arquivo.</summary>
    private static string? Organizacao(string arquivo)
    {
        try
        {
#pragma warning disable SYSLIB0057 // é a leitura do certificado de um arquivo assinado, não de um arquivo de certificado
            using var certificado = new X509Certificate2(X509Certificate.CreateFromSignedFile(arquivo));
#pragma warning restore SYSLIB0057
            foreach (var parte in certificado.SubjectName.EnumerateRelativeDistinguishedNames())
            {
                if (parte.GetSingleElementType().Value == OidOrganizacao) return parte.GetSingleElementValue();
            }
            return null;
        }
        catch (CryptographicException) { return null; }
    }
}
