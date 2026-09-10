# Reinicia o Agent Code quando o próprio agente precisa reiniciar o app.
#
# Existe porque o agente roda DENTRO do app: ele não consegue se fechar e
# reabrir sozinho. Este script roda fora, num processo destacado, então
# sobrevive ao fechamento.
#
# Uso (lançar DESTACADO, senão morre junto com o app):
#   Start-Process powershell -WindowStyle Hidden -ArgumentList `
#     '-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\relaunch-agent-code.ps1'
#
# Sequência: confere o guarda -> espera 5 s -> fecha -> espera 5 s -> reabre.
#
# REGRA CENTRAL: só reinicia se NENHUM agente estiver ocupado. Quem responde
# isso é o app, não este script — um script vê processos, nunca conversas. O
# app publica o estado em <userData>\restart-guard.json (mesma regra do
# app_restart) e reescreve a cada 2 s. Arquivo velho, ausente ou ilegível =
# estado desconhecido = NÃO reinicia. Falhar fechado é o único jeito seguro:
# assumir "ocioso" mataria um turno em andamento no meio.
param(
  # Segundos antes de fechar (o agente ainda está terminando a resposta) e
  # depois de fechar (o processo antigo precisa liberar a trava de instância).
  [int]$CloseDelay = 5,
  [int]$OpenDelay = 5,
  # Executável a reabrir. Por padrão o portátil gerado em dist/.
  [string]$Exe = '',
  # Idade máxima aceita do arquivo de estado, em segundos.
  [int]$MaxGuardAge = 15,
  # Reinicia mesmo com agente ocupado. Só para uso manual do usuário.
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Exe) { $Exe = Join-Path $root 'dist\AgentCode-0.1.0-portable.exe' }
$log = Join-Path $env:TEMP 'agent-code-relaunch.log'
function Note([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
  Write-Host $line
}

Note "pedido de reinicio (exe=$Exe force=$Force)"

if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
  Note "ABORTADO: executavel nao encontrado"
  exit 1
}

# ---- 1) Guarda: nenhum agente pode estar rodando -------------------------
$guardPath = Join-Path $env:APPDATA 'agent-code-desktop\restart-guard.json'
if (-not $Force) {
  if (-not (Test-Path -LiteralPath $guardPath -PathType Leaf)) {
    Note "ABORTADO: estado do app nao encontrado ($guardPath). Sem confirmacao de ociosidade, nao reinicio."
    exit 2
  }
  try {
    $guard = Get-Content -LiteralPath $guardPath -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    Note "ABORTADO: estado do app ilegivel."
    exit 2
  }
  $age = ((Get-Date).ToUniversalTime() - ([datetime]$guard.at).ToUniversalTime()).TotalSeconds
  if ($age -gt $MaxGuardAge) {
    Note ("ABORTADO: estado com {0:N0}s (limite {1}s) — o app pode estar travado ou fechado." -f $age, $MaxGuardAge)
    exit 2
  }
  if (-not $guard.idle) {
    Note ("ABORTADO: tem agente rodando — " + $guard.blockedBy)
    exit 3
  }
  Note ("guarda ok: ocioso, {0} sessao(oes), estado de {1:N0}s atras" -f $guard.sessions, $age)
}

# ---- 2) Fechar depois de 5 s --------------------------------------------
Note "fechando em $CloseDelay s"
Start-Sleep -Seconds $CloseDelay
$running = @(Get-Process -Name 'Agent Code' -ErrorAction SilentlyContinue)
if ($running.Count) {
  # CloseMainWindow primeiro: deixa o app salvar e encerrar o que precisa.
  foreach ($p in $running) { $null = $p.CloseMainWindow() }
  # Só então força o que sobrou — matar direto arriscaria perder gravação.
  $limit = (Get-Date).AddSeconds(20)
  while ((Get-Process -Name 'Agent Code' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $limit) {
    Start-Sleep -Milliseconds 500
  }
  $left = @(Get-Process -Name 'Agent Code' -ErrorAction SilentlyContinue)
  if ($left.Count) {
    Note ("forcando encerramento de {0} processo(s) que nao sairam" -f $left.Count)
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Note "app encerrado"
} else {
  Note "nenhum processo 'Agent Code' rodando"
}

# ---- 3) Reabrir depois de 5 s -------------------------------------------
# A espera não é enfeite: o Electron usa trava de instância única por userData.
# Reabrir com o processo antigo ainda vivo faz o novo se ver como segunda
# instância e fechar na hora, sem erro na tela.
Note "reabrindo em $OpenDelay s"
Start-Sleep -Seconds $OpenDelay
try {
  $started = Start-Process -FilePath $Exe -PassThru
  Note ("reaberto pid=" + $started.Id)
} catch {
  Note ("FALHA ao reabrir: " + $_.Exception.Message)
  exit 1
}
