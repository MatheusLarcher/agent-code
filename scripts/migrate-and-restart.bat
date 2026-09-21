@echo off
setlocal
cd /d "%~dp0.."

rem Close Agent Code gracefully; only force-close processes that refuse to exit.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=@(Get-Process -Name 'Agent Code' -ErrorAction SilentlyContinue); $p | %% { [void]$_.CloseMainWindow() }; $deadline=(Get-Date).AddSeconds(20); while ((Get-Process -Name 'Agent Code' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }; $left=@(Get-Process -Name 'Agent Code' -ErrorAction SilentlyContinue); if ($left.Count) { $left | Stop-Process -Force }"
if errorlevel 1 exit /b 1

rem Migration is fail-closed: do not relaunch if it cannot complete safely.
call npm run migrate-storage
if errorlevel 1 exit /b 1

call "%~dp0..\start.bat"
exit /b %errorlevel%
