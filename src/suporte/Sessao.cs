using System.Security.Cryptography;
using System.Text;

namespace AgentCode.Suporte;

/// <summary>O que a janela mostra.</summary>
internal enum Fase
{
    /// <summary>Discando para o relay.</summary>
    Conectando,
    /// <summary>Código na tela, esperando o técnico.</summary>
    Aguardando,
    /// <summary>Um técnico informou o código: a janela pergunta ao cliente.</summary>
    PedidoAcesso,
    /// <summary>Sessão aceita: as ferramentas respondem.</summary>
    Ativa,
    /// <summary>Ficou tempo demais sem técnico: o código venceu.</summary>
    Expirado,
    /// <summary>O relay recusou (desligado ou cheio); tenta de novo sozinho.</summary>
    Indisponivel,
    /// <summary>Este exe é antigo demais para o relay.</summary>
    Atualizar
}

internal enum EstadoRecurso { Ligado, Desligado, Travado }

internal sealed record EntradaRegistro(DateTime Hora, string Texto);

/// <summary>Estado que passa do exe comum para o exe reaberto como administrador.</summary>
internal sealed record EstadoRetomada(
    string Sessao, string Segredo, string Token, string Tecnico, DateTime Inicio,
    Dictionary<string, string> Recursos, List<EntradaRegistro> Registro);

/// <summary>
/// Estado de uma abertura do exe: a fase da janela, o código, a sessão aceita, o
/// token, o que o cliente ligou e desligou e o registro do que foi feito. É o único
/// lugar que decide se uma chamada pode passar — nada aqui aceita sessão sem o
/// clique do cliente.
/// </summary>
internal sealed class Sessao
{
    /// <summary>Recursos que este exe sabe fazer hoje (os demais existem só como chave travada).</summary>
    internal static readonly string[] Disponiveis =
        [Contrato.RecursoTela, Contrato.RecursoComandos, Contrato.RecursoArquivos, Contrato.RecursoAdministrador];

    private const int MaximoRegistro = 2000;
    private readonly object trava = new();
    private readonly Dictionary<string, EstadoRecurso> recursos = new();
    private readonly List<EntradaRegistro> registro = [];
    private byte[]? tokenHash;
    private string? tokenTexto;
    private TaskCompletionSource<bool>? resposta;
    private string? pedidoId;

    /// <summary>Algo visível mudou: a janela se redesenha.</summary>
    internal event Action? Mudou;
    /// <summary>Chegou uma pergunta para o cliente: trazer a janela para a frente.</summary>
    internal event Action? PedidoNovo;
    internal event Action? RegistroMudou;
    /// <summary>Um recurso mudou de estado: o relay avisa o técnico.</summary>
    internal event Action<string, EstadoRecurso>? RecursoMudou;
    /// <summary>A sessão acabou (queda, técnico ou cliente): encerrar o que ela abriu.</summary>
    internal event Action? Acabou;

    internal Fase Fase { get; private set; } = Fase.Conectando;
    internal string Codigo { get; private set; } = "";
    internal string Tecnico { get; private set; } = "";
    internal DateTime Inicio { get; private set; }
    internal string? Id { get; private set; }
    internal string? Segredo { get; private set; }
    /// <summary>Recurso extra que o técnico pediu e o cliente ainda não respondeu.</summary>
    internal string? RecursoPedido { get; private set; }
    internal bool Admin { get; } = Nativo.EhAdministrador();
    internal bool PedidoAberto { get { lock (trava) return resposta is not null; } }

    internal void NovoCodigo()
    {
        var limite = (int)Math.Pow(10, Contrato.CodigoDigitos);
        lock (trava)
        {
            Codigo = RandomNumberGenerator.GetInt32(0, limite).ToString($"D{Contrato.CodigoDigitos}");
            if (Fase != Fase.Indisponivel) Fase = Fase.Conectando; // "indisponível" só sai no ready
        }
        Mudou?.Invoke();
    }

    internal void DefinirFase(Fase fase)
    {
        lock (trava) Fase = fase;
        Mudou?.Invoke();
    }

    // ---- Perguntas ao cliente -----------------------------------------------

    /// <summary>O técnico pediu acesso. A tarefa termina no clique (ou em <see cref="FecharPedido"/>).</summary>
    internal Task<bool> PedirAcesso(string id, string tecnico)
    {
        TaskCompletionSource<bool> nova;
        lock (trava)
        {
            if (Fase != Fase.Aguardando || resposta is not null) return Task.FromResult(false);
            nova = resposta = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            pedidoId = id;
            Tecnico = tecnico;
            Fase = Fase.PedidoAcesso;
        }
        Mudou?.Invoke();
        PedidoNovo?.Invoke();
        return nova.Task;
    }

    /// <summary>O técnico pediu um recurso extra durante a sessão.</summary>
    internal Task<bool> PedirRecurso(string recurso)
    {
        TaskCompletionSource<bool> nova;
        lock (trava)
        {
            if (Fase != Fase.Ativa || resposta is not null) return Task.FromResult(false);
            nova = resposta = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            pedidoId = null;
            RecursoPedido = recurso;
        }
        Mudou?.Invoke();
        PedidoNovo?.Invoke();
        return nova.Task;
    }

    /// <summary>Clique do cliente na pergunta aberta. É o único caminho que responde "sim".</summary>
    internal void Responder(bool permitir) => Concluir(permitir, null, false);

    /// <summary>Fecha a pergunta sem resposta (prazo, técnico desistiu, conexão caiu): vale "não".</summary>
    internal void FecharPedido(string? id = null) => Concluir(false, id, true);

    private void Concluir(bool permitir, string? id, bool soSeMesmoId)
    {
        TaskCompletionSource<bool>? aberta;
        lock (trava)
        {
            if (resposta is null) return;
            if (soSeMesmoId && id is not null && pedidoId != id) return;
            aberta = resposta;
            resposta = null;
            pedidoId = null;
            if (RecursoPedido is { } recurso)
            {
                RecursoPedido = null;
                if (permitir) recursos[recurso] = EstadoRecurso.Ligado;
            }
            else if (!permitir && Fase == Fase.PedidoAcesso)
            {
                Fase = Fase.Aguardando;
                Tecnico = "";
            }
        }
        aberta.TrySetResult(permitir);
        Mudou?.Invoke();
    }

    // ---- Sessão ---------------------------------------------------------------

    /// <summary>
    /// O cliente permitiu: nasce o token (256 bits aleatórios), que só sai daqui na
    /// resposta daquele pedido. Básicos ligados, extras travados.
    /// </summary>
    internal string Ativar()
    {
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        lock (trava)
        {
            tokenTexto = token;
            tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
            Inicio = DateTime.Now;
            recursos.Clear();
            foreach (var basico in Contrato.RecursosBasicos) recursos[basico] = EstadoRecurso.Ligado;
            foreach (var extra in Contrato.RecursosExtras) recursos[extra] = EstadoRecurso.Travado;
            Fase = Fase.Ativa;
        }
        Registrar($"Sessão iniciada com {Tecnico}");
        Mudou?.Invoke();
        return token;
    }

    internal void GuardarRetomada(string id, string segredo)
    {
        lock (trava) { Id = id; Segredo = segredo; }
    }

    /// <summary>Exe reaberto como administrador: assume a sessão que o exe comum entregou.</summary>
    internal void Assumir(EstadoRetomada estado)
    {
        lock (trava)
        {
            tokenTexto = estado.Token;
            tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(estado.Token));
            Id = estado.Sessao;
            Segredo = estado.Segredo;
            Tecnico = estado.Tecnico;
            Inicio = estado.Inicio;
            recursos.Clear();
            foreach (var nome in Contrato.Recursos)
            {
                recursos[nome] = estado.Recursos.TryGetValue(nome, out var texto) && Enum.TryParse<EstadoRecurso>(texto, out var valor)
                    ? valor
                    : EstadoRecurso.Travado;
            }
            registro.Clear();
            registro.AddRange(estado.Registro);
            Fase = Fase.Ativa;
        }
        Registrar("Reaberto como administrador");
        Mudou?.Invoke();
    }

    internal EstadoRetomada? ParaRetomada()
    {
        lock (trava)
        {
            if (Fase != Fase.Ativa || tokenTexto is null || Id is null || Segredo is null) return null;
            return new EstadoRetomada(Id, Segredo, tokenTexto, Tecnico, Inicio,
                recursos.ToDictionary((par) => par.Key, (par) => par.Value.ToString()),
                registro.TakeLast(300).ToList());
        }
    }

    /// <summary>Confere o token de uma chamada, em tempo constante. Sem sessão ativa, nada passa.</summary>
    internal bool ConfereToken(string? candidato)
    {
        byte[]? esperado;
        lock (trava) esperado = Fase == Fase.Ativa ? tokenHash : null;
        if (esperado is null || string.IsNullOrEmpty(candidato) || candidato.Length > 512) return false;
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(candidato)), esperado);
    }

    /// <summary>Fim da sessão: o token morre e a janela volta ao começo.</summary>
    internal void Encerrar(string motivo)
    {
        bool estavaAtiva;
        TaskCompletionSource<bool>? aberta;
        lock (trava)
        {
            estavaAtiva = Fase == Fase.Ativa;
            aberta = resposta;
            resposta = null;
            pedidoId = null;
            RecursoPedido = null;
            tokenHash = null;
            tokenTexto = null;
            Id = null;
            Segredo = null;
            Tecnico = "";
            recursos.Clear();
            if (Fase is Fase.Ativa or Fase.PedidoAcesso or Fase.Aguardando) Fase = Fase.Conectando;
        }
        aberta?.TrySetResult(false);
        if (estavaAtiva)
        {
            Registrar(motivo);
            Acabou?.Invoke();
        }
        Mudou?.Invoke();
    }

    // ---- Recursos -------------------------------------------------------------

    internal EstadoRecurso Recurso(string nome)
    {
        lock (trava) return recursos.TryGetValue(nome, out var estado) ? estado : EstadoRecurso.Travado;
    }

    /// <summary>Chave da janela. Recurso travado não se liga por aqui: só pelo pedido do técnico.</summary>
    internal void Alternar(string nome, bool ligar)
    {
        EstadoRecurso novo;
        lock (trava)
        {
            if (Fase != Fase.Ativa || !recursos.TryGetValue(nome, out var atual) || atual == EstadoRecurso.Travado) return;
            novo = ligar ? EstadoRecurso.Ligado : EstadoRecurso.Desligado;
            if (novo == atual) return;
            recursos[nome] = novo;
        }
        Registrar($"Cliente {(ligar ? "ligou" : "desligou")}: {Rotulo(nome)}");
        RecursoMudou?.Invoke(nome, novo);
        Mudou?.Invoke();
    }

    /// <summary>Avisa o técnico que o recurso pedido foi liberado.</summary>
    internal void AvisarRecurso(string nome) => RecursoMudou?.Invoke(nome, Recurso(nome));

    internal static string Rotulo(string recurso) => recurso switch
    {
        Contrato.RecursoTela => "Tela",
        Contrato.RecursoComandos => "Comandos",
        Contrato.RecursoArquivos => "Arquivos",
        Contrato.RecursoChrome => "Chrome",
        Contrato.RecursoCelular => "Celular",
        Contrato.RecursoAdministrador => "Administrador",
        _ => recurso
    };

    // ---- Registro ---------------------------------------------------------------

    internal void Registrar(string texto)
    {
        var limpo = texto.ReplaceLineEndings(" ").Trim();
        if (limpo.Length > 160) limpo = limpo[..157] + "...";
        lock (trava)
        {
            registro.Add(new EntradaRegistro(DateTime.Now, limpo));
            if (registro.Count > MaximoRegistro) registro.RemoveRange(0, registro.Count - MaximoRegistro);
        }
        RegistroMudou?.Invoke();
    }

    internal List<EntradaRegistro> LerRegistro()
    {
        lock (trava) return [.. registro];
    }
}
