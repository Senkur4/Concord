# Libera as portas do Concord no Firewall do Windows (precisa de administrador; o instalar.bat pede).
# Só para a rede do Radmin (26.x) e a rede de casa: quem está na internet aberta continua bloqueado.
$ErrorActionPreference = 'Stop'
# sem administrador: pede (a janela de permissão do Windows) e roda de novo
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $p = Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  exit $p.ExitCode
}
Remove-NetFirewallRule -Group 'Concord' -ErrorAction SilentlyContinue
$redes = @('26.0.0.0/8', 'LocalSubnet')
New-NetFirewallRule -DisplayName 'Concord (site e chat)' -Group 'Concord' -Direction Inbound -Protocol TCP -LocalPort 3000 -RemoteAddress $redes -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Concord (voz e transmissão, TCP)' -Group 'Concord' -Direction Inbound -Protocol TCP -LocalPort 7880, 7881 -RemoteAddress $redes -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Concord (voz e transmissão, UDP)' -Group 'Concord' -Direction Inbound -Protocol UDP -LocalPort 7882 -RemoteAddress $redes -Action Allow -Profile Any | Out-Null
Write-Host 'Firewall liberado para o Concord.' -ForegroundColor Green
