using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using ModelContextProtocol.Protocol;

namespace AgentCode.Suporte;

/// <summary>
/// O que não é janela, comando nem arquivo: a foto da tela inteira, o retrato do
/// computador, o pedido de um recurso extra ao cliente e a elevação.
/// </summary>
internal sealed class FerramentasSistema(Sessao sessao, Action sairDepoisDeElevar)
{
    internal IEnumerable<Ferramenta> Criar() =>
    [
        new(Contrato.PrefixoFerramenta + "captura_tela",
            "Captura a tela do cliente em PNG: tudo (padrão) ou um monitor. Serve para ver o que ele vê. " +
            "Para clicar por coordenada, use a captura de remoto_get_state, que é da janela e traz o screenshotId.",
            Esquema.Objeto([Esquema.Inteiro("monitor", "Número do monitor (1 = principal). Sem ele, captura todos.", 1, 16)]),
            Contrato.RecursoTela, SoLeitura: true, Destrutiva: false,
            (a, ct) => Task.Run(() =>
            {
                var imagem = a.Tem("monitor") ? Captura.Monitor(a.Inteiro("monitor", 1, 16)) : Captura.TelaInteira();
                return Resultado.ComImagem(
                    $"Captura de {imagem.LarguraOriginal}x{imagem.AlturaOriginal} (imagem de {imagem.Largura}x{imagem.Altura}).", imagem.Png);
            }, ct),
            (_) => "Capturou a tela"),

        new(Contrato.PrefixoFerramenta + "info",
            "Retrato do computador do cliente: nome, usuário, versão do Windows, memória, discos, monitores, se o suporte roda como administrador e o estado de cada recurso (ligado, desligado pelo cliente ou travado). Chame no começo.",
            Esquema.Vazio,
            null, SoLeitura: true, Destrutiva: false,
            (_, ct) => Task.Run(() => Resultado.Objeto(Info()), ct),
            (_) => "Consultou as informações do computador"),

        new(Contrato.PrefixoFerramenta + "pedir_recurso",
            "Pede ao cliente, na janela do suporte, que libere um recurso extra. Só ele responde. " +
            "Tela, Comandos e Arquivos já vêm ligados e, se ele desligar, só ele religa. Recursos extras hoje: administrador.",
            Esquema.Objeto([Esquema.Opcoes("recurso", "Recurso a pedir.", Contrato.Recursos)], "recurso"),
            null, SoLeitura: false, Destrutiva: false,
            PedirRecurso,
            (_) => ""), // anota sozinha: o pedido e a resposta do cliente, sem "erro" numa recusa

        new(Contrato.PrefixoFerramenta + "elevar",
            "Reabre o suporte como administrador, mantendo a sessão. Antes peça o recurso administrador com remoto_pedir_recurso; " +
            "depois disso o Windows mostra a confirmação (UAC) na tela do cliente, e só ele confirma. " +
            "Processos em segundo plano iniciados antes são encerrados na troca.",
            Esquema.Vazio,
            Contrato.RecursoAdministrador, SoLeitura: false, Destrutiva: false,
            Elevar,
            (_) => "Pediu ao Windows para rodar como administrador")
    ];

    private async Task<CallToolResult> PedirRecurso(Args a, CancellationToken ct)
    {
        var recurso = a.Opcao("recurso", "", Contrato.Recursos);
        var rotulo = Sessao.Rotulo(recurso);
        if (Contrato.RecursosBasicos.Contains(recurso))
        {
            return sessao.Recurso(recurso) == EstadoRecurso.Ligado
                ? Resultado.Texto($"{rotulo} já está ligado.")
                : Resultado.Erro($"O cliente desligou este recurso ({rotulo}). Só ele religa, na janela do suporte.");
        }
        if (!Sessao.Disponiveis.Contains(recurso))
            return Resultado.Erro($"O recurso {rotulo} ainda não está disponível nesta versão do suporte.");
        switch (sessao.Recurso(recurso))
        {
            case EstadoRecurso.Ligado: return Resultado.Texto($"{rotulo} já está liberado.");
            case EstadoRecurso.Desligado: return Resultado.Erro($"O cliente desligou este recurso ({rotulo}). Só ele religa, na janela do suporte.");
        }
        if (sessao.PedidoAberto) return Resultado.Erro("Já há uma pergunta aberta na tela do cliente. Aguarde a resposta dele.");
        // Nenhuma pergunta aparece enquanto a IA mexe no mouse ou no teclado.
        for (var espera = 0; Automacao.Injetando && espera < 20; espera++) await Task.Delay(150, ct);
        if (Automacao.Injetando) return Resultado.Erro("Há uma ação na tela em andamento. Espere terminar e peça de novo.");

        sessao.Registrar($"Técnico pediu: {rotulo}");
        var clique = sessao.PedirRecurso(recurso);
        try
        {
            if (await Task.WhenAny(clique, Task.Delay(Contrato.PedidoRecursoMs, ct)) != clique) sessao.FecharPedido();
        }
        catch (OperationCanceledException)
        {
            sessao.FecharPedido();
            throw;
        }
        if (!await clique)
        {
            sessao.Registrar($"Cliente não permitiu: {rotulo}");
            return Resultado.Erro($"O cliente não permitiu ({rotulo}). Não insista: explique a ele por que precisa e peça de novo só se ele concordar.");
        }
        sessao.Registrar($"Cliente permitiu: {rotulo}");
        sessao.AvisarRecurso(recurso);
        return Resultado.Texto(recurso == Contrato.RecursoAdministrador
            ? "O cliente permitiu. Chame remoto_elevar: o Windows vai pedir a confirmação dele na tela."
            : $"O cliente permitiu ({rotulo}).");
    }

    private async Task<CallToolResult> Elevar(Args a, CancellationToken ct)
    {
        if (sessao.Admin) return Resultado.Texto("O suporte já roda como administrador.");
        if (sessao.ParaRetomada() is not { } estado)
            return Resultado.Erro("A sessão ainda não pode ser reaberta. Tente de novo em alguns segundos.");
        var (ok, mensagem) = await Elevacao.ElevarAsync(estado, ct);
        if (!ok) return Resultado.Erro(mensagem);
        sairDepoisDeElevar();
        return Resultado.Texto(mensagem);
    }

    private object Info()
    {
        var (total, livre) = Nativo.Memoria();
        return new
        {
            pc = Environment.MachineName,
            usuario = Environment.UserName,
            dominio = Environment.UserDomainName,
            sistema = Windows(),
            arquitetura = RuntimeInformation.OSArchitecture.ToString(),
            administrador = sessao.Admin,
            ligadoHa = Duracao(TimeSpan.FromMilliseconds(Environment.TickCount64)),
            horaLocal = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
            fuso = TimeZoneInfo.Local.Id,
            pastaDoUsuario = Comandos.PastaPadrao,
            memoria = new { total = Caminhos.Tamanho((long)total), livre = Caminhos.Tamanho((long)livre) },
            discos = Discos(),
            monitores = Captura.Monitores(),
            recursos = Contrato.Recursos.ToDictionary(
                (nome) => nome,
                (nome) => Sessao.Disponiveis.Contains(nome) ? sessao.Recurso(nome).ToString().ToLowerInvariant() : "indisponivel"),
            suporte = new { versao = Elo.Versao, tecnico = sessao.Tecnico, inicio = sessao.Inicio.ToString("yyyy-MM-dd HH:mm:ss") }
        };
    }

    private static object[] Discos()
    {
        var discos = new List<object>();
        foreach (var disco in DriveInfo.GetDrives())
        {
            try
            {
                if (!disco.IsReady) continue;
                discos.Add(new
                {
                    unidade = disco.Name,
                    tipo = disco.DriveType.ToString(),
                    rotulo = disco.VolumeLabel,
                    total = Caminhos.Tamanho(disco.TotalSize),
                    livre = Caminhos.Tamanho(disco.AvailableFreeSpace)
                });
            }
            catch { /* unidade sem mídia ou sem acesso */ }
        }
        return [.. discos];
    }

    internal static string Windows()
    {
        var versao = Environment.OSVersion.Version;
        try
        {
            using var chave = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            var nome = chave?.GetValue("ProductName") as string ?? "Windows";
            // O Windows 11 ainda se apresenta como "Windows 10" nesse valor.
            if (versao.Build >= 22000) nome = nome.Replace("Windows 10", "Windows 11");
            var edicao = chave?.GetValue("DisplayVersion") as string;
            var revisao = chave?.GetValue("UBR") is int ubr ? $".{ubr}" : "";
            return $"{nome}{(edicao is null ? "" : " " + edicao)} (compilação {versao.Build}{revisao})";
        }
        catch { return $"Windows {versao}"; }
    }

    private static string Duracao(TimeSpan tempo)
        => tempo.TotalDays >= 1 ? $"{(int)tempo.TotalDays} d {tempo.Hours} h" : $"{tempo.Hours} h {tempo.Minutes} min";
}
