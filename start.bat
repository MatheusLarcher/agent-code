@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Agent Code - iniciando...
echo ============================================
echo.

REM --- Verifica se o Node.js esta instalado ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado no PATH.
    echo Instale o Node.js 20+ em https://nodejs.org e tente de novo.
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo Node.js detectado: %NODE_VER%
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
