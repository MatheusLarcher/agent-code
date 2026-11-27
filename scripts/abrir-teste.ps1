# Abre o app de TESTE (moldura âmbar), com pasta e banco próprios — nunca mexe no app principal.
# Usado pelo atalho "Agent Code TESTE" da área de trabalho.
$env:AGENT_CODE_DEV_DATA_DIR = Join-Path $env:LOCALAPPDATA 'agent-code-dev'
Set-Location (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
npm run dev
