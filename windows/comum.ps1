# Coisas usadas por todos os scripts do Concord no Windows (instalar, iniciar, parar, atualizar).
# Compatível com o PowerShell 5.1 que já vem no Windows 10: nada de recursos só do PowerShell 7.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # a barra de progresso deixa os downloads 10x mais lentos no 5.1
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$NoWindows = ($env:OS -eq 'Windows_NT')
$Pasta = $PSScriptRoot                        # ...\concord-fork\windows
$Raiz = Split-Path -Parent $Pasta             # ...\concord-fork
$Bin = Join-Path $Pasta 'bin'                 # livekit-server, ffmpeg, ffprobe, yt-dlp
$Logs = Join-Path $Pasta 'logs'
$Run = Join-Path $Pasta 'run'                 # PIDs e o sinal de "parar"
$ArquivoEnv = Join-Path $Raiz '.env'          # o mesmo .env que o Docker usava
$Dados = Join-Path $Raiz 'data-dev'           # o mesmo banco, anexos e cinema de antes
$Videos = Join-Path $Raiz 'videos'
$LivekitVersao = '1.13.7'                     # a mesma do docker-compose
# o servidor roda os arquivos .ts direto: precisa do Node 22.18 ou mais novo (o Docker usava o 26)
$NodeMinimo = [version]'22.18.0'
$PsExe = (Get-Process -Id $PID).Path          # este PowerShell (5.1 no Windows; pwsh nos testes)

function Escrever([string]$texto, [string]$cor = 'Gray') { Write-Host $texto -ForegroundColor $cor }
function Titulo([string]$t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Aviso([string]$t) { Write-Host "  !   $t" -ForegroundColor Yellow }

function Exe([string]$nome) {
  if ($NoWindows) { return (Join-Path $Bin "$nome.exe") }
  return (Join-Path $Bin $nome)
}

# ---------- .env ----------

function Ler-Env {
  $vals = [ordered]@{}
  if (Test-Path -LiteralPath $ArquivoEnv) {
    foreach ($linha in (Get-Content -LiteralPath $ArquivoEnv -Encoding UTF8)) {
      $l = $linha.Trim()
      if ($l -eq '' -or $l.StartsWith('#')) { continue }
      $i = $l.IndexOf('=')
      if ($i -lt 1) { continue }
      $k = $l.Substring(0, $i).Trim()
      $v = $l.Substring($i + 1).Trim()
      if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      $vals[$k] = $v
    }
  }
  return $vals
}

function Gravar-Env([string]$chave, [string]$valor) {
  $linhas = @()
  if (Test-Path -LiteralPath $ArquivoEnv) { $linhas = @(Get-Content -LiteralPath $ArquivoEnv -Encoding UTF8) }
  $achou = $false
  for ($i = 0; $i -lt $linhas.Count; $i++) {
    if ($linhas[$i] -match ('^\s*' + [regex]::Escape($chave) + '\s*=')) { $linhas[$i] = "$chave=$valor"; $achou = $true }
  }
  if (-not $achou) { $linhas += "$chave=$valor" }
  # UTF-8 sem BOM: o Node (e o Docker, se um dia voltar) leem igual
  [IO.File]::WriteAllLines($ArquivoEnv, [string[]]$linhas, (New-Object Text.UTF8Encoding $false))
}

function Segredo {
  $b = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

# ---------- programas ----------

function Atualizar-Path {
  if ($NoWindows) {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
}

function Versao-Node {
  try {
    $v = (& node --version) 2>$null
    if ($v -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
  } catch {}
  return [version]'0.0.0'
}

function Rodar-Npm([string]$dir, [string[]]$argumentos) {
  $cmd = 'npm'
  if ($NoWindows) { $cmd = 'npm.cmd' }
  Push-Location -LiteralPath $dir
  try {
    & $cmd @argumentos
    if ($LASTEXITCODE -ne 0) { throw "npm $($argumentos -join ' ') falhou na pasta $dir" }
  } finally { Pop-Location }
}

# ---------- o que está rodando ----------

$ArquivoPidSupervisor = Join-Path $Run 'supervisor.pid'
$ArquivoPids = Join-Path $Run 'filhos.pid'
$ArquivoParar = Join-Path $Run 'parar'

function Supervisor-Ativo {
  if (-not (Test-Path -LiteralPath $ArquivoPidSupervisor)) { return $null }
  $id = (Get-Content -LiteralPath $ArquivoPidSupervisor -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $id) { return $null }
  $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
  if ($p -and ($p.ProcessName -match 'powershell|pwsh')) { return $p }
  return $null
}

function Porta-Ocupada([int]$porta) {
  $c = New-Object Net.Sockets.TcpClient
  try {
    $r = $c.BeginConnect('127.0.0.1', $porta, $null, $null)
    $ok = $r.AsyncWaitHandle.WaitOne(400)
    if ($ok -and $c.Connected) { return $true }
    return $false
  } catch { return $false } finally { $c.Close() }
}

function Concord-Respondendo {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Matar-Arvore([int]$id) {
  if ($NoWindows) { & taskkill.exe /PID $id /T /F 2>$null | Out-Null }
  else { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
