import { Captions, Check, ChevronLeft, ChevronRight, Maximize, Minimize, Pause, Play, Settings, Upload, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { cx } from './ui';

/**
 * Player de vídeo dos anexos: barra de tempo, volume, tela cheia, velocidade e legendas .srt importadas pela
 * pessoa (com fonte, tamanho, cor, fundo e sincronia ajustáveis). As legendas são desenhadas pelo próprio player
 * (não pelo navegador), por isso dá para estilizar tudo e elas também aparecem em tela cheia.
 *
 * Atalhos (com o player em foco): espaço/K tocar e pausar, ←/→ 5 s, ↑/↓ volume, F tela cheia, M mudo, C legenda.
 */

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const FONTS = [
  { id: 'sans', label: 'Padrão', css: 'Inter, system-ui, sans-serif' },
  { id: 'round', label: 'Arredondada', css: 'Outfit, Inter, sans-serif' },
  { id: 'serif', label: 'Serifada', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Máquina de escrever', css: '"Courier New", ui-monospace, monospace' },
  { id: 'impact', label: 'Grossa', css: 'Impact, "Arial Black", sans-serif' },
];
const SIZES = [
  { id: 's', label: 'P', scale: 0.75 },
  { id: 'm', label: 'M', scale: 1 },
  { id: 'l', label: 'G', scale: 1.3 },
  { id: 'xl', label: 'GG', scale: 1.65 },
];
const COLORS = ['#ffffff', '#ffe14d', '#7df9ff', '#9dff8a', '#ff9de2', '#ff8f70'];
const BACKGROUNDS = [
  { id: 'outline', label: 'Contorno' },
  { id: 'box', label: 'Caixa escura' },
  { id: 'none', label: 'Sem fundo' },
];

interface SubStyle {
  font: string;
  size: string;
  color: string;
  bg: string;
}
const STYLE_KEY = 'concord_sub_style';
const DEFAULT_STYLE: SubStyle = { font: 'sans', size: 'm', color: '#ffffff', bg: 'outline' };

function loadStyle(): SubStyle {
  try {
    return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem(STYLE_KEY) ?? '{}') };
  } catch {
    return DEFAULT_STYLE;
  }
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Lê .srt (e .vtt): "00:01:02,500 --> 00:01:04,000" + texto. Tags simples (<i>, {\an8}...) são removidas. */
export function parseSubtitles(raw: string): Cue[] {
  const time = (t: string) => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(t.trim());
    if (!m) return NaN;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  };
  const cues: Cue[] = [];
  for (const block of raw.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = time(a);
    const end = time(b);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const text = lines
      .slice(at + 1)
      .join('\n')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<\/?[^>]+>/g, '')
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Legendas brasileiras antigas costumam vir em Windows-1252, não UTF-8: tenta os dois. */
async function readSubtitleFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1252').decode(buf);
}

const fmt = (t: number) => {
  if (!Number.isFinite(t)) return '0:00';
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/**
 * Modo sincronizado (sala de cinema): o player não toca, pausa nem pula sozinho. Ele pede para a sala, e quem manda
 * no <video> é o controlador da sala (que recebe o elemento por `attach`). O resto (volume, legenda, tela cheia) é
 * de cada um.
 */
export interface PlayerSync {
  request: (action: 'play' | 'pause' | 'seek', t: number) => void;
  attach: (el: HTMLVideoElement | null) => void;
  /** linhas a mais no menu de configurações */
  menuRows?: (close: () => void) => ReactNode;
  /** recado em cima do vídeo (ex.: esperando alguém carregar) */
  banner?: ReactNode;
}

export function VideoPlayer({ src, name, onNoVideo, onBroken, footer, sync }: { src: string; name: string; onNoVideo: () => void; onBroken: () => void; footer?: ReactNode; sync?: PlayerSync }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const attach = sync?.attach;
  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      video.current = el;
      attach?.(el);
    },
    [attach],
  );
  const subInput = useRef<HTMLInputElement>(null);
  const [started, setStarted] = useState(!!sync);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [full, setFull] = useState(false);
  const [showUi, setShowUi] = useState(true);
  const [menu, setMenu] = useState<null | 'main' | 'speed' | 'subs' | 'style'>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [subs, setSubs] = useState<{ name: string; cues: Cue[] } | null>(null);
  const [subsOn, setSubsOn] = useState(true);
  const [offset, setOffset] = useState(0);
  const [style, setStyleState] = useState<SubStyle>(loadStyle);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setStyle = (patch: Partial<SubStyle>) =>
    setStyleState((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(STYLE_KEY, JSON.stringify(next));
      } catch {
        // sem armazenamento: vale só agora
      }
      return next;
    });

  // esconde os controles depois de 2,5 s sem mexer o mouse (só tocando e sem menu aberto)
  const poke = useCallback(() => {
    setShowUi(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowUi(false), 2500);
  }, []);
  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);
  const uiVisible = !started || !playing || showUi || menu !== null;

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const v = () => video.current!;
  const toggle = () => {
    const el = v();
    setStarted(true);
    if (sync) return sync.request(el.paused || el.ended ? 'play' : 'pause', el.currentTime);
    if (el.paused || el.ended) void el.play().catch(() => {});
    else el.pause();
  };
  const seek = (t: number) => {
    const el = v();
    if (sync) {
      const to = Math.max(0, Math.min(duration || el.duration || 0, t));
      sync.request('seek', to);
      setTime(to);
      return;
    }
    el.currentTime = Math.max(0, Math.min(duration || el.duration || 0, t));
    setTime(el.currentTime);
  };
  const changeVolume = (val: number) => {
    const el = v();
    el.volume = Math.max(0, Math.min(1, val));
    el.muted = el.volume === 0;
  };
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen().catch(() => {});
  };
  const changeSpeed = (s: number) => {
    v().playbackRate = s;
    setSpeed(s);
  };

  async function importSubs(file: File | undefined) {
    if (!file) return;
    const cues = parseSubtitles(await readSubtitleFile(file));
    if (!cues.length) {
      setSubs(null);
      alertMsg('Não encontrei legendas nesse arquivo. Use um .srt (ou .vtt).');
      return;
    }
    setSubs({ name: file.name, cues });
    setSubsOn(true);
    setOffset(0);
    setMenu(null);
  }
  const [msg, setMsg] = useState<string | null>(null);
  const alertMsg = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3500);
  };

  function onKey(e: ReactKeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
    const k = e.key.toLowerCase();
    const handled = [' ', 'k', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'f', 'm', 'c'].includes(k);
    if (!handled) return;
    e.preventDefault();
    poke();
    if (k === ' ' || k === 'k') toggle();
    else if (k === 'arrowleft') seek(v().currentTime - 5);
    else if (k === 'arrowright') seek(v().currentTime + 5);
    else if (k === 'arrowup') changeVolume(v().volume + 0.1);
    else if (k === 'arrowdown') changeVolume(v().volume - 0.1);
    else if (k === 'f') toggleFull();
    else if (k === 'm') v().muted = !v().muted;
    else if (k === 'c' && subs) setSubsOn((s) => !s);
  }

  const cue = subs && subsOn ? subs.cues.find((c) => time - offset >= c.start && time - offset <= c.end) : null;
  const font = FONTS.find((f) => f.id === style.font) ?? FONTS[0];
  const size = SIZES.find((s) => s.id === style.size) ?? SIZES[1];
  // a legenda acompanha o tamanho do player (maior em tela cheia)
  const baseFont = full ? 'clamp(20px, 3.2vw, 46px)' : 'clamp(13px, 3.6cqw, 22px)';
  const cueStyle: CSSProperties = {
    fontFamily: font.css,
    fontSize: `calc(${baseFont} * ${size.scale})`,
    color: style.color,
    ...(style.bg === 'box'
      ? { background: 'rgba(0,0,0,.72)', padding: '0.1em 0.45em', borderRadius: '0.25em', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }
      : style.bg === 'outline'
        ? { textShadow: '0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000' }
        : { textShadow: '0 1px 2px rgba(0,0,0,.6)' }),
  };
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const pct = duration ? (time / duration) * 100 : 0;

  return (
    <div
      ref={box}
      tabIndex={0}
      onKeyDown={onKey}
      onMouseMove={poke}
      onMouseLeave={() => playing && setShowUi(false)}
      aria-label={`Player de vídeo: ${name}`}
      className={cx('group/player relative bg-black outline-none [container-type:inline-size]', full || sync ? 'flex h-full w-full items-center justify-center' : '', !uiVisible && 'cursor-none')}
    >
      <video
        ref={videoRef}
        preload={sync ? 'auto' : 'metadata'}
        playsInline
        src={sync ? src : `${src}#t=0.1`}
        onClick={() => {
          toggle();
          setMenu(null);
        }}
        onDoubleClick={toggleFull}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setDuration(el.duration);
          if (!el.videoWidth && el.duration > 0) onNoVideo();
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onProgress={(e) => {
          const el = e.currentTarget;
          const b = el.buffered;
          for (let i = 0; i < b.length; i++) if (b.start(i) <= el.currentTime && b.end(i) >= el.currentTime) setBuffered(b.end(i));
        }}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
          poke();
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onError={onBroken}
        className={cx('block w-full bg-black object-contain', full || sync ? 'h-full max-h-none' : 'aspect-video max-h-[360px]')}
      />

      {/* legenda */}
      {cue && (
        <div className={cx('pointer-events-none absolute inset-x-0 flex justify-center px-[6%] text-center transition-[bottom] duration-200', uiVisible ? 'bottom-16' : 'bottom-[6%]')}>
          <span className="leading-snug font-semibold whitespace-pre-line" style={cueStyle}>
            {cue.text}
          </span>
        </div>
      )}

      {/* botão grande antes de começar */}
      {!started && (
        <button
          type="button"
          aria-label={`Tocar ${name}`}
          onClick={toggle}
          className="group absolute inset-0 flex items-center justify-center bg-black/25 transition-colors hover:bg-black/10"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white ring-2 ring-white/80 backdrop-blur-sm transition-transform group-hover:scale-110">
            <Play size={28} className="ml-1" fill="currentColor" />
          </span>
          {duration > 0 && <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white tabular-nums">{fmt(duration)}</span>}
        </button>
      )}

      {waiting && playing && (
        <span className="pointer-events-none absolute top-1/2 left-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 animate-spin rounded-full border-4 border-white/25 border-t-white" />
      )}
      {sync?.banner && <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">{sync.banner}</div>}
      {msg && <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-xl bg-black/80 px-3 py-2 text-xs text-white">{msg}</div>}

      {/* controles */}
      {started && (
        <div
          className={cx(
            'absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 via-black/45 to-transparent px-3 pt-8 pb-2 text-white transition-opacity duration-200',
            uiVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          {/* barra de tempo */}
          <div
            className="group/seek relative mb-1.5 flex h-4 cursor-pointer items-center"
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
              setHover({ x, t: (x / r.width) * duration });
            }}
            onMouseLeave={() => setHover(null)}
          >
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-[height] group-hover/seek:h-1.5">
              <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
              <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full bg-accent opacity-0 shadow transition-opacity group-hover/seek:opacity-100" style={{ left: `${pct}%` }} />
            {hover && (
              <span className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md bg-black/85 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums" style={{ left: hover.x }}>
                {fmt(hover.t)}
              </span>
            )}
            <input
              type="range"
              aria-label="Posição do vídeo"
              min={0}
              max={duration || 0}
              step={0.1}
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>

          <div className="flex items-center gap-1">
            <CtrlButton label={playing ? 'Pausar (espaço)' : 'Tocar (espaço)'} onClick={toggle}>
              {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
            </CtrlButton>

            {/* volume */}
            <div className="group/vol flex items-center">
              <CtrlButton label={muted ? 'Ativar som (M)' : 'Mudo (M)'} onClick={() => (v().muted = !v().muted)}>
                <VolIcon size={19} />
              </CtrlButton>
              <input
                type="range"
                aria-label="Volume"
                min={0}
                max={1}
                step={0.02}
                value={muted ? 0 : volume}
                onChange={(e) => changeVolume(Number(e.target.value))}
                className="h-1 w-0 cursor-pointer accent-white opacity-0 transition-all duration-200 group-focus-within/vol:w-20 group-focus-within/vol:opacity-100 group-hover/vol:w-20 group-hover/vol:opacity-100"
              />
            </div>

            <span className="ml-1 text-xs font-semibold tabular-nums text-white/90">
              {fmt(time)} <span className="text-white/50">/ {fmt(duration)}</span>
            </span>

            <div className="flex-1" />

            {speed !== 1 && <span className="rounded bg-white/15 px-1.5 py-0.5 text-[11px] font-bold">{speed}x</span>}
            <CtrlButton label={subs ? (subsOn ? 'Desligar legenda (C)' : 'Ligar legenda (C)') : 'Legendas'} active={!!subs && subsOn} onClick={() => (subs ? setSubsOn(!subsOn) : setMenu(menu === 'subs' ? null : 'subs'))}>
              <Captions size={19} />
            </CtrlButton>
            <CtrlButton label="Configurações" active={menu !== null} onClick={() => setMenu(menu ? null : 'main')}>
              <Settings size={18} className={cx('transition-transform', menu && 'rotate-45')} />
            </CtrlButton>
            <CtrlButton label={full ? 'Sair da tela cheia (F)' : 'Tela cheia (F)'} onClick={toggleFull}>
              {full ? <Minimize size={18} /> : <Maximize size={18} />}
            </CtrlButton>
          </div>
        </div>
      )}

      {/* menu de configurações */}
      {menu && (
        <div className="absolute right-2 bottom-14 z-10 max-h-[calc(100%-4rem)] w-64 overflow-y-auto overscroll-contain rounded-2xl bg-black/90 p-1.5 text-sm text-white shadow-2xl ring-1 ring-white/10 backdrop-blur" role="menu">
          {menu === 'main' && (
            <>
              {sync?.menuRows?.(() => setMenu(null))}
              {/* na sala de cinema a velocidade é a da sala (o controlador ajusta de leve para sincronizar) */}
              {!sync && <MenuRow label="Velocidade" value={speed === 1 ? 'Normal' : `${speed}x`} onClick={() => setMenu('speed')} />}
              <MenuRow label="Legenda" value={subs ? (subsOn ? 'Ligada' : 'Desligada') : 'Nenhuma'} onClick={() => setMenu('subs')} />
              <MenuRow label="Estilo da legenda" value={`${font.label} · ${size.label}`} onClick={() => setMenu('style')} />
            </>
          )}
          {menu === 'speed' && (
            <>
              <MenuBack label="Velocidade" onClick={() => setMenu('main')} />
              {SPEEDS.map((s) => (
                <MenuOption key={s} selected={speed === s} onClick={() => changeSpeed(s)}>
                  {s === 1 ? 'Normal' : `${s.toFixed(2).replace(/0$/, '').replace('.', ',')}x`}
                </MenuOption>
              ))}
            </>
          )}
          {menu === 'subs' && (
            <>
              <MenuBack label="Legenda" onClick={() => setMenu('main')} />
              <button type="button" onClick={() => subInput.current?.click()} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/10">
                <Upload size={15} /> Importar legenda (.srt)
              </button>
              {subs && (
                <>
                  <MenuOption selected={subsOn} onClick={() => setSubsOn(true)}>
                    <span className="truncate">{subs.name}</span>
                  </MenuOption>
                  <MenuOption selected={!subsOn} onClick={() => setSubsOn(false)}>
                    Desligada
                  </MenuOption>
                  <div className="mt-1 border-t border-white/10 px-3 pt-2 pb-1">
                    <span className="mb-1.5 block text-xs text-white/60">Sincronia (se a fala e a legenda não batem)</span>
                    <div className="flex items-center justify-between gap-2">
                      <button type="button" onClick={() => setOffset((o) => Math.round((o - 0.5) * 10) / 10)} className="rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
                        −0,5 s
                      </button>
                      <span className="text-xs font-semibold tabular-nums">{offset === 0 ? 'Sem ajuste' : `${offset > 0 ? '+' : ''}${offset.toFixed(1).replace('.', ',')} s`}</span>
                      <button type="button" onClick={() => setOffset((o) => Math.round((o + 0.5) * 10) / 10)} className="rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
                        +0,5 s
                      </button>
                    </div>
                  </div>
                </>
              )}
              <p className="px-3 pt-1 pb-1.5 text-[11px] leading-snug text-white/50">A legenda fica só no seu player. Cada pessoa importa a sua.</p>
            </>
          )}
          {menu === 'style' && (
            <>
              <MenuBack label="Estilo da legenda" onClick={() => setMenu('main')} />
              <div className="space-y-2.5 px-2 py-1.5">
                <div className="rounded-xl bg-neutral-500 bg-[linear-gradient(135deg,#3a4a5a,#6b5a4a)] px-2 py-2.5 text-center">
                  <span className="leading-snug font-semibold" style={{ ...cueStyle, fontSize: `${14 * size.scale}px` }}>
                    Assim fica a legenda
                  </span>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs text-white/60">Fonte</span>
                  <div className="grid grid-cols-2 gap-1">
                    {FONTS.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setStyle({ font: f.id })}
                        className={cx('truncate rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white/10', style.font === f.id ? 'bg-white text-black' : 'bg-white/10')}
                        style={{ fontFamily: f.css }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs text-white/60">Tamanho</span>
                  <div className="grid grid-cols-4 gap-1">
                    {SIZES.map((s) => (
                      <button key={s.id} type="button" onClick={() => setStyle({ size: s.id })} className={cx('rounded-lg py-1.5 text-xs font-bold hover:bg-white/10', style.size === s.id ? 'bg-white text-black' : 'bg-white/10')}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs text-white/60">Cor</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Cor ${c}`}
                        onClick={() => setStyle({ color: c })}
                        className={cx('h-7 w-7 rounded-full ring-2 transition-transform hover:scale-110', style.color === c ? 'ring-white' : 'ring-transparent')}
                        style={{ background: c }}
                      />
                    ))}
                    <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full ring-2 ring-white/30" title="Outra cor" style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}>
                      <span className="sr-only">Outra cor</span>
                      <input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" />
                    </label>
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs text-white/60">Fundo</span>
                  <div className="grid grid-cols-3 gap-1">
                    {BACKGROUNDS.map((b) => (
                      <button key={b.id} type="button" onClick={() => setStyle({ bg: b.id })} className={cx('rounded-lg px-1 py-1.5 text-[11px] font-semibold hover:bg-white/10', style.bg === b.id ? 'bg-white text-black' : 'bg-white/10')}>
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <input
        ref={subInput}
        type="file"
        accept=".srt,.vtt,text/plain"
        className="hidden"
        onChange={(e) => {
          void importSubs(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {footer}
    </div>
  );
}

function CtrlButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cx('flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/15', active ? 'text-accent' : 'text-white')}
    >
      {children}
    </button>
  );
}

function MenuRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/10">
      <span className="flex-1">{label}</span>
      <span className="truncate text-xs text-white/60">{value}</span>
      <ChevronRight size={15} className="shrink-0 text-white/60" />
    </button>
  );
}

function MenuBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mb-1 flex w-full items-center gap-1 rounded-xl border-b border-white/10 px-2 py-2 text-left font-semibold hover:bg-white/10">
      <ChevronLeft size={16} /> {label}
    </button>
  );
}

function MenuOption({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} onClick={onClick} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/10">
      <span className="w-4 shrink-0">{selected && <Check size={15} />}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
