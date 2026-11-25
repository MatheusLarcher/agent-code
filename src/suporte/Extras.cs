using System.Diagnostics;
using System.IO;

namespace AgentCode.Suporte;

/// <summary>
/// Os recursos extras que põem algo no PC do cliente (Chrome e Celular). Cada um só
/// é preparado depois do Permitir e é desfeito ao encerrar ou na chave desligada.
/// </summary>
/// <param name="liberado">Diz se o cliente está com o recurso ligado agora; nada é preparado fora disso.</param>
internal sealed class Extras(
    string? raiz = null, int[]? portasDoChrome = null, OrigemDoAdb? origemDoAdb = null, ExecutorAdb? adbFalso = null, Func<string, bool>? liberado = null) : IDisposable
{
    private volatile bool entregue;

    internal ControleChrome Chrome { get; } = new(
        raiz is null ? null : Path.Combine(raiz, "chrome-extension"), portasDoChrome,
        liberado is null ? null : () => liberado(Contrato.RecursoChrome));
    internal ControleCelular Celular { get; } = new(
        raiz is null ? null : Path.Combine(raiz, "platform-tools"), origemDoAdb, adbFalso,
        liberado: liberado is null ? null : () => liberado(Contrato.RecursoCelular));

    /// <summary>
    /// O cliente acabou de permitir o recurso: prepara e devolve à IA o que fazer em
    /// seguida (nulo quando o recurso não precisa de preparo).
    /// </summary>
    internal async Task<string?> AoPermitirAsync(string recurso, CancellationToken ct)
    {
        switch (recurso)
        {
            case Contrato.RecursoChrome:
                await Chrome.GarantirAsync();
                return "O cliente permitiu o controle do Chrome. A extensão do suporte ainda precisa ser instalada no Chrome dele, e quem instala é você, pela tela. "
                    + Chrome.ComoInstalar()
                    + " Ao encerrar o suporte a extensão se remove sozinha.";
            case Contrato.RecursoCelular:
                await Celular.GarantirAsync(ct);
                return "O cliente permitiu o controle do celular e as ferramentas do Google foram baixadas e conferidas. "
                    + "Peça a ele para ligar o aparelho no PC pelo cabo USB com a Depuração USB ativada; o celular pergunta \"Permitir depuração USB?\" e só o cliente responde, na tela do aparelho. "
                    + "Depois chame remoto_android_dispositivos. Ao encerrar o suporte as ferramentas são apagadas; antes de terminar, lembre o cliente de desligar a Depuração USB no celular.";
            default:
                return null;
        }
    }

    /// <summary>
    /// Desfaz um recurso (ou todos, sem nome). Devolve verdadeiro quando ficou no
    /// Chrome uma extensão que não pôde ser removida.
    /// </summary>
    internal async Task<bool> LimparAsync(string? recurso = null)
    {
        if (entregue) return false;
        var sobrou = false;
        if (recurso is null or Contrato.RecursoChrome)
        {
            try { sobrou = await Chrome.LimparAsync(); } catch { /* o que der para desfazer */ }
        }
        if (recurso is null or Contrato.RecursoCelular)
        {
            try { await Celular.LimparAsync(); } catch { /* o que der para desfazer */ }
        }
        return sobrou;
    }

    /// <summary>O exe reaberto como administrador herda as pastas, a extensão e a ponte; o adb é conferido de novo no primeiro uso.</summary>
    internal void Retomar(Sessao sessao)
    {
        if (sessao.Recurso(Contrato.RecursoChrome) == EstadoRecurso.Ligado) _ = Chrome.GarantirAsync(reaproveitar: true);
    }

    /// <summary>Este exe entregou a sessão ao exe elevado: sai sem desfazer nada.</summary>
    internal void Largar()
    {
        entregue = true;
        Chrome.Largar();
        Celular.Largar();
    }

    /// <summary>
    /// Sobra de uma sessão que acabou sem o Encerrar (exe derrubado). Só quando não há
    /// outro exe do suporte aberto, que poderia estar usando a pasta.
    /// </summary>
    internal static void LimparSobras()
    {
        try
        {
            using var eu = Process.GetCurrentProcess();
            var outros = Process.GetProcessesByName(eu.ProcessName);
            var sozinho = outros.All((processo) => processo.Id == eu.Id);
            foreach (var processo in outros) processo.Dispose();
            if (!sozinho || !Directory.Exists(ExtensaoChrome.Raiz)) return;
            ControleCelular.ApagarChaveDaSessao(PlatformTools.PastaPadrao, ControleCelular.ChavePadrao);
            Directory.Delete(ExtensaoChrome.Raiz, true);
        }
        catch { /* em uso: fica para a próxima abertura */ }
    }

    public void Dispose()
    {
        if (entregue) return;
        Chrome.Dispose();
        Celular.Dispose();
    }
}
