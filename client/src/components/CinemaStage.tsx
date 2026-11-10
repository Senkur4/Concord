import { Clapperboard, Film, FolderOpen, HardDrive, ListVideo, RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { memberName, type Channel, type ServerDetail } from '../lib/types';
import { useApp } from '../store/app';
import { toast } from '../store/toast';
import { AvatarStack, Spinner, cx } from './ui';
import { VideoPlayer, type PlayerSync } from './VideoPlayer';

/**
 * Tela da sala de cinema. Ninguém transmite: cada um toca o arquivo (do servidor ou do próprio PC) e o servidor só
 * diz "qual filme, tocando ou pausado, em qual segundo". Este componente mantém o <video> de cada um no mesmo ponto:
 * pulos grandes viram um pulo, diferenças pequenas são corrigidas acelerando ou freando o vídeo de leve (até 5%).
 */

interface FilmInfo {
  id: string;
  name: string;
  file: string;
  size: number;
  ext: string;
}

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
    socket.on('cinema:state', onState);
    socket.on('connect', watch);
    if (socket.connected) watch();
    return () => {
      socket.off('cinema:state', onState);
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

  // ---------- o <video> ----------
  const attach = useCallback(
    (el: HTMLVideoElement | null) => {
      video.current = el;
      if (!el) return;
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
    [apply, channel.id],
  );

  const sync: PlayerSync = useMemo(
    () => ({
      attach,
      request: (action, t) => emit('cinema:control', { action, t }),
      banner: undefined,
    }),
    [attach, channel.id],
  );

  const film = lib?.films.find((f) => f.id === fileId);
  const src = local ? local.url : fileId && lib ? `/api/cinema/file/${fileId}?k=${encodeURIComponent(lib.key)}` : '';
  const waitingNames = (state?.waiting ?? []).map(nameOf);
  const viewers = (state?.viewers ?? []).map((id) => detail.members.find((m) => m.id === id)).filter((m) => !!m);

  const banner = waitingNames.length ? (
    <span className="flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur">
      <Spinner size={14} /> Esperando {waitingNames.join(', ')} carregar…
    </span>
  ) : notice ? (
    <span className="rounded-full bg-black/75 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur">{notice}</span>
  ) : undefined;

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
                      <span className="rounded-md bg-surface-0 px-1.5 py-0.5 text-[10px] font-bold text-fg-muted uppercase">{f.ext}</span>
                    </button>
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
        {broken ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-white/80">
            <TriangleAlert size={32} className="text-amber-300" />
            <p className="font-semibold">Este arquivo não toca aqui</p>
            <p className="max-w-md text-sm text-white/60">
              O formato do vídeo ou do áudio não é suportado pelo navegador (comum em .mkv com áudio AC3/DTS). Por enquanto, use uma versão .mp4 (vídeo H.264 e áudio AAC). A conversão automática vem na próxima etapa.
            </p>
          </div>
        ) : (
          <VideoPlayer
            key={src}
            src={src}
            name={state.name || 'Filme'}
            sync={{ ...sync, banner }}
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
