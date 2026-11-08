import { useEffect, useRef, useState } from 'react';

/**
 * Moldura do mini perfil: decoração em volta do cartão (por fora da borda). Desenhada em SVG no tamanho exato do
 * cartão, então acompanha a altura dele (que muda de pessoa para pessoa).
 *
 * "christmas": um fio de luzinhas de Natal, estilo desenho (contorno escuro, brilho branco chapado), com as lâmpadas
 * piscando em tempos diferentes. Quem pede menos movimento no sistema vê as luzes acesas, paradas.
 */

export const CARD_FRAME_LABELS: Record<string, string> = { christmas: 'Natal' };

const BULB_COLORS = ['#ff4b5c', '#ffd23f', '#35d07f', '#4aa8ff', '#ff8c3a'];
/** quanto a moldura sai para fora do cartão (px, na escala 1) */
const OUT = 16;

interface Pt {
  x: number;
  y: number;
  /** normal para fora */
  nx: number;
  ny: number;
}

/** Ponto a `s` px do começo, contornando um retângulo arredondado (sentido horário, começando no topo-esquerdo). */
function roundedRectPoint(s: number, x0: number, y0: number, w: number, h: number, r: number): Pt {
  const top = w - 2 * r;
  const side = h - 2 * r;
  const arc = (Math.PI * r) / 2;
  const segs: [number, (t: number) => Pt][] = [
    [top, (t) => ({ x: x0 + r + t, y: y0, nx: 0, ny: -1 })],
    [arc, (t) => corner(x0 + w - r, y0 + r, -Math.PI / 2 + t / r)],
    [side, (t) => ({ x: x0 + w, y: y0 + r + t, nx: 1, ny: 0 })],
    [arc, (t) => corner(x0 + w - r, y0 + h - r, t / r)],
    [top, (t) => ({ x: x0 + w - r - t, y: y0 + h, nx: 0, ny: 1 })],
    [arc, (t) => corner(x0 + r, y0 + h - r, Math.PI / 2 + t / r)],
    [side, (t) => ({ x: x0, y: y0 + h - r - t, nx: -1, ny: 0 })],
    [arc, (t) => corner(x0 + r, y0 + r, Math.PI + t / r)],
  ];
  function corner(cx: number, cy: number, a: number): Pt {
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) };
  }
  let rest = s;
  for (const [len, at] of segs) {
    if (rest <= len) return at(rest);
    rest -= len;
  }
  return segs[0][1](0);
}

/** número "aleatório" fixo por índice (o desenho não muda a cada render) */
const jitter = (i: number) => {
  const v = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return v - Math.floor(v);
};

function ChristmasLights({ w, h, scale }: { w: number; h: number; scale: number }) {
  const out = OUT * scale;
  const cw = w - 2 * out;
  const ch = h - 2 * out;
  const r = Math.min(24 * scale, cw / 2, ch / 2);
  if (cw <= 0 || ch <= 0) return null;
  const perimeter = 2 * (cw - 2 * r) + 2 * (ch - 2 * r) + 2 * Math.PI * r;
  const count = Math.max(8, Math.round(perimeter / (30 * scale)));
  const gap = perimeter / count;
  const sag = 4 * scale;

  // fio: cai um pouco para fora entre uma lâmpada e outra, como um varal
  const wire: string[] = [];
  const steps = Math.ceil(perimeter / (3 * scale));
  for (let k = 0; k <= steps; k++) {
    const s = (k / steps) * perimeter;
    const p = roundedRectPoint(s % perimeter, out, out, cw, ch, r);
    const frac = (s % gap) / gap;
    const d = Math.sin(Math.PI * frac) * sag;
    wire.push(`${k ? 'L' : 'M'}${(p.x + p.nx * d).toFixed(1)} ${(p.y + p.ny * d).toFixed(1)}`);
  }
  const wirePath = `${wire.join(' ')} Z`;

  const bulbs = Array.from({ length: count }, (_, i) => {
    const p = roundedRectPoint(i * gap + gap * 0.02, out, out, cw, ch, r);
    // lâmpada aponta para fora, com uma inclinação leve diferente em cada uma (cara de desenho à mão)
    const angle = (Math.atan2(p.ny, p.nx) * 180) / Math.PI - 90 + (jitter(i) - 0.5) * 26;
    return { x: p.x, y: p.y, angle, color: BULB_COLORS[i % BULB_COLORS.length], delay: ((i * 0.53) % 2.6).toFixed(2) };
  });

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block overflow-visible" aria-hidden="true">
      <defs>
        <filter id="xmas-glow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation={2.6 * scale} />
        </filter>
      </defs>
      {/* fio: contorno escuro + verde por cima */}
      <path d={wirePath} fill="none" stroke="#0f1d16" strokeWidth={3 * scale} strokeLinejoin="round" />
      <path d={wirePath} fill="none" stroke="#3f8a55" strokeWidth={1.3 * scale} strokeLinejoin="round" />
      {bulbs.map((b, i) => (
        <g key={i} transform={`translate(${b.x.toFixed(1)} ${b.y.toFixed(1)}) rotate(${b.angle.toFixed(1)}) scale(${scale})`}>
          {/* brilho em volta (pisca) */}
          <circle className="xmas-glow" cx="0" cy="10.5" r="7.5" fill={b.color} filter="url(#xmas-glow)" style={{ animationDelay: `${b.delay}s` }} />
          {/* bocal */}
          <rect x="-2.9" y="-1.2" width="5.8" height="5.6" rx="1.2" fill="#2e6b41" stroke="#0f1d16" strokeWidth="1.1" />
          <path d="M-2.9 1.6 H2.9" stroke="#0f1d16" strokeWidth="0.8" />
          {/* lâmpada (formato de gota) */}
          <g className="xmas-bulb" style={{ animationDelay: `${b.delay}s` }}>
            <path d="M-3.7 4.6 C-5.2 8 -3.9 12.6 0 16 C3.9 12.6 5.2 8 3.7 4.6 Z" fill={b.color} stroke="#0f1d16" strokeWidth="1.1" strokeLinejoin="round" />
            {/* reflexo chapado */}
            <path d="M-1.9 6.6 C-2.6 8.4 -2.2 10.6 -1 12" fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.2" strokeLinecap="round" />
          </g>
        </g>
      ))}
    </svg>
  );
}

/** Coloque dentro de um elemento `relative` do tamanho do cartão. */
export function CardFrame({ frame, scale = 1 }: { frame: string | null | undefined; scale?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || !frame) return;
    const read = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame]);

  if (frame !== 'christmas') return null;
  return (
    <div ref={box} className="pointer-events-none absolute z-20" style={{ inset: -OUT * scale }}>
      {size && <ChristmasLights w={size.w} h={size.h} scale={scale} />}
    </div>
  );
}
