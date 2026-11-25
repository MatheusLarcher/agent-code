using System.Text.Json.Nodes;

namespace AgentCode.Suporte;

/// <summary>
/// O recurso "Chrome" de uma sessão: no Permitir grava a pasta da extensão e sobe a
/// ponte; ao encerrar (ou na chave desligada) manda a extensão se remover, fecha a
/// ponte e apaga a pasta. Nada aqui roda antes do clique do cliente.
/// </summary>
internal sealed class ControleChrome(string? pasta = null, int[]? portas = null, Func<bool>? liberado = null) : IDisposable
{
    private readonly SemaphoreSlim trava = new(1, 1);
    private PonteChrome? ponte;
    private bool gravou;

    internal string Pasta { get; } = pasta ?? ExtensaoChrome.PastaPadrao;
    internal PonteChrome? Ponte => ponte;
    /// <summary>Aba padrão das chamadas que não dizem qual: a última usada nesta sessão.</summary>
    internal int? UltimaAba { get; set; }

    /// <summary>
    /// Pasta gravada e ponte no ar (uma vez por sessão). Com <paramref name="reaproveitar"/>,
    /// o exe reaberto como administrador mantém o token da pasta que já está instalada.
    /// </summary>
    internal async Task<PonteChrome> GarantirAsync(bool reaproveitar = false)
    {
        await trava.WaitAsync();
        try
        {
            if (ponte is not null) return ponte;
            // Uma chamada que chegou junto com a chave desligada ou com o Encerrar não prepara nada de novo.
            if (liberado is not null && !liberado()) throw new InvalidOperationException("O cliente desligou este recurso.");
            var token = reaproveitar ? ExtensaoChrome.TokenGravado(Pasta) : null;
            if (token is null)
            {
                token = ExtensaoChrome.NovoToken();
                ExtensaoChrome.Gravar(Pasta, token);
            }
            gravou = true;
            var nova = new PonteChrome(token, ExtensaoChrome.Versao, portas);
            nova.Iniciar();
            return ponte = nova;
        }
        finally { trava.Release(); }
    }

    /// <summary>
    /// Desfaz o que o recurso pôs no PC. Devolve verdadeiro quando a extensão ficou
    /// instalada (o Chrome estava fechado ou não respondeu): o cliente é avisado.
    /// </summary>
    internal async Task<bool> LimparAsync()
    {
        await trava.WaitAsync();
        try
        {
            var atual = ponte;
            ponte = null;
            UltimaAba = null;
            var sobrou = false;
            if (atual is not null)
            {
                if (atual.Conectada)
                {
                    try
                    {
                        await atual.ChamarAsync("uninstallSelf", new JsonObject(), 4000, CancellationToken.None);
                        // Removida, a extensão some e a conexão cai sozinha.
                        sobrou = !await atual.EsperarQuedaAsync(4000);
                    }
                    catch { sobrou = true; }
                }
                else sobrou = atual.JaConectou;
                await atual.PararAsync();
            }
            if (gravou)
            {
                gravou = false;
                ExtensaoChrome.Apagar(Pasta);
                ExtensaoChrome.ApagarRaizSeVazia(Pasta);
            }
            return sobrou;
        }
        finally { trava.Release(); }
    }

    /// <summary>O exe elevado assumiu a sessão: este fecha a ponte e deixa pasta e extensão como estão.</summary>
    internal void Largar()
    {
        var atual = ponte;
        ponte = null;
        gravou = false;
        if (atual is not null) _ = atual.PararAsync();
    }

    /// <summary>
    /// A resposta curta de uma ferramenta sem conexão (o erro de uma chamada é cortado em
    /// 800 caracteres): diz a pasta e aponta para quem ensina a instalar.
    /// </summary>
    internal string SemConexao() =>
        $"A extensão do suporte não está conectada ao Chrome do cliente (pasta da extensão: {Pasta}). " +
        "Se ainda não foi instalada, remoto_chrome_status ensina a instalar pela tela. " +
        "Se já foi, o Chrome pode estar fechado ou a extensão reconectando (até 30 s).";

    /// <summary>O passo a passo completo da instalação, para o Permitir e para remoto_chrome_status.</summary>
    internal string ComoInstalar() =>
        "A extensão do suporte não está conectada ao Chrome do cliente. " +
        "Se ainda não foi instalada, instale pela tela, com as ferramentas de janela: " +
        "(1) descubra os perfis em %LOCALAPPDATA%\\Google\\Chrome\\User Data\\Local State (JSON, chave profile.info_cache); com mais de um, pergunte ao técnico qual usar; " +
        "(2) remoto_launch_app com app \"chrome\" e o argumento --profile-directory=<pasta do perfil> (não passe chrome://extensions como argumento: o Chrome ignora); " +
        "(3) escreva chrome://extensions na \"Barra de endereço e de pesquisa\" e confirme com Enter; " +
        "(4) ligue o \"Modo do desenvolvedor\"; " +
        "(5) clique em \"Carregar sem compactação\": a janela de escolher pasta abre como uma janela à parte do Chrome; ache-a com remoto_list_windows e aja nela pelo id dela; " +
        $"(6) no campo \"Pasta\" informe {Pasta} e confirme em \"Selecionar pasta\"; " +
        "(7) confira com remoto_chrome_status. " +
        "Um clique que abre página ou diálogo pode responder \"não respondeu em 1,2 s\" e chegar logo depois: observe a janela antes de repetir. " +
        "Se já foi instalada, o Chrome pode estar fechado ou a extensão reconectando (até 30 s). " +
        "Não mexa em outras extensões nem feche abas do cliente.";

    public void Dispose()
    {
        var atual = ponte;
        ponte = null;
        if (atual is not null) _ = atual.PararAsync();
        if (gravou)
        {
            gravou = false;
            ExtensaoChrome.Apagar(Pasta);
            ExtensaoChrome.ApagarRaizSeVazia(Pasta);
        }
    }
}
