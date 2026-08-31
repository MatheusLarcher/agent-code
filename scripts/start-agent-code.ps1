$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectDir 'start.bat'

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Launcher not found: $launcher"
}

Start-Process -FilePath $launcher -WorkingDirectory $projectDir
