# Roda a análise de uso dos dois apps (principal e teste) e o comparativo.
# Agendado pela tarefa "Agent Code - relatorio de uso" (ver docs/COMPARACAO-PRINCIPAL-TESTE.md).
# Só leitura: cada análise copia o banco do app para uma pasta temporária e lê a cópia.
# Saída e log: %LOCALAPPDATA%\agent-code\analise-conversas\

$ErrorActionPreference = 'Continue'
# O node escreve em UTF-8; sem isto o PowerShell 5.1 lê na página antiga e estraga os acentos do log.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$saida = Join-Path $env:LOCALAPPDATA 'agent-code\analise-conversas'
New-Item -ItemType Directory -Force $saida | Out-Null
$log = Join-Path $saida 'ultimo-relatorio.log'
# Período comum aos dois: a partir do dia em que o app de teste começou a valer.
if (-not $env:AC_DESDE) { $env:AC_DESDE = '2026-11-25' }

"== $(Get-Date -Format 'dd/MM/yyyy HH:mm') — desde $env:AC_DESDE" | Out-File $log -Encoding utf8

# Memória do PC no limite: adia em vez de pesar mais (cada análise sobe um Postgres temporário por ~1 min).
$os = Get-CimInstance Win32_OperatingSystem
$uso = 100 - [math]::Round($os.FreePhysicalMemory * 100 / $os.TotalVisibleMemorySize)
if ($uso -ge 92) { "Memória em $uso%: relatório adiado para a próxima rodada." | Out-File $log -Append -Encoding utf8; exit 0 }

$bancos = @{
  principal = Join-Path $env:LOCALAPPDATA 'agent-code\pgdata'
  # Lado "teste" = Agent Code Homol desde 27/11 (antes: a cópia de desenvolvimento agent-code-dev).
  teste     = Join-Path $env:LOCALAPPDATA 'agent-code-homol\pgdata'
}
foreach ($inst in 'principal', 'teste') {
  if (-not (Test-Path (Join-Path $bancos[$inst] 'PG_VERSION'))) { "[$inst] banco ainda não existe, pulado." | Out-File $log -Append -Encoding utf8; continue }
  "[$inst] analisando..." | Out-File $log -Append -Encoding utf8
  node (Join-Path $raiz 'analisar.mjs') $inst 2>&1 | Select-Object -First 8 | Out-File $log -Append -Encoding utf8
}
node (Join-Path $raiz 'comparar.mjs') 2>&1 | Out-File $log -Append -Encoding utf8

# Roda de 30 em 30 min: guarda só os últimos 14 dias (o comparativo do dia é sobrescrito a cada rodada).
Get-ChildItem $saida -Recurse -File -Include 'analise-*.json', 'comparativo-*.md' |
  Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item -Force
