import { ArrowLeft, AudioLines, Clapperboard, Film, ImageUp, Pencil, Play, RefreshCw, RotateCcw, Search, Star, Tv, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, getToken } from '../lib/api';
import { toast } from '../store/toast';
import { Spinner, cx } from './ui';

/**
 * Biblioteca da sala de cinema: capas em grade (filmes, séries e outros vídeos), a página de cada um (fundo, sinopse,
 * versões do arquivo, temporadas e episódios) e a correção manual dos dados. Os dados vêm do TMDB pelo nome do
 * arquivo (ver cinemaMeta.ts no servidor); sem eles, o card usa um quadro do próprio vídeo.
 */

export interface PrepInfo {
  state: 'queued' | 'running' | 'ready' | 'failed';
  progress: number;
  error?: string;
}

export interface FilmMeta {
  kind: 'movie' | 'tv' | 'video';
  source: 'tmdb' | 'manual' | 'none';
  tmdbId: number | null;
  title: string;
  year: number | null;
  overview: string | null;
  genres: string[];
  runtime: number | null;
  rating: number | null;
  poster: string | null;
  backdrop: string | null;
  frame: string | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  episodeOverview: string | null;
  still: string | null;
}

export interface FilmInfo {
  id: string;
  name: string;
  file: string;
  size: number;
  ext: string;
  addedAt: number;
  meta: FilmMeta | null;
  duration: number;
  /** faixas de áudio do arquivo */
  audio: { label: string; codec: string }[];
  /** mais de uma faixa (ou áudio que o navegador não toca): toca a versão preparada, com troca de áudio */
  needsPrep: boolean;
  prep: PrepInfo | null;
}

export interface LibraryData {
  configured: boolean;
  films: FilmInfo[];
  key: string;
  tmdb: boolean;
  canEdit: boolean;
}

interface Entry {
  key: string;
  type: 'movie' | 'series' | 'video';
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  genres: string[];
  rating: number | null;
  runtime: number | null;
  files: FilmInfo[];
  addedAt: number;
  loading: boolean;
}

export const fmtSize = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const fmtRuntime = (min: number | null) => (!min ? null : min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`);
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const epOrder = (f: FilmInfo) => (f.meta?.season ?? 999) * 10000 + (f.meta?.episode ?? 9999);

/** Junta os arquivos: versões do mesmo filme num card só, e os episódios de uma série num card só. */
export function groupEntries(films: FilmInfo[]): Entry[] {
  const map = new Map<string, Entry>();
  for (const f of films) {
    const m = f.meta;
    const type = m?.kind === 'tv' ? 'series' : m?.kind === 'movie' ? 'movie' : 'video';
    const key = type === 'series' ? `tv:${m?.tmdbId ?? norm(m!.title)}` : type === 'movie' && m?.tmdbId ? `movie:${m.tmdbId}` : `file:${f.id}`;
    let e = map.get(key);
    if (!e) {
      e = {
        key,
        type,
        title: m?.title ?? f.name,
        year: m?.year ?? null,
        poster: m?.poster ?? null,
        backdrop: m?.backdrop ?? m?.frame ?? null,
        overview: m?.overview ?? null,
        genres: m?.genres ?? [],
        rating: m?.rating ?? null,
        runtime: type === 'series' ? null : (m?.runtime ?? (f.duration ? Math.round(f.duration / 60) : null)),
        files: [],
        addedAt: 0,
        loading: !m,
      };
      map.set(key, e);
    }
    e.files.push(f);
    e.addedAt = Math.max(e.addedAt, f.addedAt);
    // capa: a do TMDB; sem ela, um quadro do vídeo (o primeiro episódio que tiver)
    e.poster ??= m?.poster ?? null;
    if (!e.poster && !e.backdrop) e.backdrop = m?.frame ?? null;
  }
  for (const e of map.values()) if (e.type === 'series') e.files.sort((a, b) => epOrder(a) - epOrder(b));
  return [...map.values()];
}

/** Nome para mostrar de um arquivo: "Summer Ghost (2021)" ou "Frieren · T1 E2 · Nome do episódio". */
export function filmTitle(f: FilmInfo | undefined, fallback = 'Filme') {
  const m = f?.meta;
  if (!m) return f?.name ?? fallback;
  if (m.kind === 'tv') return [m.title, m.season != null && m.episode != null ? `T${m.season} E${m.episode}` : null, m.episodeTitle].filter(Boolean).join(' · ');
  return m.year ? `${m.title} (${m.year})` : m.title;
}

/** O próximo episódio da mesma série (para o botão "Próximo episódio"). */
export function nextEpisode(films: FilmInfo[], fileId: string): FilmInfo | null {
  const entry = groupEntries(films).find((e) => e.files.some((f) => f.id === fileId));
  if (!entry || entry.type !== 'series') return null;
  const i = entry.files.findIndex((f) => f.id === fileId);
  return entry.files[i + 1] ?? null;
}

// ---------- pedaços ----------

function Cover({ entry, className }: { entry: Entry; className?: string }) {
  const src = entry.poster ?? entry.backdrop;
  return (
    <div className={cx('relative overflow-hidden bg-surface-3', className)}>
      {src ? (
        <img src={src} alt="" loading="lazy" className={cx('h-full w-full object-cover', !entry.poster && 'scale-110')} />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-linear-to-br from-surface-3 to-surface-0 text-fg-subtle">
          {entry.loading ? <Spinner size={22} /> : entry.type === 'series' ? <Tv size={30} /> : <Film size={30} />}
        </div>
      )}
      {/* sem capa de verdade: o título vai em cima do quadro do vídeo */}
      {!entry.poster && (
        <div className="absolute inset-0 flex items-end bg-linear-to-t from-black/85 via-black/20 to-transparent p-2.5">
          <span className="line-clamp-3 font-display text-sm leading-tight font-bold text-white">{entry.title}</span>
        </div>
      )}
    </div>
  );
}

function Card({ entry, onOpen }: { entry: Entry; onOpen: () => void }) {
  const audios = Math.max(...entry.files.map((f) => f.audio.length));
  const preparing = entry.files.find((f) => f.prep?.state === 'running' || f.prep?.state === 'queued')?.prep;
  const sub =
    entry.type === 'series'
      ? `${entry.files.length} ${entry.files.length === 1 ? 'episódio' : 'episódios'}`
      : entry.files.length > 1
        ? `${entry.files.length} versões`
        : fmtSize(entry.files[0].size);
  return (
    <button onClick={onOpen} className="group w-full text-left outline-none" title={entry.title}>
      <div className="relative">
        <Cover entry={entry} className="aspect-[2/3] rounded-2xl ring-1 ring-white/5 transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-xl group-hover:ring-2 group-hover:ring-accent group-focus-visible:ring-2 group-focus-visible:ring-accent" />
        {audios > 1 && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur">
            <AudioLines size={11} /> {audios}
          </span>
        )}
        {preparing && (
          <span className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-black/50">
            <span className="block h-full bg-accent" style={{ width: `${Math.round(preparing.progress * 100)}%` }} />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur">
            <Play size={20} className="ml-0.5" fill="currentColor" />
          </span>
        </span>
      </div>
      <div className="mt-2 px-0.5">
        <div className="line-clamp-2 text-sm leading-snug font-semibold">{entry.title}</div>
        <div className="mt-0.5 text-xs text-fg-muted">
          {[entry.year, sub].filter(Boolean).join(' · ')}
        </div>
      </div>
    </button>
  );
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="mb-3 flex items-center gap-2 px-1 font-display text-base font-bold">
        {icon} {title}
      </h3>
      {children}
    </section>
  );
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(138px,1fr))] gap-x-4 gap-y-5';

function PrepLine({ film, onPrepare }: { film: FilmInfo; onPrepare: () => void }) {
  const p = film.prep;
  if (!film.needsPrep || p?.state === 'ready') return null;
  if (p?.state === 'running' || p?.state === 'queued') {
    return (
      <span className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="h-1 w-24 overflow-hidden rounded-full bg-surface-3">
          <span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.round(p.progress * 100)}%` }} />
        </span>
        {p.state === 'queued' ? 'Na fila' : `Preparando ${Math.round(p.progress * 100)}%`}
      </span>
    );
  }
  return (
    <button onClick={onPrepare} title="Separa as faixas de áudio agora, para ninguém esperar na hora" className="flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
      <Wand2 size={12} /> {p?.state === 'failed' ? 'Tentar preparar de novo' : 'Preparar agora'}
    </button>
  );
}

// ---------- página de um filme/série ----------

function Detail({
  entry,
  lib,
  onBack,
  onPlay,
  onPrepare,
  onEdit,
}: {
  entry: Entry;
  lib: LibraryData;
  onBack: () => void;
  onPlay: (fileId: string) => void;
  onPrepare: (fileId: string) => void;
  onEdit: () => void;
}) {
  const seasons = useMemo(() => [...new Set(entry.files.map((f) => f.meta?.season ?? 0))].sort((a, b) => a - b), [entry.files]);
  const [season, setSeason] = useState(seasons[0] ?? 0);
  const [more, setMore] = useState(false);
  const bg = entry.backdrop ?? entry.poster;
  const facts = [entry.year, fmtRuntime(entry.runtime), entry.genres.slice(0, 3).join(', ') || null].filter(Boolean);

  return (
    <div className="relative">
      {/* fundo */}
      <div className="absolute inset-x-0 top-0 h-80 overflow-hidden">
        {bg && <img src={bg} alt="" className={cx('h-full w-full object-cover', !entry.backdrop && 'scale-125 blur-xl')} />}
        <div className="absolute inset-0 bg-linear-to-b from-surface-0/30 via-surface-0/70 to-surface-0" />
        <div className="absolute inset-0 bg-linear-to-r from-surface-0/80 via-transparent to-transparent" />
      </div>

      <div className="relative px-6 pt-4 pb-6">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="flex h-9 items-center gap-1.5 rounded-full bg-black/40 px-3 text-sm font-semibold text-white backdrop-blur hover:bg-black/60">
            <ArrowLeft size={16} /> Biblioteca
          </button>
          <div className="flex-1" />
          {lib.canEdit && (
            <button onClick={onEdit} className="flex h-9 items-center gap-1.5 rounded-full bg-black/40 px-3 text-sm font-semibold text-white backdrop-blur hover:bg-black/60">
              <Pencil size={14} /> Editar
            </button>
          )}
        </div>

        <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-end">
          <Cover entry={entry} className="aspect-[2/3] w-40 shrink-0 rounded-2xl shadow-2xl ring-1 ring-white/10" />
          <div className="min-w-0 flex-1 pb-1">
            <span className="text-xs font-bold tracking-wider text-accent uppercase">{entry.type === 'series' ? 'Série' : entry.type === 'movie' ? 'Filme' : 'Vídeo'}</span>
            <h2 className="mt-1 font-display text-3xl leading-tight font-bold">{entry.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-fg-muted">
              {facts.map((f, i) => (
                <span key={i}>{f}</span>
              ))}
              {entry.rating ? (
                <span className="flex items-center gap-1 font-semibold text-amber-300">
                  <Star size={13} fill="currentColor" /> {entry.rating.toFixed(1).replace('.', ',')}
                </span>
              ) : null}
            </div>
            {entry.overview && (
              <p className={cx('mt-3 max-w-3xl text-sm leading-relaxed text-fg/85', !more && 'line-clamp-4')} onClick={() => setMore(!more)}>
                {entry.overview}
              </p>
            )}
            {entry.type !== 'series' && entry.files.length === 1 && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button onClick={() => onPlay(entry.files[0].id)} className="flex h-11 items-center gap-2 rounded-full bg-accent px-6 font-semibold text-white shadow-lg hover:brightness-110">
                  <Play size={18} fill="currentColor" /> Assistir na sala
                </button>
                <PrepLine film={entry.files[0]} onPrepare={() => onPrepare(entry.files[0].id)} />
              </div>
            )}
          </div>
        </div>

        {/* versões (dublado/legendado, 1080p/4K...) */}
        {entry.type !== 'series' && (
          <div className="mt-7">
            <h3 className="mb-2 font-display text-sm font-bold tracking-wide text-fg-muted uppercase">{entry.files.length > 1 ? 'Versões' : 'Arquivo'}</h3>
            <ul className="space-y-2">
              {entry.files.map((f) => (
                <li key={f.id} className="flex items-center gap-3 rounded-2xl bg-surface-2/80 p-3">
                  <Film size={18} className="shrink-0 text-fg-subtle" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{f.file.split('/').pop()}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                      <span>{fmtSize(f.size)}</span>
                      <span className="uppercase">{f.ext}</span>
                      {f.audio.length > 0 && <span title={f.audio.map((a) => a.label).join(' · ')}>{f.audio.length > 1 ? `${f.audio.length} áudios: ${f.audio.map((a) => a.label).join(', ')}` : '1 áudio'}</span>}
                      <PrepLine film={f} onPrepare={() => onPrepare(f.id)} />
                    </div>
                  </div>
                  {entry.files.length > 1 && (
                    <button onClick={() => onPlay(f.id)} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-white hover:brightness-110">
                      <Play size={14} fill="currentColor" /> Assistir
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* temporadas e episódios */}
        {entry.type === 'series' && (
          <div className="mt-7">
            {seasons.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {seasons.map((s) => (
                  <button key={s} onClick={() => setSeason(s)} className={cx('h-9 rounded-full px-4 text-sm font-semibold transition-colors', season === s ? 'bg-fg text-surface-0' : 'bg-surface-2 hover:bg-surface-3')}>
                    {s ? `Temporada ${s}` : 'Outros'}
                  </button>
                ))}
              </div>
            )}
            <ul className="space-y-2">
              {entry.files
                .filter((f) => (f.meta?.season ?? 0) === season)
                .map((f) => {
                  const m = f.meta;
                  const thumb = m?.still ?? m?.frame;
                  return (
                    <li key={f.id}>
                      <button onClick={() => onPlay(f.id)} className="group flex w-full items-center gap-4 rounded-2xl bg-surface-2/80 p-2.5 text-left transition-colors hover:bg-surface-3">
                        <span className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-xl bg-surface-3">
                          {thumb ? <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Tv size={22} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-fg-subtle" />}
                          <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                            <Play size={22} className="text-white" fill="currentColor" />
                          </span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">
                            {m?.episode != null ? `${m.episode}. ` : ''}
                            {m?.episodeTitle ?? f.name}
                          </span>
                          {m?.episodeOverview && <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-muted">{m.episodeOverview}</span>}
                          <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
                            {fmtRuntime(m?.runtime ?? (f.duration ? Math.round(f.duration / 60) : null))}
                            {f.audio.length > 1 && <span>{f.audio.length} áudios</span>}
                          </span>
                        </span>
                      </button>
                      {f.needsPrep && f.prep?.state !== 'ready' && (
                        <div className="mt-1 pl-3">
                          <PrepLine film={f} onPrepare={() => onPrepare(f.id)} />
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- corrigir os dados ----------

interface SearchHit {
  tmdbId: number;
  kind: 'movie' | 'tv';
  title: string;
  year?: number;
  overview?: string;
  poster: string | null;
}

function EditPanel({ entry, lib, channelId, onClose, onSaved }: { entry: Entry; lib: LibraryData; channelId: string; onClose: () => void; onSaved: () => void }) {
  const film = entry.files[0];
  const [tab, setTab] = useState<'search' | 'own'>(lib.tmdb ? 'search' : 'own');
  const [q, setQ] = useState(entry.title);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [year, setYear] = useState(entry.year ? String(entry.year) : '');
  const [overview, setOverview] = useState(entry.overview ?? '');
  const fileInput = useRef<HTMLInputElement>(null);
  const base = `/channels/${channelId}/cinema/films/${film.id}`;

  async function search() {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setHits((await api.get<{ results: SearchHit[] }>(`/channels/${channelId}/cinema/search?q=${encodeURIComponent(q.trim())}`)).results);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  // abre já buscando pelo título atual
  useEffect(() => {
    if (lib.tmdb) void search();
  }, []);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-surface-1 shadow-2xl ring-1 ring-line">
        <div className="flex items-center gap-2 px-5 pt-4">
          <h3 className="flex-1 truncate font-display text-lg font-bold">Editar “{entry.title}”</h3>
          <button onClick={onClose} aria-label="Fechar" className="flex h-9 w-9 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg">
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-1 px-5 pt-2">
          {(
            [
              ['search', 'Buscar no TMDB'],
              ['own', 'Dados próprios'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} className={cx('h-9 rounded-full px-4 text-sm font-semibold', tab === id ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}>
              {label}
            </button>
          ))}
        </div>
        {entry.type === 'series' && <p className="px-5 pt-2 text-xs text-fg-muted">Numa série, a escolha vale para todos os episódios dela.</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === 'search' ? (
            lib.tmdb ? (
              <>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void search();
                  }}
                  className="flex gap-2"
                >
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome do filme ou série" className="h-10 flex-1 rounded-xl bg-surface-0 px-3 text-sm ring-1 ring-line outline-none focus:ring-accent" />
                  <button type="submit" className="flex h-10 items-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-semibold text-white">
                    <Search size={15} /> Buscar
                  </button>
                </form>
                {busy && !hits && (
                  <div className="flex justify-center py-8">
                    <Spinner />
                  </div>
                )}
                {hits && !hits.length && <p className="py-8 text-center text-sm text-fg-muted">Nada encontrado. Tente o nome original ou em inglês.</p>}
                <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
                  {hits?.map((h) => (
                    <button
                      key={`${h.kind}${h.tmdbId}`}
                      disabled={busy}
                      onClick={() => void run(() => api.put(`${base}/meta`, { kind: h.kind, tmdbId: h.tmdbId }), `Agora é “${h.title}”`)}
                      className="group text-left disabled:opacity-50"
                      title={h.overview}
                    >
                      <div className="aspect-[2/3] overflow-hidden rounded-xl bg-surface-3 ring-1 ring-white/5 group-hover:ring-2 group-hover:ring-accent">
                        {h.poster ? <img src={h.poster} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Film size={24} className="m-auto mt-16 text-fg-subtle" />}
                      </div>
                      <div className="mt-1.5 line-clamp-2 text-xs font-semibold">{h.title}</div>
                      <div className="text-[11px] text-fg-muted">
                        {[h.kind === 'tv' ? 'Série' : 'Filme', h.year].filter(Boolean).join(' · ')}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-fg-muted">
                Falta a chave do TMDB no servidor. Coloque <b>TMDB_API_KEY</b> no arquivo .env e reinicie o Concord.
              </p>
            )
          ) : (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-bold tracking-wide text-fg-muted uppercase">Título</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="h-10 w-full rounded-xl bg-surface-0 px-3 text-sm ring-1 ring-line outline-none focus:ring-accent" />
              </label>
              <label className="block w-32">
                <span className="mb-1 block text-xs font-bold tracking-wide text-fg-muted uppercase">Ano</span>
                <input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" className="h-10 w-full rounded-xl bg-surface-0 px-3 text-sm ring-1 ring-line outline-none focus:ring-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold tracking-wide text-fg-muted uppercase">Sinopse</span>
                <textarea value={overview} onChange={(e) => setOverview(e.target.value)} maxLength={2000} rows={4} className="w-full resize-none rounded-xl bg-surface-0 px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-accent" />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={busy || !title.trim()}
                  onClick={() => void run(() => api.put(`${base}/meta`, { title: title.trim(), year: year ? Number(year) : null, overview }), 'Dados salvos')}
                  className="h-10 rounded-xl bg-accent px-5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Salvar
                </button>
                <button disabled={busy} onClick={() => fileInput.current?.click()} className="flex h-10 items-center gap-1.5 rounded-xl bg-surface-3 px-4 text-sm font-semibold hover:bg-surface-2">
                  <ImageUp size={15} /> Trocar a capa
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    void run(async () => {
                      const res = await fetch(`/api${base}/poster`, { method: 'POST', headers: { authorization: `Bearer ${getToken() ?? ''}` }, body: file });
                      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Não deu para enviar a capa');
                    }, 'Capa trocada');
                  }}
                />
              </div>
              <p className="text-xs text-fg-subtle">Bom para vídeos que não são filmes (gravações, episódios avulsos). A capa fica melhor em pé, 2:3.</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <span className="text-xs text-fg-subtle">{film.file}</span>
          <button disabled={busy} onClick={() => void run(() => api.del(base + '/meta'), 'Voltou ao automático')} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-fg-muted hover:bg-surface-3 hover:text-fg">
            <RotateCcw size={14} /> Voltar ao automático
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- biblioteca ----------

export function CinemaLibrary({
  lib,
  channelId,
  loading,
  viewers,
  onRefresh,
  onPlay,
  onPrepare,
}: {
  lib: LibraryData;
  channelId: string;
  loading: boolean;
  viewers: ReactNode;
  onRefresh: (force: boolean) => void;
  onPlay: (fileId: string) => void;
  onPrepare: (fileId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => groupEntries(lib.films), [lib.films]);
  const entry = open ? entries.find((e) => e.key === open) : undefined;
  // a chave do card muda quando os dados chegam (arquivo vira "série X"): segue o arquivo
  const openFile = useRef<string | null>(null);
  useEffect(() => {
    if (open && !entry && openFile.current) {
      const again = entries.find((e) => e.files.some((f) => f.id === openFile.current));
      if (again) setOpen(again.key);
    }
  }, [entries, entry, open]);
  useEffect(() => {
    // em navegadores novos o scrollTo devolve uma Promise: não pode virar o "retorno" do efeito
    void scroller.current?.scrollTo({ top: 0 });
  }, [open]);

  const shown = filter.trim() ? entries.filter((e) => norm(`${e.title} ${e.files.map((f) => f.name).join(' ')}`).includes(norm(filter))) : entries;
  const movies = shown.filter((e) => e.type === 'movie').sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  const series = shown.filter((e) => e.type === 'series').sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  const videos = shown.filter((e) => e.type === 'video').sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  const recent = !filter && entries.length > 6 ? [...entries].sort((a, b) => b.addedAt - a.addedAt).slice(0, 8) : [];
  const pending = lib.films.some((f) => !f.meta);
  const openEntry = (e: Entry) => {
    openFile.current = e.files[0]?.id ?? null;
    setOpen(e.key);
  };

  return (
    <div ref={scroller} className="relative h-full overflow-y-auto">
      {entry ? (
        <Detail entry={entry} lib={lib} onBack={() => setOpen(null)} onPlay={onPlay} onPrepare={onPrepare} onEdit={() => setEditing(true)} />
      ) : (
        <div className="px-6 pt-5 pb-6">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/15 text-accent">
              <Clapperboard size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-lg font-bold">Escolha o que assistir</h2>
              <p className="text-sm text-fg-muted">{pending && lib.tmdb ? 'Buscando capas e detalhes…' : 'Todo mundo na sala assiste junto, no mesmo segundo.'}</p>
            </div>
            {viewers}
            {entries.length > 8 && (
              <label className="flex h-10 items-center gap-2 rounded-full bg-surface-2 px-3 text-sm">
                <Search size={15} className="text-fg-muted" />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Procurar" className="w-32 bg-transparent outline-none" />
              </label>
            )}
            <button onClick={() => onRefresh(true)} title="Procurar arquivos novos na pasta" aria-label="Atualizar a lista de filmes" className="flex h-10 w-10 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg">
              <RefreshCw size={18} className={cx(loading && 'animate-spin')} />
            </button>
          </div>

          {!lib.films.length ? (
            <div className="mx-auto mt-10 max-w-md rounded-3xl bg-surface-2 p-6 text-center">
              <Film size={36} className="mx-auto text-fg-subtle" />
              <p className="mt-3 font-semibold">{lib.configured ? 'Nenhum filme na pasta ainda' : 'A pasta de filmes não está configurada'}</p>
              <p className="mt-1.5 text-sm text-fg-muted">
                {lib.configured ? (
                  <>
                    Coloque arquivos <b>.mp4</b> ou <b>.mkv</b> na pasta <b>videos</b>, ao lado do docker-compose (pode usar subpastas), e clique em atualizar.
                  </>
                ) : (
                  <>Quem hospeda o servidor precisa definir CINEMA_DIR (no Docker, a pasta videos já vem ligada).</>
                )}
              </p>
            </div>
          ) : (
            <>
              {recent.length > 0 && (
                <Section title="Adicionados recentemente" icon={<Wand2 size={16} className="text-accent" />}>
                  <div className="flex gap-4 overflow-x-auto pb-2">
                    {recent.map((e) => (
                      <div key={e.key} className="w-[138px] shrink-0">
                        <Card entry={e} onOpen={() => openEntry(e)} />
                      </div>
                    ))}
                  </div>
                </Section>
              )}
              {movies.length > 0 && (
                <Section title="Filmes" icon={<Film size={16} className="text-accent" />}>
                  <div className={GRID}>
                    {movies.map((e) => (
                      <Card key={e.key} entry={e} onOpen={() => openEntry(e)} />
                    ))}
                  </div>
                </Section>
              )}
              {series.length > 0 && (
                <Section title="Séries" icon={<Tv size={16} className="text-accent" />}>
                  <div className={GRID}>
                    {series.map((e) => (
                      <Card key={e.key} entry={e} onOpen={() => openEntry(e)} />
                    ))}
                  </div>
                </Section>
              )}
              {videos.length > 0 && (
                <Section title={movies.length || series.length ? 'Outros vídeos' : 'Vídeos'} icon={<Clapperboard size={16} className="text-accent" />}>
                  <div className={GRID}>
                    {videos.map((e) => (
                      <Card key={e.key} entry={e} onOpen={() => openEntry(e)} />
                    ))}
                  </div>
                </Section>
              )}
              {!shown.length && <p className="py-10 text-center text-sm text-fg-muted">Nada com esse nome.</p>}
              {lib.tmdb && (
                <p className="mt-2 text-center text-[11px] text-fg-subtle">Capas e detalhes: TMDB (The Movie Database). Este app usa a API do TMDB, mas não é endossado nem certificado por ele.</p>
              )}
            </>
          )}
        </div>
      )}
      {editing && entry && <EditPanel entry={entry} lib={lib} channelId={channelId} onClose={() => setEditing(false)} onSaved={() => onRefresh(false)} />}
    </div>
  );
}
