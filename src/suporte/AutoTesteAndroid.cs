using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using ModelContextProtocol.Protocol;
using static AgentCode.Suporte.AutoTeste;

namespace AgentCode.Suporte;

/// <summary>
/// Parte do <c>--self-test</c>: o recurso Celular sem celular e sem internet. O pacote
/// vem de um servidor local, a assinatura é conferida em executáveis assinados que já
/// estão no PC e um <c>adb</c> falso anota os argumentos de cada ferramenta. O download
/// de verdade é o de <c>scripts/suporte-e2e.mjs</c>.
/// </summary>
internal static class AutoTesteAndroid
{
    private const string S = "R58M12345";

    /// <summary>Um executável com assinatura digital embutida que já existe neste PC, e quem o assinou.</summary>
    private static (string Arquivo, string Organizacao) Assinado()
    {
        var programas = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        (string, string)[] candidatos =
        [
            (Path.Combine(programas, "dotnet", "dotnet.exe"), "Microsoft Corporation"),
            (Path.Combine(programas, "Google", "Chrome", "Application", "chrome.exe"), "Google LLC"),
            (Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"), "Google LLC"),
            (Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe"), "Google LLC")
        ];
        foreach (var (arquivo, organizacao) in candidatos)
        {
            if (File.Exists(arquivo) && Assinatura.Confere(arquivo, organizacao, out _)) return (arquivo, organizacao);
        }
        throw new InvalidOperationException("nenhum executável assinado conhecido neste PC (dotnet.exe ou chrome.exe) para conferir a assinatura");
    }

    internal static Task AssinaturaDigital()
    {
        var (arquivo, organizacao) = Assinado();
        var pasta = PastaDeTeste();
        try
        {
            Confere(!Assinatura.Confere(arquivo, "Outra Empresa Ltda", out var motivo) && motivo.Contains($"assinado por \"{organizacao}\""), $"aceitou outro assinante: {motivo}");
            Confere(!Assinatura.Confere(arquivo, organizacao.ToLowerInvariant(), out _), "comparou o assinante sem diferenciar maiúsculas");

            var alterado = Path.Combine(pasta, "alterado.exe");
            var bytes = File.ReadAllBytes(arquivo);
            bytes[bytes.Length / 3] ^= 0xFF; // um byte trocado: a assinatura continua lá, mas não vale mais
            File.WriteAllBytes(alterado, bytes);
            Confere(!Assinatura.Confere(alterado, organizacao, out motivo) && motivo.Contains("sem assinatura digital válida"), $"aceitou um arquivo alterado: {motivo}");

            var semAssinatura = Path.Combine(pasta, "adb.exe");
            File.WriteAllText(semAssinatura, "MZ isto não é um programa");
            Confere(!Assinatura.Confere(semAssinatura, organizacao, out motivo) && motivo.Contains("sem assinatura digital válida"), $"aceitou um arquivo sem assinatura: {motivo}");
            Confere(!Assinatura.Confere(Path.Combine(pasta, "nao-existe.exe"), organizacao, out _), "aceitou um arquivo que não existe");
        }
        finally { Directory.Delete(pasta, true); }
        return Task.CompletedTask;
    }

    // ---- Download ------------------------------------------------------------------

    /// <summary>Servidor HTTP mínimo, só na própria máquina, que entrega um corpo fixo.</summary>
    private sealed class ServidorLocal : IDisposable
    {
        private readonly TcpListener escuta = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource vida = new();

        internal ServidorLocal(Func<(int Codigo, byte[] Corpo)> responder)
        {
            escuta.Start();
            _ = Task.Run(async () =>
            {
                while (!vida.IsCancellationRequested)
                {
                    try
                    {
                        using var cliente = await escuta.AcceptTcpClientAsync(vida.Token);
                        await using var fluxo = cliente.GetStream();
                        var pedido = new byte[8192];
                        var lidos = 0;
                        while (lidos < pedido.Length && !Encoding.ASCII.GetString(pedido, 0, lidos).Contains("\r\n\r\n"))
                        {
                            var agora = await fluxo.ReadAsync(pedido.AsMemory(lidos), vida.Token);
                            if (agora == 0) break;
                            lidos += agora;
                        }
                        var (codigo, corpo) = responder();
                        await fluxo.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 {codigo} X\r\nContent-Type: application/zip\r\nContent-Length: {corpo.Length}\r\nConnection: close\r\n\r\n"), vida.Token);
                        await fluxo.WriteAsync(corpo, vida.Token);
                    }
                    catch { /* cliente desistiu ou servidor fechando */ }
                }
            });
        }

        internal string Url => $"http://127.0.0.1:{((IPEndPoint)escuta.LocalEndpoint).Port}/platform-tools.zip";

        public void Dispose()
        {
            vida.Cancel();
            escuta.Stop();
        }
    }

    private static byte[] Zip(params (string Nome, byte[] Bytes)[] itens)
    {
        using var memoria = new MemoryStream();
        using (var zip = new ZipArchive(memoria, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (nome, bytes) in itens)
            {
                using var entrada = zip.CreateEntry(nome, CompressionLevel.Fastest).Open();
                entrada.Write(bytes);
            }
        }
        return memoria.ToArray();
    }

    internal static async Task Download()
    {
        var (arquivo, organizacao) = Assinado();
        var bom = File.ReadAllBytes(arquivo);
        var falso = Encoding.ASCII.GetBytes("MZ programa sem assinatura");
        var raiz = PastaDeTeste();
        var resposta = (Codigo: 200, Corpo: Array.Empty<byte>());
        using var servidor = new ServidorLocal(() => resposta);
        var pasta = Path.Combine(raiz, "platform-tools");
        try
        {
            // Pacote bom: só os três arquivos saem do zip, conferidos e presos contra troca.
            resposta = (200, Zip(
                ("platform-tools/adb.exe", bom), ("platform-tools/AdbWinApi.dll", bom), ("platform-tools/AdbWinUsbApi.dll", bom),
                ("platform-tools/fastboot.exe", falso), ("../fora.txt", falso), ("platform-tools/../../fora.txt", falso), ("adb.exe", falso)));
            using (var celular = new ControleCelular(pasta, new OrigemDoAdb(servidor.Url, organizacao)))
            {
                await celular.GarantirAsync(CancellationToken.None);
                var nomes = Directory.EnumerateFileSystemEntries(pasta).Select(Path.GetFileName).Order().ToArray();
                Confere(nomes.SequenceEqual(PlatformTools.Arquivos.Order()), $"a pasta deveria ter só os três arquivos: {string.Join(", ", nomes)}");
                Confere(!File.Exists(Path.Combine(raiz, "fora.txt")) && !File.Exists(Path.Combine(Path.GetDirectoryName(raiz)!, "fora.txt")), "um caminho de dentro do zip escapou da pasta");
                Confere(File.ReadAllBytes(Path.Combine(pasta, "adb.exe")).Length == bom.Length, "extraiu o adb errado");
                var trocou = true;
                try { File.WriteAllText(Path.Combine(pasta, "adb.exe"), "troca"); } catch (IOException) { trocou = false; }
                Confere(!trocou, "deu para trocar o adb depois de conferido");
                await celular.LimparAsync();
                Confere(!Directory.Exists(pasta) && !celular.Pronto, "a pasta ficou depois de limpar");
            }

            // Assinado por outra empresa, sem assinatura, pacote incompleto, pacote inválido, erro do servidor:
            // nada é usado e a pasta não fica.
            (string Caso, int Codigo, byte[] Corpo, string Organizacao, string Esperado)[] ruins =
            [
                ("outro assinante", 200, resposta.Corpo, "Empresa Que Não Assinou", "assinado por"),
                ("sem assinatura", 200, Zip(("platform-tools/adb.exe", falso), ("platform-tools/AdbWinApi.dll", bom), ("platform-tools/AdbWinUsbApi.dll", bom)), organizacao, "sem assinatura digital válida"),
                ("biblioteca sem assinatura", 200, Zip(("platform-tools/adb.exe", bom), ("platform-tools/AdbWinApi.dll", bom), ("platform-tools/AdbWinUsbApi.dll", falso)), organizacao, "AdbWinUsbApi.dll"),
                ("pacote incompleto", 200, Zip(("platform-tools/adb.exe", bom)), organizacao, "não traz"),
                ("pacote inválido", 200, falso, organizacao, "não é um pacote válido"),
                ("erro do servidor", 404, falso, organizacao, "HTTP 404")
            ];
            foreach (var (caso, codigo, corpo, quem, esperado) in ruins)
            {
                resposta = (codigo, corpo);
                using var celular = new ControleCelular(pasta, new OrigemDoAdb(servidor.Url, quem));
                var mensagem = "";
                try { await celular.GarantirAsync(CancellationToken.None); }
                catch (InvalidOperationException erro) { mensagem = erro.Message; }
                Confere(mensagem.Contains(esperado), $"{caso}: esperava \"{esperado}\", veio \"{mensagem}\"");
                Confere(!celular.Pronto && !Directory.Exists(pasta), $"{caso}: a pasta ficou no PC");
            }

            // Pelo caminho do técnico: o cliente permite, o adb não confere e nenhuma ferramenta o usa.
            resposta = (200, Zip(("platform-tools/adb.exe", falso), ("platform-tools/AdbWinApi.dll", falso), ("platform-tools/AdbWinUsbApi.dll", falso)));
            using var nucleo = new Nucleo(raiz, [0], new OrigemDoAdb(servidor.Url, organizacao));
            await Ativar(nucleo.Sessao);
            var (texto, falhou) = await Permitir(nucleo);
            Confere(falhou && texto.Contains("a preparação falhou") && texto.Contains("sem assinatura digital válida"), $"o Permitir com adb sem assinatura: {texto}");
            (texto, falhou, _) = await Chamar(nucleo, "android_dispositivos");
            Confere(falhou && texto.Contains("sem assinatura digital válida") && !Directory.Exists(pasta), $"usou um adb sem assinatura: {texto}");
        }
        finally { if (Directory.Exists(raiz)) Directory.Delete(raiz, true); }
    }

    // ---- Ferramentas, com um adb falso ----------------------------------------------

    private sealed class AdbFalso
    {
        private readonly List<string> chamadas = [];
        internal string Aparelhos { get; set; } = "";
        /// <summary>O que o adb de verdade faz ao subir (criar a chave de pareamento, por exemplo).</summary>
        internal Action? AoIniciar { get; set; }
        internal string[] Chamadas { get { lock (chamadas) return [.. chamadas]; } }
        internal string Ultima => Chamadas[^1];

        internal Task<SaidaAdb> Rodar(IReadOnlyList<string> argumentos, int prazoMs, int limiteBytes, CancellationToken ct)
        {
            lock (chamadas) chamadas.Add(string.Join(" ", argumentos));
            var comando = string.Join(" ", argumentos.SkipWhile((a) => a == "-s" || a == S));
            if (comando == "start-server") AoIniciar?.Invoke();
            byte[] saida = comando switch
            {
                "devices -l" => Encoding.UTF8.GetBytes($"List of devices attached\n{Aparelhos}\n"),
                "exec-out screencap -p" => Tela(),
                _ when comando.StartsWith("install ", StringComparison.Ordinal) => Encoding.UTF8.GetBytes("Performing Streamed Install\nSuccess\n"),
                "shell pm list packages" => Encoding.UTF8.GetBytes("package:com.exemplo.ação\n"),
                _ => []
            };
            return Task.FromResult(new SaidaAdb(comando == "shell exit 3" ? 3 : 0, saida, "", false));
        }

        private static byte[] Tela()
        {
            using var bitmap = new Bitmap(1080, 2400, PixelFormat.Format24bppRgb);
            using var png = new MemoryStream();
            bitmap.Save(png, ImageFormat.Png);
            return png.ToArray();
        }
    }

    private static async Task<(string Texto, bool Erro)> Permitir(Nucleo nucleo)
    {
        var pedido = Chamar(nucleo, "pedir_recurso", new { recurso = Contrato.RecursoCelular });
        await Ate(() => nucleo.Sessao.PedidoAberto, "o pedido chegar à janela");
        Confere(!nucleo.Extras.Celular.Pronto, "preparou o celular antes do clique do cliente");
        nucleo.Sessao.Responder(true);
        var (texto, erro, _) = await pedido;
        return (texto, erro);
    }

    private static async Task Ate(Func<bool> condicao, string oQue)
    {
        for (var tentativa = 0; tentativa < 200; tentativa++)
        {
            if (condicao()) return;
            await Task.Delay(25);
        }
        throw new InvalidOperationException($"tempo esgotado esperando {oQue}");
    }

    /// <summary>A chave de pareamento que o adb grava na pasta do usuário: a da sessão some, a do cliente fica.</summary>
    internal static async Task Chave()
    {
        var raiz = PastaDeTeste();
        try
        {
            var pasta = Path.Combine(raiz, "sessao", "platform-tools");
            var chave = Path.Combine(raiz, ".android");
            string[] arquivos = [Path.Combine(chave, "adbkey"), Path.Combine(chave, "adbkey.pub")];
            var adb = new AdbFalso
            {
                // O adb de verdade cria a chave ao subir, se o PC ainda não tem uma.
                AoIniciar = () =>
                {
                    Directory.CreateDirectory(chave);
                    foreach (var arquivo in arquivos.Where((arquivo) => !File.Exists(arquivo))) File.WriteAllText(arquivo, "da sessão");
                }
            };
            string[] listar = ["devices", "-l"];
            async Task Sessao()
            {
                using var celular = new ControleCelular(pasta, null, adb.Rodar, chave);
                await celular.AdbAsync(listar, 5000, 4096, CancellationToken.None);
                Confere(arquivos.All(File.Exists), "o adb falso não criou a chave");
                await celular.LimparAsync();
                Confere(!Directory.Exists(pasta), "a pasta da sessão ficou");
            }

            // PC sem chave: a que nasceu na sessão some, e a pasta .android criada junto também.
            await Sessao();
            Confere(!Directory.Exists(chave), "a chave criada na sessão ficou no PC");

            // PC com a pasta .android de outro programa, mas sem chave: só a chave some.
            Directory.CreateDirectory(chave);
            var outro = Path.Combine(chave, "adb_usb.ini");
            File.WriteAllText(outro, "do cliente");
            await Sessao();
            Confere(!arquivos.Any(File.Exists) && File.ReadAllText(outro) == "do cliente", "apagou além da chave da sessão");

            // PC que já tinha a chave: fica como estava.
            foreach (var arquivo in arquivos) File.WriteAllText(arquivo, "do cliente");
            await Sessao();
            Confere(arquivos.All((arquivo) => File.ReadAllText(arquivo) == "do cliente"), "mexeu na chave que já era do cliente");

            // O exe reaberto como administrador herda a marca: a chave da sessão some do mesmo jeito.
            foreach (var arquivo in arquivos) File.Delete(arquivo);
            var comum = new ControleCelular(pasta, null, adb.Rodar, chave);
            await comum.AdbAsync(listar, 5000, 4096, CancellationToken.None);
            comum.Largar();
            Confere(arquivos.All(File.Exists) && Directory.Exists(pasta), "largar para o exe elevado não deveria desfazer nada");
            await Sessao();
            Confere(!arquivos.Any(File.Exists) && File.Exists(outro), "o exe elevado não desfez a chave da sessão");
        }
        finally { Directory.Delete(raiz, true); }
    }

    internal static async Task SemPermitir()
    {
        var adb = new AdbFalso();
        using var nucleo = new Nucleo(PastaQueNaoExiste(), [0], adbFalso: adb.Rodar);
        await Ativar(nucleo.Sessao);
        var doCelular = nucleo.Ferramentas.Todas.Where((f) => f.Nome.StartsWith(Contrato.PrefixoFerramenta + "android_", StringComparison.Ordinal)).ToList();
        Confere(doCelular.Count == 8 && doCelular.All((f) => f.Recurso == Contrato.RecursoCelular), $"{doCelular.Count} ferramentas do celular");
        string[] soLeitura = ["remoto_android_dispositivos", "remoto_android_captura"];
        Confere(doCelular.All((f) => f.SoLeitura == soLeitura.Contains(f.Nome)), "só dispositivos e captura são de leitura");
        foreach (var ferramenta in doCelular)
        {
            var (texto, erro, _) = await Chamar(nucleo, ferramenta.Nome[Contrato.PrefixoFerramenta.Length..]);
            Confere(erro && texto.Contains("peça ao cliente"), $"{ferramenta.Nome} passou sem o Permitir: {texto}");
        }
        Confere(adb.Chamadas.Length == 0 && !nucleo.Extras.Celular.Pronto, "rodou o adb sem o Permitir");
    }

    private static string PastaQueNaoExiste() => Path.Combine(Path.GetTempPath(), $"AgentCodeSuporte-teste-{Guid.NewGuid():N}");

    internal static async Task Comandos()
    {
        var adb = new AdbFalso();
        var apk = Path.Combine(PastaDeTeste(), "app teste.apk");
        File.WriteAllText(apk, "apk");
        try
        {
            using var nucleo = new Nucleo(PastaQueNaoExiste(), [0], adbFalso: adb.Rodar);
            await Ativar(nucleo.Sessao);
            var (texto, erro) = await Permitir(nucleo);
            Confere(!erro && texto.Contains("Depuração USB") && texto.Contains("só o cliente responde"), $"o Permitir não orienta o segundo consentimento: {texto}");
            Confere(nucleo.Sessao.Recurso(Contrato.RecursoCelular) == EstadoRecurso.Ligado && adb.Chamadas.Length == 0, "o Permitir já rodou o adb");

            async Task Espera(string ferramenta, object? argumentos, string comando, string naResposta = "")
            {
                var (resposta, falhou, _) = await Chamar(nucleo, ferramenta, argumentos);
                Confere(!falhou && resposta.Contains(naResposta), $"{ferramenta} falhou: {resposta}");
                Confere(adb.Ultima == comando, $"{ferramenta} montou \"{adb.Ultima}\", esperava \"{comando}\"");
            }
            async Task Recusa(string ferramenta, object? argumentos, string motivo)
            {
                var antes = adb.Chamadas.Count((c) => !c.StartsWith("devices", StringComparison.Ordinal));
                var (resposta, falhou, _) = await Chamar(nucleo, ferramenta, argumentos);
                Confere(falhou && resposta.Contains(motivo), $"{ferramenta} deveria recusar com \"{motivo}\": {resposta}");
                Confere(adb.Chamadas.Count((c) => !c.StartsWith("devices", StringComparison.Ordinal)) == antes, $"{ferramenta} rodou o adb mesmo recusando");
            }

            // Sem aparelho: lista vazia com o que pedir ao cliente.
            await Espera("android_dispositivos", null, "devices -l", "\"dispositivos\": []");
            Confere(adb.Chamadas.SequenceEqual(["start-server", "devices -l"]), $"primeiro uso: {string.Join(" | ", adb.Chamadas)}");
            (texto, _, _) = await Chamar(nucleo, "android_dispositivos");
            Confere(texto.Contains("Depuração USB") && texto.Contains("cabo USB"), $"lista vazia sem instrução: {texto}");
            await Recusa("android_captura", null, "Nenhum aparelho ligado");

            // O celular perguntando "Permitir depuração USB?": só o cliente responde.
            adb.Aparelhos = $"{S}\tunauthorized usb:1-4 transport_id:1";
            await Espera("android_dispositivos", null, "devices -l", "\"estado\": \"unauthorized\"");
            await Recusa("android_tecla", new { tecla = "HOME" }, "Permitir depuração USB?");

            adb.Aparelhos = $"{S}\tdevice usb:1-4 product:panther model:Pixel_7 device:panther transport_id:1";
            await Espera("android_dispositivos", null, "devices -l", "\"modelo\": \"Pixel 7\"");
            await Recusa("android_tocar", new { x = 0.5, y = 0.5 }, "Capture a tela antes");

            var (meta, semImagem, bruto) = await Chamar(nucleo, "android_captura");
            var imagem = bruto.Content.OfType<ImageContentBlock>().FirstOrDefault();
            Confere(!semImagem && imagem?.MimeType == "image/png" && adb.Ultima == $"-s {S} exec-out screencap -p", $"captura: {meta}");
            Confere(meta.Contains("\"largura\": 1080") && meta.Contains("\"altura\": 2400") && meta.Contains("\"altura\": 1600"), $"tamanhos da captura: {meta}");

            await Espera("android_tocar", new { x = 0.5, y = 0.25 }, $"-s {S} shell input tap 540 600");
            await Espera("android_deslizar", new { x1 = 0.5, y1 = 0.8, x2 = 0.5, y2 = 0.2 }, $"-s {S} shell input swipe 540 1919 540 480 300");
            await Espera("android_deslizar", new { x1 = 0, y1 = 0, x2 = 1, y2 = 1, duracaoMs = 800, serial = S }, $"-s {S} shell input swipe 0 0 1079 2399 800");
            await Espera("android_digitar", new { texto = "ola mundo; rm -rf 'x'" }, $"-s {S} shell input text 'ola%smundo;%srm%s-rf%s'\\''x'\\'''");
            await Espera("android_tecla", new { tecla = "home" }, $"-s {S} shell input keyevent KEYCODE_HOME");
            await Espera("android_tecla", new { tecla = "KEYCODE_BACK" }, $"-s {S} shell input keyevent KEYCODE_BACK");
            await Espera("android_tecla", new { tecla = "66" }, $"-s {S} shell input keyevent 66");
            await Espera("android_instalar", new { caminho = apk }, $"-s {S} install -r {apk}", "Instalado: app teste.apk");
            await Espera("android_shell", new { comando = "pm list packages" }, $"-s {S} shell pm list packages", "package:com.exemplo.ação");
            await Espera("android_shell", new { comando = "exit 3" }, $"-s {S} shell exit 3", "[código de saída 3]");

            // O cliente lê no registro o que foi feito no aparelho: o comando e o aplicativo, nunca o texto digitado.
            var registro = nucleo.Sessao.LerRegistro().Select((entrada) => entrada.Texto).ToList();
            Confere(registro.Contains("Celular: comando no aparelho: pm list packages") && registro.Contains("Celular: instalar aplicativo: app teste.apk"), "o registro não mostra o comando e o aplicativo");
            Confere(registro.Contains("Celular: digitou um texto") && !registro.Any((linha) => linha.Contains("ola")), "o texto digitado foi parar no registro");

            // Parâmetros vindos da rede: validados antes de virar argumento.
            await Recusa("android_tocar", new { x = 1.5, y = 0.5 }, "x deve estar entre 0 e 1");
            await Recusa("android_tocar", new { x = 0.5, y = 0.5, serial = "-P 5037" }, "serial inválido");
            await Recusa("android_digitar", new { texto = "ação" }, "sem acento");
            await Recusa("android_tecla", new { tecla = "HOME; reboot" }, "tecla deve ser");
            await Recusa("android_instalar", new { caminho = Path.ChangeExtension(apk, ".exe") }, ".apk");
            await Recusa("android_instalar", new { caminho = Path.Combine(Path.GetDirectoryName(apk)!, "falta.apk") }, "não existe");
            await Recusa("android_shell", new { comando = "-x ls" }, "não pode começar");

            adb.Aparelhos += $"\nemulator-5554\tdevice product:sdk model:sdk transport_id:2";
            await Recusa("android_tecla", new { tecla = "HOME" }, "informe serial");
            adb.Aparelhos = adb.Aparelhos.Split('\n')[0];

            // O cliente desliga a chave: o adb para. Religada, sobe de novo; encerrar para outra vez.
            nucleo.Sessao.Alternar(Contrato.RecursoCelular, false);
            await Ate(() => adb.Ultima == "kill-server" && !nucleo.Extras.Celular.Pronto, "a chave desligada parar o adb");
            (texto, erro, _) = await Chamar(nucleo, "android_dispositivos");
            Confere(erro && texto.Contains("O cliente desligou este recurso"), $"chave desligada não bloqueou: {texto}");
            var preparou = true;
            try { await nucleo.Extras.Celular.GarantirAsync(CancellationToken.None); } catch (InvalidOperationException) { preparou = false; }
            Confere(!preparou && !nucleo.Extras.Celular.Pronto, "uma chamada atrasada preparou o celular com a chave desligada");
            nucleo.Sessao.Alternar(Contrato.RecursoCelular, true);
            (texto, erro, _) = await Chamar(nucleo, "android_tocar", new { x = 0.5, y = 0.5 });
            Confere(erro && texto.Contains("Capture a tela antes"), $"religar deveria esquecer a captura antiga: {texto}");
            Confere(adb.Chamadas[^2] == "start-server" && adb.Ultima == "devices -l", "religar não subiu o adb de novo");
            await nucleo.EncerrarAsync();
            Confere(adb.Ultima == "kill-server" && !nucleo.Extras.Celular.Pronto, "encerrar não parou o adb");
        }
        finally { Directory.Delete(Path.GetDirectoryName(apk)!, true); }
    }
}
