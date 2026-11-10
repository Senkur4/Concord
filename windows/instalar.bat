@echo off
rem Instala o Concord para rodar sem Docker
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
echo.
pause
