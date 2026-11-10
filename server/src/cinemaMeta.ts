// Capa, título e detalhes dos filmes da sala de cinema.
//
// O nome do arquivo já diz quase tudo: "Summer.Ghost.2021.1080p.mp4" é o filme "Summer Ghost" de 2021, e
// "Frieren.S01E05.mkv" é o episódio 5 da temporada 1 de "Frieren". Com isso o servidor busca os dados no TMDB (The
// Movie Database), em português: capa, fundo, sinopse, gêneros, duração, nota e, em séries, o nome e a imagem de
// cada episódio. As imagens são baixadas uma vez e ficam guardadas aqui; quem assiste não busca nada lá fora.
//
// - TMDB_API_KEY: a chave da API do TMDB (a "API Key" curta ou o "Token de leitura", os dois servem). Sem ela, a
//   biblioteca usa o nome do arquivo e um quadro do próprio vídeo como capa.
// - Quem cuida da sala pode corrigir na mão (buscar o filme certo, ou pôr título e capa próprios): isso vale até
//   alguém pedir para voltar ao automático.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { config } from './config.ts';

// ---------- nome do arquivo ----------

export interface ParsedName {
  kind: 'movie' | 'tv';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
}

const JUNK =
  /\b(2160p|1080p|720p|576p|480p|4k|uhd|web[ -]?dl|web[ -]?rip|webrip|hdtv|blu[ -]?ray|bluray|brrip|bdrip|hdrip|dvdrip|remux|x ?26[45]|h ?26[45]|hevc|avc|10 ?bit|8 ?bit|hdr10?|dv|aac[0-9. ]*|ac3|eac3|ddp?[0-9. ]*|dts(-hd)?|truehd|atmos|dual[ -]?(audio|áudio)?|dublado|legendado|nacional|multi|proper|repack|extended|unrated|imax|complete|nf|amzn|dsnp|hmax|cr)\b/i;
const SEASON_FOLDER = /^(season|temporada|s)\s*\d+$/i;

const clean = (s: string) =>
  s
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–(]+|[\s\-–(]+$/g, '')
    .trim();

/** "Pasta/Summer.Ghost.2021.1080p.mp4" -> filme "Summer Ghost" (2021). "Frieren/S01E05.mkv" -> série "Frieren", T1 E5. */
export function parseName(file: string): ParsedName {
  const parts = file.split('/');
  const base = clean(basename(file, extname(file)));
  const folders = parts.slice(0, -1).map(clean).filter((f) => f && !SEASON_FOLDER.test(f));
  const ep = /\bS(\d{1,2})\s*E(\d{1,3})\b/i.exec(base) ?? /\b(\d{1,2})x(\d{2,3})\b/.exec(base) ?? /\b(?:temporada|season)\s*(\d{1,2}).*?\b(?:epis[oó]dio|episode|ep)\s*(\d{1,3})\b/i.exec(base);
  if (ep) {
    let title = clean(base.slice(0, ep.index).replace(JUNK, ' '));
    title = title.replace(/\b(19|20)\d{2}\b\s*$/, '').trim() || folders.at(-1) || 'Série';
    return { kind: 'tv', title: clean(title), season: Number(ep[1]), episode: Number(ep[2]) };
  }
  // ano: o primeiro depois de pelo menos uma palavra ("2001 Uma Odisseia..." fica com o título inteiro)
  const year = /^(.+?)\s*\(?\b((?:19|20)\d{2})\b\)?/.exec(base);
  if (year && year[1].trim()) {
    const title = clean(year[1].replace(JUNK, ' '));
    if (title) return { kind: 'movie', title, year: Number(year[2]) };
  }
  const junk = JUNK.exec(base);
  const title = clean(junk ? base.slice(0, junk.index) : base) || base;
  return { kind: 'movie', title };
}

// ---------- o que fica guardado ----------

export interface Meta {
  /** tv = episódio de série; video = não achou no TMDB (ou sem chave) */
  kind: 'movie' | 'tv' | 'video';
  source: 'tmdb' | 'manual' | 'none';
  tmdbId?: number;
  title: string;
  year?: number;
  overview?: string;
  genres?: string[];
  /** minutos */
  runtime?: number;
  rating?: number;
  poster?: string;
  backdrop?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  episodeOverview?: string;
  still?: string;
  /** quadro do próprio vídeo (capa reserva) */
  frame?: string;
  /** buscado sem a chave do TMDB: tenta de novo quando ela aparecer */
  noKey?: boolean;
  checkedAt: number;
}

interface Store {
  films: Record<string, Meta>;
  /** "nome da série no arquivo" -> série do TMDB escolhida na mão (vale para todos os episódios) */
  seriesAlias: Record<string, number>;
}

const metaDir = () => process.env.CINEMA_META_DIR || join(dirname(config.dbPath), 'cinema-meta');
export const imgDir = () => join(metaDir(), 'img');
const storePath = () => join(metaDir(), 'meta.json');

let store: Store | null = null;
function load(): Store {
  if (store) return store;
  try {
    store = JSON.parse(readFileSync(storePath(), 'utf8')) as Store;
    store.films ??= {};
    store.seriesAlias ??= {};
  } catch {
    store = { films: {}, seriesAlias: {} };
  }
  return store;
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    mkdirSync(metaDir(), { recursive: true });
    const tmp = `${storePath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(load()));
    renameSync(tmp, storePath());
  }, 300);
}

export const getMeta = (filmId: string): Meta | undefined => load().films[filmId];

// ---------- TMDB ----------

const apiBase = () => (process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/$/, '');
export const tmdbImageBase = () => (process.env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p').replace(/\/$/, '');
const apiKey = () => (process.env.TMDB_API_KEY || '').trim();
export const hasTmdb = () => !!apiKey();

class TmdbDown extends Error {}

async function tmdb<T>(path: string, params: Record<string, string | number | undefined> = {}, lang = 'pt-BR'): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  const url = new URL(`${apiBase()}${path}`);
  url.searchParams.set('language', lang);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  // "Token de leitura" (longo, começa com eyJ) vai no cabeçalho; a "API Key" curta, no endereço
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new TmdbDown('sem conexão com o TMDB');
  }
  if (res.status === 404) return null;
  if (res.status === 401) throw new TmdbDown('a chave do TMDB foi recusada');
  if (!res.ok) throw new TmdbDown(`TMDB respondeu ${res.status}`);
  return (await res.json()) as T;
}

/** Baixa uma imagem do TMDB uma vez e guarda. Devolve o nome do arquivo guardado. */
async function saveImage(size: string, path: string | null | undefined): Promise<string | undefined> {
  if (!path || !/^\/[\w.-]+\.(jpg|jpeg|png|webp)$/i.test(path)) return undefined;
  const name = `${createHash('sha1').update(`${size}${path}`).digest('hex')}.jpg`;
  const out = join(imgDir(), name);
  if (existsSync(out)) return name;
  try {
    const res = await fetch(`${tmdbImageBase()}/${size}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    mkdirSync(imgDir(), { recursive: true });
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return name;
  } catch {
    return undefined;
  }
}

/** Guarda uma imagem enviada por alguém (capa própria). */
export function saveOwnImage(data: Buffer): string {
  const name = `${createHash('sha1').update(data).digest('hex')}.jpg`;
  mkdirSync(imgDir(), { recursive: true });
  writeFileSync(join(imgDir(), name), data);
  return name;
}

interface TmdbMovie {
  id: number;
  title: string;
  release_date?: string;
  overview?: string;
  genres?: { name: string }[];
  runtime?: number;
  vote_average?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
}
interface TmdbTv {
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  genres?: { name: string }[];
  vote_average?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  episode_run_time?: number[];
}
interface TmdbSeason {
  episodes?: { episode_number: number; name?: string; overview?: string; still_path?: string | null; runtime?: number | null }[];
}

const yearOf = (d?: string) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined);
const rating = (v?: number) => (v ? Math.round(v * 10) / 10 : undefined);

/** Sinopse em português; se o TMDB não tiver, em inglês (melhor que nada). */
async function overviewFallback(path: string, pt?: string) {
  if (pt?.trim()) return pt.trim();
  const en = await tmdb<{ overview?: string }>(path, {}, 'en-US');
  return en?.overview?.trim() || undefined;
}

async function movieMeta(id: number, source: Meta['source']): Promise<Meta | null> {
  const m = await tmdb<TmdbMovie>(`/movie/${id}`);
  if (!m) return null;
  return {
    kind: 'movie',
    source,
    tmdbId: m.id,
    title: m.title,
    year: yearOf(m.release_date),
    overview: await overviewFallback(`/movie/${id}`, m.overview),
    genres: m.genres?.map((g) => g.name).slice(0, 4),
    runtime: m.runtime || undefined,
    rating: rating(m.vote_average),
    poster: await saveImage('w500', m.poster_path),
    backdrop: await saveImage('w1280', m.backdrop_path),
    checkedAt: Date.now(),
  };
}

const tvCache = new Map<number, TmdbTv | null>();
const seasonCache = new Map<string, TmdbSeason | null>();

async function tvMeta(id: number, season: number | undefined, episode: number | undefined, source: Meta['source']): Promise<Meta | null> {
  if (!tvCache.has(id)) tvCache.set(id, await tmdb<TmdbTv>(`/tv/${id}`));
  const tv = tvCache.get(id);
  if (!tv) return null;
  const meta: Meta = {
    kind: 'tv',
    source,
    tmdbId: tv.id,
    title: tv.name,
    year: yearOf(tv.first_air_date),
    overview: await overviewFallback(`/tv/${id}`, tv.overview),
    genres: tv.genres?.map((g) => g.name).slice(0, 4),
    rating: rating(tv.vote_average),
    poster: await saveImage('w500', tv.poster_path),
    backdrop: await saveImage('w1280', tv.backdrop_path),
    season,
    episode,
    runtime: tv.episode_run_time?.[0],
    checkedAt: Date.now(),
  };
  if (season !== undefined && episode !== undefined) {
    const key = `${id}:${season}`;
    if (!seasonCache.has(key)) seasonCache.set(key, await tmdb<TmdbSeason>(`/tv/${id}/season/${season}`));
    const ep = seasonCache.get(key)?.episodes?.find((e) => e.episode_number === episode);
    if (ep) {
      meta.episodeTitle = ep.name || undefined;
      meta.episodeOverview = ep.overview?.trim() || undefined;
      meta.still = await saveImage('w300', ep.still_path);
      if (ep.runtime) meta.runtime = ep.runtime;
    }
  }
  return meta;
}

export interface SearchResult {
  tmdbId: number;
  kind: 'movie' | 'tv';
  title: string;
  year?: number;
  overview?: string;
  poster: string | null;
}

/** Busca para a correção manual: filmes e séries, com a capa (direto do TMDB, só para escolher). */
export async function searchTmdb(query: string, kind: 'movie' | 'tv' | 'all' = 'all'): Promise<SearchResult[]> {
  const out: SearchResult[] = [];
  type Hit = { id: number; title?: string; name?: string; release_date?: string; first_air_date?: string; overview?: string; poster_path?: string | null };
  const pic = (p?: string | null) => (p ? `${tmdbImageBase()}/w185${p}` : null);
  const [movies, shows] = await Promise.all([
    kind !== 'tv' ? tmdb<{ results?: Hit[] }>('/search/movie', { query }) : null,
    kind !== 'movie' ? tmdb<{ results?: Hit[] }>('/search/tv', { query }) : null,
  ]);
  for (const r of movies?.results?.slice(0, 12) ?? []) out.push({ tmdbId: r.id, kind: 'movie', title: r.title ?? '', year: yearOf(r.release_date), overview: r.overview?.slice(0, 200), poster: pic(r.poster_path) });
  for (const r of shows?.results?.slice(0, 12) ?? []) out.push({ tmdbId: r.id, kind: 'tv', title: r.name ?? '', year: yearOf(r.first_air_date), overview: r.overview?.slice(0, 200), poster: pic(r.poster_path) });
  return out;
}

// ---------- quadro do vídeo (capa reserva) ----------

function grabFrame(path: string, at: number): Promise<string | undefined> {
  const name = `${createHash('sha1').update(`frame:${path}:${at}`).digest('hex')}.jpg`;
  const out = join(imgDir(), name);
  if (existsSync(out)) return Promise.resolve(name);
  mkdirSync(imgDir(), { recursive: true });
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(process.env.CINEMA_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(Math.max(0, at)), '-i', path, '-frames:v', '1', '-vf', 'scale=780:-2', '-q:v', '4', out], { stdio: 'ignore' });
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    proc.on('error', () => resolve(undefined));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && existsSync(out) ? name : undefined);
    });
  });
}

// ---------- descobrir os dados de um arquivo ----------

export interface MetaFilm {
  id: string;
  file: string;
  path: string;
  duration: number;
}

const aliasKey = (title: string) => title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function detect(film: MetaFilm): Promise<Meta> {
  const parsed = parseName(film.file);
  let meta: Meta | null = null;
  if (hasTmdb()) {
    if (parsed.kind === 'tv') {
      const alias = load().seriesAlias[aliasKey(parsed.title)];
      let id = alias;
      if (!id) {
        const r = await tmdb<{ results?: { id: number }[] }>('/search/tv', { query: parsed.title });
        id = r?.results?.[0]?.id ?? 0;
      }
      if (id) meta = await tvMeta(id, parsed.season, parsed.episode, alias ? 'manual' : 'tmdb');
    } else {
      let r = await tmdb<{ results?: { id: number }[] }>('/search/movie', { query: parsed.title, year: parsed.year });
      if (!r?.results?.length && parsed.year) r = await tmdb<{ results?: { id: number }[] }>('/search/movie', { query: parsed.title });
      const id = r?.results?.[0]?.id;
      if (id) meta = await movieMeta(id, 'tmdb');
    }
  }
  meta ??= {
    kind: parsed.kind === 'tv' ? 'tv' : 'video',
    source: 'none',
    title: parsed.title,
    year: parsed.year,
    season: parsed.season,
    episode: parsed.episode,
    noKey: !hasTmdb() || undefined,
    checkedAt: Date.now(),
  };
  // sem capa (ou episódio sem imagem): um quadro do próprio vídeo, lá pelos 20% do filme
  if (!meta.poster || (meta.kind === 'tv' && !meta.still)) meta.frame = await grabFrame(film.path, film.duration ? Math.round(film.duration * 0.2) : 60);
  return meta;
}

// ---------- fila em segundo plano ----------

const queue: MetaFilm[] = [];
const queued = new Set<string>();
let busy = false;
let lastFailure = 0;
let onChange: () => void = () => {};
export const onMetaChange = (fn: () => void) => void (onChange = fn);

/** Arquivos ainda sem dados (ou buscados sem a chave, que agora existe) entram na fila. */
export function ensureMeta(films: MetaFilm[]) {
  const s = load();
  // o TMDB caiu há pouco: espera 10 min antes de tentar de novo
  if (Date.now() - lastFailure < 10 * 60_000) return;
  for (const f of films) {
    const m = s.films[f.id];
    const stale = !m || (m.noKey && hasTmdb());
    if (stale && !queued.has(f.id)) {
      queued.add(f.id);
      queue.push(f);
    }
  }
  void pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  let changed = false;
  try {
    while (queue.length) {
      const film = queue.shift()!;
      try {
        const meta = await detect(film);
        // alguém corrigiu na mão enquanto buscava: vale a correção
        if (load().films[film.id]?.source !== 'manual') {
          load().films[film.id] = meta;
          changed = true;
        }
      } catch (err) {
        if (err instanceof TmdbDown) {
          console.error(`[cinema] TMDB: ${err.message}`);
          lastFailure = Date.now();
          queue.length = 0;
          queued.clear();
          break;
        }
      } finally {
        queued.delete(film.id);
      }
      if (changed && queue.length % 5 === 0) {
        save();
        onChange();
        changed = false;
      }
    }
  } finally {
    busy = false;
    if (changed) {
      save();
      onChange();
    }
  }
}

// ---------- correção manual ----------

/** Liga o arquivo a um filme/série do TMDB escolhido na mão. Em série, vale para todos os episódios com o mesmo nome. */
export async function setTmdbMatch(film: MetaFilm, kind: 'movie' | 'tv', tmdbId: number): Promise<Meta> {
  const parsed = parseName(film.file);
  let meta: Meta | null;
  try {
    if (kind === 'tv') {
      load().seriesAlias[aliasKey(parsed.title)] = tmdbId;
      meta = await tvMeta(tmdbId, parsed.season ?? 1, parsed.episode, 'manual');
    } else {
      meta = await movieMeta(tmdbId, 'manual');
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'TMDB fora do ar');
  }
  if (!meta) throw new Error('Não encontrei esse título no TMDB');
  load().films[film.id] = meta;
  save();
  onChange();
  return meta;
}

/** Os outros episódios da mesma série (pelo nome no arquivo) são buscados de novo, já com a série certa. */
export function refreshSeries(films: MetaFilm[], file: string) {
  const key = aliasKey(parseName(file).title);
  const others = films.filter((f) => f.file !== file && parseName(f.file).kind === 'tv' && aliasKey(parseName(f.file).title) === key);
  for (const f of others) delete load().films[f.id];
  ensureMeta(others);
}

/** Título, ano, sinopse e capa próprios (vídeos que não são filmes, ou quando o TMDB não tem). */
export function setCustom(film: MetaFilm, data: { title?: string; year?: number; overview?: string; poster?: string }): Meta {
  const cur = load().films[film.id];
  const meta: Meta = {
    ...(cur ?? { kind: 'video', title: parseName(film.file).title, checkedAt: Date.now() }),
    source: 'manual',
    ...(data.title !== undefined ? { title: data.title } : {}),
    ...(data.year !== undefined ? { year: data.year || undefined } : {}),
    ...(data.overview !== undefined ? { overview: data.overview || undefined } : {}),
    ...(data.poster !== undefined ? { poster: data.poster } : {}),
    noKey: undefined,
  };
  load().films[film.id] = meta;
  save();
  onChange();
  return meta;
}

/** Volta ao automático. */
export function resetMeta(film: MetaFilm) {
  const s = load();
  const parsed = parseName(film.file);
  if (parsed.kind === 'tv' && s.films[film.id]?.source === 'manual') delete s.seriesAlias[aliasKey(parsed.title)];
  delete s.films[film.id];
  save();
  ensureMeta([film]);
}
