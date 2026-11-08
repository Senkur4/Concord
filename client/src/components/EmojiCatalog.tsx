import { Apple, Car, Clock, Flag, Heart, Lightbulb, PawPrint, Search, Smile, Trophy, Hand, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from './ui';

/**
 * Catálogo completo de emojis para a caixa de mensagem (o rostinho no canto, como no Discord e no WhatsApp).
 * Os nomes e palavras-chave vêm em português (emojibase), carregados só quando o catálogo abre pela primeira vez.
 * Emojis que o sistema de quem está usando não sabe desenhar (o Windows 10 não tem os mais novos, e nenhum
 * Windows desenha bandeiras) ficam de fora, para ninguém escolher um quadradinho.
 */

interface Emoji {
  e: string;
  label: string;
  search: string;
  /** variações de tom de pele, na ordem 1..5 */
  skins?: string[];
}
interface Group {
  key: string;
  label: string;
  icon: ReactNode;
  emojis: Emoji[];
}

const GROUP_META: Record<number, { key: string; label: string; icon: ReactNode }> = {
  0: { key: 'smileys', label: 'Carinhas e emoções', icon: <Smile size={17} /> },
  1: { key: 'people', label: 'Pessoas e corpo', icon: <Hand size={17} /> },
  3: {
    key: 'nature',
    label: 'Animais e natureza',
    icon: <PawPrint size={17} />,
  },
  4: { key: 'food', label: 'Comida e bebida', icon: <Apple size={17} /> },
  5: { key: 'travel', label: 'Viagens e lugares', icon: <Car size={17} /> },
  6: { key: 'activities', label: 'Atividades', icon: <Trophy size={17} /> },
  7: { key: 'objects', label: 'Objetos', icon: <Lightbulb size={17} /> },
  8: { key: 'symbols', label: 'Símbolos', icon: <Heart size={17} /> },
  9: { key: 'flags', label: 'Bandeiras', icon: <Flag size={17} /> },
};

const TONES = ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];
const TONE_NAMES = ['Padrão', 'Pele clara', 'Pele morena clara', 'Pele morena', 'Pele morena escura', 'Pele escura'];
const RECENT_KEY = 'concord_recent_emojis';
const TONE_KEY = 'concord_emoji_tone';

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // navegador sem armazenamento: só não lembra
  }
}

// ---------- o sistema sabe desenhar este emoji? ----------

let probe: { ctx: CanvasRenderingContext2D; base: number } | null = null;
const supportCache = new Map<string, boolean>();

function canDraw(emoji: string): boolean {
  const hit = supportCache.get(emoji);
  if (hit !== undefined) return hit;
  if (!probe) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return true;
    ctx.font = '24px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
    ctx.textBaseline = 'top';
    probe = { ctx, base: ctx.measureText('😀').width || 24 };
  }
  const { ctx, base } = probe;
  // sequência que o sistema não junta vira dois ou mais desenhos lado a lado (fica larga)
  let ok = ctx.measureText(emoji).width <= base * 1.35;
  if (ok) {
    // e o que ele não conhece vira um quadradinho sem cor
    ctx.clearRect(0, 0, 32, 32);
    ctx.fillText(emoji, 0, 0);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    ok = false;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && (Math.abs(d[i] - d[i + 1]) > 12 || Math.abs(d[i + 1] - d[i + 2]) > 12)) {
        ok = true;
        break;
      }
    }
  }
  supportCache.set(emoji, ok);
  return ok;
}

// ---------- dados ----------

let catalog: Promise<Group[]> | null = null;

interface RawEmoji {
  label: string;
  emoji: string;
  group?: number;
  order?: number;
  tags?: string[];
  skins?: { emoji: string; tone?: number | number[] }[];
}

function loadCatalog(): Promise<Group[]> {
  catalog ??= import('emojibase-data/pt/data.json').then((mod) => {
    const raw = ((mod as { default?: unknown }).default ?? mod) as RawEmoji[];
    const groups = new Map<number, Emoji[]>();
    for (const r of [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (r.group === undefined || !GROUP_META[r.group] || !canDraw(r.emoji)) continue;
      // tons de pele só para quem tem um tom por variação (não os de duas pessoas com tons diferentes)
      const skins = r.skins
        ?.filter((s) => typeof s.tone === 'number' || (Array.isArray(s.tone) && s.tone.every((t) => t === (s.tone as number[])[0])))
        .sort((a, b) => [a.tone].flat()[0]! - [b.tone].flat()[0]!)
        .map((s) => s.emoji);
      const item: Emoji = {
        e: r.emoji,
        label: r.label,
        search: normalize(`${r.label} ${(r.tags ?? []).join(' ')}`),
      };
      if (skins?.length === 5 && canDraw(skins[0])) item.skins = skins;
      const list = groups.get(r.group) ?? [];
      list.push(item);
      groups.set(r.group, list);
    }
    return Object.keys(GROUP_META)
      .map(Number)
      .filter((g) => groups.get(g)?.length)
      .map((g) => ({ ...GROUP_META[g], emojis: groups.get(g)! }));
  });
  return catalog;
}

// ---------- inserir no texto ----------

/** Põe o texto onde está o cursor da caixa (ou no fim) e devolve o cursor logo depois dele. */
export function insertAtCursor(el: HTMLTextAreaElement | HTMLInputElement | null, value: string, insert: string, setValue: (v: string) => void) {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const next = value.slice(0, start) + insert + value.slice(end);
  setValue(next);
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus();
    const at = start + insert.length;
    el.setSelectionRange(at, at);
  });
}

// ---------- botão + catálogo ----------

/** O rostinho da caixa de mensagem. Clicar num emoji coloca no texto; com Shift, coloca e deixa o catálogo aberto. */
export function ComposerEmojiButton({ onPick, className }: { onPick: (emoji: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [hoverFace, setHoverFace] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const FACES = ['🙂', '😄', '😎', '🤩', '😂', '🥳', '😍', '🤔'];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className={className ?? 'relative'}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setHoverFace((f) => (f + 1) % FACES.length)}
        title="Emojis"
        aria-label="Emojis"
        aria-expanded={open}
        className={cx('group flex h-9 w-9 items-center justify-center rounded-full transition-colors', open ? 'text-accent' : 'text-fg-muted hover:text-fg')}
      >
        {/* como no Discord: o ícone vira um emoji colorido diferente a cada vez que o mouse passa */}
        <Smile size={22} className={cx('group-hover:hidden', open && 'hidden')} />
        <span className={cx('hidden text-[21px] leading-none transition-transform group-hover:block group-hover:scale-110', open && '!block')}>
          {FACES[hoverFace]}
        </span>
      </button>
      {open && (
        <EmojiCatalogPanel
          onPick={(emoji, keepOpen) => {
            onPick(emoji);
            if (!keepOpen) setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function EmojiCatalogPanel({ onPick }: { onPick: (emoji: string, keepOpen: boolean) => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState<number>(() => readStore(TONE_KEY, 0));
  const [toneOpen, setToneOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readStore<string[]>(RECENT_KEY, []));
  const [hover, setHover] = useState<{ e: string; label: string } | null>(null);
  const [activeGroup, setActiveGroup] = useState('recent');
  const scroller = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void loadCatalog().then((g) => alive && setGroups(g));
    searchRef.current?.focus();
    return () => {
      alive = false;
    };
  }, []);

  const byEmoji = useMemo(() => {
    const map = new Map<string, Emoji>();
    for (const g of groups ?? []) for (const e of g.emojis) map.set(e.e, e);
    return map;
  }, [groups]);

  const show = (e: Emoji) => (tone && e.skins ? e.skins[tone - 1] : e.e);

  function pick(e: Emoji, keepOpen: boolean) {
    const value = show(e);
    const next = [e.e, ...recent.filter((r) => r !== e.e)].slice(0, 27);
    setRecent(next);
    writeStore(RECENT_KEY, next);
    onPick(value, keepOpen);
  }

  const results = useMemo(() => {
    const q = normalize(query.trim());
    if (!q || !groups) return null;
    const words = q.split(/\s+/);
    const out: Emoji[] = [];
    for (const g of groups) for (const e of g.emojis) if (words.every((w) => e.search.includes(w))) out.push(e);
    // começa com a palavra primeiro (ex.: "gato" antes de "carrapato")
    const starts = (e: Emoji) => (normalize(e.label).startsWith(words[0]) ? 0 : 1);
    return out.sort((a, b) => starts(a) - starts(b));
  }, [query, groups]);

  const recentEmojis = recent.map((r) => byEmoji.get(r)).filter(Boolean) as Emoji[];
  const sections: Group[] = groups
    ? [
        ...(recentEmojis.length
          ? [
              {
                key: 'recent',
                label: 'Usados recentemente',
                icon: <Clock size={17} />,
                emojis: recentEmojis,
              },
            ]
          : []),
        ...groups,
      ]
    : [];

  function jump(key: string) {
    setQuery('');
    setActiveGroup(key);
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-group="${key}"]`);
      if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - 4;
    });
  }

  function onScroll() {
    const sc = scroller.current;
    if (!sc || results) return;
    let current = sections[0]?.key;
    for (const el of sc.querySelectorAll<HTMLElement>('[data-group]')) if (el.offsetTop - 40 <= sc.scrollTop) current = el.dataset.group!;
    if (current && current !== activeGroup) setActiveGroup(current);
  }

  const cell = (e: Emoji) => (
    <button
      key={e.e}
      type="button"
      onClick={(ev) => pick(e, ev.shiftKey)}
      onMouseEnter={() => setHover({ e: show(e), label: e.label })}
      aria-label={e.label}
      className="flex h-10 w-10 items-center justify-center rounded-xl text-[26px] leading-none transition-transform hover:scale-110 hover:bg-surface-4 focus-visible:bg-surface-4 focus-visible:outline-none"
    >
      {show(e)}
    </button>
  );

  return (
    <div
      role="dialog"
      aria-label="Emojis"
      className="absolute right-0 bottom-full z-40 mb-3 flex h-[440px] w-[min(392px,calc(100vw-24px))] animate-pop-in flex-col overflow-hidden rounded-3xl bg-popover shadow-2xl ring-1 ring-line"
    >
      {/* busca + tom de pele */}
      <div className="flex items-center gap-2 p-3 pb-2">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-2xl bg-surface-0 px-3 ring-1 ring-line focus-within:ring-accent">
          <Search size={15} className="shrink-0 text-fg-subtle" />
          <span className="sr-only">Procurar emoji</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Procurar emoji (ex.: risada, gato, fogo)"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
          />
          {query && (
            <button type="button" aria-label="Limpar busca" onClick={() => setQuery('')} className="text-fg-subtle hover:text-fg">
              <X size={15} />
            </button>
          )}
        </label>
        <div className="relative">
          <button
            type="button"
            onClick={() => setToneOpen(!toneOpen)}
            title={`Tom de pele: ${TONE_NAMES[tone]}`}
            aria-label={`Tom de pele: ${TONE_NAMES[tone]}`}
            aria-expanded={toneOpen}
            className="flex h-10 w-10 items-center justify-center rounded-2xl text-[22px] hover:bg-surface-4"
          >
            {TONES[tone]}
          </button>
          {toneOpen && (
            <div className="absolute top-full right-0 z-10 mt-1 flex flex-col rounded-2xl bg-surface-1 p-1 shadow-xl ring-1 ring-line">
              {TONES.map((t, i) => (
                <button
                  key={t}
                  type="button"
                  title={TONE_NAMES[i]}
                  aria-label={TONE_NAMES[i]}
                  onClick={() => {
                    setTone(i);
                    writeStore(TONE_KEY, i);
                    setToneOpen(false);
                  }}
                  className={cx('flex h-9 w-9 items-center justify-center rounded-xl text-[20px] hover:bg-surface-4', i === tone && 'bg-surface-4')}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* categorias */}
      <div className="flex shrink-0 gap-0.5 border-b border-line px-2 pb-2">
        {sections.map((g) => (
          <button
            key={g.key}
            type="button"
            title={g.label}
            aria-label={g.label}
            onClick={() => jump(g.key)}
            className={cx(
              'flex h-8 flex-1 items-center justify-center rounded-xl transition-colors',
              !results && activeGroup === g.key ? 'bg-accent/15 text-accent' : 'text-fg-subtle hover:bg-surface-4 hover:text-fg',
            )}
          >
            {g.icon}
          </button>
        ))}
      </div>

      {/* grade */}
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2">
        {!groups ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-subtle">Carregando emojis…</div>
        ) : results ? (
          results.length ? (
            <section>
              <h3 className="sticky top-0 z-[1] bg-popover px-1.5 py-1.5 text-xs font-bold text-fg-subtle">Resultados para “{query.trim()}”</h3>
              <div className="grid grid-cols-[repeat(auto-fill,40px)] justify-between">{results.map(cell)}</div>
            </section>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-fg-subtle">
              <span className="text-4xl">🔍</span>
              Nenhum emoji com “{query.trim()}”
            </div>
          )
        ) : (
          sections.map((g) => (
            <section
              key={g.key}
              data-group={g.key}
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: `auto ${Math.ceil(g.emojis.length / 9) * 40 + 32}px`,
              }}
            >
              <h3 className="sticky top-0 z-[1] bg-popover px-1.5 py-1.5 text-xs font-bold text-fg-subtle">{g.label}</h3>
              <div className="grid grid-cols-[repeat(auto-fill,40px)] justify-between">{g.emojis.map(cell)}</div>
            </section>
          ))
        )}
      </div>

      {/* rodapé: o emoji em destaque e o nome dele */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line bg-surface-1/60 px-4">
        {hover ? (
          <>
            <span className="text-[28px] leading-none">{hover.e}</span>
            <span className="truncate text-sm font-semibold first-letter:uppercase">{hover.label}</span>
          </>
        ) : (
          <span className="text-xs text-fg-subtle">Clique para colocar · Shift + clique para colocar vários</span>
        )}
      </div>
    </div>
  );
}
