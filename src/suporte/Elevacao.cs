using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AgentCode.Suporte;

/// <summary>
/// Reabrir o suporte como administrador sem perder a sessão. Quem autoriza é o
/// Windows (UAC), na tela dele, depois de o cliente já ter permitido o recurso na
/// janela. O exe comum entrega o estado da sessão ao exe elevado por um canal
/// nomeado de uso único; nada da sessão passa por argumento nem por variável, e cada
/// lado confere que o outro é este mesmo executável.
/// </summary>
internal static partial class Elevacao
{
    internal const string Argumento = "--retomar";
    private const int MaximoMensagem = 4 * 1024 * 1024;
    private const int UacCancelado = 1223;

    [GeneratedRegex("^AgentCodeSuporte-[0-9a-f]{32}$")]
    private static partial Regex NomeValido();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(nint pipe, out uint processId);

    internal static string NovoNome() => $"AgentCodeSuporte-{Guid.NewGuid():N}";

    /// <summary>Canal de uma conexão só, aberto ao usuário atual e aos administradores.</summary>
    internal static NamedPipeServerStream CriarServidor(string nome)
    {
        var seguranca = new PipeSecurity();
        seguranca.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User!, PipeAccessRights.FullControl, AccessControlType.Allow));
        seguranca.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(
            nome, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, seguranca);
    }

    /// <summary>
    /// Exe comum: pede a elevação ao Windows e entrega a sessão. Devolve se o exe
    /// elevado assumiu; em qualquer falha este exe continua atendendo como antes.
    /// </summary>
    internal static async Task<(bool Ok, string Mensagem)> ElevarAsync(EstadoRetomada estado, CancellationToken ct)
    {
        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("Não foi possível localizar o executável do suporte.");
        var nome = NovoNome();
        await using var cano = CriarServidor(nome);
        Process? filho;
        try
        {
            filho = Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, Verb = "runas", Arguments = $"{Argumento} {nome}" });
        }
        catch (Win32Exception erro) when (erro.NativeErrorCode == UacCancelado)
        {
            return (false, "O cliente não confirmou a permissão de administrador no Windows. O suporte continua sem ela.");
        }
        if (filho is null) return (false, "O Windows não reabriu o suporte como administrador.");
        using (filho)
        {
            try
            {
                var assumiu = await EntregarAsync(cano, (uint)filho.Id, estado, 60_000, ct);
                return assumiu
                    ? (true, "O suporte foi reaberto como administrador e a sessão continua. As próximas chamadas já rodam elevadas.")
                    : (false, "O suporte reaberto como administrador não conseguiu assumir a sessão. Continua sem a permissão.");
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return (false, "O suporte reaberto como administrador não respondeu a tempo. Continua sem a permissão.");
            }
        }
    }

    /// <summary>Lado de quem entrega: confere o par, manda o estado e espera o "ok".</summary>
    internal static async Task<bool> EntregarAsync(NamedPipeServerStream cano, uint pidEsperado, EstadoRetomada estado, int prazoMs, CancellationToken ct)
    {
        using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
        prazo.CancelAfter(prazoMs);
        await cano.WaitForConnectionAsync(prazo.Token);
        if (!Nativo.GetNamedPipeClientProcessId(cano.SafePipeHandle.DangerousGetHandle(), out var pid) || pid != pidEsperado || !MesmoExecutavel(pid))
            return false;
        await EnviarAsync(cano, JsonSerializer.Serialize(estado), prazo.Token);
        return await ReceberAsync(cano, prazo.Token) == "ok";
    }

    /// <summary>
    /// Exe elevado: recebe o estado do exe comum. Devolve o estado e a função que
    /// responde se a retomada no relay deu certo; nulo se algo não confere.
    /// </summary>
    internal static async Task<(EstadoRetomada Estado, Func<bool, Task> Responder)?> ReceberEstadoAsync(string nome, CancellationToken ct)
    {
        if (!NomeValido().IsMatch(nome)) return null;
        var cano = new NamedPipeClientStream(".", nome, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
            prazo.CancelAfter(15_000);
            await cano.ConnectAsync(prazo.Token);
            if (!GetNamedPipeServerProcessId(cano.SafePipeHandle.DangerousGetHandle(), out var pid) || !MesmoExecutavel(pid))
                throw new InvalidOperationException("par desconhecido");
            var estado = JsonSerializer.Deserialize<EstadoRetomada>(await ReceberAsync(cano, prazo.Token))
                ?? throw new InvalidOperationException("estado vazio");
            if (string.IsNullOrEmpty(estado.Sessao) || string.IsNullOrEmpty(estado.Segredo) || string.IsNullOrEmpty(estado.Token))
                throw new InvalidOperationException("estado incompleto");
            return (estado, async (ok) =>
            {
                try { await EnviarAsync(cano, ok ? "ok" : "falha", CancellationToken.None); } catch { /* o outro lado já saiu */ }
                await cano.DisposeAsync();
            });
        }
        catch
        {
            await cano.DisposeAsync();
            return null;
        }
    }

    private static bool MesmoExecutavel(uint pid)
        => Nativo.CaminhoDoProcesso(pid) is { } caminho
            && Environment.ProcessPath is { } nosso
            && string.Equals(Path.GetFullPath(caminho), Path.GetFullPath(nosso), StringComparison.OrdinalIgnoreCase);

    private static async Task EnviarAsync(Stream cano, string texto, CancellationToken ct)
    {
        var corpo = Encoding.UTF8.GetBytes(texto);
        var tamanho = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(tamanho, corpo.Length);
        await cano.WriteAsync(tamanho, ct);
        await cano.WriteAsync(corpo, ct);
        await cano.FlushAsync(ct);
    }

    private static async Task<string> ReceberAsync(Stream cano, CancellationToken ct)
    {
        var tamanho = new byte[4];
        await cano.ReadExactlyAsync(tamanho, ct);
        var total = BinaryPrimitives.ReadInt32LittleEndian(tamanho);
        if (total is < 0 or > MaximoMensagem) throw new InvalidDataException("mensagem fora do limite");
        var corpo = new byte[total];
        await cano.ReadExactlyAsync(corpo, ct);
        return Encoding.UTF8.GetString(corpo);
    }
}
