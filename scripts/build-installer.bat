@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0.."

echo ============================================
echo   Agent Code - Larcher Tech
echo   gerando instalador...
echo ============================================
echo.

if not exist "package.json" (
    echo [ERRO] package.json nao encontrado.
    echo Execute este script dentro do repositorio do Agent Code.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERRO] npm nao foi encontrado no PATH.
    echo Instale o Node.js ou abra um terminal com o ambiente correto.
    echo.
    pause
    exit /b 1
)

REM --- Controle de versao automatico: incrementa o patch a cada execucao ---
set "VERSAO="
for /f "delims=" %%V in ('node "%~dp0bump-version.mjs"') do set "VERSAO=%%V"
if not defined VERSAO (
    echo [ERRO] Nao foi possivel incrementar a versao em package.json.
    echo.
    pause
    exit /b 1
)
echo Versao desta build: !VERSAO!
echo.

echo Executando npm run package:win...
echo.
call npm run package:win
if errorlevel 1 (
    echo.
    echo [ERRO] A geracao do exe falhou.
    echo Verifique a mensagem acima.
    echo.
    pause
    exit /b 1
)

echo.
set "ARTIFACT="
if exist "dist\AgentCode-setup.exe" set "ARTIFACT=dist\AgentCode-setup.exe"

if not defined ARTIFACT (
    echo [ERRO] O empacotamento terminou, mas nenhum exe foi encontrado em dist\.
    echo.
    pause
    exit /b 1
)

for %%F in ("!ARTIFACT!") do (
    echo ============================================
    echo   EXE GERADO COM SUCESSO
    echo ============================================
    echo Arquivo: %%~fF
    echo Tamanho: %%~zF bytes
    echo Gerado em: %%~tF
)
echo.
echo O arquivo esta na pasta dist\.
echo.
start "" explorer.exe "%CD%\dist"
pause
endlocal
exit /b 0
