import { ArrowLeftRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ColoredName } from '../ColoredName';
import { cx } from '../ui';

/**
 * "Cor do nome": padrão (cor do cargo), uma cor sólida, ou degradê de 2 ou 3 cores (começo, meio e fim), cada uma
 * escolhida no seletor ou digitada em hex. A prévia mostra o nome como vai aparecer no chat.
 */

type Mode = 'default' | 'solid' | 'grad2' | 'grad3';

const PRESETS: { name: string; colors: string[] }[] = [
  { name: 'Pôr do sol', colors: ['#ffb36b', '#ff5f7e'] },
  { name: 'Oceano', colors: ['#3ad7ff', '#5b6bff'] },
  { name: 'Aurora', colors: ['#7cffb2', '#3ad7ff', '#b46bff'] },
  { name: 'Fogo', colors: ['#ffd000', '#ff7a00', '#ff1f4b'] },
  { name: 'Sakura', colors: ['#ffd1e6', '#ff6fa8'] },
  { name: 'Galáxia', colors: ['#6a5cff', '#c14bff', '#ff5fc8'] },
  { name: 'Menta', colors: ['#b8ffda', '#2fd6a3'] },
  { name: 'Ouro', colors: ['#fff1a8', '#ffc83d', '#d98a00'] },
];

const HEX = /^#[0-9a-f]{6}$/i;
const modeOf = (c: string[] | null): Mode => (!c?.length ? 'default' : c.length === 1 ? 'solid' : c.length === 2 ? 'grad2' : 'grad3');
const STOP_LABELS: Record<number, string[]> = { 1: ['Cor'], 2: ['Começo', 'Fim'], 3: ['Começo', 'Meio', 'Fim'] };

/** Mistura duas cores (para criar o meio quando passa de 2 para 3). */
function mix(a: string, b: string) {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round((p(a, i) + p(b, i)) / 2).toString(16).padStart(2, '0')).join('')}`;
}

export function NameColorEditor({ value, onChange, name }: { value: string[] | null; onChange: (v: string[] | null) => void; name: string }) {
  const mode = modeOf(value);
  // lembra as cores ao trocar de modo (ex.: volta do sólido para o degradê sem perder o que tinha)
  const [memory, setMemory] = useState<string[]>(value?.length ? value : ['#ff8f70', '#b46bff', '#3ad7ff']);
  useEffect(() => {
    if (value?.length) setMemory((m) => value.concat(m.slice(value.length)));
  }, [value]);

  function setMode(next: Mode) {
    if (next === 'default') return onChange(null);
    const base = value?.length ? value : memory;
    if (next === 'solid') return onChange([base[0]]);
    if (next === 'grad2') return onChange([base[0], base.length === 3 ? base[2] : (base[1] ?? memory[1] ?? '#b46bff')]);
    const start = base[0];
    const end = base.length >= 2 ? base[base.length - 1] : (memory[2] ?? '#3ad7ff');
    onChange([start, base.length === 3 ? base[1] : mix(start, end), end]);
  }

  function setStop(i: number, c: string) {
    const next = [...(value ?? [])];
    next[i] = c.toLowerCase();
    onChange(next);
  }

  const modes: { id: Mode; label: string }[] = [
    { id: 'default', label: 'Padrão' },
    { id: 'solid', label: 'Sólida' },
    { id: 'grad2', label: 'Degradê · 2' },
    { id: 'grad3', label: 'Degradê · 3' },
  ];

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <span className="block text-xs font-bold text-fg-muted">Cor do nome</span>
        <div role="radiogroup" aria-label="Tipo de cor do nome" className="grid grid-cols-4 gap-1 rounded-2xl bg-surface-3 p-1">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => setMode(m.id)}
              className={cx(
                'rounded-xl px-2 py-2 text-xs font-semibold whitespace-nowrap transition-colors',
                mode === m.id ? 'bg-accent text-on-accent' : 'text-fg-muted hover:bg-surface-4 hover:text-fg',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* prévia: como o nome aparece no chat */}
      <div className="flex items-center gap-3 rounded-2xl bg-surface-0 px-4 py-3 ring-1 ring-line">
        <span className="text-xs text-fg-subtle">Prévia</span>
        <ColoredName colors={value} className="truncate text-lg font-bold">
          {name || 'Seu nome'}
        </ColoredName>
        {mode === 'default' && <span className="text-xs text-fg-subtle">· usa a cor do seu cargo em cada servidor</span>}
      </div>

      {value && (
        <div className="flex flex-wrap items-end gap-3">
          {value.map((c, i) => (
            <ColorStop key={i} label={STOP_LABELS[value.length][i]} value={c} onChange={(v) => setStop(i, v)} />
          ))}
          {value.length > 1 && (
            <button
              type="button"
              onClick={() => onChange([...value].reverse())}
              title="Inverter o degradê"
              aria-label="Inverter o degradê"
              className="mb-0.5 flex h-10 w-10 items-center justify-center rounded-xl text-fg-muted hover:bg-surface-3 hover:text-fg"
            >
              <ArrowLeftRight size={16} />
            </button>
          )}
        </div>
      )}

      {mode !== 'default' && mode !== 'solid' && (
        <div className="flex flex-wrap gap-1.5" aria-label="Degradês prontos">
          {PRESETS.filter((p) => p.colors.length === value!.length).map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => onChange(p.colors)}
              className="rounded-full bg-surface-3 px-3 py-1.5 text-xs font-bold hover:bg-surface-4"
              title={`Usar o degradê ${p.name}`}
            >
              <ColoredName colors={p.colors}>{p.name}</ColoredName>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Um ponto de cor: o quadradinho abre o seletor do sistema; o campo aceita o hex digitado. */
function ColorStop({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = HEX.test(text.startsWith('#') ? text : `#${text}`);
  return (
    <div className="w-[136px]">
      <span className="mb-1 block text-[11px] font-bold text-fg-subtle">{label}</span>
      <div className={cx('flex h-10 items-center gap-2 rounded-xl bg-surface-3 pr-2 pl-1.5 ring-1', valid ? 'ring-transparent focus-within:ring-accent' : 'ring-danger')}>
        <label className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-lg ring-1 ring-white/15" style={{ background: value }} title="Escolher a cor">
          <span className="sr-only">Escolher a cor ({label})</span>
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </label>
        <input
          value={text}
          aria-label={`Hex da cor (${label})`}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => {
            const t = e.target.value.trim();
            setText(t);
            const hex = t.startsWith('#') ? t : `#${t}`;
            if (HEX.test(hex)) onChange(hex);
          }}
          onBlur={() => setText(value)}
          className="w-full min-w-0 bg-transparent font-mono text-sm uppercase outline-none"
        />
      </div>
    </div>
  );
}
