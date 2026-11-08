import { Smile } from 'lucide-react';
import { useEffect, useRef, useState, type InputHTMLAttributes, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Input, cx } from './ui';

// Emojis mais usados em nomes de canais e categorias. Qualquer outro também funciona: no Windows, Win + . abre o
// painel de emojis do sistema; no celular, o teclado já tem.
const GROUPS: { label: string; emojis: string[] }[] = [
  { label: 'Canais', emojis: ['💬', '📢', '📌', '📜', '❓', '💡', '🐞', '🔊', '🎤', '🎧', '📺', '🎬', '🍿', '📷', '🖼️', '🔗', '🔒', '⭐', '🏆', '🎉'] },
  { label: 'Jogos', emojis: ['🎮', '🕹️', '👾', '🎲', '♟️', '🃏', '⚔️', '🛡️', '🏹', '🔫', '🚀', '🏎️', '⚽', '🏀', '🧩', '🗺️', '⛏️', '🧱', '🐉', '👑'] },
  { label: 'Vibe', emojis: ['😂', '🤣', '😎', '🥶', '🔥', '💀', '👻', '🤡', '😈', '🫡', '👀', '🧠', '💯', '✨', '🌙', '☀️', '🌈', '❤️', '💜', '🖤'] },
  { label: 'Coisas', emojis: ['🎵', '🎶', '📚', '✏️', '💻', '🖥️', '📱', '🍕', '🍔', '🍺', '☕', '🧪', '🔬', '🩺', '💊', '🧬', '🐱', '🐶', '🌸', '🍀'] },
];

/** Botão com uma grade de emojis; chama onPick com o escolhido. */
export function EmojiPickerButton({ onPick, className }: { onPick: (emoji: string) => void; className?: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = pos !== null;
  const WIDTH = 300;

  function toggle() {
    if (open) return setPos(null);
    // a bandeja fica no body (por cima de modais com rolagem), alinhada ao botão e dentro da tela
    const r = buttonRef.current!.getBoundingClientRect();
    const height = 400;
    const below = r.bottom + 6 + height < window.innerHeight;
    setPos({
      top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - height),
      left: Math.min(Math.max(8, r.right - WIDTH), window.innerWidth - WIDTH - 8),
    });
  }

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setPos(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // fecha só a bandeja, não o modal
      setPos(null);
    };
    const reposition = () => setPos(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  return (
    <div className={cx('relative', className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Inserir emoji"
        title="Inserir emoji"
        aria-expanded={open}
        // não tira o foco (nem o cursor) do campo de texto
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        className={cx('flex h-11 w-11 items-center justify-center rounded-2xl text-fg-subtle transition-colors hover:bg-surface-4 hover:text-fg', open && 'text-fg')}
      >
        <Smile size={19} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: WIDTH }}
            className="fixed z-[1000] animate-pop-in rounded-2xl bg-popover p-2.5 shadow-2xl ring-1 ring-line"
          >
            {GROUPS.map((g) => (
              <div key={g.label} className="mb-1.5 last:mb-0">
                <div className="mb-1 px-1 text-[11px] font-bold text-fg-subtle">{g.label}</div>
                <div className="grid grid-cols-10 gap-0.5">
                  {g.emojis.map((emoji) => (
                    <button
                      type="button"
                      key={emoji}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onPick(emoji);
                        setPos(null);
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-lg hover:bg-surface-4"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="mt-2 border-t border-line px-1 pt-2 text-[11px] text-fg-subtle">
              Quer outro? No Windows, aperte <kbd className="rounded bg-surface-4 px-1">Win</kbd> + <kbd className="rounded bg-surface-4 px-1">.</kbd> no campo de texto.
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Insere texto onde está o cursor do campo (ou no fim) e devolve o novo valor. */
function insertAtCursor(input: HTMLInputElement | null, value: string, text: string, maxLength?: number) {
  const start = input?.selectionStart ?? value.length;
  const end = input?.selectionEnd ?? value.length;
  const next = value.slice(0, start) + text + value.slice(end);
  if (maxLength && next.length > maxLength) return null;
  requestAnimationFrame(() => {
    input?.focus();
    input?.setSelectionRange(start + text.length, start + text.length);
  });
  return next;
}

/** Campo de nome com o botão de emoji ao lado. */
export function NameInput({
  value,
  onValueChange,
  label,
  maxLength,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onValueChange: (v: string) => void; label?: string }) {
  const ref = useRef<HTMLInputElement>(null) as RefObject<HTMLInputElement>;
  return (
    <div className="flex items-end gap-1.5">
      <div className="min-w-0 flex-1">
        <Input {...props} label={label} ref={ref} value={value} maxLength={maxLength} onChange={(e) => onValueChange(e.target.value)} />
      </div>
      <EmojiPickerButton
        onPick={(emoji) => {
          const next = insertAtCursor(ref.current, value, emoji, maxLength);
          if (next !== null) onValueChange(next);
        }}
      />
    </div>
  );
}
