# Baixa os programas que o Docker trazia: LiveKit (voz e transmissão), ffmpeg/ffprobe (cinema e bots) e
# yt-dlp (bot de música). Ficam em windows\bin; nada é instalado no Windows.
param([switch]$Forcar)
. (Join-Path $PSScriptRoot 'comum.ps1')
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('concord-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Baixar([string]$url, [string]$destino) {
  Escrever "  baixando $url"
  Invoke-WebRequest -Uri $url -OutFile $destino -UseBasicParsing -Headers @{ 'User-Agent' = 'concord-instalador' }
}

function Extrair([string]$arquivo, [string]$pasta) {
  if ($arquivo.EndsWith('.zip')) { Expand-Archive -LiteralPath $arquivo -DestinationPath $pasta -Force }
  else { & tar -xzf $arquivo -C $pasta; if ($LASTEXITCODE -ne 0) { throw "não deu para abrir $arquivo" } }
}

try {
  # ---------- LiveKit ----------
  if ($Forcar -or -not (Test-Path -LiteralPath (Exe 'livekit-server'))) {
    Titulo "LiveKit $LivekitVersao (voz e transmissão de tela)"
    $padrao = 'windows_amd64\.zip$'
    $nome = "livekit_${LivekitVersao}_windows_amd64.zip"
    if (-not $NoWindows) { $padrao = 'linux_amd64\.tar\.gz$'; $nome = "livekit_${LivekitVersao}_linux_amd64.tar.gz" }   # fora do Windows: só nos testes
    # primeiro o link direto da versão certa; se não existir, pergunta ao GitHub qual é a mais nova
    $arq = Join-Path $tmp $nome
    $baixou = $false
    try { Baixar "https://github.com/livekit/livekit/releases/download/v$LivekitVersao/$nome" $arq; $baixou = $true } catch {}
    $rel = $null
    if (-not $baixou) {
      try { $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/livekit/livekit/releases/tags/v$LivekitVersao" -Headers @{ 'User-Agent' = 'concord-instalador' } } catch {}
      $asset = $null
      if ($rel) { $asset = $rel.assets | Where-Object { $_.name -match $padrao } | Select-Object -First 1 }
      if (-not $asset) {
        Aviso "a versão $LivekitVersao não tem versão para Windows; usando a mais nova"
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/livekit/livekit/releases/latest' -Headers @{ 'User-Agent' = 'concord-instalador' }
        $asset = $rel.assets | Where-Object { $_.name -match $padrao } | Select-Object -First 1
      }
      if (-not $asset) { throw 'Não encontrei o LiveKit para Windows no GitHub.' }
      $arq = Join-Path $tmp $asset.name
      Baixar $asset.browser_download_url $arq
    }
    $dest = Join-Path $tmp 'livekit'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Extrair $arq $dest
    $exe = Get-ChildItem -LiteralPath $dest -Recurse -File | Where-Object { $_.Name -match '^livekit-server(\.exe)?$' } | Select-Object -First 1
    if (-not $exe) { throw 'O pacote do LiveKit veio sem o livekit-server.' }
    Copy-Item -LiteralPath $exe.FullName -Destination (Exe 'livekit-server') -Force
    $versao = "v$LivekitVersao"
    if ($rel) { $versao = $rel.tag_name }
    Ok "LiveKit ($versao)"
  } else { Ok 'LiveKit já baixado' }

  if ($NoWindows) {
    # ---------- ffmpeg e ffprobe ----------
    if ($Forcar -or -not (Test-Path -LiteralPath (Exe 'ffmpeg')) -or -not (Test-Path -LiteralPath (Exe 'ffprobe'))) {
      Titulo 'ffmpeg (cinema e bots)'
      $arq = Join-Path $tmp 'ffmpeg.zip'
      try { Baixar 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $arq }
      catch {
        Aviso 'gyan.dev fora do ar; usando a versão do GitHub (BtbN)'
        Baixar 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' $arq
      }
      $dest = Join-Path $tmp 'ffmpeg'
      Extrair $arq $dest
      foreach ($n in @('ffmpeg.exe', 'ffprobe.exe')) {
        $f = Get-ChildItem -LiteralPath $dest -Recurse -File -Filter $n | Select-Object -First 1
        if (-not $f) { throw "O pacote do ffmpeg veio sem o $n." }
        Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $Bin $n) -Force
      }
      Ok 'ffmpeg e ffprobe'
    } else { Ok 'ffmpeg já baixado' }

    # ---------- yt-dlp ----------
    if ($Forcar -or -not (Test-Path -LiteralPath (Exe 'yt-dlp'))) {
      Titulo 'yt-dlp (bot de música)'
      Baixar 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Exe 'yt-dlp')
      Ok 'yt-dlp'
    } else { Ok 'yt-dlp já baixado' }
  } else {
    Aviso 'fora do Windows: usando o ffmpeg e o yt-dlp do sistema'
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
