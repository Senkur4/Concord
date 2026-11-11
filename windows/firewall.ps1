# Libera as portas do Concord no Firewall do Windows (precisa de administrador; o firewall.bat pede).
# Quem entra: os IPs do Radmin listados em AMIGOS_RADMIN no .env (ou todo o Radmin, 26.x, se a lista
# estiver vazia) e, se LIBERAR_REDE_DE_CASA não for "nao", a rede de casa. O resto continua bloqueado.
# Depois de mudar o .env, rode o firewall.bat de novo.
$ErrorActionPreference = 'Stop'
# sem administrador: pede (a janela de permissão do Windows) e roda de novo
$admin = $true
if ($env:OS -eq 'Windows_NT') { $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
if (-not $admin) {
  $p = Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  exit $p.ExitCode
}
. (Join-Path $PSScriptRoot 'comum.ps1')

function Ips-Dos-Amigos([string]$texto) {
  $certos = @(); $errados = @()
  foreach ($parte in ($texto -split '[,;\s]+')) {
    $ip = $parte.Trim()
    if ($ip -eq '') { continue }
    $x = $null
    if ([ipaddress]::TryParse($ip, [ref]$x) -and $x.AddressFamily -eq 'InterNetwork' -and $ip -match '^\d+\.\d+\.\d+\.\d+$') {
      if ($certos -notcontains $x.ToString()) { $certos += $x.ToString() }
    } else { $errados += $ip }
  }
  return @{ Certos = $certos; Errados = $errados }
}

$e = Ler-Env
$lista = Ips-Dos-Amigos ([string]$e['AMIGOS_RADMIN'])
foreach ($x in $lista.Errados) { Aviso "AMIGOS_RADMIN: '$x' não é um IP válido, ignorado" }

$redes = @()
if ($lista.Certos.Count -gt 0) {
  $redes += $lista.Certos
  Escrever ('Liberado só para estes IPs do Radmin: ' + ($lista.Certos -join ', '))
} else {
  $redes += '26.0.0.0/8'
  Aviso 'AMIGOS_RADMIN está vazio no .env: liberando TODO o Radmin (qualquer rede em que você estiver)'
}
$casa = ([string]$e['LIBERAR_REDE_DE_CASA']).Trim().ToLower()
if ($casa -eq 'nao' -or $casa -eq 'não' -or $casa -eq 'false' -or $casa -eq 'n') {
  Escrever 'Rede de casa: bloqueada'
} else {
  $redes += 'LocalSubnet'
  Escrever 'Rede de casa: liberada'
}

if (-not $NoWindows) { Escrever "(teste fora do Windows) regras seriam para: $($redes -join ', ')"; return }

Remove-NetFirewallRule -Group 'Concord' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'Concord (site e chat)' -Group 'Concord' -Direction Inbound -Protocol TCP -LocalPort 3000 -RemoteAddress $redes -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Concord (voz e transmissão, TCP)' -Group 'Concord' -Direction Inbound -Protocol TCP -LocalPort 7880, 7881 -RemoteAddress $redes -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Concord (voz e transmissão, UDP)' -Group 'Concord' -Direction Inbound -Protocol UDP -LocalPort 7882 -RemoteAddress $redes -Action Allow -Profile Any | Out-Null

# Quando o node.exe ou o livekit-server.exe abrem uma porta pela primeira vez, o Windows pergunta
# "Permitir acesso?" e cria uma regra para o PROGRAMA, aberta para qualquer IP. Ela passaria por cima
# da lista acima. Aqui essas regras de entrada são desativadas (não apagadas, senão a pergunta volta).
$programas = @((Join-Path $Bin 'livekit-server.exe'))
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { $programas += $node.Source }
$programas = @($programas | ForEach-Object { $_.ToLower() })
$desativadas = 0
foreach ($filtro in (Get-NetFirewallApplicationFilter -All -ErrorAction SilentlyContinue)) {
  $prog = [Environment]::ExpandEnvironmentVariables([string]$filtro.Program).ToLower()
  if ($programas -notcontains $prog) { continue }
  foreach ($r in @($filtro | Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
    if ($r.Group -eq 'Concord' -or $r.Direction -ne 'Inbound' -or $r.Enabled -ne 'True') { continue }
    Set-NetFirewallRule -Name $r.Name -Enabled False
    $desativadas++
  }
}
if ($desativadas -gt 0) { Escrever "Desativadas $desativadas regra(s) antigas que deixavam o node/livekit abertos para todos." }
Write-Host 'Firewall liberado para o Concord.' -ForegroundColor Green
