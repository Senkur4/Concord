@echo off
rem Libera as portas do Concord no Firewall (o Windows pede permissao de administrador)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0firewall.ps1"
echo.
pause
