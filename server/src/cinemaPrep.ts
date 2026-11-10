// Preparo dos filmes da sala de cinema, para a troca de faixa de áudio.
//
// O navegador não deixa escolher entre as faixas de áudio de um arquivo comum, e não toca AC3/DTS (comuns em MKV).
// Então, quando um filme tem mais de uma faixa ou um áudio que o navegador não toca, o ffmpeg prepara uma versão
// em HLS (o formato de pedaços do streaming):
//   - o vídeo é COPIADO, bit a bit, só cortado em pedaços de 6 s: a imagem fica 100% igual à do arquivo original;
//   - cada faixa de áudio vira uma faixa separada em Opus (estéreo, 160 kbps), que qualquer navegador toca.
// O player escolhe a faixa de cada pessoa sem afetar os outros. O preparo fica guardado em CINEMA_CACHE_DIR (padrão:
// a pasta "cinema-cache" ao lado do banco); ocupa mais ou menos o tamanho do filme e pode ser apagado a qualquer hora.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';

const FFMPEG = () => process.env.CINEMA_FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.CINEMA_FFPROBE || 'ffprobe';
export const cacheDir = () => process.env.CINEMA_CACHE_DIR || join(dirname(config.dbPath), 'cinema-cache');

/** áudios que o navegador toca direto */
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const LANGS: Record<string, string> = {
  por: 'Português',
  pt: 'Português',
  eng: 'Inglês',
  en: 'Inglês',
  spa: 'Espanhol',
  es: 'Espanhol',
  jpn: 'Japonês',
  ja: 'Japonês',
  fre: 'Francês',
  fra: 'Francês',
  ger: 'Alemão',
  deu: 'Alemão',
  ita: 'Italiano',
  kor: 'Coreano',
  chi: 'Chinês',
  zho: 'Chinês',
  rus: 'Russo',
};

export interface AudioTrack {
  label: string;
  lang: string;
  codec: string;
  channels: number;
}

export interface Probe {
  duration: number;
  video: string | null;
  audio: AudioTrack[];
}

export interface PrepStatus {
  state: 'queued' | 'running' | 'ready' | 'failed';
  progress: number;
  error?: string;
}

export interface PrepFilm {
  id: string;
  path: string;
  size: number;
}

const stamp = (path: string) => {
  const st = statSync(path);
  return `${st.size}-${Math.floor(st.mtimeMs)}`;
};
/** a pasta do preparo muda se o arquivo mudar (outro tamanho ou data): nunca toca uma versão velha */
const prepDir = (film: PrepFilm) => join(cacheDir(), `${film.id}-${stamp(film.path)}`);

// ---------- leitura das faixas (ffprobe) ----------

const probes = new Map<string, { stamp: string; probe: Probe | null }>();

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ code: -1, out: '' });
    }
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d: Buffer) => (out += d));
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, out: '' });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** Faixas e duração do arquivo. null = o ffprobe não está instalado ou não conseguiu ler. */
export async function probe(film: PrepFilm): Promise<Probe | null> {
  let s: string;
  try {
    s = stamp(film.path);
  } catch {
    return null;
  }
  const hit = probes.get(film.id);
  if (hit && hit.stamp === s) return hit.probe;
  const { code, out } = await run(FFPROBE(), ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', film.path], 30_000);
  let result: Probe | null = null;
  if (code === 0) {
    try {
      const data = JSON.parse(out) as {
        format?: { duration?: string };
        streams?: { codec_type?: string; codec_name?: string; channels?: number; tags?: Record<string, string>; disposition?: { attached_pic?: number } }[];
      };
      const streams = data.streams ?? [];
      const video = streams.find((st) => st.codec_type === 'video' && !st.disposition?.attached_pic);
      const audio = streams.filter((st) => st.codec_type === 'audio');
      result = {
        duration: Number(data.format?.duration) || 0,
        video: video?.codec_name ?? null,
        audio: audio.map((a, i) => {
          const lang = (a.tags?.language ?? a.tags?.LANGUAGE ?? '').toLowerCase();
          const title = (a.tags?.title ?? a.tags?.TITLE ?? '').trim();
          const named = LANGS[lang];
          return {
            label: (title || named || `Faixa ${i + 1}`).slice(0, 60),
            lang: lang === 'und' ? '' : lang,
            codec: a.codec_name ?? '?',
            channels: a.channels ?? 2,
          };
        }),
      };
    } catch {
      result = null;
    }
  }
  probes.set(film.id, { stamp: s, probe: result });
  return result;
}

/** Precisa de preparo: mais de uma faixa de áudio, ou um áudio que o navegador não toca. */
export const needsPrep = (p: Probe | null) => !!p && (p.audio.length > 1 || p.audio.some((a) => !BROWSER_AUDIO.has(a.codec)));

// ---------- fila de preparo (um filme por vez: o preparo usa disco e CPU) ----------

const jobs = new Map<string, PrepStatus>();
const queue: PrepFilm[] = [];
let busy = false;
let onChange: (filmId: string, status: PrepStatus) => void = () => {};

export function onPrepChange(fn: (filmId: string, status: PrepStatus) => void) {
  onChange = fn;
}

function setStatus(filmId: string, status: PrepStatus) {
  jobs.set(filmId, status);
  onChange(filmId, status);
}

export function prepStatus(film: PrepFilm): PrepStatus | null {
  const job = jobs.get(film.id);
  if (job && job.state !== 'ready') return job;
  try {
    if (existsSync(join(prepDir(film), 'master.m3u8'))) return { state: 'ready', progress: 1 };
  } catch {
    // arquivo sumiu
  }
  return null;
}

/** Põe o filme na fila (se ainda não estiver pronto nem na fila). */
export async function requestPrep(film: PrepFilm): Promise<PrepStatus | null> {
  const current = prepStatus(film);
  if (current && current.state !== 'failed') return current;
  const p = await probe(film);
  if (!p) {
    const status: PrepStatus = { state: 'failed', progress: 0, error: 'O ffmpeg não está instalado no servidor (ou não conseguiu ler o arquivo).' };
    setStatus(film.id, status);
    return status;
  }
  if (!needsPrep(p)) return null;
  setStatus(film.id, { state: 'queued', progress: 0 });
  queue.push(film);
  void pump();
  return jobs.get(film.id)!;
}

async function pump() {
  if (busy) return;
  const film = queue.shift();
  if (!film) return;
  busy = true;
  try {
    await prepare(film);
  } finally {
    busy = false;
    void pump();
  }
}

const quote = (s: string) => s.replace(/["\r\n]/g, "'");

async function prepare(film: PrepFilm) {
  const p = await probe(film);
  if (!p || !p.audio.length) return setStatus(film.id, { state: 'failed', progress: 0, error: 'Não encontrei áudio nesse arquivo.' });
  const dir = prepDir(film);
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  setStatus(film.id, { state: 'running', progress: 0 });

  const hls = (prefix: string) => [
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', `${prefix}_init.mp4`,
    '-hls_segment_filename', join(tmp, `${prefix}_%05d.m4s`),
    join(tmp, `${prefix}.m3u8`),
  ];
  const args = [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-i', film.path,
    // vídeo: copiado, sem recomprimir
    '-map', '0:v:0', '-c:v', 'copy', ...(p.video === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-an', '-sn', '-dn', ...hls('v'),
  ];
  p.audio.forEach((_, i) => {
    args.push('-map', `0:a:${i}`, '-c:a', 'libopus', '-b:a', '160k', '-ac', '2', '-vn', '-sn', '-dn', '-strict', '-2', ...hls(`a${i}`));
  });

  const ok = await new Promise<boolean>((resolve) => {
    let proc;
    try {
      proc = spawn(FFMPEG(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(false);
    }
    let lastEmit = 0;
    let errText = '';
    proc.stderr.on('data', (d: Buffer) => (errText = (errText + d).slice(-2000)));
    proc.stdout.on('data', (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (!m || !p.duration) return;
      const progress = Math.min(0.99, Number(m[1]) / 1e6 / p.duration);
      if (Date.now() - lastEmit > 1000) {
        lastEmit = Date.now();
        setStatus(film.id, { state: 'running', progress });
      }
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      if (code !== 0 && errText) console.error(`[cinema] preparo de ${film.path} falhou: ${errText.trim()}`);
      resolve(code === 0);
    });
  });

  if (!ok) {
    rmSync(tmp, { recursive: true, force: true });
    return setStatus(film.id, { state: 'failed', progress: 0, error: 'O ffmpeg não conseguiu preparar esse arquivo.' });
  }

  // a "playlist mestre": o vídeo + as faixas de áudio, com o nome de cada uma
  const sizeBytes = readdirSync(tmp).reduce((sum, f) => sum + statSync(join(tmp, f)).size, 0);
  const bandwidth = p.duration ? Math.round((sizeBytes * 8) / p.duration) : 8_000_000;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  p.audio.forEach((a, i) => {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${quote(a.label)}"${a.lang ? `,LANGUAGE="${quote(a.lang)}"` : ''},DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,CHANNELS="2",URI="a${i}.m3u8"`,
    );
  });
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AUDIO="aud"`, 'v.m3u8', '');
  writeFileSync(join(tmp, 'master.m3u8'), lines.join('\n'));

  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  // versões velhas do mesmo filme (o arquivo foi trocado) não servem mais
  for (const name of readdirSync(cacheDir())) {
    if (name.startsWith(`${film.id}-`) && join(cacheDir(), name) !== dir) rmSync(join(cacheDir(), name), { recursive: true, force: true });
  }
  setStatus(film.id, { state: 'ready', progress: 1 });
}

/** Caminho de um arquivo do preparo (só nomes simples: nada de "../"). */
export function prepFile(film: PrepFilm, name: string): string | null {
  if (!/^[\w-]+\.(m3u8|m4s|mp4)$/.test(name)) return null;
  const path = join(prepDir(film), name);
  return existsSync(path) ? path : null;
}
