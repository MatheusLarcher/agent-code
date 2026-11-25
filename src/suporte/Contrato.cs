namespace AgentCode.Suporte;

/// <summary>
/// Espelho de <c>src/shared/suporteRemoto.ts</c>: mesmos nomes (em PascalCase) e
/// mesmos números. O teste <c>suporteRemoto.test.ts</c> lê este arquivo como texto
/// e falha se um lado mudar sem o outro. Só literais e multiplicações aqui.
/// </summary>
internal static class Contrato
{
    public const int Protocolo = 1;
    public const int ProtocoloMinimo = 1;

    public const string CaminhoWs = "/__suporte";
    public const string CaminhoParear = "/suporte/parear";
    public const string CaminhoMcp = "/suporte/mcp";
    public const string CaminhoEventos = "/suporte/eventos";
    public const string CaminhoEncerrar = "/suporte/encerrar";
    public const string CaminhoDownload = "/suporte";
    public const string DownloadUrl = "https://github.com/MatheusLarcher/agent-code/releases/latest/download/AgentCode-Suporte.exe";
    public const string CabecalhoChave = "x-suporte-chave";
    public const string PrefixoFerramenta = "remoto_";

    // Limites (bytes e milissegundos).
    public const int ChamadaBytes = 32 * 1024 * 1024;
    public const int ArquivoBytes = 20 * 1024 * 1024;
    public const int SaidaBytes = 200 * 1024;
    public const int ComandoPadraoMs = 120_000;
    public const int ComandoMaximoMs = 600_000;
    public const int BatimentoMs = 20_000;
    public const int MortoMs = 65_000;
    public const int SemTecnicoMs = 15 * 60_000;
    public const int PedidoAcessoMs = 60_000;
    public const int PedidoRecursoMs = 5 * 60_000;
    public const int CodigoDigitos = 9;
    public const int TentativasPorMinuto = 5;
    public const int BloqueioMs = 10 * 60_000;
    public const int MaximoExes = 50;

    // Recursos, na ordem da janela.
    public const string RecursoTela = "tela";
    public const string RecursoComandos = "comandos";
    public const string RecursoArquivos = "arquivos";
    public const string RecursoChrome = "chrome";
    public const string RecursoCelular = "celular";
    public const string RecursoAdministrador = "administrador";

    public static readonly string[] Recursos =
        [RecursoTela, RecursoComandos, RecursoArquivos, RecursoChrome, RecursoCelular, RecursoAdministrador];
    public static readonly string[] RecursosBasicos = [RecursoTela, RecursoComandos, RecursoArquivos];
    public static readonly string[] RecursosExtras = [RecursoChrome, RecursoCelular, RecursoAdministrador];

    /// <summary>Endereço fixo do relay. Só troca para teste local (ver <see cref="RelayUrl"/>).</summary>
    public const string RelayPadrao = "wss://agent-code.larchertech.com";

    /// <summary>
    /// Variável de teste: só é aceita se apontar para a própria máquina
    /// (<c>127.0.0.1</c> ou <c>localhost</c>). Qualquer outro valor é ignorado, para
    /// ninguém desviar o exe de um cliente para outro relay.
    /// </summary>
    public const string VariavelRelayTeste = "AGENT_CODE_SUPORTE_RELAY";

    public static Uri RelayUrl()
    {
        var teste = Environment.GetEnvironmentVariable(VariavelRelayTeste);
        if (!string.IsNullOrWhiteSpace(teste)
            && Uri.TryCreate(teste.Trim(), UriKind.Absolute, out var uri)
            && uri.Scheme is "ws" or "http"
            && uri.Host is "127.0.0.1" or "localhost"
            && string.IsNullOrEmpty(uri.UserInfo))
        {
            return new Uri($"ws://{uri.Host}:{uri.Port}{CaminhoWs}");
        }
        return new Uri(RelayPadrao + CaminhoWs);
    }
}
