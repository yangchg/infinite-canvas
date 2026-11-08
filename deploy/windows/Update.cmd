@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Canvas.ps1" %*
set "updateExitCode=%errorlevel%"
pause
exit /b %updateExitCode%
