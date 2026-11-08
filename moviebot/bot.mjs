// Bot de filmes do Concord (separado do bot de música).
// Transmite vídeos que estão numa pasta do PC (montada em /videos) para a sala de voz de quem pediu, como uma
// transmissão de tela, na qualidade escolhida no comando. Legendas (dentro do MKV ou .srt ao lado) saem gravadas
// na imagem, e dá para escolher a faixa de áudio.
//
// Comandos:
//   !filmes [página | busca]                      lista os vídeos da pasta, numerados
//   !playmovie <nome ou número> [qualidade] [opções]
//        qualidade: 480p, 720p, 1080p, com fps junto ou separado (720p60, 1080p 60fps). Padrão: 1080p30
//        opções:    audio:2 | audio:jpn    legenda:1 | legenda:por | legenda:nao    inicio:12:30
//   !faixas <nome ou número>                      mostra as faixas de áudio e legenda do arquivo
//   !pausemovie / !resumemovie                    pausa e continua
//   !seekmovie <tempo>                            vai para um ponto (12:30, 1:02:03, +30, -1:00)
//   !skipmovie                                    pula para o próximo da fila
//   !stopmovie                                    limpa a fila e sai da sala
//   !moviequeue                                   o que está passando e a fila
//   !volmovie <0-100>                             volume do bot
//   !ajudafilme                                   lista os comandos
//
// Variáveis de ambiente:
//   CONCORD_URL, CONCORD_TOKEN                       -> API do Concord (token do bot, começa com cb_)
//   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET -> mesmo LiveKit e mesmas chaves do Concord
//   VIDEOS_DIR (padrão /videos), PREFIX (padrão "!"), BOT_NAME (padrão "Cine"), DEFAULT_VOLUME (padrão 100)
//   DEFAULT_QUALITY (padrão 1080p30), MAX_HEIGHT (padrão 1080), MAX_BITRATE_KBPS (padrão 8000)

import { spawn } from 'node:child_process';
import { readdir, stat, symlink, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { AccessToken } from 'livekit-server-sdk';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoSource,
  dispose,
} from '@livekit/rtc-node';

const env = process.env;
const CONCORD_URL = env.CONCORD_URL;
const CONCORD_TOKEN = env.CONCORD_TOKEN;
const LIVEKIT_URL = env.LIVEKIT_URL;
const LIVEKIT_API_KEY = env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = env.LIVEKIT_API_SECRET;
const VIDEOS_DIR = env.VIDEOS_DIR || '/videos';
const PREFIX = env.PREFIX || '!';
const BOT_NAME = env.BOT_NAME || 'Cine';
const DEFAULT_VOLUME = Math.min(100, Math.max(0, Number(env.DEFAULT_VOLUME ?? 100)));
const MAX_HEIGHT = Number(env.MAX_HEIGHT) || 1080;
const MAX_BITRATE_KBPS = Number(env.MAX_BITRATE_KBPS) || 8000;
const LEAVE_WHEN_IDLE_MS = 3 * 60_000; // sai da sala 3 min depois que a fila acabar
const LEAVE_WHEN_ALONE_MS = 60_000; // sai 1 min depois que todo mundo sair da sala

const missing = Object.entries({ CONCORD_URL, CONCORD_TOKEN, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET }).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  // fica parado em vez de sair: o Docker religaria o bot sem parar
  console.error(`Falta ${missing.join(', ')}. ${missing.includes('CONCORD_TOKEN') ? 'Coloque MOVIEBOT_TOKEN=cb_... no arquivo .env. ' : ''}Veja o LEIA-ME do bot.`);
  await new Promise(() => {});
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = SAMPLE_RATE / 100; // 10 ms por quadro de áudio
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // s16le
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg']);
const SUB_EXTS = ['.srt', '.ass', '.ssa', '.vtt'];
const PAGE = 15;

// ---------- qualidade ----------

const HEIGHTS = [360, 480, 540, 720, 900, 1080, 1440];
const FPS_CHOICES = [24, 25, 30, 48, 50, 60];

/** "1080p60", "720p", "60fps", "60" (depois de uma resolução) -> { height?, fps? } ou null */
function parseQualityToken(token, afterHeight) {
  const t = token.toLowerCase();
  let m = /^(\d{3,4})p(?:(\d{2})(?:fps)?)?$/.exec(t);
  if (m && HEIGHTS.includes(Number(m[1]))) {
    const fps = m[2] ? Number(m[2]) : undefined;
    if (fps !== undefined && !FPS_CHOICES.includes(fps)) return null;
    return { height: Number(m[1]), fps };
  }
  if (t === 'hd') return { height: 720 };
  if (t === 'fullhd' || t === 'fhd') return { height: 1080 };
  m = /^(\d{2})fps$/.exec(t) ?? (afterHeight ? /^(\d{2})$/.exec(t) : null);
  if (m && FPS_CHOICES.includes(Number(m[1]))) return { fps: Number(m[1]) };
  return null;
}

function parseDefaultQuality() {
  const q = { height: 1080, fps: 30 };
  let afterHeight = false;
  for (const tok of String(env.DEFAULT_QUALITY || '1080p30').split(/\s+/)) {
    const r = parseQualityToken(tok, afterHeight);
    if (r?.height) q.height = r.height;
    if (r?.fps) q.fps = r.fps;
    afterHeight = !!r?.height;
  }
  q.height = Math.min(q.height, MAX_HEIGHT);
  return q;
}
const DEFAULT_QUALITY = parseDefaultQuality();

/** Taxa de bits para a resolução/fps (60 fps não precisa do dobro: os quadros são parecidos entre si). */
function bitrateFor(w, h, fps) {
  const kbps = (w * h * 30 * 0.1 * Math.pow(fps / 30, 0.6)) / 1000;
  return Math.round(Math.min(MAX_BITRATE_KBPS, Math.max(800, kbps)));
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
/** largura em múltiplo de 8: o codificador de vídeo corta o que sobra (854 virava 852) */
const mult8 = (n) => Math.max(8, Math.round(n / 8) * 8);

// ---------- API do Concord ----------

async function api(method, p, body) {
  const res = await fetch(`${CONCORD_URL}/api${p}`, {
    method,
    headers: { Authorization: `Bot ${CONCORD_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data;
}

const say = (channelId, content) => api('POST', `/channels/${channelId}/messages`, { content: content.slice(0, 2000) }).catch((err) => console.error('Falha ao enviar mensagem:', err.message));

// ---------- quem está em cada sala de voz ----------

const voiceStates = new Map(); // serverId -> [{ userId, channelId, ... }]

function voiceChannelOf(userId) {
  for (const states of voiceStates.values()) {
    const s = states.find((v) => v.userId === userId);
    if (s) return s.channelId;
  }
  return null;
}

function peopleIn(channelId) {
  let n = 0;
  for (const states of voiceStates.values()) n += states.filter((v) => v.channelId === channelId && v.userId !== me.id).length;
  return n;
}

// ---------- a pasta de vídeos ----------

const normalize = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Todos os vídeos da pasta (e subpastas), em ordem de nome: [{ file, rel, name }] */
async function library() {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
        const rel = path.relative(VIDEOS_DIR, full);
        out.push({ file: full, rel, name: rel.slice(0, -path.extname(rel).length).split(path.sep).join(' / ') });
      }
    }
  }
  await walk(VIDEOS_DIR, 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel, 'pt-BR', { numeric: true, sensitivity: 'base' }));
}

/** Acha o vídeo pelo número da lista ou pelo nome. Devolve { item } ou { matches } ou { none }. */
async function findVideo(query) {
  const all = await library();
  if (/^\d+$/.test(query)) {
    const item = all[Number(query) - 1];
    return item ? { item, index: Number(query) } : { none: true, total: all.length };
  }
  const q = normalize(query);
  const words = q.split(' ').filter(Boolean);
  const scored = all
    .map((v, i) => ({ v, i, n: normalize(v.name) }))
    .filter(({ n }) => words.every((w) => n.includes(w)));
  if (!scored.length) return { none: true, total: all.length };
  const exact = scored.find(({ n, v }) => n === q || normalize(path.basename(v.name)) === q);
  if (exact) return { item: exact.v, index: exact.i + 1 };
  if (scored.length === 1) return { item: scored[0].v, index: scored[0].i + 1 };
  return { matches: scored.map(({ v, i }) => ({ ...v, index: i + 1 })) };
}

// ---------- ffprobe ----------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${cmd} saiu com código ${code}`))));
  });
}

const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'srt']);
const IMAGE_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'pgssub']);

function evalRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
}

/** Informações do arquivo: vídeo, faixas de áudio e de legenda (e .srt/.ass ao lado). */
async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const data = JSON.parse(out);
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('esse arquivo não tem vídeo');
  const lang = (s) => s.tags?.language ?? '';
  const title = (s) => s.tags?.title ?? '';
  const audios = streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({ i, lang: lang(s), title: title(s), channels: s.channels ?? 2, def: !!s.disposition?.default }));
  const subs = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s, i) => ({ i, lang: lang(s), title: title(s), codec: s.codec_name, def: !!s.disposition?.default, forced: !!s.disposition?.forced, image: IMAGE_SUBS.has(s.codec_name) }))
    .filter((s) => s.image || TEXT_SUBS.has(s.codec));
  // legendas em arquivo separado: "Filme.srt", "Filme.pt-BR.srt", "Filme.por.ass"...
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const external = [];
  try {
    for (const f of await readdir(dir)) {
      const ext = path.extname(f).toLowerCase();
      if (!SUB_EXTS.includes(ext) || !f.startsWith(base)) continue;
      const middle = f.slice(base.length, -ext.length).replace(/^[.\s_-]+/, '');
      external.push({ file: path.join(dir, f), lang: middle, title: f, external: true });
    }
  } catch {
    // sem permissão para listar: segue sem legendas externas
  }
  const transfer = video.color_transfer ?? '';
  return {
    width: video.width,
    height: video.height,
    sar: evalRate(video.sample_aspect_ratio?.replace(':', '/')) || 1,
    fps: evalRate(video.avg_frame_rate) || evalRate(video.r_frame_rate) || 30,
    rate: video.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate,
    hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67',
    duration: Number(data.format?.duration) || Number(video.duration) || 0,
    audios,
    subs,
    external,
  };
}

const PT = ['por', 'pt', 'pob', 'pt-br', 'ptbr', 'pt_br', 'portuguese', 'portugues'];
const isPt = (l) => PT.includes(normalize(l).replace(/ /g, '-')) || /portugu|pt-?br|brazil|brasil/i.test(l);

/** Escolhe a faixa por número (1, 2...) ou por idioma (jpn, por...). */
function pickBy(list, wanted) {
  if (/^\d+$/.test(wanted)) return list[Number(wanted) - 1] ?? null;
  const w = normalize(wanted);
  return list.find((t) => normalize(t.lang) === w || normalize(t.lang).startsWith(w) || normalize(t.title).includes(w) || (isPt(wanted) && isPt(t.lang + ' ' + t.title))) ?? null;
}

/** Legenda automática: português (de preferência não "forçada"), senão a marcada como padrão, senão nenhuma. */
function defaultSub(info) {
  const all = [...info.subs, ...info.external];
  return (
    all.find((s) => isPt(`${s.lang} ${s.title}`) && !s.forced) ??
    all.find((s) => isPt(`${s.lang} ${s.title}`)) ??
    info.subs.find((s) => s.def && !s.forced) ??
    null
  );
}

function describeTrack(t, n) {
  const bits = [t.lang && t.lang.toUpperCase(), t.title && t.title !== t.lang ? t.title : '', t.channels > 2 ? `${t.channels === 6 ? '5.1' : t.channels === 8 ? '7.1' : t.channels + ' canais'}` : '', t.image ? 'imagem' : '', t.forced ? 'forçada' : '', t.def ? 'padrão' : '', t.external ? 'arquivo separado' : ''].filter(Boolean);
  return `\`${n}\` ${bits.join(' · ') || 'sem nome'}`;
}

// ---------- ffmpeg ----------

let hasZscale = false;
run('ffmpeg', ['-hide_banner', '-filters'])
  .then((out) => (hasZscale = / zscale /.test(out)))
  .catch(() => {});

/** O caminho vai dentro do filtro de legenda, que se confunde com : ' [ ] , — usa um atalho com nome simples. */
let tmpDir = null;
let linkSeq = 0;
async function safeLink(file) {
  tmpDir ??= await mkdtemp(path.join(tmpdir(), 'cine-'));
  const link = path.join(tmpDir, `s${++linkSeq}${path.extname(file).toLowerCase()}`);
  await symlink(file, link);
  return link;
}

/**
 * Um ffmpeg lê o arquivo e solta quadros I420 já no tamanho/fps da transmissão (fd 4) e PCM 48 kHz estéreo (stdout).
 * Pular para um ponto usa -ss antes da entrada (rápido em arquivo local); -copyts mantém o tempo original para a
 * legenda aparecer na hora certa.
 */
async function startDecoder(job, startAt) {
  const { file, info, out } = job;
  const links = [];
  const seek = startAt > 0 ? ['-ss', String(startAt), '-copyts'] : [];
  const chain = [];
  let label = '[0:v:0]';
  const sub = job.sub;
  // legenda em imagem (Blu-ray/DVD): sobrepõe no tamanho original e depois redimensiona
  if (sub && !sub.external && sub.image) {
    chain.push(`${label}[0:s:${sub.i}]overlay=(W-w)/2:(H-h):eof_action=pass[sv]`);
    label = '[sv]';
  }
  // reduz primeiro: converter HDR para cores normais é pesado, e em 1080p custa 4x menos que em 4K
  const filters = [`scale=${out.w}:${out.h}:flags=bicubic`, 'setsar=1'];
  if (info.hdr && hasZscale) {
    filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  if (sub && (sub.external || !sub.image)) {
    const link = await safeLink(sub.external ? sub.file : file);
    links.push(link);
    filters.push(sub.external ? `subtitles=${link}` : `subtitles=${link}:si=${sub.i}`);
  }
  filters.push(`fps=${out.fpsExpr}`, 'format=yuv420p', 'setpts=PTS-STARTPTS');
  chain.push(`${label}${filters.join(',')}[vout]`);

  const args = ['-hide_banner', '-loglevel', 'error', ...seek, '-i', file, '-filter_complex', chain.join(';'), '-map', '[vout]', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:4'];
  if (job.audio) args.push('-map', `0:a:${job.audio.i}`, '-af', 'asetpts=PTS-STARTPTS', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1');
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  ffmpeg.stderr.on('data', (d) => console.error('[ffmpeg]', String(d).trim()));
  const kill = () => {
    if (ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    for (const l of links) void unlink(l).catch(() => {});
  };
  ffmpeg.on('close', () => {
    for (const l of links) void unlink(l).catch(() => {});
  });
  return { audio: job.audio ? ffmpeg.stdout : null, video: ffmpeg.stdio[4], kill };
}

function formatDuration(s) {
  if (!s && s !== 0) return '';
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "1:30" -> 90, "1:02:03" -> 3723, "90" -> 90 */
function parseTime(text) {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(text)) return null;
  return text.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

// ---------- preparar um pedido ----------

/**
 * Lê "<nome> [qualidade] [opções]" e monta o que vai ser transmitido.
 * Devolve { job } ou { error } ou { matches }.
 */
async function prepare(arg) {
  const tokens = arg.split(/\s+/).filter(Boolean);
  const nameParts = [];
  const want = { height: undefined, fps: undefined, audio: null, sub: undefined, start: 0 };
  let afterHeight = false;
  for (const tok of tokens) {
    const opt = /^(audio|áudio|faixa|legenda|leg|sub|inicio|início|start):(.+)$/i.exec(tok);
    if (opt) {
      const key = normalize(opt[1]);
      const val = opt[2];
      if (key === 'audio' || key === 'faixa') want.audio = val;
      else if (key === 'inicio' || key === 'start') {
        const t = parseTime(val);
        if (t === null) return { error: `Não entendi o início "${val}". Use inicio:12:30` };
        want.start = t;
      } else want.sub = val;
      afterHeight = false;
      continue;
    }
    const q = parseQualityToken(tok, afterHeight);
    if (q) {
      if (q.height) want.height = q.height;
      if (q.fps) want.fps = q.fps;
      afterHeight = !!q.height;
      continue;
    }
    afterHeight = false;
    nameParts.push(tok);
  }
  const query = nameParts.join(' ');
  if (!query) return { error: `Diga qual vídeo: \`${PREFIX}playmovie <nome ou número> 1080p60\`. Veja a lista com \`${PREFIX}filmes\`.` };
  const found = await findVideo(query);
  if (found.none) return { error: found.total ? `Não achei "${query}" na pasta. Veja a lista com \`${PREFIX}filmes\`.` : 'A pasta de vídeos está vazia. Coloque os arquivos na pasta `videos` do Concord.' };
  if (found.matches) return { matches: found.matches, query };

  const { item } = found;
  let info;
  try {
    info = await probe(item.file);
  } catch (err) {
    return { error: `Não consegui ler **${item.name}**: ${err.message}` };
  }

  // resolução: a pedida, sem passar do arquivo (aumentar não melhora nada) nem do limite do servidor
  const asked = Math.min(want.height ?? DEFAULT_QUALITY.height, MAX_HEIGHT);
  const srcW = info.width * info.sar;
  const srcH = info.height;
  const h = even(Math.min(asked, srcH));
  // cabe numa caixa 16:9 da altura pedida, mantendo a proporção do filme (filme "largo" fica mais baixo)
  const boxW = (h * 16) / 9;
  let w = mult8((srcW / srcH) * h);
  let hh = h;
  if (w > boxW + 8) {
    w = mult8(boxW);
    hh = even((w * srcH) / srcW);
  }
  // fps: o pedido, sem passar do arquivo (filme a 24 fps não ganha nada em 60)
  const askedFps = want.fps ?? DEFAULT_QUALITY.fps;
  let fps = askedFps;
  let fpsExpr = String(askedFps);
  if (info.fps && info.fps < askedFps - 0.5) {
    fps = info.fps;
    fpsExpr = info.rate;
  }

  let audio = info.audios.find((a) => a.def) ?? info.audios[0] ?? null;
  if (want.audio) {
    const a = pickBy(info.audios, want.audio);
    if (!a) return { error: `Esse arquivo não tem a faixa de áudio "${want.audio}". Veja com \`${PREFIX}faixas ${found.index}\`.` };
    audio = a;
  }
  const allSubs = [...info.subs, ...info.external];
  let sub = defaultSub(info);
  if (want.sub !== undefined) {
    if (/^(nao|não|off|sem|nenhuma|0)$/i.test(want.sub)) sub = null;
    else {
      sub = pickBy(allSubs, want.sub);
      if (!sub) return { error: `Esse arquivo não tem a legenda "${want.sub}". Veja com \`${PREFIX}faixas ${found.index}\`.` };
    }
  }
  if (want.start && info.duration && want.start >= info.duration) return { error: `Esse vídeo só tem ${formatDuration(info.duration)}.` };

  return {
    job: {
      file: item.file,
      title: item.name,
      info,
      duration: info.duration,
      audio,
      sub,
      start: want.start,
      out: { w, h: hh, fps, fpsExpr, bitrate: bitrateFor(w, hh, fps) },
      asked: { height: asked, fps: askedFps },
    },
  };
}

function qualityText(job) {
  const { out, asked } = job;
  const fpsLabel = Number.isInteger(out.fps) ? out.fps : out.fps.toFixed(2).replace(/0+$/, '').replace('.', ',');
  // pediu mais do que o arquivo tem: avisa que é o máximo dele (aumentar não melhora a imagem)
  const capped = (out.h < asked.height && out.h === job.info.height) || out.fps < asked.fps - 0.5;
  const note = capped ? ` (o máximo do arquivo: ${job.info.height}p, ${fpsLabel} fps)` : '';
  return `${out.w}x${out.h}, ${fpsLabel} fps, ~${(out.bitrate / 1000).toFixed(1).replace('.', ',')} Mbps${note}`;
}

function tracksText(job) {
  const parts = [];
  if (job.audio && job.info.audios.length > 1) parts.push(`áudio ${job.audio.lang ? job.audio.lang.toUpperCase() : `#${job.audio.i + 1}`}`);
  if (job.sub) parts.push(`legenda ${job.sub.lang ? job.sub.lang.toUpperCase() : job.sub.title || 'ligada'}`);
  return parts.join(' · ');
}

// ---------- tocador (uma sala por vez) ----------

class Player {
  constructor(voiceChannelId, textChannelId) {
    this.voiceChannelId = voiceChannelId;
    this.textChannelId = textChannelId;
    this.queue = [];
    this.current = null;
    this.volume = DEFAULT_VOLUME / 100;
    this.paused = false;
    this.position = 0;
    this.seekTo = null;
    this.room = null;
    this.screen = null; // { video, audio, pubs, w, h, fps, bitrate }
    this.decoder = null;
    this.idleTimer = null;
    this.aloneTimer = null;
  }

  async connect() {
    const joined = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'sem resposta' }), 5000);
      socket.emit('voice:join', { channelId: this.voiceChannelId }, (r) => {
        clearTimeout(timer);
        resolve(r ?? { ok: false });
      });
    });
    if (!joined.ok) console.warn('O Concord não registrou o bot na sala (segue mesmo assim):', joined.error);

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: me.id,
      name: me.displayName ?? BOT_NAME,
      metadata: JSON.stringify({ avatarColor: me.avatarColor, username: me.username }),
      ttl: '24h',
    });
    at.kind = 'agent'; // a faxina das salas do Concord não expulsa o bot
    at.addGrant({ room: this.voiceChannelId, roomJoin: true, canPublish: true, canSubscribe: false, canPublishData: false });
    this.room = new Room();
    await this.room.connect(LIVEKIT_URL, await at.toJwt(), { autoSubscribe: false, dynacast: false });
    console.log(`Entrei na sala ${this.voiceChannelId}`);
  }

  /** Publica a "transmissão de tela" no tamanho do vídeo atual (troca se o próximo for diferente). */
  async startScreen(out) {
    const s = this.screen;
    if (s && s.w === out.w && s.h === out.h && s.fps === out.fps && s.bitrate === out.bitrate) return;
    if (s) await this.stopScreen(false);
    const video = new VideoSource(out.w, out.h);
    const audio = new AudioSource(SAMPLE_RATE, CHANNELS, 200);
    const lp = this.room.localParticipant;
    const vPub = await lp.publishTrack(
      LocalVideoTrack.createVideoTrack('filme', video),
      new TrackPublishOptions({
        source: TrackSource.SOURCE_SCREENSHARE,
        videoCodec: VideoCodec.VP8,
        simulcast: false,
        videoEncoding: { maxBitrate: BigInt(out.bitrate * 1000), maxFramerate: Math.ceil(out.fps) },
      }),
    );
    const aPub = await lp.publishTrack(
      LocalAudioTrack.createAudioTrack('filme-audio', audio),
      new TrackPublishOptions({ source: TrackSource.SOURCE_SCREENSHARE_AUDIO, audioEncoding: { maxBitrate: 160_000n }, dtx: false }),
    );
    this.screen = { video, audio, pubs: [vPub.sid, aPub.sid], ...out };
    socket.emit('voice:update', { streaming: true });
  }

  async stopScreen(announce = true) {
    const s = this.screen;
    if (!s) return;
    this.screen = null;
    if (announce) socket.emit('voice:update', { streaming: false });
    for (const sid of s.pubs) await this.room?.localParticipant.unpublishTrack(sid).catch(() => {});
  }

  enqueue(job) {
    this.queue.push(job);
    this.clearIdle();
    if (!this.current) void this.playNext();
  }

  async playNext() {
    this.current = this.queue.shift() ?? null;
    this.paused = false;
    if (!this.current) {
      await this.stopScreen();
      this.scheduleIdle();
      return;
    }
    const job = this.current;
    console.log(`Transmitindo: ${job.title} (${qualityText(job)})`);
    const tracks = tracksText(job);
    void say(
      this.textChannelId,
      `🎬 Passando: **${job.title}** ${job.duration ? `(${formatDuration(job.duration)})` : ''} — pedido por ${job.requester}\n` +
        `📺 ${qualityText(job)}${tracks ? ` · ${tracks}` : ''}${job.start ? ` · começando em ${formatDuration(job.start)}` : ''}\n` +
        'Clique na transmissão do bot na sala de voz para assistir.',
    );
    try {
      await this.startScreen(job.out);
      await this.stream(job);
    } catch (err) {
      console.error('Erro transmitindo', job.file, err);
      void say(this.textChannelId, `⚠️ Não consegui transmitir **${job.title}**: ${err.message}`);
    }
    if (this.current === job) void this.playNext();
  }

  async stream(job) {
    let startAt = job.start || 0;
    for (;;) {
      this.seekTo = null;
      this.position = startAt;
      await this.runOnce(job, startAt);
      if (this.current !== job) return;
      if (this.seekTo !== null) {
        startAt = this.seekTo;
        continue;
      }
      return;
    }
  }

  /** Uma passada do ffmpeg, no ritmo do relógio do áudio. */
  async runOnce(job, startAt) {
    const decoder = await startDecoder(job, startAt);
    this.decoder = decoder;
    const { w, h, fps } = job.out;
    const frameBytes = (w * h * 3) / 2;
    const alive = () => this.decoder === decoder && this.current === job && this.seekTo === null;
    let audioSent = 0;
    let audioDone = !decoder.audio;
    let audioDoneAt = Date.now() / 1000;
    let received = 0;
    let pausedFor = 0; // tempo pausado sem áudio (vídeo mudo)

    const pumpAudio = async () => {
      if (!decoder.audio) return;
      const target = this.screen?.audio;
      let pending = Buffer.alloc(0);
      for await (const chunk of decoder.audio) {
        if (!alive()) break;
        received += chunk.length;
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= FRAME_BYTES) {
          while (this.paused && alive()) await new Promise((r) => setTimeout(r, 100));
          if (!alive()) break;
          const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
          const vol = this.volume;
          for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-32768, Math.min(32767, Math.round(pending.readInt16LE(i * 2) * vol)));
          pending = pending.subarray(FRAME_BYTES);
          await target.captureFrame(new AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
          this.position += 0.01;
          audioSent += 0.01;
        }
      }
      audioDone = true;
      audioDoneAt = Date.now() / 1000;
    };

    const pumpVideo = async () => {
      const queue = [];
      let readDone = false;
      let wallStart = null;
      const AUDIO_LATENCY = 0.15;
      const clock = () => {
        if (!audioDone) return audioSent - AUDIO_LATENCY;
        if (audioSent > 0) return audioSent - AUDIO_LATENCY + (Date.now() / 1000 - audioDoneAt);
        wallStart ??= Date.now() / 1000; // vídeo sem som: relógio de parede (descontando as pausas)
        return Date.now() / 1000 - wallStart - pausedFor;
      };
      const sender = (async () => {
        let sent = 0;
        while (alive() && (!readDone || queue.length)) {
          if (this.paused && !decoder.audio) {
            const t0 = Date.now();
            while (this.paused && alive()) await new Promise((r) => setTimeout(r, 100));
            pausedFor += (Date.now() - t0) / 1000;
          }
          while (queue.length && sent / fps <= clock() && alive()) {
            this.screen?.video.captureFrame(new VideoFrame(queue.shift(), w, h, VideoBufferType.I420));
            sent++;
            if (!decoder.audio) this.position = startAt + sent / fps;
          }
          await new Promise((r) => setTimeout(r, 4));
        }
      })();
      let frame = new Uint8Array(frameBytes);
      let filled = 0;
      // ~1 s de quadros na memória no máximo (1080p ocupa 3 MB por quadro)
      const maxQueued = Math.max(15, Math.ceil(fps));
      for await (const chunk of decoder.video) {
        if (!alive()) break;
        received += chunk.length;
        let off = 0;
        while (off < chunk.length) {
          const n = Math.min(frameBytes - filled, chunk.length - off);
          frame.set(chunk.subarray(off, off + n), filled);
          filled += n;
          off += n;
          if (filled === frameBytes) {
            queue.push(frame);
            frame = new Uint8Array(frameBytes);
            filled = 0;
          }
        }
        while (queue.length > maxQueued && alive()) await new Promise((r) => setTimeout(r, 10));
      }
      readDone = true;
      await sender;
    };

    let completed = false;
    try {
      await Promise.all([pumpAudio(), pumpVideo()]);
      completed = alive();
    } catch (err) {
      if (alive()) throw err;
    } finally {
      decoder.kill();
      if (this.decoder === decoder) this.decoder = null;
    }
    if (completed && !received) throw new Error('o ffmpeg não conseguiu ler o arquivo (veja o log do bot)');
    return completed;
  }

  skip() {
    this.paused = false;
    this.decoder?.kill();
    this.decoder = null;
  }

  seek(seconds) {
    this.seekTo = Math.max(0, seconds);
    this.decoder?.kill();
  }

  async stop() {
    this.queue = [];
    this.current = null;
    this.skip();
    this.clearIdle();
    clearTimeout(this.aloneTimer);
    if (player === this) player = null;
    await this.stopScreen();
    socket.emit('voice:leave');
    try {
      await this.room?.disconnect();
    } catch {
      // já desconectado
    }
    console.log(`Saí da sala ${this.voiceChannelId}`);
  }

  scheduleIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      void say(this.textChannelId, '👋 Acabou a fila de filmes, saindo da sala.');
      void this.stop();
    }, LEAVE_WHEN_IDLE_MS);
  }

  clearIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  checkAlone() {
    if (peopleIn(this.voiceChannelId) > 0) {
      clearTimeout(this.aloneTimer);
      this.aloneTimer = null;
    } else if (!this.aloneTimer) {
      this.aloneTimer = setTimeout(() => {
        if (peopleIn(this.voiceChannelId) === 0) void this.stop();
      }, LEAVE_WHEN_ALONE_MS);
    }
  }
}

let player = null;

// ---------- comandos ----------

const P = PREFIX;
const HELP = [
  `🎬 **Comandos do ${BOT_NAME}:**`,
  `\`${P}filmes\` lista os vídeos da pasta · \`${P}filmes 2\` próxima página · \`${P}filmes naruto\` busca`,
  `\`${P}playmovie <nome ou número> [qualidade]\` transmite. Ex.: \`${P}playmovie 3 1080p60\`, \`${P}playmovie frieren 12 720p\``,
  `   qualidade: \`480p\` \`720p\` \`1080p\` + fps \`24\` \`30\` \`60\` (\`720p60\` ou \`1080p 60fps\`). Padrão: ${DEFAULT_QUALITY.height}p${DEFAULT_QUALITY.fps}`,
  `   opções: \`audio:jpn\` ou \`audio:2\` · \`legenda:por\`, \`legenda:2\` ou \`legenda:nao\` · \`inicio:12:30\``,
  `\`${P}faixas <nome ou número>\` mostra os áudios e legendas do arquivo`,
  `\`${P}pausemovie\` / \`${P}resumemovie\` · \`${P}seekmovie 12:30\` (ou \`+30\`, \`-1:00\`) · \`${P}skipmovie\` · \`${P}stopmovie\``,
  `\`${P}moviequeue\` o que está passando · \`${P}volmovie <0-100>\``,
  'Entre numa sala de voz antes de pedir.',
].join('\n');

const PLAY = ['playmovie', 'filme', 'movie', 'pm'];
const KNOWN = [...PLAY, 'filmes', 'movies', 'faixas', 'pausemovie', 'resumemovie', 'seekmovie', 'skipmovie', 'stopmovie', 'moviequeue', 'volmovie', 'ajudafilme', 'helpmovie'];

function listMatches(matches, query) {
  const lines = [`🔎 Achei ${matches.length} vídeos com "${query}". Use o número:`];
  for (const m of matches.slice(0, 10)) lines.push(`\`${m.index}\` ${m.name}`);
  if (matches.length > 10) lines.push(`...e mais ${matches.length - 10}. Seja mais específico.`);
  return lines.join('\n');
}

async function handle(msg) {
  const text = msg.content.trim();
  if (!text.startsWith(PREFIX)) return;
  const [rawCmd, ...rest] = text.slice(PREFIX.length).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ').trim();
  const who = msg.author.displayName || msg.author.username;
  if (!KNOWN.includes(cmd)) return;

  if (cmd === 'ajudafilme' || cmd === 'helpmovie') return say(msg.channelId, HELP);

  if (cmd === 'filmes' || cmd === 'movies') {
    const all = await library();
    if (!all.length) return say(msg.channelId, '📂 A pasta de vídeos está vazia. Coloque os arquivos na pasta `videos` do Concord e tente de novo.');
    let list = all.map((v, i) => ({ ...v, index: i + 1 }));
    let page = 1;
    let title = `🎬 **Vídeos na pasta** (${all.length})`;
    if (/^\d+$/.test(arg)) page = Number(arg);
    else if (arg) {
      const words = normalize(arg).split(' ');
      list = list.filter((v) => words.every((w) => normalize(v.name).includes(w)));
      if (!list.length) return say(msg.channelId, `Nada com "${arg}" na pasta.`);
      title = `🔎 **"${arg}"** (${list.length})`;
    }
    const pages = Math.ceil(list.length / PAGE);
    page = Math.min(Math.max(1, page), pages);
    const lines = [title + (pages > 1 ? ` — página ${page}/${pages}` : '')];
    for (const v of list.slice((page - 1) * PAGE, page * PAGE)) lines.push(`\`${v.index}\` ${v.name}`);
    if (page < pages && !arg) lines.push(`Próxima: \`${P}filmes ${page + 1}\``);
    lines.push(`Para passar: \`${P}playmovie <número> 1080p\` · comandos: \`${P}ajudafilme\``);
    return say(msg.channelId, lines.join('\n'));
  }

  if (cmd === 'faixas') {
    if (!arg) return say(msg.channelId, `Use \`${P}faixas <nome ou número>\`.`);
    const found = await findVideo(arg);
    if (found.none) return say(msg.channelId, `Não achei "${arg}" na pasta.`);
    if (found.matches) return say(msg.channelId, listMatches(found.matches, arg));
    let info;
    try {
      info = await probe(found.item.file);
    } catch (err) {
      return say(msg.channelId, `⚠️ Não consegui ler o arquivo: ${err.message}`);
    }
    const subs = [...info.subs, ...info.external];
    const auto = defaultSub(info);
    const lines = [
      `🎞️ **${found.item.name}** — ${info.width}x${info.height}, ${info.fps.toFixed(2).replace(/\.?0+$/, '').replace('.', ',')} fps${info.hdr ? ', HDR' : ''}, ${formatDuration(info.duration)}`,
      `**Áudio** (\`audio:N\`): ${info.audios.length ? info.audios.map((a, i) => describeTrack(a, i + 1)).join('  ') : 'nenhum'}`,
      `**Legendas** (\`legenda:N\`): ${subs.length ? subs.map((s, i) => describeTrack(s, i + 1)).join('  ') : 'nenhuma'}`,
    ];
    if (auto) lines.push(`Sem escolher, uso a legenda \`${subs.indexOf(auto) + 1}\`. Para desligar: \`legenda:nao\`.`);
    return say(msg.channelId, lines.join('\n'));
  }

  const voiceId = voiceChannelOf(msg.author.id);

  if (PLAY.includes(cmd)) {
    if (!arg) return say(msg.channelId, `Use \`${P}playmovie <nome ou número> [qualidade]\`. Veja a lista com \`${P}filmes\`.`);
    if (!voiceId) return say(msg.channelId, `${who}, entra numa sala de voz primeiro que eu vou atrás. 🍿`);
    const prep = await prepare(arg);
    if (prep.error) return say(msg.channelId, `⚠️ ${prep.error}`);
    if (prep.matches) return say(msg.channelId, listMatches(prep.matches, prep.query));
    const job = { ...prep.job, requester: who };
    if (player && player.voiceChannelId !== voiceId) {
      if (player.current || player.queue.length) return say(msg.channelId, `🍿 Já estou passando um filme em outra sala. Use ${P}stopmovie lá ou entre na mesma sala.`);
      await player.stop();
    }
    if (!player) {
      player = new Player(voiceId, msg.channelId);
      try {
        await player.connect();
      } catch (err) {
        console.error(err);
        await player.stop();
        return say(msg.channelId, `⚠️ Não consegui entrar na sala de voz: ${err.message}`);
      }
    }
    player.textChannelId = msg.channelId;
    if (player.current) await say(msg.channelId, `➕ Na fila (#${player.queue.length + 1}): **${job.title}** (${qualityText(job)})`);
    return player.enqueue(job);
  }

  if (!player || player.voiceChannelId !== voiceId) return say(msg.channelId, voiceId ? 'Não estou passando nada na sua sala.' : 'Entra na sala de voz onde estou passando o filme para usar esse comando.');

  if (cmd === 'skipmovie') {
    if (!player.current) return say(msg.channelId, 'Nada passando.');
    await say(msg.channelId, `⏭️ Pulando **${player.current.title}**`);
    return player.skip();
  }
  if (cmd === 'pausemovie') {
    if (!player.current) return say(msg.channelId, 'Nada passando.');
    player.paused = true;
    return say(msg.channelId, `⏸️ Pausado em ${formatDuration(player.position)}.`);
  }
  if (cmd === 'resumemovie') {
    if (!player.current) return say(msg.channelId, 'Nada passando.');
    player.paused = false;
    return say(msg.channelId, '▶️ Continuando.');
  }
  if (cmd === 'seekmovie') {
    if (!player.current) return say(msg.channelId, 'Nada passando.');
    const rel = /^([+-])(.+)$/.exec(arg);
    const t0 = parseTime(rel ? rel[2] : arg);
    if (t0 === null) return say(msg.channelId, `Use \`${P}seekmovie 12:30\`, \`${P}seekmovie 1:02:03\` ou \`${P}seekmovie +30\` / \`-1:00\`.`);
    const t = rel ? player.position + (rel[1] === '+' ? t0 : -t0) : t0;
    const dur = player.current.duration;
    if (dur && t >= dur) return say(msg.channelId, `Esse vídeo só tem ${formatDuration(dur)}.`);
    player.seek(t);
    return say(msg.channelId, `⏩ Indo para ${formatDuration(Math.max(0, t))}.`);
  }
  if (cmd === 'stopmovie') {
    await say(msg.channelId, '⏹️ Parei e saí da sala.');
    return player.stop();
  }
  if (cmd === 'moviequeue') {
    const lines = [];
    if (player.current) {
      const cur = player.current;
      lines.push(`🎬 Agora: **${cur.title}** ${formatDuration(player.position)}${cur.duration ? ` / ${formatDuration(cur.duration)}` : ''}${player.paused ? ' (pausado)' : ''}`);
      lines.push(`📺 ${qualityText(cur)}`);
    }
    player.queue.slice(0, 10).forEach((j, i) => lines.push(`${i + 1}. ${j.title} — ${j.out.h}p${Math.round(j.out.fps)} — ${j.requester}`));
    if (player.queue.length > 10) lines.push(`...e mais ${player.queue.length - 10}`);
    return say(msg.channelId, lines.length ? lines.join('\n') : 'Fila vazia.');
  }
  if (cmd === 'volmovie') {
    const v = Number(arg);
    if (!arg || Number.isNaN(v)) return say(msg.channelId, `🔊 Volume: ${Math.round(player.volume * 100)}`);
    player.volume = Math.min(100, Math.max(0, v)) / 100;
    return say(msg.channelId, `🔊 Volume: ${Math.round(player.volume * 100)}`);
  }
}

// ---------- conexão com o Concord ----------

try {
  if (!(await stat(VIDEOS_DIR)).isDirectory()) throw new Error();
} catch {
  console.warn(`A pasta ${VIDEOS_DIR} não existe ou não está montada. Veja o LEIA-ME do bot.`);
}

const me = await api('GET', '/me');
const socket = io(CONCORD_URL, { auth: { token: CONCORD_TOKEN }, transports: ['websocket'] });

socket.on('connect', () => {
  console.log(`Conectado ao Concord como ${me.displayName ?? me.username} (@${me.username})`);
  if (player) {
    socket.emit('voice:join', { channelId: player.voiceChannelId }, () => {
      if (player?.screen) socket.emit('voice:update', { streaming: true });
    });
  }
});
socket.on('connect_error', (err) => console.error('Não foi possível conectar ao Concord:', err.message));

socket.on('voice:states', ({ serverId, states }) => {
  voiceStates.set(serverId, states);
  player?.checkAlone();
});

socket.on('message:new', (msg) => {
  if (msg.author.id === me.id || msg.author.bot) return;
  handle(msg).catch((err) => console.error('Erro no comando:', err));
});

async function shutdown() {
  await player?.stop();
  socket.close();
  await dispose();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
