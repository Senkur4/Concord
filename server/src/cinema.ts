// Sala de cinema: uma sala de voz com uma tela que toca os filmes de uma pasta do servidor, sincronizados.
//
// Ninguém transmite o filme. Cada pessoa toca o arquivo original: puxando do servidor (como um vídeo de site, com
// o Range do HTTP, sem recomprimir nada) ou do próprio PC, se tiver uma cópia. O servidor só guarda "qual filme,
// tocando ou pausado, em qual segundo" e avisa todo mundo; cada player se acerta sozinho.
//
// - CINEMA_DIR: a pasta dos filmes (no Docker, a pasta "videos" ao lado do docker-compose vira /videos).
// - CINEMA_MAX_MBPS: quanto do upload os filmes podem usar ao todo (padrão 70; 0 = sem limite). Dividido por igual
//   entre quem está puxando. Sem isso, o filme lota o upload e a voz da sala começa a travar.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, readdirSync, statSync, type Stats } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express, { type Request, type Response, type Router } from 'express';
import type { Server, Socket } from 'socket.io';
import { P, has } from '../../shared/permissions.ts';
import { channelPermissions, getChannel, requireChannelPerm } from './access.ts';
import { config } from './config.ts';
import type { ChannelRow } from './db.ts';
import { fail, uid } from './http.ts';
import { needsPrep, onPrepChange, prepFile, prepStatus, probe, requestPrep, type PrepFilm } from './cinemaPrep.ts';
import { ensureMeta, getMeta, hasTmdb, imgDir, onMetaChange, refreshSeries, resetMeta, saveOwnImage, searchTmdb, setCustom, setTmdbMatch, type Meta, type MetaFilm } from './cinemaMeta.ts';
import { detectImage } from './uploads.ts';

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov']);
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm' };
const KEY_TTL_MS = 12 * 60 * 60_000;

const cinemaDir = () => process.env.CINEMA_DIR?.trim() || '';
const maxBytesPerMs = () => {
  const mbps = process.env.CINEMA_MAX_MBPS === undefined || process.env.CINEMA_MAX_MBPS === '' ? 70 : Number(process.env.CINEMA_MAX_MBPS);
  return mbps > 0 ? (mbps * 1_000_000) / 8 / 1000 : Infinity;
};

export const isCinema = (channel: ChannelRow) => channel.type === 'voice' && !!channel.cinema;

// ---------- biblioteca ----------

export interface Film {
  id: string;
  name: string;
  file: string;
  size: number;
  ext: string;
  /** quando o arquivo chegou na pasta (para "Adicionados recentemente") */
  addedAt: number;
}

let cache: { at: number; dir: string; films: Film[] } | null = null;

/** Os filmes da pasta (e das subpastas, até 3 níveis). Relido no máximo a cada 10 s. */
export function library(force = false): Film[] {
  const dir = cinemaDir();
  if (!dir) return [];
  if (!force && cache && cache.dir === dir && Date.now() - cache.at < 10_000) return cache.films;
  const films: Film[] = [];
  const walk = (path: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = join(path, name);
      let st: Stats;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (VIDEO_EXTS.has(extname(name).toLowerCase())) {
        const rel = relative(dir, full).split(sep).join('/');
        films.push({
          id: createHash('sha256').update(rel).digest('hex').slice(0, 20),
          name: name.slice(0, -extname(name).length),
          file: rel,
          size: st.size,
          ext: extname(name).slice(1).toLowerCase(),
          addedAt: Math.floor(st.mtimeMs),
        });
      }
    }
  };
  walk(dir, 0);
  films.sort((a, b) => a.file.localeCompare(b.file, 'pt-BR', { numeric: true }));
  cache = { at: Date.now(), dir, films };
  return films;
}

const findFilm = (id: string) => library().find((f) => f.id === id) ?? library(true).find((f) => f.id === id);
const prepFilm = (f: Film): PrepFilm => ({ id: f.id, path: join(cinemaDir(), f.file), size: f.size });

const metaFilm = (f: Film, duration = 0): MetaFilm => ({ id: f.id, file: f.file, path: join(cinemaDir(), f.file), duration });

/** Capa, título e detalhes (com os endereços das imagens guardadas, que levam a chave de quem pediu). */
function metaJson(m: Meta | undefined, key: string) {
  if (!m) return null;
  const img = (n?: string) => (n ? `/api/cinema/img/${encodeURIComponent(key)}/${n}` : null);
  return {
    kind: m.kind,
    source: m.source,
    tmdbId: m.tmdbId ?? null,
    title: m.title,
    year: m.year ?? null,
    overview: m.overview ?? null,
    genres: m.genres ?? [],
    runtime: m.runtime ?? null,
    rating: m.rating ?? null,
    poster: img(m.poster),
    backdrop: img(m.backdrop),
    frame: img(m.frame),
    season: m.season ?? null,
    episode: m.episode ?? null,
    episodeTitle: m.episodeTitle ?? null,
    episodeOverview: m.episodeOverview ?? null,
    still: img(m.still),
  };
}

/** O que a biblioteca mostra de cada filme: detalhes, faixas de áudio e se já está preparado para a troca de áudio. */
async function filmJson(f: Film, key: string) {
  const p = await probe(prepFilm(f));
  return {
    id: f.id,
    name: f.name,
    file: f.file,
    size: f.size,
    ext: f.ext,
    addedAt: f.addedAt,
    meta: metaJson(getMeta(f.id), key),
    duration: p?.duration ?? 0,
    audio: (p?.audio ?? []).map((a) => ({ label: a.label, codec: a.codec })),
    needsPrep: needsPrep(p),
    prep: prepStatus(prepFilm(f)),
  };
}

/** ffprobe em até 4 arquivos por vez (o resultado fica guardado; só arquivo novo ou trocado é lido de novo) */
async function filmsJson(films: Film[], key: string) {
  const out: Awaited<ReturnType<typeof filmJson>>[] = new Array(films.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, films.length) }, async () => {
      while (next < films.length) {
        const i = next++;
        out[i] = await filmJson(films[i], key);
      }
    }),
  );
  // quem ainda não tem capa e detalhes entra na fila (em segundo plano; a sala recebe "cinema:library" quando chegar)
  ensureMeta(films.map((f, i) => metaFilm(f, out[i].duration)));
  return out;
}

// ---------- chave para o <video> (ele não manda o token de login) ----------

const sign = (payload: string) => createHmac('sha256', `${config.jwtSecret}|cinema`).update(payload).digest('base64url').slice(0, 32);

export function fileKey(userId: string): string {
  const exp = Date.now() + KEY_TTL_MS;
  return `${userId}.${exp}.${sign(`${userId}.${exp}`)}`;
}

function checkKey(key: unknown): string | null {
  if (typeof key !== 'string') return null;
  const [user, exp, sig] = key.split('.');
  if (!user || !exp || !sig || Number(exp) < Date.now()) return null;
  const want = Buffer.from(sign(`${user}.${exp}`));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? user : null;
}

// ---------- envio com limite de banda ----------

let streams = 0;

/** Divide o limite por igual entre quem está puxando um filme agora. */
class Throttle extends Transform {
  private tokens = 0;
  private last = Date.now();
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: (err: Error | null, data?: Buffer) => void) {
    const rate = maxBytesPerMs() / Math.max(1, streams);
    if (!Number.isFinite(rate)) return done(null, chunk);
    const now = Date.now();
    // até 1 s de folga acumulada: o começo do filme (e depois de um pulo) carrega rápido
    this.tokens = Math.min(this.tokens + (now - this.last) * rate, rate * 1000);
    this.last = now;
    this.tokens -= chunk.length;
    const wait = this.tokens < 0 ? -this.tokens / rate : 0;
    if (wait > 0) setTimeout(() => done(null, chunk), wait);
    else done(null, chunk);
  }
}

/** Manda um arquivo (inteiro ou o pedaço pedido pelo Range), dentro do limite de banda. */
async function sendFile(req: Request, res: Response, path: string, type: string, cacheControl: string) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return void res.status(404).json({ error: 'Esse arquivo não está mais lá.' });
    }
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range) {
      if (range[1] === '' && range[2] !== '') {
        start = Math.max(0, size - Number(range[2]));
      } else {
        start = Number(range[1] || 0);
        if (range[2] !== '') end = Math.min(size - 1, Number(range[2]));
      }
      if (start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return void res.end();
      }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Cache-Control', cacheControl);
    if (req.method === 'HEAD') return void res.end();
    streams++;
    try {
      await pipeline(createReadStream(path, { start, end, highWaterMark: 256 * 1024 }), new Throttle(), res);
    } catch {
      // quem estava assistindo pulou para outro ponto ou fechou: o navegador cancela o pedido, é normal
    } finally {
      streams--;
    }
}

const IMG_NAME = /^[a-f0-9]{40}\.jpg$/;

const PREP_MIME: Record<string, string> = { m3u8: 'application/vnd.apple.mpegurl', m4s: 'video/iso.segment', mp4: 'video/mp4' };

/** Antes do requireAuth: o <video> não manda o login, então vem com uma chave assinada. */
export function registerCinemaPublicRoutes(api: Router) {
  // o arquivo original (?k=chave)
  api.get('/cinema/file/:id', async (req, res) => {
    if (!checkKey(req.query.k)) return void res.status(403).json({ error: 'Chave do cinema inválida ou vencida. Recarregue a sala.' });
    const film = findFilm(req.params.id);
    if (!film) return void res.status(404).json({ error: 'Esse filme não está mais na pasta.' });
    await sendFile(req, res, join(cinemaDir(), film.file), MIME[`.${film.ext}`] ?? 'application/octet-stream', 'private, no-store');
  });

  // capas, fundos e imagens dos episódios guardados (?chave no caminho, como o resto do cinema)
  api.get('/cinema/img/:key/:name', (req, res) => {
    if (!checkKey(req.params.key)) return void res.status(403).end();
    if (!IMG_NAME.test(req.params.name)) return void res.status(404).end();
    const path = join(imgDir(), req.params.name);
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(path, { headers: { 'Content-Type': 'image/jpeg' } }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // a versão preparada (troca de áudio). A chave vai no caminho: as playlists apontam para os pedaços com
  // endereços relativos, que herdam o caminho mas não o "?k=".
  api.get('/cinema/hls/:key/:id/:file', async (req, res) => {
    if (!checkKey(req.params.key)) return void res.status(403).json({ error: 'Chave do cinema inválida ou vencida. Recarregue a sala.' });
    const film = findFilm(req.params.id);
    const path = film && prepFile(prepFilm(film), req.params.file);
    if (!path) return void res.status(404).json({ error: 'Esse pedaço do filme não existe.' });
    const ext = req.params.file.split('.').pop()!;
    await sendFile(req, res, path, PREP_MIME[ext], ext === 'm3u8' ? 'private, no-cache' : 'private, max-age=86400, immutable');
  });
}

// ---------- estado da sala ----------

interface Room {
  fileId: string | null;
  name: string;
  duration: number;
  playing: boolean;
  /** segundo do filme no instante `at` (relógio do servidor) */
  position: number;
  at: number;
  by: string | null;
  action: string;
  /** quem travou carregando: a sala pausa e espera */
  waiting: Set<string>;
  pausedForWaiting: boolean;
  /** socketId -> userId de quem está com a sala aberta */
  viewers: Map<string, string>;
}

const rooms = new Map<string, Room>();
let io: Server | null = null;

function room(channelId: string): Room {
  let r = rooms.get(channelId);
  if (!r) {
    r = { fileId: null, name: '', duration: 0, playing: false, position: 0, at: Date.now(), by: null, action: 'idle', waiting: new Set(), pausedForWaiting: false, viewers: new Map() };
    rooms.set(channelId, r);
  }
  return r;
}

const positionNow = (r: Room) => (r.playing ? r.position + (Date.now() - r.at) / 1000 : r.position);

export function cinemaState(channelId: string) {
  const r = room(channelId);
  return {
    channelId,
    fileId: r.fileId,
    name: r.name,
    duration: r.duration,
    playing: r.playing,
    position: r.position,
    at: r.at,
    by: r.by,
    action: r.action,
    waiting: [...r.waiting],
    viewers: [...new Set(r.viewers.values())],
    now: Date.now(),
  };
}

const broadcast = (channelId: string) => io?.to(`cinema:${channelId}`).emit('cinema:state', cinemaState(channelId));

const clampTime = (r: Room, t: unknown) => {
  const n = typeof t === 'number' && Number.isFinite(t) ? Math.max(0, t) : positionNow(r);
  return r.duration > 0 ? Math.min(n, r.duration) : n;
};

function setPlaying(r: Room, playing: boolean, at: number) {
  r.position = at;
  r.at = Date.now();
  r.playing = playing;
}

function dropViewer(channelId: string, socketId: string) {
  const r = rooms.get(channelId);
  if (!r) return;
  const userId = r.viewers.get(socketId);
  r.viewers.delete(socketId);
  // quem saiu não segura mais a sala
  if (userId && ![...r.viewers.values()].includes(userId) && r.waiting.delete(userId)) resumeIfReady(r);
  broadcast(channelId);
}

function resumeIfReady(r: Room) {
  if (r.waiting.size === 0 && r.pausedForWaiting) {
    r.pausedForWaiting = false;
    setPlaying(r, true, r.position);
    r.action = 'resume';
  }
}

// chegaram capas/detalhes novos: as salas abertas recarregam a biblioteca (no máximo uma vez por segundo)
let libraryTimer: ReturnType<typeof setTimeout> | null = null;
onMetaChange(() => {
  if (libraryTimer) return;
  libraryTimer = setTimeout(() => {
    libraryTimer = null;
    for (const [channelId, r] of rooms) if (r.viewers.size) io?.to(`cinema:${channelId}`).emit('cinema:library', { channelId });
  }, 1000);
});

// progresso do preparo: vai para todas as salas de cinema abertas
onPrepChange((fileId, status) => {
  for (const [channelId, r] of rooms) if (r.viewers.size) io?.to(`cinema:${channelId}`).emit('cinema:prep', { fileId, ...status });
});

/** Chamado para cada conexão (em setupRealtime). */
export function registerCinemaSocket(server: Server, socket: Socket, userId: string) {
  io = server;
  const watching = new Set<string>();

  const cinemaChannel = (channelId: unknown) => {
    if (typeof channelId !== 'string') return null;
    try {
      const channel = getChannel(channelId);
      return isCinema(channel) && has(channelPermissions(channel, userId), P.VIEW_CHANNEL) ? channel : null;
    } catch {
      return null;
    }
  };

  socket.on('cinema:time', (ack: unknown) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('cinema:watch', (data: { channelId?: unknown }, ack?: unknown) => {
    const channel = cinemaChannel(data?.channelId);
    if (!channel) return typeof ack === 'function' && ack({ error: 'Sem acesso a esta sala de cinema' });
    void socket.join(`cinema:${channel.id}`);
    watching.add(channel.id);
    room(channel.id).viewers.set(socket.id, userId);
    broadcast(channel.id);
    if (typeof ack === 'function') ack(cinemaState(channel.id));
  });

  socket.on('cinema:unwatch', (data: { channelId?: unknown }) => {
    if (typeof data?.channelId !== 'string' || !watching.has(data.channelId)) return;
    watching.delete(data.channelId);
    void socket.leave(`cinema:${data.channelId}`);
    dropViewer(data.channelId, socket.id);
  });

  socket.on('cinema:control', (data: { channelId?: unknown; action?: unknown; t?: unknown; fileId?: unknown }) => {
    const channel = cinemaChannel(data?.channelId);
    if (!channel || !watching.has(channel.id)) return;
    const r = room(channel.id);
    switch (data.action) {
      case 'load': {
        const film = typeof data.fileId === 'string' ? findFilm(data.fileId) : undefined;
        if (!film) return;
        Object.assign(r, { fileId: film.id, name: film.name, duration: 0 });
        // tem mais de uma faixa de áudio (ou um áudio que o navegador não toca): prepara para a troca de áudio
        void requestPrep(prepFilm(film));
        r.waiting.clear();
        r.pausedForWaiting = false;
        setPlaying(r, false, 0);
        break;
      }
      case 'stop':
        Object.assign(r, { fileId: null, name: '', duration: 0 });
        r.waiting.clear();
        r.pausedForWaiting = false;
        setPlaying(r, false, 0);
        break;
      case 'play':
        if (!r.fileId) return;
        // quem dá play manualmente passa por cima da espera
        r.waiting.clear();
        r.pausedForWaiting = false;
        setPlaying(r, true, clampTime(r, data.t));
        break;
      case 'pause':
        if (!r.fileId) return;
        r.pausedForWaiting = false;
        setPlaying(r, false, clampTime(r, data.t));
        break;
      case 'seek':
        if (!r.fileId) return;
        // pulando enquanto a sala espera alguém: continua esperando, só que no ponto novo
        setPlaying(r, r.playing, clampTime(r, data.t));
        break;
      default:
        return;
    }
    r.by = userId;
    r.action = data.action;
    broadcast(channel.id);
  });

  // a duração vem do primeiro player que abriu o arquivo do servidor (o servidor não lê o arquivo para descobrir)
  socket.on('cinema:duration', (data: { channelId?: unknown; fileId?: unknown; duration?: unknown }) => {
    const channel = cinemaChannel(data?.channelId);
    if (!channel) return;
    const r = room(channel.id);
    const d = Number(data.duration);
    if (r.fileId && data.fileId === r.fileId && !r.duration && Number.isFinite(d) && d > 0 && d < 24 * 3600) {
      r.duration = d;
      broadcast(channel.id);
    }
  });

  socket.on('cinema:buffering', (data: { channelId?: unknown; buffering?: unknown }) => {
    const channel = cinemaChannel(data?.channelId);
    if (!channel || !watching.has(channel.id)) return;
    const r = room(channel.id);
    if (data.buffering === true) {
      if (!r.playing && !r.pausedForWaiting) return;
      r.waiting.add(userId);
      if (r.playing) {
        setPlaying(r, false, positionNow(r));
        r.pausedForWaiting = true;
        r.action = 'wait';
      }
    } else {
      if (!r.waiting.delete(userId)) return;
      resumeIfReady(r);
    }
    broadcast(channel.id);
  });

  socket.on('disconnect', () => {
    for (const channelId of watching) dropViewer(channelId, socket.id);
    watching.clear();
  });
}

/** Biblioteca e estado, para quem abre a sala (com a chave dos arquivos). */
export function registerCinemaRoutes(api: Router) {
  api.get('/channels/:id/cinema', async (req, res) => {
    const channel = requireChannelPerm(req.params.id, uid(res), P.VIEW_CHANNEL);
    if (!isCinema(channel)) fail(400, 'Este canal não é uma sala de cinema');
    res.json({
      configured: !!cinemaDir(),
      ...(await (async () => {
        const key = fileKey(uid(res));
        return { films: await filmsJson(library(req.query.refresh === '1'), key), key };
      })()),
      tmdb: hasTmdb(),
      canEdit: has(channelPermissions(channel, uid(res)), P.MANAGE_CHANNELS),
      state: cinemaState(channel.id),
    });
  });

  // ---------- corrigir capa e detalhes (quem gerencia o canal) ----------
  const editable = (req: Request, res: Response) => {
    const channel = requireChannelPerm(String(req.params.id), uid(res), P.MANAGE_CHANNELS);
    if (!isCinema(channel)) fail(400, 'Este canal não é uma sala de cinema');
    const film = findFilm(String(req.params.filmId ?? '')) ?? fail(404, 'Esse filme não está mais na pasta.');
    return film;
  };

  api.get('/channels/:id/cinema/search', async (req, res) => {
    const channel = requireChannelPerm(req.params.id, uid(res), P.MANAGE_CHANNELS);
    if (!isCinema(channel)) fail(400, 'Este canal não é uma sala de cinema');
    if (!hasTmdb()) fail(400, 'Falta a chave do TMDB no servidor (TMDB_API_KEY no .env).');
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    if (!q) return void res.json({ results: [] });
    const kind = req.query.kind === 'movie' || req.query.kind === 'tv' ? req.query.kind : 'all';
    try {
      res.json({ results: await searchTmdb(q, kind) });
    } catch (err) {
      fail(502, `Não deu para buscar no TMDB: ${err instanceof Error ? err.message : 'erro'}`);
    }
  });

  // { tmdbId, kind } liga ao TMDB; { title, year, overview } põe dados próprios
  api.put('/channels/:id/cinema/films/:filmId/meta', async (req, res) => {
    const film = editable(req, res);
    const body = req.body ?? {};
    if (typeof body.tmdbId === 'number' && (body.kind === 'movie' || body.kind === 'tv')) {
      try {
        const meta = await setTmdbMatch(metaFilm(film), body.kind, body.tmdbId);
        if (body.kind === 'tv') refreshSeries(library().map((f) => metaFilm(f)), film.file);
        return void res.json({ meta: metaJson(meta, fileKey(uid(res))) });
      } catch (err) {
        fail(502, err instanceof Error ? err.message : 'Não deu para buscar no TMDB');
      }
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : undefined;
    if (title !== undefined && !title) fail(400, 'O título não pode ficar vazio');
    const year = body.year === null || body.year === '' ? 0 : body.year !== undefined ? Number(body.year) : undefined;
    if (year !== undefined && year !== 0 && !(Number.isInteger(year) && year >= 1880 && year <= 2100)) fail(400, 'Ano inválido');
    const overview = typeof body.overview === 'string' ? body.overview.trim().slice(0, 2000) : undefined;
    res.json({ meta: metaJson(setCustom(metaFilm(film), { title, year, overview }), fileKey(uid(res))) });
  });

  // capa própria (imagem no corpo do pedido)
  api.post('/channels/:id/cinema/films/:filmId/poster', express.raw({ type: () => true, limit: '9mb' }), (req, res) => {
    const film = editable(req, res);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length || !detectImage(data)) fail(400, 'Mande uma imagem (JPG, PNG, WebP ou GIF)');
    res.json({ meta: metaJson(setCustom(metaFilm(film), { poster: saveOwnImage(data) }), fileKey(uid(res))) });
  });

  // volta ao automático
  api.delete('/channels/:id/cinema/films/:filmId/meta', (req, res) => {
    const film = editable(req, res);
    resetMeta(metaFilm(film));
    res.json({ ok: true });
  });

  // preparar antes da sessão (para ninguém esperar na hora): o botão "Preparar" da biblioteca
  api.post('/channels/:id/cinema/films/:filmId/prepare', async (req, res) => {
    const channel = requireChannelPerm(req.params.id, uid(res), P.VIEW_CHANNEL);
    if (!isCinema(channel)) fail(400, 'Este canal não é uma sala de cinema');
    const film = findFilm(req.params.filmId) ?? fail(404, 'Esse filme não está mais na pasta.');
    res.json({ prep: await requestPrep(prepFilm(film)) });
  });
}

/** Para os testes. */
export function resetCinema() {
  rooms.clear();
  cache = null;
}
