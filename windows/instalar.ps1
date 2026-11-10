# Instala o Concord para rodar direto no Windows, sem Docker e sem WSL.
# Usa o mesmo .env, a mesma pasta data-dev (contas, mensagens, anexos) e a mesma pasta videos de antes.
param([switch]$Automatico)
. (Join-Path $PSScriptRoot 'comum.ps1')

function Pergunta([string]$texto, [bool]$padrao) {
  if ($Automatico) { return $padrao }
  $sufixo = ' (s/n)'
  if ($padrao) { $sufixo = ' (S/n)' }
  $r = Read-Host ($texto + $sufixo)
  if (-not $r) { return $padrao }
  return ($r.Trim().ToLower().StartsWith('s'))
}

Escrever ''
Escrever 'Concord no Windows: instalação (sem Docker)' 'Cyan'
Escrever "Pasta: $Raiz"

# ---------- 1. Node.js ----------
Titulo 'Node.js'
$v = Versao-Node
if ($v -lt $NodeMinimo) {
  if ($v.Major -gt 0) { Aviso "o Node.js $v é antigo (precisa do $NodeMinimo ou mais novo)" } else { Aviso 'o Node.js não está instalado' }
  if (-not $NoWindows) { throw "Instale o Node.js $NodeMinimo ou mais novo." }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Start-Process 'https://nodejs.org/pt'
    throw 'Instale o Node.js (botão "Atual") pelo site que abriu, feche esta janela e rode o instalar.bat de novo.'
  }
  Escrever '  instalando o Node.js pelo winget (o Windows pode pedir permissão)...'
  & winget install --id OpenJS.NodeJS -e --silent --accept-package-agreements --accept-source-agreements
  Atualizar-Path
  $v = Versao-Node
  if ($v -lt $NodeMinimo) { throw 'O Node.js não ficou disponível. Feche esta janela e rode o instalar.bat de novo (às vezes o Windows só enxerga programas novos numa janela nova).' }
}
Ok "Node.js $v"

# ---------- 2. .env ----------
Titulo 'Configuração (.env)'
$e = Ler-Env
if (-not $e['JWT_SECRET']) { Gravar-Env 'JWT_SECRET' (Segredo); Ok 'senha de login gerada' }
if (-not $e['LIVEKIT_SECRET']) { Gravar-Env 'LIVEKIT_SECRET' (Segredo); Ok 'senha da voz gerada' }
if (-not $e['HOST_IP']) {
  $ip = $null
  if ($NoWindows) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '26.*' } | Select-Object -First 1).IPAddress
  }
  if ($ip) { Ok "IP do Radmin encontrado: $ip" }
  elseif ($Automatico) { $ip = '127.0.0.1' }
  else { $ip = Read-Host 'Qual é o seu IP no Radmin (ex.: 26.125.194.51)?' }
  Gravar-Env 'HOST_IP' $ip.Trim()
}
$e = Ler-Env
Ok "IP: $($e['HOST_IP'])  (o .env já existente foi mantido)"

# ---------- 3. o Docker ainda está rodando o Concord? ----------
if ((Porta-Ocupada 3000) -and -not (Supervisor-Ativo)) {
  Titulo 'Docker'
  Aviso 'tem algo usando a porta 3000 (o Concord no Docker?)'
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($docker -and (Pergunta 'Desligar o Concord do Docker agora?' $true)) {
    Push-Location -LiteralPath $Raiz
    try { & docker compose -f docker-compose.dev.yml down } finally { Pop-Location }
  }
}

# ---------- 4. programas e dependências ----------
& (Join-Path $Pasta 'programas.ps1')
& (Join-Path $Pasta 'dependencias.ps1')
New-Item -ItemType Directory -Force -Path $Dados, $Videos, $Logs, $Run | Out-Null

# ---------- 5. firewall ----------
if ($NoWindows) {
  Titulo 'Firewall do Windows'
  if (Pergunta 'Liberar as portas do Concord para o Radmin? (o Windows vai pedir permissão de administrador)' $true) {
    try {
      & (Join-Path $Pasta 'firewall.ps1')
      if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) { Ok 'portas liberadas' } else { Aviso 'não deu para liberar as portas (pode rodar o firewall.bat depois)' }
    } catch { Aviso 'permissão negada: rode o firewall.bat depois, como administrador' }
  }

  Titulo 'Ligar com o Windows'
  if (Pergunta 'Ligar o Concord sozinho quando você entrar no Windows?' $true) { & (Join-Path $Pasta 'ligar-com-windows.ps1') }
}

# ---------- 6. liga ----------
Titulo 'Ligando'
& (Join-Path $Pasta 'iniciar.ps1')
Escrever ''
Escrever 'Pronto! Daqui para frente:' 'Cyan'
Escrever '  windows\iniciar.bat     liga o Concord'
Escrever '  windows\parar.bat       desliga'
Escrever '  windows\atualizar.bat   depois de aplicar um patch (git am)'
