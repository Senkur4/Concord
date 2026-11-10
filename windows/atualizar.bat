@echo off
rem Depois de um patch: atualiza e liga
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0atualizar.ps1" %*
echo.
pause
