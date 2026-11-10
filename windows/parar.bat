@echo off
rem Desliga o Concord
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0parar.ps1" %*
echo.
pause
