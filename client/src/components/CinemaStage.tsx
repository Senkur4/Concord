import { AudioLines, Clapperboard, Film, FolderOpen, HardDrive, ListVideo, RefreshCw, Server, TriangleAlert, Wand2 } from 'lucide-react';
import type Hls from 'hls.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { memberName, type Channel, type ServerDetail } from '../lib/types';
import { useApp } from '../store/app';
import { toast } from '../store/toast';
import { AvatarStack, Spinner, cx } from './ui';
import { MenuOption, VideoPlayer, type PlayerSync } from './VideoPlayer';

/**
 * Tela da sala de cinema. Ninguém transmite: cada um toca o arquivo (do servidor ou do próprio PC) e o servidor só
 * diz "qual filme, tocando ou pausado, em qual segundo". Este componente mantém o <video> de cada um no mesmo ponto:
 * pulos grandes viram um pulo, diferenças pequenas são corrigidas acelerando ou freando o vídeo de leve (até 5%).
 */

interface PrepInfo {
  state: 'queued' | 'running' | 'ready' | 'failed';
  progress: number;
  error?: string;
}

interface FilmInfo {
  id: string;
  name: string;
  file: string;
  size: number;
  ext: string;
  duration: number;
  /** faixas de áudio do arquivo */
  audio: { label: string; codec: string }[];
  /** mais de uma faixa (ou áudio que o navegador não toca): toca a versão preparada, com troca de áudio */
  needsPrep: boolean;
  prep: PrepInfo | null;
}

/** a faixa de áudio que a pessoa escolheu por último (por idioma/nome): vale para os próximos filmes */
const AUDIO_PREF_KEY = 'concord.cinemaAudio';
const readAudioPref = () => {
  try {
    return localStorage.getItem(AUDIO_PREF_KEY) ?? '';
  } catch {
    return '';
  }
};

interface CinemaState {
  channelId: string;
  fileId: string | null;
  name: string;
  duration: number;
  playing: boolean;
  position: number;
  at: number;
  by: string | null;
  action: string;
  waiting: string[];
  viewers: string[];
  now: number;
}

const fmtSize = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const fmtTime = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const ACTION_TEXT: Record<string, string> = { play: 'deu play', pause: 'pausou', seek: 'pulou para', load: 'escolheu o filme', resume: '' };

/** Quantos segundos já carregados na frente do ponto atual. */
function bufferedAhead(v: HTMLVideoElement) {
  for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) >= v.currentTime) return v.buffered.end(i) - v.currentTime;
  return 0;
}

export function CinemaStage({ channel, detail }: { channel: Channel; detail: ServerDetail }) {
  const meId = useApp((s) => s.me?.id);
  const [lib, setLib] = useState<{ configured: boolean; films: FilmInfo[]; key: string } | null>(null);
  const [loadingLib, setLoadingLib] = useState(false);
  const [state, setState] = useState<CinemaState | null>(null);
  const [local, setLocal] = useState<{ fileId: string; url: string; name: string; size: number } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [broken, setBroken] = useState(false);
  const [durationWarn, setDurationWarn] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tracks, setTracks] = useState<{ id: number; name: string; lang: string }[]>([]);
  const [track, setTrack] = useState(-1);
  const hls = useRef<Hls | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const stateRef = useRef<CinemaState | null>(null);
  const offset = useRef(0); // relógio do servidor - relógio daqui
  const reported = useRef(false); // avisei a sala que travei carregando
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localInput = useRef<HTMLInputElement>(null);
  const localRef = useRef(local);
  localRef.current = local;

  const nameOf = useCallback((id: string) => {
    const m = detail.members.find((x) => x.id === id);
    return m ? memberName(m) : 'Alguém';
  }, [detail.members]);

  const loadLibrary = useCallback(
    async (refresh = false) => {
      setLoadingLib(true);
      try {
        const res = await api.get<{ configured: boolean; films: FilmInfo[]; key: string; state: CinemaState }>(`/channels/${channel.id}/cinema${refresh ? '?refresh=1' : ''}`);
        setLib(res);
      } catch (err) {
        toast.error(err);
      } finally {
        setLoadingLib(false);
      }
    },
    [channel.id],
  );
  useEffect(() => void loadLibrary(), [loadLibrary]);

  // ---------- estado da sala pelo socket ----------
  const target = (st: CinemaState) => (st.playing ? st.position + (Date.now() + offset.current - st.at) / 1000 : st.position);

  const apply = useCallback((force: boolean) => {
    const v = video.current;
    const st = stateRef.current;
    if (!v || !st?.fileId || v.readyState < 1) return;
    const t = Math.min(target(st), v.duration || Infinity);
    if (Math.abs(v.currentTime - t) > (force ? 0.35 : 1)) v.currentTime = t;
    if (st.playing && v.paused) {
      v.play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    } else if (!st.playing && !v.paused) {
      v.pause();
    }
    if (!st.playing) v.playbackRate = 1;
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onState = (st: CinemaState) => {
      if (st.channelId !== channel.id) return;
      const prev = stateRef.current;
      stateRef.current = st;
      setState(st);
      // recado curto de quem mexeu (não para as próprias ações)
      if (st.by && st.by !== meId && prev && (st.at !== prev.at || st.fileId !== prev.fileId) && ACTION_TEXT[st.action]) {
        setNotice(`${nameOf(st.by)} ${ACTION_TEXT[st.action]}${st.action === 'seek' ? ` ${fmtTime(st.position)}` : ''}`);
      }
      apply(true);
    };
    // acerta o relógio com o do servidor: das 5 medidas, vale a de resposta mais rápida
    const syncClock = async () => {
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const sent = Date.now();
        const serverNow = await new Promise<number>((resolve) => socket.timeout(3000).emit('cinema:time', (err: unknown, now: number) => resolve(err ? NaN : now)));
        const rtt = Date.now() - sent;
        if (Number.isFinite(serverNow) && rtt < best) {
          best = rtt;
          offset.current = serverNow + rtt / 2 - Date.now();
        }
      }
      apply(true);
    };
    const watch = () => {
      socket.emit('cinema:watch', { channelId: channel.id }, (st: CinemaState | { error: string }) => {
        if ('error' in st) return toast.error(st.error);
        onState(st);
      });
      void syncClock();
    };
    const onPrep = (p: PrepInfo & { fileId: string }) => {
      setLib((cur) => cur && { ...cur, films: cur.films.map((f) => (f.id === p.fileId ? { ...f, prep: { state: p.state, progress: p.progress, error: p.error } } : f)) });
    };
    socket.on('cinema:state', onState);
    socket.on('cinema:prep', onPrep);
    socket.on('connect', watch);
    if (socket.connected) watch();
    return () => {
      socket.off('cinema:state', onState);
      socket.off('cinema:prep', onPrep);
      socket.off('connect', watch);
      socket.emit('cinema:unwatch', { channelId: channel.id });
    };
  }, [channel.id, apply, meId, nameOf]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(t);
  }, [notice]);

  // correção contínua: pulo se passou de 1 s, senão acelera/freia de leve até alinhar
  useEffect(() => {
    const id = setInterval(() => {
      const v = video.current;
      const st = stateRef.current;
      if (!v || !st?.fileId || v.readyState < 2 || v.seeking) return;
      if (st.playing !== !v.paused) return apply(false);
      if (!st.playing) return;
      const drift = v.currentTime - target(st);
      if (Math.abs(drift) > 1) v.currentTime = target(st);
      else if (Math.abs(drift) > 0.06) v.playbackRate = 1 - Math.max(-0.05, Math.min(0.05, drift * 0.5));
      else v.playbackRate = 1;
    }, 500);
    return () => clearInterval(id);
  }, [apply]);

  // trocou de filme: o arquivo local era do anterior
  const fileId = state?.fileId ?? null;
  useEffect(() => {
    setBroken(false);
    setDurationWarn(null);
    reported.current = false;
    if (localRef.current && localRef.current.fileId !== fileId) {
      URL.revokeObjectURL(localRef.current.url);
      setLocal(null);
    }
  }, [fileId]);
  useEffect(() => () => void (localRef.current && URL.revokeObjectURL(localRef.current.url)), []);

  const emit = (event: string, payload: Record<string, unknown>) => getSocket()?.emit(event, { channelId: channel.id, ...payload });
  const setBuffering = (buffering: boolean) => {
    if (reported.current === buffering) return;
    reported.current = buffering;
    emit('cinema:buffering', { buffering });
  };

  const film = lib?.films.find((f) => f.id === fileId);
  const prepared = !local && !!film?.needsPrep && film.prep?.state === 'ready';
  const hlsUrl = prepared && lib ? `/api/cinema/hls/${encodeURIComponent(lib.key)}/${fileId}/master.m3u8` : '';
  const src = local ? local.url : hlsUrl ? '' : fileId && lib ? `/api/cinema/file/${fileId}?k=${encodeURIComponent(lib.key)}` : '';
  const playerKey = local ? local.url : hlsUrl || src;

  // ---------- o <video> ----------
  const attach = useCallback(
    (el: HTMLVideoElement | null) => {
      video.current = el;
      if (!el) {
        hls.current?.destroy();
        hls.current = null;
        setTracks([]);
        setTrack(-1);
        return;
      }
      if (hlsUrl) {
        // versão preparada: o hls.js toca os pedaços e troca a faixa de áudio sem parar o vídeo
        void import('hls.js').then(({ default: HlsJs }) => {
          if (video.current !== el) return;
          if (!HlsJs.isSupported()) return setBroken(true);
          const h = new HlsJs({ maxBufferLength: 60, maxMaxBufferLength: 240, backBufferLength: 60 });
          hls.current = h;
          const syncTracks = () => {
            setTracks(h.audioTracks.map((t) => ({ id: t.id, name: t.name, lang: t.lang ?? '' })));
            setTrack(h.audioTrack);
          };
          h.on(HlsJs.Events.AUDIO_TRACKS_UPDATED, () => {
            syncTracks();
            // volta para a faixa que a pessoa escolheu da última vez (mesmo nome ou mesmo idioma)
            const pref = readAudioPref();
            const i = pref ? h.audioTracks.findIndex((t) => t.name === pref || (t.lang && t.lang === pref)) : -1;
            if (i >= 0 && i !== h.audioTrack) h.audioTrack = i;
          });
          h.on(HlsJs.Events.AUDIO_TRACK_SWITCHED, syncTracks);
          h.on(HlsJs.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            if (data.type === HlsJs.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
            else if (data.type === HlsJs.ErrorTypes.NETWORK_ERROR) h.startLoad();
            else setBroken(true);
          });
          h.loadSource(hlsUrl);
          h.attachMedia(el);
        });
      }
      const onMeta = () => {
        const st = stateRef.current;
        if (st?.fileId && !localRef.current) emit('cinema:duration', { fileId: st.fileId, duration: el.duration });
        if (localRef.current && st?.duration && Math.abs(el.duration - st.duration) > 2) {
          setDurationWarn(`Seu arquivo tem ${fmtTime(el.duration)} e o da sala tem ${fmtTime(st.duration)}: as versões são diferentes e a sincronia pode não bater.`);
        } else setDurationWarn(null);
        apply(true);
      };
      const onWaiting = () => {
        if (waitTimer.current) clearTimeout(waitTimer.current);
        // só avisa a sala se travou de verdade (mais de 1,5 s), não num soluço
        waitTimer.current = setTimeout(() => {
          if (stateRef.current?.playing && el.readyState < 3) setBuffering(true);
        }, 1500);
      };
      const onReady = () => {
        if (waitTimer.current) clearTimeout(waitTimer.current);
        if (reported.current && (el.readyState === 4 || bufferedAhead(el) >= 4)) setBuffering(false);
      };
      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('waiting', onWaiting);
      for (const ev of ['playing', 'canplay', 'canplaythrough', 'progress']) el.addEventListener(ev, onReady);
      if (el.readyState >= 1) onMeta();
    },
    [apply, channel.id, hlsUrl],
  );

  function pickTrack(i: number) {
    const h = hls.current;
    if (!h) return;
    h.audioTrack = i;
    const t = h.audioTracks[i];
    try {
      localStorage.setItem(AUDIO_PREF_KEY, t?.lang || t?.name || '');
    } catch {
      // sem armazenamento
    }
  }

  const sync: PlayerSync = useMemo(
    () => ({
      attach,
      request: (action, t) => emit('cinema:control', { action, t }),
      banner: undefined,
    }),
    [attach, channel.id],
  );

  // a faixa de áudio é de cada um: não muda a dos outros
  const menuRows =
    tracks.length > 1
      ? (close: () => void) => (
          <div className="mb-1 border-b border-white/10 pb-1">
            <span className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-xs font-semibold text-white/60">
              <AudioLines size={13} /> Faixa de áudio
            </span>
            {tracks.map((t, i) => (
              <MenuOption
                key={t.id}
                selected={track === i}
                onClick={() => {
                  pickTrack(i);
                  close();
                }}
              >
                <span className="truncate">{t.name}</span>
              </MenuOption>
            ))}
          </div>
        )
      : undefined;
  const waitingNames = (state?.waiting ?? []).map(nameOf);
  const viewers = (state?.viewers ?? []).map((id) => detail.members.find((m) => m.id === id)).filter((m) => !!m);

  const banner = waitingNames.length ? (
    <span className="flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur">
      <Spinner size={14} /> Esperando {waitingNames.join(', ')} carregar…
    </span>
  ) : notice ? (
    <span className="rounded-full bg-black/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur">{notice}</span>
  ) : undefined;

  // filme que precisa de preparo e ninguém pediu ainda (ex.: o servidor reiniciou): pede agora
  const needsStart = !!film?.needsPrep && !film.prep && !local;
  useEffect(() => {
    if (needsStart && fileId) void prepare(fileId);
  }, [needsStart, fileId]);

  async function prepare(filmId: string) {
    try {
      const { prep } = await api.post<{ prep: PrepInfo | null }>(`/channels/${channel.id}/cinema/films/${filmId}/prepare`);
      setLib((cur) => cur && { ...cur, films: cur.films.map((f) => (f.id === filmId ? { ...f, prep } : f)) });
    } catch (err) {
      toast.error(err);
    }
  }

  function chooseLocal(file: File | undefined) {
    if (!file || !fileId) return;
    if (localRef.current) URL.revokeObjectURL(localRef.current.url);
    setBroken(false);
    setLocal({ fileId, url: URL.createObjectURL(file), name: file.name, size: file.size });
    // a cópia do servidor estava carregando: quem trocou não segura mais a sala
    setBuffering(false);
  }

  if (!state || !lib) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <Spinner size={36} />
      </div>
    );
  }

  // ---------- biblioteca (nenhum filme escolhido) ----------
  if (!fileId) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 px-6 pt-5 pb-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/15 text-accent">
            <Clapperboard size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-bold">Escolha um filme</h2>
            <p className="text-sm text-fg-muted">Todo mundo na sala assiste junto, no mesmo segundo.</p>
          </div>
          {viewers.length > 0 && <AvatarStack people={viewers.map((m) => ({ id: m.id, name: memberName(m), color: m.avatarColor, src: m.avatarUrl }))} max={6} size={28} />}
          <button
            onClick={() => void loadLibrary(true)}
            title="Procurar filmes novos na pasta"
            aria-label="Atualizar a lista de filmes"
            className="flex h-10 w-10 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            <RefreshCw size={18} className={cx(loadingLib && 'animate-spin')} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
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
            <ul className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
              {lib.films.map((f) => {
                const folder = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : '';
                return (
                  <li key={f.id}>
                    <button
                      onClick={() => emit('cinema:control', { action: 'load', fileId: f.id })}
                      className="group flex w-full items-center gap-3 rounded-2xl bg-surface-2 p-3 text-left transition-colors hover:bg-surface-3"
                    >
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-black/30 text-fg-muted transition-colors group-hover:bg-accent group-hover:text-white">
                        <Film size={20} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{f.name}</span>
                        <span className="block truncate text-xs text-fg-muted">
                          {folder && `${folder} · `}
                          {fmtSize(f.size)}
                        </span>
                      </span>
                      {f.audio.length > 1 && (
                        <span title={f.audio.map((a) => a.label).join(' · ')} className="flex items-center gap-1 rounded-md bg-surface-0 px-1.5 py-0.5 text-[10px] font-bold text-fg-muted">
                          <AudioLines size={11} /> {f.audio.length} áudios
                        </span>
                      )}
                      <span className="rounded-md bg-surface-0 px-1.5 py-0.5 text-[10px] font-bold text-fg-muted uppercase">{f.ext}</span>
                    </button>
                    {f.needsPrep && <PrepLine film={f} onPrepare={() => void prepare(f.id)} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }

  // ---------- filme escolhido ----------
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <Clapperboard size={18} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display font-bold">{state.name || film?.name}</div>
          <div className="flex items-center gap-1 text-xs text-fg-muted">
            {local ? (
              <>
                <HardDrive size={12} /> Tocando do seu PC: {local.name}
              </>
            ) : (
              <>
                <Server size={12} /> Tocando do servidor, na qualidade original{film ? ` · ${fmtSize(film.size)}` : ''}
                {prepared && tracks.length > 1 && ` · ${tracks.length} faixas de áudio (troque na engrenagem)`}
              </>
            )}
          </div>
        </div>
        {viewers.length > 0 && (
          <span title={viewers.map((m) => memberName(m)).join(', ')}>
            <AvatarStack people={viewers.map((m) => ({ id: m.id, name: memberName(m), color: m.avatarColor, src: m.avatarUrl }))} max={6} size={26} />
          </span>
        )}
        {local ? (
          <button
            onClick={() => {
              URL.revokeObjectURL(local.url);
              setLocal(null);
              setDurationWarn(null);
            }}
            className="flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-sm font-semibold hover:bg-surface-3"
          >
            <Server size={15} /> Voltar ao do servidor
          </button>
        ) : (
          <button
            onClick={() => localInput.current?.click()}
            title="Se você tem o mesmo filme no PC, toca dele: qualidade máxima sem usar a internet"
            className="flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-sm font-semibold hover:bg-surface-3"
          >
            <FolderOpen size={15} /> Usar arquivo do meu PC
          </button>
        )}
        <button onClick={() => emit('cinema:control', { action: 'stop' })} className="flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-sm font-semibold hover:bg-surface-3">
          <ListVideo size={15} /> Trocar filme
        </button>
        <input
          ref={localInput}
          type="file"
          accept="video/*,.mkv"
          className="hidden"
          onChange={(e) => {
            chooseLocal(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {durationWarn && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-2xl bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {durationWarn}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-black">
        {!local && film?.needsPrep && film.prep?.state !== 'ready' ? (
          <PrepScreen film={film} onRetry={() => void prepare(film.id)} onLocal={() => localInput.current?.click()} />
        ) : broken ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-white/80">
            <TriangleAlert size={32} className="text-amber-300" />
            <p className="font-semibold">Este arquivo não toca aqui</p>
            <p className="max-w-md text-sm text-white/60">
              O formato do vídeo ou do áudio não é suportado pelo navegador (comum em .mkv com áudio AC3/DTS). Por enquanto, use uma versão .mp4 (vídeo H.264 e áudio AAC). A conversão automática vem na próxima etapa.
            </p>
          </div>
        ) : (
          <VideoPlayer
            key={playerKey}
            src={src}
            name={state.name || 'Filme'}
            sync={{ ...sync, banner, menuRows }}
            onNoVideo={() => {}}
            onBroken={() => setBroken(true)}
          />
        )}
        {blocked && !broken && (
          <button
            onClick={() => {
              setBlocked(false);
              apply(true);
            }}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 text-white"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent text-white">
              <Clapperboard size={28} />
            </span>
            <span className="font-semibold">O filme já está passando. Clique para entrar na sessão.</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Linha embaixo do filme na biblioteca: preparar a troca de áudio antes da sessão. */
function PrepLine({ film, onPrepare }: { film: FilmInfo; onPrepare: () => void }) {
  const p = film.prep;
  if (p?.state === 'ready') return null;
  return (
    <div className="mt-1 flex items-center gap-2 px-3 text-xs text-fg-muted">
      {p?.state === 'running' || p?.state === 'queued' ? (
        <>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
            <span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.round(p.progress * 100)}%` }} />
          </span>
          {p.state === 'queued' ? 'Na fila' : `Preparando ${Math.round(p.progress * 100)}%`}
        </>
      ) : (
        <button onClick={onPrepare} className="flex items-center gap-1 font-semibold text-accent hover:underline">
          <Wand2 size={12} /> {p?.state === 'failed' ? 'Tentar preparar de novo' : 'Preparar agora (troca de áudio)'}
        </button>
      )}
    </div>
  );
}

/** Enquanto o servidor prepara o filme escolhido. */
function PrepScreen({ film, onRetry, onLocal }: { film: FilmInfo; onRetry: () => void; onLocal: () => void }) {
  const p = film.prep;
  const failed = p?.state === 'failed';
  const pct = Math.round((p?.progress ?? 0) * 100);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-white/85">
      {failed ? <TriangleAlert size={32} className="text-amber-300" /> : <Wand2 size={32} className="text-accent" />}
      <p className="font-display text-lg font-bold">{failed ? 'Não deu para preparar este filme' : 'Preparando o filme…'}</p>
      <p className="max-w-md text-sm text-white/60">
        {failed
          ? p?.error
          : `Ele tem ${film.audio.length > 1 ? `${film.audio.length} faixas de áudio` : 'um áudio que o navegador não toca'}. O servidor está separando as faixas para cada um escolher a sua; o vídeo é copiado sem perder nada. Isso só acontece uma vez por filme.`}
      </p>
      {!failed && (
        <div className="w-64">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
            <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="mt-1.5 block text-xs text-white/50 tabular-nums">{p?.state === 'queued' ? 'Na fila…' : `${pct}%`}</span>
        </div>
      )}
      <div className="flex gap-2">
        {failed && (
          <button onClick={onRetry} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20">
            Tentar de novo
          </button>
        )}
        <button onClick={onLocal} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20">
          Usar arquivo do meu PC
        </button>
      </div>
    </div>
  );
}
