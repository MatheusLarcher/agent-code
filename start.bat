@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Agent Code - iniciando...
echo ============================================
echo.

REM --- Linka as skills versionadas (.agents\skills) para o Claude Code (.claude\skills) ---
REM Fonte da verdade = .agents\skills (vai no Git). Aqui apenas LINKAMOS (nao reinstala
REM nada da internet), usando junctions (mklink /J): nao exige admin e funciona em
REM qualquer clone/Windows. Idempotente: so cria o link que ainda nao existe.
if exist ".agents\skills" (
    if not exist ".claude\skills" mkdir ".claude\skills"
    for /d %%s in (".agents\skills\*") do (
        if not exist ".claude\skills\%%~nxs" (
            mklink /J ".claude\skills\%%~nxs" "%%~fs" >nul 2>nul && echo   + skill: %%~nxs
        )
    )
    echo Skills sincronizadas (.agents\skills -^> .claude\skills).
    echo.
)

REM --- Garante o Node.js (usa o do sistema; se faltar, baixa um portatil) ---
REM Versao fixada = a mesma usada no desenvolvimento. Portatil (sem admin),
REM extraido em .node\ e reaproveitado nas proximas execucoes.
set "NODE_VER=v24.11.1"
set "NODE_PKG=node-%NODE_VER%-win-x64"
set "NODE_HOME=%~dp0.node\%NODE_PKG%"

where node >nul 2>nul && goto :node_ok

if exist "%NODE_HOME%\node.exe" (
    set "PATH=%NODE_HOME%;%PATH%"
    goto :node_ok
)

echo Node.js nao encontrado. Baixando o Node %NODE_VER% (portatil, sem admin)...
echo Isso so acontece na primeira vez.
echo.
if not exist "%~dp0.node" mkdir "%~dp0.node"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/%NODE_VER%/%NODE_PKG%.zip' -OutFile '%~dp0.node\node.zip'; Expand-Archive -LiteralPath '%~dp0.node\node.zip' -DestinationPath '%~dp0.node' -Force"
del "%~dp0.node\node.zip" >nul 2>nul

if exist "%NODE_HOME%\node.exe" (
    set "PATH=%NODE_HOME%;%PATH%"
    goto :node_ok
)

echo [ERRO] Nao foi possivel instalar o Node automaticamente.
echo Verifique sua internet ou instale manualmente o Node.js 20+ em https://nodejs.org
echo.
pause
exit /b 1

:node_ok
for /f "delims=" %%v in ('node -v') do set NODE_DETECTED=%%v
echo Node.js: %NODE_DETECTED%
echo.

REM --- Instala dependencias se ainda nao foram instaladas ---
if not exist "node_modules" (
    echo node_modules nao encontrado. Instalando dependencias...
    echo Isso tambem baixa o Chromium do Playwright na primeira vez.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERRO] Falha ao instalar as dependencias.
        pause
        exit /b 1
    )
    echo.
    echo Dependencias instaladas com sucesso.
    echo.
) else (
    echo Dependencias ja instaladas.
    echo.
)

REM --- Garante que o binario do Electron foi baixado ---
REM (as vezes o npm pula o postinstall do Electron e so o pacote npm fica)
if not exist "node_modules\electron\dist\electron.exe" (
    echo Binario do Electron ausente. Baixando...
    echo.
    call node "node_modules\electron\install.js"
    if not exist "node_modules\electron\dist\electron.exe" (
        echo.
        echo [ERRO] Nao foi possivel baixar o binario do Electron.
        echo Tente manualmente: node node_modules\electron\install.js
        pause
        exit /b 1
    )
    echo Electron pronto.
    echo.
)

REM --- Inicia o app em modo de desenvolvimento ---
echo Iniciando o Agent Code...
echo.
call npm run dev

if errorlevel 1 (
    echo.
    echo [ERRO] O app encerrou com erro. Veja as mensagens acima.
    pause
    exit /b 1
)

endlocal
