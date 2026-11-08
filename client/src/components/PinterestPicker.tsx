import { Check, ExternalLink, Link2, Pin, Search } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { getToken } from '../lib/api';
import { Button, Modal, cx } from './ui';

/**
 * "Buscar no Pinterest": abre o Pinterest numa aba ao lado e a pessoa cola aqui o link do pin (ou arrasta a imagem,
 * ou cola a imagem com Ctrl+V). O servidor pega a imagem do pin (ver server/src/pinterest.ts) e ela aparece na prévia.
 */

const PINTEREST_RED = 'bg-[#e0213a] text-white hover:bg-[#c81d33] focus-visible:outline-[#e0213a]';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Botão vermelho "Buscar no Pinterest", ao lado dos botões de escolher imagem. */
export function PinterestButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2', PINTEREST_RED, className)}
    >
      <Pin size={15} /> Buscar no Pinterest
    </button>
  );
}

/** Versão redonda (só o alfinete), para a foto de perfil. O nome aparece ao passar o mouse. */
export function PinterestBubble({ onClick }: { onClick: () => void }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label="Buscar no Pinterest"
        className={cx('flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2', PINTEREST_RED)}
      >
        <Pin size={16} />
      </button>
      <span className="pointer-events-none absolute top-1/2 left-11 z-10 -translate-y-1/2 rounded-lg bg-surface-0 px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-fg opacity-0 shadow-lg ring-1 ring-line transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        Buscar no Pinterest
      </span>
    </span>
  );
}

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; file: File; preview: string } | { kind: 'error'; message: string };

const looksLikeLink = (text: string) => /(pinterest\.|pin\.it|pinimg\.com)/i.test(text);

async function fetchPin(url: string): Promise<File> {
  const token = getToken();
  const res = await fetch('/api/pinterest/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Erro ${res.status}`);
  }
  const blob = await res.blob();
  return new File([blob], 'pinterest', { type: blob.type || 'image/jpeg' });
}

export function PinterestPicker({
  title,
  target,
  applyLabel = 'Usar esta imagem',
  onUse,
  onClose,
}: {
  /** ex.: "Capa do Pinterest" */
  title: string;
  /** para onde a imagem vai, ex.: "Capa com Fundo de Mini-Perfil" */
  target: string;
  applyLabel?: string;
  /** recebe a imagem escolhida; se der certo a janela fecha */
  onUse: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [applying, setApplying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const request = useRef(0);
  const preview = state.kind === 'ready' ? state.preview : null;

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  function takeFile(file: File) {
    if (!IMAGE_TYPES.includes(file.type)) {
      setState({ kind: 'error', message: 'Formato não suportado (use PNG, JPG, GIF ou WEBP)' });
      return;
    }
    request.current++;
    setState({ kind: 'ready', file, preview: URL.createObjectURL(file) });
  }

  async function resolve(text: string) {
    const url = text.trim();
    if (!url) return setState({ kind: 'idle' });
    if (!looksLikeLink(url)) return setState({ kind: 'error', message: 'Cole o link de um pin do Pinterest (pinterest.com ou pin.it).' });
    const id = ++request.current;
    setState({ kind: 'loading' });
    try {
      const file = await fetchPin(url);
      if (id === request.current) setState({ kind: 'ready', file, preview: URL.createObjectURL(file) });
    } catch (err) {
      if (id === request.current) setState({ kind: 'error', message: err instanceof Error ? err.message : 'Não consegui pegar a imagem' });
    }
  }

  // procura sozinho pouco depois de colar ou digitar o link
  useEffect(() => {
    if (!link.trim()) return;
    const t = setTimeout(() => void resolve(link), 350);
    return () => clearTimeout(t);
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+V com uma imagem copiada (botão direito na imagem do pin > Copiar imagem)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        takeFile(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onDrop(e: ReactDragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) return takeFile(file);
    const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n').find((l) => l && !l.startsWith('#'));
    if (text) setLink(text.trim());
  }

  async function apply() {
    if (state.kind !== 'ready') return;
    setApplying(true);
    try {
      await onUse(state.file);
      onClose();
    } catch {
      // quem chamou já mostrou o erro
    }
    setApplying(false);
  }

  const searchUrl = query.trim() ? `https://br.pinterest.com/search/pins/?q=${encodeURIComponent(query.trim())}` : 'https://br.pinterest.com/';

  return (
    <Modal
      width={520}
      onClose={onClose}
      title={
        <span className="flex items-center gap-3">
          <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', PINTEREST_RED)}>
            <Pin size={17} />
          </span>
          {title}
        </span>
      }
      subtitle={`Vai para: ${target}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={state.kind !== 'ready'} loading={applying} onClick={() => void apply()}>
            {applyLabel}
          </Button>
        </>
      }
    >
      <div
        className={cx('space-y-5 rounded-2xl transition-shadow', dragging && 'ring-2 ring-accent ring-offset-4 ring-offset-surface-2')}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <section className="space-y-2">
          <span className="block text-xs font-bold text-fg-muted">1. Ache a imagem no Pinterest</span>
          <div className="flex gap-2">
            <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-2xl bg-surface-0 px-3.5 ring-1 ring-line focus-within:ring-accent">
              <Search size={16} className="shrink-0 text-fg-subtle" />
              <span className="sr-only">Pesquisar no Pinterest</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && window.open(searchUrl, '_blank', 'noopener')}
                placeholder="Ex.: anime paisagem céu"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
              />
            </label>
            <a
              href={searchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cx('inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors', PINTEREST_RED)}
            >
              Abrir <ExternalLink size={14} />
            </a>
          </div>
          <span className="block text-xs text-fg-subtle">Abre o Pinterest numa aba ao lado, já pesquisando.</span>
        </section>

        <section className="space-y-2">
          <span className="block text-xs font-bold text-fg-muted">2. Cole o link do pin (ou arraste a imagem para cá)</span>
          <label
            className={cx(
              'flex h-11 items-center gap-2 rounded-2xl bg-surface-0 px-3.5 ring-1 focus-within:ring-accent',
              state.kind === 'error' ? 'ring-red-400/70' : 'ring-line',
            )}
          >
            <Link2 size={16} className="shrink-0 text-fg-subtle" />
            <span className="sr-only">Link do pin</span>
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://pin.it/…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
            />
          </label>
          <span className="block text-xs text-fg-subtle">No pin: Compartilhar → Copiar link. Ou botão direito na imagem → Copiar imagem, e Ctrl+V aqui.</span>
        </section>

        <section className="flex items-stretch gap-4">
          <div
            className={cx(
              'flex h-48 w-36 shrink-0 items-center justify-center overflow-hidden rounded-2xl text-center text-xs text-fg-subtle',
              preview ? 'bg-surface-0 ring-1 ring-line' : 'border-2 border-dashed border-line p-3',
            )}
          >
            {preview ? <img src={preview} alt="Prévia da imagem do pin" className="h-full w-full object-cover" /> : state.kind === 'loading' ? 'Buscando…' : 'Prévia da imagem do pin'}
          </div>
          <div className="flex min-w-0 flex-col justify-center gap-2 text-sm">
            {state.kind === 'ready' && (
              <span className="flex items-center gap-2 font-medium text-fg-muted">
                <Check size={16} className="text-green-400" /> Imagem encontrada
              </span>
            )}
            {state.kind === 'loading' && <span className="text-fg-muted">Pegando a imagem do pin…</span>}
            {state.kind === 'error' && (
              <span role="alert" className="text-red-300">
                {state.message}
              </span>
            )}
            <span className="text-xs leading-relaxed text-fg-subtle">
              {state.kind === 'ready' ? 'Se for essa, é só usar.' : 'A imagem aparece aqui assim que você colar o link.'}
            </span>
          </div>
        </section>
      </div>
    </Modal>
  );
}
