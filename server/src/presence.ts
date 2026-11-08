// Detector de jogos para quem usa o Concord no navegador: um .bat para Windows, baixado em Configurações →
// Privacidade, que fica rodando e conta ao servidor o que a pessoa está jogando (e ouvindo no Spotify).
// O navegador não tem como ver os programas abertos; o app desktop faz isso sozinho (desktop/main.cjs).
//
// O detector se identifica com uma chave própria (não a sessão da pessoa): ela só serve para mandar a atividade
// e é trocada toda vez que alguém baixa o detector de novo.
import { randomBytes, createHash } from 'node:crypto';
import express, { type Request, type Router } from 'express';
import { config } from './config.ts';
import { get, run } from './db.ts';
import { fail, humansOnly, uid } from './http.ts';
import { setExternalActivities } from './realtime.ts';

const hashPresenceToken = (token: string) => createHash('sha256').update(token).digest('hex');

function presenceUser(req: Request): string {
  const m = /^Presence\s+(cp_[A-Za-z0-9_-]{20,80})$/.exec(req.get('authorization') ?? '');
  const id = m ? get<{ id: string }>('SELECT id FROM users WHERE presence_token_hash = ? AND banned_at IS NULL', hashPresenceToken(m[1]))?.id : null;
  if (!id) fail(401, 'Detector desativado. Baixe de novo em Configurações → Privacidade.');
  return id!;
}

// ------------------------------------------------------------------ jogos conhecidos (executável → nome)

// Reserva, se a lista completa não puder ser baixada. Jogos da Steam nem precisam estar aqui: o detector
// pergunta à própria Steam qual jogo está aberto.
const FALLBACK_GAMES: Record<string, string> = {
  'geometrydash.exe': 'Geometry Dash',
  'robloxplayerbeta.exe': 'Roblox',
  'minecraft.windows.exe': 'Minecraft',
  'league of legends.exe': 'League of Legends',
  'valorant-win64-shipping.exe': 'VALORANT',
  'fortniteclient-win64-shipping.exe': 'Fortnite',
  'rocketleague.exe': 'Rocket League',
  'gta5.exe': 'Grand Theft Auto V',
  'osu!.exe': 'osu!',
  'overwatch.exe': 'Overwatch 2',
  'cs2.exe': 'Counter-Strike 2',
  'dota2.exe': 'Dota 2',
  'r5apex.exe': 'Apex Legends',
  'eldenring.exe': 'ELDEN RING',
  'hollow_knight.exe': 'Hollow Knight',
  'terraria.exe': 'Terraria',
  'stardew valley.exe': 'Stardew Valley',
  'among us.exe': 'Among Us',
  'genshinimpact.exe': 'Genshin Impact',
  'starrail.exe': 'Honkai: Star Rail',
};

// nomes genéricos demais para identificar um jogo (dariam falso positivo)
const GENERIC_EXES = new Set(['game.exe', 'launcher.exe', 'start.exe', 'client.exe', 'main.exe', 'app.exe', 'setup.exe', 'play.exe', 'run.exe', 'javaw.exe', 'java.exe', 'python.exe', 'node.exe', 'unity.exe', 'ue4game.exe', 'electron.exe']);

let gamesCache: { at: number; text: string } | null = null;
let gamesLoading: Promise<string> | null = null;
const GAMES_TTL = 24 * 60 * 60_000;

function linesOf(map: Map<string, string>) {
  return [...map].map(([exe, name]) => `${exe}\t${name}`).join('\n');
}

/** Lista "executável<TAB>nome" por linha: a lista pública de jogos detectáveis do Discord, mais a reserva. */
async function knownGames(): Promise<string> {
  if (gamesCache && Date.now() - gamesCache.at < GAMES_TTL) return gamesCache.text;
  gamesLoading ??= (async () => {
    const map = new Map(Object.entries(FALLBACK_GAMES));
    try {
      const res = await fetch('https://discord.com/api/v9/applications/detectable', { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Concord' } });
      if (res.ok) {
        const apps = (await res.json()) as { name?: string; executables?: { name?: string; os?: string; is_launcher?: boolean }[] }[];
        const seen = new Map<string, string | null>(); // exe -> nome (null = mais de um jogo usa esse nome)
        for (const a of apps) {
          if (!a.name) continue;
          for (const ex of a.executables ?? []) {
            if (ex.os !== 'win32' || ex.is_launcher || !ex.name) continue;
            const exe = ex.name.replace(/^>/, '').split('/').pop()!.toLowerCase();
            if (!exe.endsWith('.exe') || GENERIC_EXES.has(exe) || exe.includes('\t')) continue;
            const prev = seen.get(exe);
            seen.set(exe, prev === undefined || prev === a.name ? a.name : null);
          }
        }
        for (const [exe, name] of seen) if (name && !map.has(exe)) map.set(exe, name.replace(/[\t\r\n]/g, ' ').slice(0, 80));
      }
    } catch {
      // sem internet ou o Discord fora: segue com a reserva
    }
    gamesCache = { at: Date.now(), text: linesOf(map) };
    return gamesCache.text;
  })().finally(() => {
    gamesLoading = null;
  });
  return gamesLoading;
}

// ------------------------------------------------------------------ o arquivo do detector

/** Endereço que o detector usa: o mesmo de onde a pessoa baixou (localhost para quem hospeda, o Radmin para os amigos). */
function serverAddress(req: Request): string {
  const origin = req.get('origin') ?? '';
  if (/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) return origin;
  if (config.publicUrl) return config.publicUrl;
  fail(400, 'Não deu para saber o endereço deste Concord. Abra o Concord pelo navegador e tente de novo.');
  return '';
}

// O .bat chama o PowerShell com o resto do próprio arquivo (depois da linha #PS#). Assim é um arquivo só, que
// abre com dois cliques, sem instalar nada e sem mexer na política de scripts do Windows.
function detectorScript(server: string, token: string): string {
  const bat = [
    '@echo off',
    'title Concord - detector de jogos',
    'set "CONCORD_SELF=%~f0"',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:CONCORD_SELF,[Text.Encoding]::UTF8); iex ($s.Substring($s.IndexOf('#'+'PS'+'#')+4))"`,
    'exit /b',
    '#PS#',
  ];
  const ps = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Server = '__SERVER__'
$Headers = @{ Authorization = 'Presence __TOKEN__' }

Write-Host ''
Write-Host '  Detector de jogos do Concord' -ForegroundColor Magenta
Write-Host '  Deixe esta janela aberta (pode minimizar). Para parar, feche a janela.'
Write-Host ''

# jogos conhecidos fora da Steam: "executavel<TAB>nome" por linha, vindos do servidor
$Known = @{}
try {
  $text = (Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/presence/games" -Headers $Headers -TimeoutSec 60).Content
  if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
  foreach ($line in ($text -split "\n")) {
    $i = $line.IndexOf([char]9)
    if ($i -gt 0) { $Known[$line.Substring(0, $i)] = $line.Substring($i + 1).Trim() }
  }
} catch {}
Write-Host ("  {0} jogos conhecidos, alem dos da Steam." -f $Known.Count) -ForegroundColor DarkGray

$SteamNames = @{}
function Get-SteamGame {
  $id = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -Name RunningAppID -ErrorAction SilentlyContinue).RunningAppID
  if (-not $id -or $id -eq 0) { return $null }
  if ($SteamNames.ContainsKey($id)) { return $SteamNames[$id] }
  $name = $null
  $steamPath = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction SilentlyContinue).SteamPath
  if ($steamPath) {
    $libs = @($steamPath)
    $vdf = Join-Path $steamPath 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
      foreach ($m in [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"([^"]+)"')) { $libs += ($m.Groups[1].Value -replace '\\\\', '\') }
    }
    foreach ($lib in $libs) {
      $acf = Join-Path $lib "steamapps\appmanifest_$id.acf"
      if (Test-Path $acf) {
        $mm = [regex]::Match((Get-Content $acf -Raw -Encoding UTF8), '"name"\s+"([^"]+)"')
        if ($mm.Success) { $name = $mm.Groups[1].Value; break }
      }
    }
  }
  if (-not $name) { $name = 'um jogo da Steam' }
  $SteamNames[$id] = $name
  return $name
}

function Get-KnownGame {
  foreach ($p in (Get-Process)) {
    $exe = ($p.ProcessName + '.exe').ToLower()
    if ($Known.ContainsKey($exe)) { return $Known[$exe] }
  }
  return $null
}

function Get-SpotifyTrack {
  $t = (Get-Process Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle
  if ($t -and $t.Contains(' - ') -and $t -notmatch '^Spotify( Free| Premium)?$') { return $t }
  return $null
}

$last = ''
while ($true) {
  $list = @()
  $game = Get-SteamGame
  if (-not $game) { $game = Get-KnownGame }
  if ($game) { $list += @{ type = 'playing'; name = $game } }
  $track = Get-SpotifyTrack
  if ($track) { $list += @{ type = 'listening'; name = 'Spotify'; details = $track } }

  $json = ConvertTo-Json -InputObject @{ activities = $list } -Depth 4 -Compress
  try {
    Invoke-RestMethod -Method Post -Uri "$Server/api/presence/activity" -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 15 | Out-Null
    $now = if ($list.Count) { ($list | ForEach-Object { if ($_.type -eq 'playing') { 'Jogando ' + $_.name } else { 'Ouvindo ' + $_.details } }) -join '  |  ' } else { 'nada detectado' }
    if ($now -ne $last) { Write-Host ("  [{0}] {1}" -f (Get-Date -Format 'HH:mm'), $now); $last = $now }
  } catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    if ($code -eq 401) {
      Write-Host '  Este detector foi desativado (alguem baixou outro na sua conta). Baixe de novo no Concord.' -ForegroundColor Red
      Read-Host '  Aperte Enter para fechar'
      exit
    }
    if ($last -ne 'offline') { Write-Host ("  [{0}] Sem conexao com o Concord. Tentando de novo..." -f (Get-Date -Format 'HH:mm')) -ForegroundColor Yellow; $last = 'offline' }
  }
  Start-Sleep -Seconds 15
}
`;
  return [...bat, ...ps.replace('__SERVER__', server).replace('__TOKEN__', token).trim().split('\n')].join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ rotas

/** Rotas do detector: ele se identifica com a própria chave, não com a sessão (ficam antes do requireAuth). */
export function registerPublicPresenceRoutes(api: Router) {
  api.get('/presence/games', async (req, res) => {
    presenceUser(req);
    res.type('text/plain; charset=utf-8').send(await knownGames());
  });

  api.post('/presence/activity', express.json({ limit: '4kb' }), (req, res) => {
    const userId = presenceUser(req);
    setExternalActivities(userId, req.body?.activities);
    res.json({ ok: true });
  });
}

export function registerPresenceRoutes(api: Router) {
  /** Gera o detector já configurado (endereço + chave nova; a chave anterior para de funcionar). */
  api.post('/me/presence-helper', humansOnly, (req, res) => {
    const server = serverAddress(req);
    const token = `cp_${randomBytes(24).toString('base64url')}`;
    run('UPDATE users SET presence_token_hash = ? WHERE id = ?', hashPresenceToken(token), uid(res));
    res.json({ filename: 'Concord - detector de jogos.bat', content: detectorScript(server, token) });
  });

  /** Desliga o detector (a chave para de valer). */
  api.delete('/me/presence-helper', humansOnly, (_req, res) => {
    run('UPDATE users SET presence_token_hash = NULL WHERE id = ?', uid(res));
    setExternalActivities(uid(res), []);
    res.json({ ok: true });
  });
}
