# O "Docker" do Concord no Windows: liga o LiveKit (voz), o Concord e os bots, e religa quem cair.
# Roda escondido (o iniciar.bat e o "ligar com o Windows" chamam este arquivo). Os registros ficam em windows\logs.
. (Join-Path $PSScriptRoot 'comum.ps1')
$ErrorActionPreference = 'Continue'

New-Item -ItemType Directory -Force -Path $Logs, $Run, $Dados, $Videos | Out-Null
if (Supervisor-Ativo) { exit 0 }   # já tem um rodando
Remove-Item -LiteralPath $ArquivoParar -ErrorAction SilentlyContinue
Set-Content -LiteralPath $ArquivoPidSupervisor -Value $PID
$registro = Join-Path $Logs 'servico.log'
function Log([string]$t) { Add-Content -LiteralPath $registro -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $t) -Encoding UTF8 }

# tudo do .env vira variável (STEAM_API_KEY, TMDB_API_KEY, ADMIN_USERS...), como o Docker fazia
$e = Ler-Env
foreach ($k in $e.Keys) { Set-Item -LiteralPath "Env:$k" -Value $e[$k] }
$ip = $e['HOST_IP']
$segredo = $e['LIVEKIT_SECRET']
if (-not $ip -or -not $segredo) { Log 'Falta HOST_IP ou LIVEKIT_SECRET no .env: rode o instalar.bat'; exit 1 }
$env:Path = "$Bin;$env:Path"   # ffmpeg, ffprobe e yt-dlp para o Concord e os bots
function Padrao([string]$k, [string]$v) { if ($e[$k]) { return $e[$k] } return $v }

$livekitBase = @{ CONCORD_URL = 'http://127.0.0.1:3000'; LIVEKIT_URL = 'ws://127.0.0.1:7880'; LIVEKIT_API_KEY = 'devkey'; LIVEKIT_API_SECRET = $segredo }
$servicos = New-Object System.Collections.ArrayList
[void]$servicos.Add(@{
  Nome = 'livekit'; Arquivo = (Exe 'livekit-server'); Pasta = $Pasta
  Args = @('--dev', '--bind', '0.0.0.0', '--node-ip', $ip)
  Env = @{ LIVEKIT_KEYS = "devkey: $segredo" }
})
[void]$servicos.Add(@{
  Nome = 'concord'; Arquivo = 'node'; Pasta = (Join-Path $Raiz 'server')
  Args = @('--disable-warning=ExperimentalWarning', 'src/index.ts')
  Env = @{
    NODE_ENV = 'production'; PORT = '3000'; HOST = '0.0.0.0'
    DB_PATH = (Join-Path $Dados 'concord.db'); PUBLIC_DIR = (Join-Path $Raiz 'client\dist')
    LIVEKIT_API_URL = 'http://127.0.0.1:7880'; LIVEKIT_PUBLIC_URL = "ws://${ip}:7880"
    LIVEKIT_API_KEY = 'devkey'; LIVEKIT_API_SECRET = $segredo
    PUBLIC_URL = "http://${ip}:3000"
    ATTACH_DISK_RESERVE_GB = (Padrao 'ATTACH_DISK_RESERVE_GB' '5')
    CINEMA_DIR = $Videos; CINEMA_MAX_MBPS = (Padrao 'CINEMA_MAX_MBPS' '70')
  }
})
if ($e['MUSICBOT_TOKEN']) {
  $m = $livekitBase.Clone(); $m.CONCORD_TOKEN = $e['MUSICBOT_TOKEN']
  [void]$servicos.Add(@{ Nome = 'musicbot'; Arquivo = 'node'; Pasta = (Join-Path $Raiz 'musicbot'); Args = @('bot.mjs'); Env = $m; Antes = 'yt-dlp' })
}
if ($e['MOVIEBOT_TOKEN']) {
  $m = $livekitBase.Clone(); $m.CONCORD_TOKEN = $e['MOVIEBOT_TOKEN']; $m.VIDEOS_DIR = $Videos
  $m.DEFAULT_QUALITY = (Padrao 'MOVIEBOT_QUALITY' '1080p30'); $m.MAX_BITRATE_KBPS = (Padrao 'MOVIEBOT_MAX_KBPS' '8000')
  [void]$servicos.Add(@{ Nome = 'moviebot'; Arquivo = 'node'; Pasta = (Join-Path $Raiz 'moviebot'); Args = @('bot.mjs'); Env = $m })
}

$procs = @{}
$quedas = @{}

function Gravar-Pids {
  $ids = @()
  foreach ($p in $procs.Values) { if ($p -and -not $p.HasExited) { $ids += $p.Id } }
  Set-Content -LiteralPath $ArquivoPids -Value ($ids -join "`n")
}

function Ligar($s) {
  foreach ($k in $s.Env.Keys) { Set-Item -LiteralPath "Env:$k" -Value $s.Env[$k] }
  # o YouTube muda sempre: o yt-dlp se atualiza antes do bot de música ligar (como no Docker)
  if ($s.Antes -eq 'yt-dlp' -and (Test-Path -LiteralPath (Exe 'yt-dlp'))) { & (Exe 'yt-dlp') -U *> $null }
  $out = Join-Path $Logs "$($s.Nome).log"
  $err = Join-Path $Logs "$($s.Nome).erros.log"
  foreach ($f in @($out, $err)) {
    if ((Test-Path -LiteralPath $f) -and ((Get-Item -LiteralPath $f).Length -gt 10MB)) { Move-Item -LiteralPath $f -Destination "$f.antigo" -Force }
  }
  try {
    $p = Start-Process -FilePath $s.Arquivo -ArgumentList $s.Args -WorkingDirectory $s.Pasta -NoNewWindow -PassThru `
      -RedirectStandardOutput "$out.agora" -RedirectStandardError "$err.agora"
    $null = $p.Handle   # sem isso o PowerShell 5.1 perde o código de saída
    $procs[$s.Nome] = $p
    Log "ligou $($s.Nome) (PID $($p.Id))"
  } catch {
    Log "não deu para ligar $($s.Nome): $($_.Exception.Message)"
    $procs[$s.Nome] = $null
  }
  Gravar-Pids
}

# as saídas de agora vão para o .log de cada um (o Start-Process não sabe acrescentar, então junta aqui)
function Juntar-Logs {
  foreach ($s in $servicos) {
    foreach ($tipo in @('', '.erros')) {
      $agora = Join-Path $Logs "$($s.Nome)$tipo.log.agora"
      $final = Join-Path $Logs "$($s.Nome)$tipo.log"
      $p = $procs[$s.Nome]
      if ((Test-Path -LiteralPath $agora) -and (-not $p -or $p.HasExited)) {
        Get-Content -LiteralPath $agora -Raw -ErrorAction SilentlyContinue | Add-Content -LiteralPath $final -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $agora -ErrorAction SilentlyContinue
      }
    }
  }
}

Log "---- Concord ligando (IP $ip) ----"
Juntar-Logs   # sobras de uma vez que o PC desligou com o Concord ligado
foreach ($s in $servicos) {
  Ligar $s
  if ($s.Nome -eq 'livekit') { Start-Sleep -Seconds 1 }
}

while (-not (Test-Path -LiteralPath $ArquivoParar)) {
  Start-Sleep -Seconds 2
  foreach ($s in $servicos) {
    $p = $procs[$s.Nome]
    if ($p -and -not $p.HasExited) { continue }
    $codigo = ''
    if ($p) { $codigo = $p.ExitCode }
    Juntar-Logs
    # caiu: religa. Se caiu 5 vezes em 2 minutos, espera 1 minuto (algo errado: ver windows\logs)
    $agora = Get-Date
    $lista = @($quedas[$s.Nome] | Where-Object { $_ -and (($agora - $_).TotalSeconds -lt 120) })
    $lista += $agora
    $quedas[$s.Nome] = $lista
    if ($lista.Count -ge 5) {
      Log "$($s.Nome) caiu $($lista.Count) vezes seguidas (código $codigo): esperando 1 minuto"
      $quedas[$s.Nome] = @()
      for ($i = 0; $i -lt 30 -and -not (Test-Path -LiteralPath $ArquivoParar); $i++) { Start-Sleep -Seconds 2 }
      if (Test-Path -LiteralPath $ArquivoParar) { break }
    } else {
      Log "$($s.Nome) parou (código $codigo): religando"
    }
    Ligar $s
  }
}

Log 'desligando'
# os bots primeiro, o LiveKit por último
$ordem = @($servicos | ForEach-Object { $_.Nome })
[array]::Reverse($ordem)
foreach ($n in $ordem) {
  $p = $procs[$n]
  if ($p -and -not $p.HasExited) { Matar-Arvore $p.Id }
}
Start-Sleep -Milliseconds 500
Juntar-Logs
Remove-Item -LiteralPath $ArquivoPids, $ArquivoPidSupervisor, $ArquivoParar -ErrorAction SilentlyContinue
Log 'desligado'
