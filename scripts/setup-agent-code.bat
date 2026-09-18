@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Agent Code - setup
echo ============================================
echo.

set "REPO_URL=https://github.com/MatheusLarcher/agent-code.git"

REM --- Garante o Git ---
where git >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Git nao encontrado no PATH.
    echo Instale o Git em https://git-scm.com/download/win e rode este arquivo de novo.
    echo.
    pause
    exit /b 1
)

REM --- Ja estamos dentro de um checkout do agent-code (tem .git e start.bat um nivel acima)? ---
if exist "%~dp0..\.git" if exist "%~dp0..\start.bat" (
    set "PROJECT_DIR=%~dp0.."
    goto :pull
)

REM --- Fora do repo: clona (ou reaproveita) numa subpasta ao lado deste .bat ---
if exist "%~dp0agent-code\.git" (
    set "PROJECT_DIR=%~dp0agent-code"
    goto :pull
)

echo Clonando o agent-code...
echo.
git clone "%REPO_URL%" "%~dp0agent-code"
if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao clonar o repositorio. Verifique sua internet/acesso ao GitHub.
    echo.
    pause
    exit /b 1
)
set "PROJECT_DIR=%~dp0agent-code"
goto :launch

:pull
echo Atualizando o repositorio existente em "%PROJECT_DIR%"...
echo.
pushd "%PROJECT_DIR%"
git pull --ff-only
if errorlevel 1 (
    echo.
    echo [AVISO] Nao foi possivel atualizar automaticamente ^(alteracoes locais pendentes?^).
    echo Continuando com o codigo que ja esta na pasta.
    echo.
)
popd

:launch
if not exist "%PROJECT_DIR%\start.bat" (
    echo.
    echo [ERRO] start.bat nao encontrado em "%PROJECT_DIR%".
    pause
    exit /b 1
)
echo.
echo Setup concluido. Instalando dependencias e iniciando o Agent Code...
echo.
call "%PROJECT_DIR%\start.bat"

endlocal
