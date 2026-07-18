using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgentCode.WindowsControl;

internal sealed record RpcRequest(string Id, string Method, JsonObject? Params);
internal sealed record RpcError(string Message);
internal sealed record RpcResponse(string Id, object? Result = null, RpcError? Error = null);

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
        {
            return await SelfTest.RunAsync(args.Contains("--wait-for-focus", StringComparer.OrdinalIgnoreCase));
        }

        Console.InputEncoding = System.Text.Encoding.UTF8;
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        var dispatcher = new CommandDispatcher();

        while (await Console.In.ReadLineAsync() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            RpcRequest? request = null;
            RpcResponse response;
            try
            {
                request = JsonSerializer.Deserialize<RpcRequest>(line, JsonOptions)
                    ?? throw new InvalidOperationException("Solicitação JSON vazia.");
                if (string.IsNullOrWhiteSpace(request.Id) || request.Id.Length > 100)
                    throw new ArgumentException("id inválido.");
                if (string.IsNullOrWhiteSpace(request.Method) || request.Method.Length > 80)
                    throw new ArgumentException("method inválido.");

                var result = await dispatcher.ExecuteAsync(request.Method, request.Params ?? new JsonObject());
                response = new RpcResponse(request.Id, result);
            }
            catch (Exception error)
            {
                response = new RpcResponse(request?.Id ?? "", Error: new RpcError(CleanError(error)));
            }

            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, JsonOptions));
            await Console.Out.FlushAsync();
        }

        return 0;
    }

    private static string CleanError(Exception error)
    {
        var message = error.GetBaseException().Message.Trim();
        return message.Length > 800 ? message[..800] : message;
    }
}
