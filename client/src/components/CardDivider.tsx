import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';

/**
 * Divisor do mini perfil: decoração em cima da linha entre a capa e as informações. Desenhada em SVG na largura
 * exata do cartão. Fica atrás da foto de perfil.
 *
 * "lights": dois fios de pisca-pisca se entrelaçando (um passa por cima, depois por baixo do outro), com lâmpadas.
 * "snow": um monte de neve com pingentes de gelo, brilhinhos e uns flocos caindo.
 */

export const CARD_DIVIDER_LABELS: Record<string, string> = { lights: 'Pisca-pisca', snow: 'Neve' };

const BULB_COLORS = ['#ff4b5c', '#ffd23f', '#35d07f', '#4aa8ff', '#ff8c3a'];
const INK = '#0f1d16';

function Bulb({ x, y, angle, color, delay, scale }: { x: number; y: number; angle: number; color: string; delay: number; scale: number }) {
  return (
    <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)}) scale(${scale})`}>
      <circle className="xmas-glow" cx="0" cy="10.5" r="7" fill={color} filter="url(#divider-glow)" style={{ animationDelay: `${delay}s` }} />
      <rect x="-2.9" y="-1.2" width="5.8" height="5.6" rx="1.2" fill="#2e6b41" stroke={INK} strokeWidth="1.1" />
      <g className="xmas-bulb" style={{ animationDelay: `${delay}s` }}>
        <path d="M-3.7 4.6 C-5.2 8 -3.9 12.6 0 16 C3.9 12.6 5.2 8 3.7 4.6 Z" fill={color} stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M-1.9 6.6 C-2.6 8.4 -2.2 10.6 -1 12" fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.2" strokeLinecap="round" />
      </g>
    </g>
  );
}

function Lights({ w, scale }: { w: number; scale: number }) {
  const h = 44 * scale;
  const mid = h / 2;
  const amp = 5 * scale;
  const waves = Math.max(2, Math.round(w / (70 * scale)));
  const lambda = w / waves;
  const wire = (sign: number, from = 0, to = w) => {
    const pts: string[] = [];
    for (let x = from; x <= to + 0.01; x += 2) pts.push(`${pts.length ? 'L' : 'M'}${x.toFixed(1)} ${(mid + sign * amp * Math.sin((2 * Math.PI * x) / lambda)).toFixed(1)}`);
    return pts.join(' ');
  };
  const stroke = (d: string, key: string, color: string) => (
    <g key={key}>
      <path d={d} fill="none" stroke={INK} strokeWidth={3.2 * scale} strokeLinecap="round" />
      <path d={d} fill="none" stroke={color} strokeWidth={1.4 * scale} strokeLinecap="round" />
    </g>
  );
  // cruzamentos a cada meia onda: nos pares o fio A passa por cima, nos ímpares o B (por isso "entrelaça")
  const overA: ReactElement[] = [];
  for (let k = 0; k <= waves * 2; k += 2) {
    const cx = (k * lambda) / 2;
    overA.push(stroke(wire(1, Math.max(0, cx - 7 * scale), Math.min(w, cx + 7 * scale)), `o${k}`, '#3f8a55'));
  }
  // lâmpadas nas pontas das ondas, apontando para fora (as de cima sobre a capa, as de baixo sobre o cartão)
  const bulbs = [];
  let n = 0;
  for (let i = 0; i < waves * 2; i++) {
    const x = lambda / 4 + (i * lambda) / 2;
    const up = i % 2 === 1; // fio A: sin>0 em i par (embaixo); o fio B é o espelho
    for (const sign of [1, -1]) {
      const y = mid + sign * amp * (up ? -1 : 1);
      const pointsDown = sign * (up ? -1 : 1) > 0;
      bulbs.push(
        <Bulb key={`${i}${sign}`} x={x + sign * 3 * scale} y={y} angle={pointsDown ? (sign > 0 ? -8 : 8) : 180 + (sign > 0 ? 8 : -8)} color={BULB_COLORS[n % BULB_COLORS.length]} delay={(n * 0.53) % 2.6} scale={0.82 * scale} />,
      );
      n++;
    }
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block overflow-visible" aria-hidden="true">
      <defs>
        <filter id="divider-glow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>
      {stroke(wire(1), 'a', '#3f8a55')}
      {stroke(wire(-1), 'b', '#5aa36b')}
      {overA}
      {bulbs}
    </svg>
  );
}

/** número fixo por índice: o desenho não muda a cada render */
const jitter = (i: number) => {
  const v = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return v - Math.floor(v);
};

function Snow({ w, scale }: { w: number; scale: number }) {
  const h = 40 * scale;
  const top = 12 * scale;
  const base = 25 * scale;
  // borda de cima: montinhos de neve
  const bumps = Math.max(4, Math.round(w / (34 * scale)));
  const bw = w / bumps;
  let d = `M0 ${base}`;
  d += ` L0 ${top + 4 * scale}`;
  for (let i = 0; i < bumps; i++) {
    const x0 = i * bw;
    const peak = top - (jitter(i) * 5 - 1) * scale;
    d += ` Q${(x0 + bw / 2).toFixed(1)} ${(peak - 5 * scale).toFixed(1)} ${(x0 + bw).toFixed(1)} ${(top + 3 * scale + jitter(i + 7) * 3 * scale).toFixed(1)}`;
  }
  // borda de baixo: ondulada, com gotas
  const drips = Math.max(5, Math.round(w / (26 * scale)));
  const dw = w / drips;
  d += ` L${w} ${base}`;
  for (let i = drips - 1; i >= 0; i--) {
    const x0 = (i + 1) * dw;
    const deep = base + (3 + jitter(i + 3) * 5) * scale;
    d += ` Q${(x0 - dw / 2).toFixed(1)} ${deep.toFixed(1)} ${(x0 - dw).toFixed(1)} ${base.toFixed(1)}`;
  }
  d += ' Z';
  const icicles = Array.from({ length: Math.round(w / (22 * scale)) }, (_, i) => {
    const x = (i + 0.5) * (w / Math.round(w / (22 * scale))) + (jitter(i + 11) - 0.5) * 6 * scale;
    const len = (5 + jitter(i + 5) * 9) * scale;
    return { x, len, wd: (2.2 + jitter(i + 2) * 1.6) * scale };
  });
  const sparkles = Array.from({ length: Math.round(w / (45 * scale)) }, (_, i) => ({
    x: (i + 0.5) * 45 * scale + (jitter(i + 21) - 0.5) * 20 * scale,
    y: top + (2 + jitter(i + 31) * 9) * scale,
    delay: ((i * 0.61) % 2.4).toFixed(2),
  }));
  const flakes = Array.from({ length: Math.round(w / (28 * scale)) }, (_, i) => ({
    x: jitter(i + 41) * w,
    r: (1 + jitter(i + 51) * 1.4) * scale,
    delay: (jitter(i + 61) * 3.2).toFixed(2),
    dur: (2.6 + jitter(i + 71) * 1.8).toFixed(2),
  }));
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block overflow-visible" aria-hidden="true">
      {/* flocos caindo sobre a capa, até pousar no monte */}
      {flakes.map((f, i) => (
        <circle key={`f${i}`} className="divider-flake" cx={f.x.toFixed(1)} cy={-18 * scale} r={f.r.toFixed(2)} fill="#fff" style={{ animationDelay: `-${f.delay}s`, animationDuration: `${f.dur}s`, '--fall': `${(top + 18 * scale).toFixed(0)}px` } as CSSProperties} />
      ))}
      {icicles.map((c, i) => (
        <path key={`i${i}`} d={`M${(c.x - c.wd).toFixed(1)} ${(base - 1).toFixed(1)} L${c.x.toFixed(1)} ${(base + c.len).toFixed(1)} L${(c.x + c.wd).toFixed(1)} ${(base - 1).toFixed(1)} Z`} fill="#cfe9ff" stroke="#6f93b8" strokeWidth={0.8 * scale} strokeLinejoin="round" />
      ))}
      <path d={d} fill="#f6fbff" stroke="#6f93b8" strokeWidth={1.1 * scale} strokeLinejoin="round" />
      {/* sombra azulada embaixo do monte, para ter volume */}
      <path d={`M${3 * scale} ${(base - 2 * scale).toFixed(1)} L${w - 3 * scale} ${(base - 2 * scale).toFixed(1)}`} stroke="#bcd8f2" strokeWidth={3 * scale} strokeLinecap="round" opacity="0.8" />
      {sparkles.map((s, i) => (
        <path key={`s${i}`} className="divider-sparkle" transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) scale(${scale})`} d="M0 -3.2 L0.7 -0.7 L3.2 0 L0.7 0.7 L0 3.2 L-0.7 0.7 L-3.2 0 L-0.7 -0.7 Z" fill="#9fd4ff" style={{ animationDelay: `${s.delay}s` }} />
      ))}
    </svg>
  );
}

/** Coloque dentro de um elemento `relative` (a capa): o divisor fica centrado na borda de baixo dele. */
export function CardDivider({ kind, scale = 1 }: { kind: string | null | undefined; scale?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || !kind) return;
    const read = () => setW(el.offsetWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [kind]);
  if (kind !== 'lights' && kind !== 'snow') return null;
  const h = (kind === 'lights' ? 44 : 40) * scale;
  // a neve fica um pouco mais para baixo: o monte "pousa" na linha
  const offset = kind === 'snow' ? 0.6 : 0.5;
  return (
    <div ref={box} className="pointer-events-none absolute inset-x-0 z-[1]" style={{ bottom: -h * offset, height: h }}>
      {w > 0 && (kind === 'lights' ? <Lights w={w} scale={scale} /> : <Snow w={w} scale={scale} />)}
    </div>
  );
}
