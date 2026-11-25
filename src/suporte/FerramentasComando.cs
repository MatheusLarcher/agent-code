using ModelContextProtocol.Protocol;

namespace AgentCode.Suporte;

/// <summary>PowerShell no PC do cliente: rodar, acompanhar em segundo plano e parar.</summary>
internal sealed class FerramentasComando(Comandos comandos)
{
    private const string R = Contrato.RecursoComandos;
    private const int ComandoMaximo = 100_000;

    internal IEnumerable<Ferramenta> Criar() =>
    [
        new(Contrato.PrefixoFerramenta + "executar",
            "Roda um comando ou roteiro do Windows PowerShell no computador do cliente e devolve a saída (stdout e stderr juntos, em UTF-8) e o código de saída. " +
            "Roda como o usuário do cliente, sem janela e sem entrada interativa: nada pode esperar digitação. " +
            $"Tempo limite padrão de {Contrato.ComandoPadraoMs / 1000} s (máximo {Contrato.ComandoMaximoMs / 1000} s); ao estourar, o processo e os filhos são encerrados. " +
            $"Saída acima de {Contrato.SaidaBytes / 1024} KB chega com o começo e o fim e um aviso do corte. " +
            "segundoPlano=true devolve um id na hora: acompanhe com remoto_processo_ler e pare com remoto_processo_parar.",
            Esquema.Objeto(
                [
                    Esquema.Texto("comando", "Comando ou roteiro do PowerShell (várias linhas são aceitas)."),
                    Esquema.Texto("pasta", "Pasta de trabalho, caminho completo (padrão: a pasta do usuário)."),
                    Esquema.Inteiro("tempoLimiteMs", "Tempo limite em milissegundos.", 1000, Contrato.ComandoMaximoMs),
                    Esquema.Logico("segundoPlano", "Iniciar e devolver um id sem esperar terminar.")
                ], "comando"),
            R, SoLeitura: false, Destrutiva: true,
            Executar,
            (a) => $"Comando: {Resultado.Encurtar(a.Texto("comando", ComandoMaximo), 110)}"),

        new(Contrato.PrefixoFerramenta + "processo_ler",
            "Lê a saída nova de um processo iniciado com segundoPlano e diz se ele ainda roda. aguardarMs espera até esse tempo pelo fim do processo antes de responder.",
            Esquema.Objeto(
                [
                    Esquema.Texto("id", "Id devolvido por remoto_executar."),
                    Esquema.Inteiro("aguardarMs", "Quanto esperar pelo fim (padrão: 0).", 0, 60_000)
                ], "id"),
            R, SoLeitura: true, Destrutiva: false,
            async (a, ct) =>
            {
                var (saida, situacao, _) = await comandos.Ler(a.Texto("id", 40), a.Inteiro("aguardarMs", 0, 60_000, 0), ct);
                return Resultado.Texto(saida.Length == 0 ? $"[sem saída nova · {situacao}]" : $"{saida.TrimEnd()}\n\n[{situacao}]");
            },
            (a) => $"Leu a saída do processo {Resultado.Encurtar(a.Texto("id", 40), 20)}"),

        new(Contrato.PrefixoFerramenta + "processo_parar",
            "Encerra um processo iniciado com segundoPlano, com todos os filhos.",
            Esquema.Objeto([Esquema.Texto("id", "Id devolvido por remoto_executar.")], "id"),
            R, SoLeitura: false, Destrutiva: true,
            (a, _) =>
            {
                var id = a.Texto("id", 40);
                return Task.FromResult(comandos.Parar(id)
                    ? Resultado.Texto($"Processo {id} encerrado.")
                    : Resultado.Erro($"Processo desconhecido: {id}."));
            },
            (a) => $"Parou o processo {Resultado.Encurtar(a.Texto("id", 40), 20)}")
    ];

    private async Task<CallToolResult> Executar(Args a, CancellationToken ct)
    {
        var comando = a.Texto("comando", ComandoMaximo);
        var pasta = a.TextoOpcional("pasta", 32_000);
        if (a.Logico("segundoPlano", false))
        {
            var id = comandos.IniciarEmFundo(comando, pasta);
            return Resultado.Texto($"Iniciado em segundo plano: {id}. Leia a saída com remoto_processo_ler e pare com remoto_processo_parar.");
        }

        var limite = a.Inteiro("tempoLimiteMs", 1000, Contrato.ComandoMaximoMs, Contrato.ComandoPadraoMs);
        var feito = await comandos.ExecutarAsync(comando, pasta, limite, ct);
        var saida = feito.Saida.TrimEnd();
        var tempo = $"{feito.DuracaoMs / 1000.0:0.0} s";
        if (feito.TempoEsgotado)
        {
            return Resultado.Erro(
                $"{saida}\n\n[tempo limite de {limite / 1000} s esgotado: o processo foi encerrado. Para algo demorado use segundoPlano.]".TrimStart());
        }
        var rodape = $"[código de saída {feito.Codigo} · {tempo}]";
        return Resultado.Texto(saida.Length == 0 ? $"(sem saída)\n{rodape}" : $"{saida}\n\n{rodape}");
    }
}
