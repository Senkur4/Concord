# Depois de aplicar um patch (git am): desliga, instala o que mudou, monta o site de novo e liga.
param([switch]$Programas)
. (Join-Path $PSScriptRoot 'comum.ps1')
& (Join-Path $Pasta 'parar.ps1')
if ($Programas) { & (Join-Path $Pasta 'programas.ps1') -Forcar }
& (Join-Path $Pasta 'dependencias.ps1')
Titulo 'Ligando'
& (Join-Path $Pasta 'iniciar.ps1')
