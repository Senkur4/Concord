// Anexos nas conversas (canais, chat da call e DMs): o arquivo sobe assim que é escolhido e só
// aparece para alguém quando a mensagem é enviada junto com ele.
import { Check, Download, FileText, Hourglass, Infinity as InfinityIcon, Paperclip, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { uploadInChunks, type UploadProgress } from '../lib/chunkUpload';
import type { Attachment } from '../lib/types';
import { useApp } from '../store/app';
import { toast } from '../store/toast';
import { Spinner, cx } from './ui';

const MAX_FILES = 10;
// o servidor confere de novo; aqui é só para avisar antes de enviar
const ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.log,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.zip,.rar,.7z,.mp3,.ogg,.wav,.m4a,.flac,.mp4,.webm,.mov,.mkv';
const ALLOWED = new Set(ACCEPT.split(',').map((e) => e.slice(1)));

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}

/** "faltam 3 min" a partir do que falta e da velocidade */
function eta(left: number, speed: number) {
  if (speed < 1) return '';
  const s = left / speed;
  if (s < 60) return `faltam ${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `faltam ${Math.round(s / 60)} min`;
  return `faltam ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

interface Pending {
  key: string;
  name: string;
  size: number;
  progress?: UploadProgress;
  done?: Attachment;
  abort: AbortController;
}

/** Arquivos escolhidos para a próxima mensagem (e por quanto tempo vão ficar). */
export function useAttachmentDraft() {
  const [items, setItems] = useState<Pending[]>([]);
  /** validade em segundos; null = para sempre */
  const [expiresIn, setExpiresIn] = useState<number | null>(null);

  // fechar a página no meio de um envio grande perde o progresso: pede confirmação
  const busy = items.some((p) => !p.done);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  function add(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    if (items.length + list.length > MAX_FILES) return toast.error(`Até ${MAX_FILES} arquivos por mensagem`);
    for (const file of list) {
      const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
      // imagem colada da área de transferência vem sem nome
      const named = ext ? file : new File([file], `imagem.${file.type.split('/')[1] || 'png'}`, { type: file.type });
      const realExt = ext || named.name.split('.').pop()!;
      if (!ALLOWED.has(realExt)) {
        toast.error(`"${file.name}": tipo de arquivo não permitido`);
        continue;
      }
      if (!named.size) {
        toast.error(`"${file.name}" está vazio`);
        continue;
      }
      const key = crypto.randomUUID();
      const abort = new AbortController();
      setItems((cur) => [...cur, { key, name: named.name, size: named.size, abort }]);
      uploadInChunks(named, (progress) => setItems((cur) => cur.map((p) => (p.key === key ? { ...p, progress } : p))), abort.signal).then(
        (done) => setItems((cur) => cur.map((p) => (p.key === key ? { ...p, done } : p))),
        (err) => {
          if ((err as Error).name === 'AbortError') return;
          setItems((cur) => cur.filter((p) => p.key !== key));
          toast.error(`"${named.name}": ${(err as Error).message}`);
        },
      );
    }
  }

  return {
    items,
    add,
    remove: (key: string) =>
      setItems((cur) => {
        cur.find((p) => p.key === key && !p.done)?.abort.abort(); // tirou no meio do envio: cancela
        return cur.filter((p) => p.key !== key);
      }),
    clear: () => {
      setItems([]);
      setExpiresIn(null);
    },
    /** algum arquivo ainda subindo: espera antes de enviar */
    uploading: busy,
    ids: items.flatMap((p) => (p.done ? [p.done.id] : [])),
    expiresIn,
    setExpiresIn,
    /** colar (Ctrl+V) um print ou arquivo direto no campo de mensagem */
    onPaste: (e: ClipboardEvent) => {
      if (e.clipboardData.files.length) {
        e.preventDefault();
        add(e.clipboardData.files);
      }
    },
    /** arrastar arquivos para cima do campo de mensagem */
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      add(e.dataTransfer.files);
    },
  };
}

/** Botão de clipe ao lado do campo de mensagem. */
/** Abre o seletor de arquivos para anexar (usado pelo menu + do chat estreito, que não tem o botão de clipe). */
export function pickAttachments(): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT;
    input.onchange = () => resolve(input.files);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function AttachButton({ onFiles, disabled }: { onFiles: (files: FileList) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        aria-label="Anexar arquivo"
        title="Anexar arquivo"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="flex h-[50px] w-[50px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Paperclip size={19} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Arquivos esperando o envio, logo acima do campo de mensagem (com o progresso e a validade). */
export function PendingAttachments({
  items,
  onRemove,
  expiresIn,
  onExpiresIn,
}: {
  items: Pending[];
  onRemove: (key: string) => void;
  expiresIn?: number | null;
  onExpiresIn?: (v: number | null) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mb-2 space-y-2">
      <div className="flex flex-wrap gap-2">
        {items.map((p) => {
          const pr = p.progress;
          const pct = p.done ? 100 : pr ? Math.floor((pr.sent / Math.max(1, pr.total)) * 100) : 0;
          return (
            <span key={p.key} className="relative flex w-72 max-w-full items-center gap-2.5 overflow-hidden rounded-2xl bg-surface-3 py-2 pr-1.5 pl-3 text-sm">
              {/* barra de progresso no fundo do cartão */}
              {!p.done && <span className="absolute inset-y-0 left-0 bg-accent/15 transition-[width] duration-300" style={{ width: `${pct}%` }} aria-hidden="true" />}
              <span className="relative shrink-0">
                {p.done ? (
                  <FileText size={16} className="text-fg-muted" />
                ) : pr?.retrying ? (
                  <RotateCw size={15} className="animate-spin text-warn" />
                ) : (
                  <Spinner size={15} />
                )}
              </span>
              <span className="relative min-w-0 flex-1">
                <span className="block truncate font-semibold">{p.name}</span>
                <span className="block truncate text-[11px] text-fg-subtle">
                  {p.done
                    ? formatSize(p.size)
                    : pr?.retrying
                      ? `Conexão caiu, continuando de ${pct}%…`
                      : `${pct}% de ${formatSize(p.size)}${pr && pr.speed > 0 ? ` · ${formatSize(pr.speed)}/s · ${eta(pr.total - pr.sent, pr.speed)}` : ''}`}
                </span>
              </span>
              <button
                type="button"
                aria-label={p.done ? `Remover ${p.name}` : `Cancelar o envio de ${p.name}`}
                title={p.done ? 'Remover' : 'Cancelar o envio'}
                onClick={() => onRemove(p.key)}
                className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface-4 hover:text-fg"
              >
                <X size={14} />
              </button>
            </span>
          );
        })}
      </div>
      {onExpiresIn && <ExpiryPicker value={expiresIn ?? null} onChange={onExpiresIn} />}
    </div>
  );
}

// ---------- validade ----------

const HOUR = 3600;
const DAY = 86400;

export function expiryLabel(seconds: number | null) {
  if (!seconds) return 'Fica para sempre';
  if (seconds < HOUR) return `Some em ${Math.round(seconds / 60)} minutos`;
  if (seconds < DAY || seconds % DAY !== 0) {
    const h = Math.round(seconds / HOUR);
    return `Some em ${h} ${h === 1 ? 'hora' : 'horas'}`;
  }
  const d = seconds / DAY;
  return `Some em ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

/** Por quanto tempo a mensagem (e os arquivos) ficam: para sempre, 5 a 55 minutos, 1 a 24 horas ou 1 a 30 dias. */
export function ExpiryPicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'forever' | 'minutes' | 'hours' | 'days'>(
    !value ? 'forever' : value < HOUR ? 'minutes' : value % DAY === 0 && value >= DAY ? 'days' : 'hours',
  );
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const nums =
    tab === 'minutes'
      ? Array.from({ length: 11 }, (_, i) => (i + 1) * 5)
      : tab === 'hours'
        ? Array.from({ length: 24 }, (_, i) => i + 1)
        : Array.from({ length: 30 }, (_, i) => i + 1);
  const unit = tab === 'minutes' ? 60 : tab === 'hours' ? HOUR : DAY;
  const word = (n: number) => (tab === 'minutes' ? 'minutos' : tab === 'hours' ? (n === 1 ? 'hora' : 'horas') : n === 1 ? 'dia' : 'dias');
  const short = tab === 'minutes' ? 'min' : tab === 'hours' ? 'h' : 'd';

  return (
    <div ref={wrap} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cx(
          'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold ring-1 transition-colors',
          value ? 'bg-warn/12 text-warn ring-warn/30 hover:bg-warn/20' : 'bg-surface-3 text-fg-muted ring-line hover:text-fg',
        )}
      >
        {value ? <Hourglass size={13} /> : <InfinityIcon size={14} />}
        {expiryLabel(value)}
      </button>
      {open && (
        <div role="dialog" aria-label="Validade da mensagem" className="absolute bottom-full left-0 z-40 mb-2 w-[300px] animate-pop-in rounded-3xl bg-popover p-3 shadow-2xl ring-1 ring-line">
          <p className="mb-2 px-1 text-xs text-fg-subtle">Quando o tempo acabar, a mensagem e os arquivos são apagados para todo mundo.</p>
          <div role="tablist" className="mb-3 grid grid-cols-4 gap-1 rounded-2xl bg-surface-3 p-1">
            {(
              [
                ['forever', 'Sempre'],
                ['minutes', 'Minutos'],
                ['hours', 'Horas'],
                ['days', 'Dias'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => {
                  setTab(id);
                  if (id === 'forever') {
                    onChange(null);
                    setOpen(false);
                  }
                }}
                className={cx('rounded-xl py-1.5 text-xs font-semibold', tab === id ? 'bg-accent text-on-accent' : 'text-fg-muted hover:text-fg')}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'forever' ? (
            <p className="flex items-center gap-2 px-1 pb-1 text-sm text-fg-muted">
              <Check size={15} className="text-ok" /> A mensagem fica até alguém apagar.
            </p>
          ) : (
            <div className={cx('grid gap-1', tab === 'minutes' ? 'grid-cols-4' : 'grid-cols-6')} aria-label={tab === 'minutes' ? 'Minutos' : tab === 'hours' ? 'Horas' : 'Dias'}>
              {nums.map((n) => {
                const v = n * unit;
                const on = value === v;
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${n} ${word(n)}`}
                    onClick={() => {
                      onChange(v);
                      setOpen(false);
                    }}
                    className={cx('h-9 rounded-xl text-sm font-semibold tabular-nums transition-colors', on ? 'bg-accent text-on-accent' : 'bg-surface-3 hover:bg-surface-4')}
                  >
                    {n}
                    <span className="text-[10px] font-medium opacity-70">{short}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "⏳ some em 3 h" na mensagem que tem validade (atualiza sozinho). */
export function ExpiryBadge({ expiresAt }: { expiresAt: number | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const left = Math.max(0, expiresAt - Date.now()) / 1000;
  const text =
    left < 60 ? 'some em instantes' : left < HOUR ? `some em ${Math.ceil(left / 60)} min` : left < DAY ? `some em ${Math.round(left / HOUR)} h` : `some em ${Math.round(left / DAY)} ${Math.round(left / DAY) === 1 ? 'dia' : 'dias'}`;
  const when = new Date(expiresAt).toLocaleString('pt-BR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-semibold text-warn" title={`Apagada em ${when}`}>
      <Hourglass size={11} /> {text}
    </span>
  );
}

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv)$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|flac)$/i;

/**
 * Vídeo que toca na própria conversa. "Leve": o navegador só baixa o começo (para mostrar a primeira imagem e a
 * duração) e depois vai buscando só o trecho que está assistindo; um vídeo de 700 MB não é baixado inteiro.
 * Formato que o navegador não toca (alguns MKV) vira o cartão de baixar.
 */
function VideoAttachment({ a }: { a: Attachment }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <FileCard a={a} />;
  return (
    <figure className="w-[min(480px,100%)] overflow-hidden rounded-2xl bg-black ring-1 ring-line">
      <video
        controls
        preload="metadata"
        playsInline
        // #t=0.1: mostra a primeira imagem do vídeo no lugar de um quadro preto
        src={`${a.url}#t=0.1`}
        onError={() => setBroken(true)}
        className="block max-h-[360px] w-full bg-black"
      />
      <figcaption className="flex items-center gap-2 bg-surface-3 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-semibold">{a.name}</span>
        <span className="shrink-0 text-fg-subtle">{formatSize(a.size)}</span>
        <a href={a.url} download={a.name} title="Baixar" aria-label={`Baixar ${a.name}`} className="shrink-0 text-fg-muted hover:text-fg">
          <Download size={15} />
        </a>
      </figcaption>
    </figure>
  );
}

function AudioAttachment({ a }: { a: Attachment }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <FileCard a={a} />;
  return (
    <div className="w-80 max-w-full rounded-2xl bg-surface-3 p-3 ring-1 ring-line">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-semibold">{a.name}</span>
        <span className="shrink-0 text-fg-subtle">{formatSize(a.size)}</span>
        <a href={a.url} download={a.name} title="Baixar" aria-label={`Baixar ${a.name}`} className="shrink-0 text-fg-muted hover:text-fg">
          <Download size={15} />
        </a>
      </div>
      <audio controls preload="metadata" src={a.url} onError={() => setBroken(true)} className="w-full" />
    </div>
  );
}

function FileCard({ a }: { a: Attachment }) {
  return (
    <a
      href={a.url}
      download={a.name}
      className="flex w-72 max-w-full items-center gap-3 rounded-2xl bg-surface-3 p-3 ring-1 ring-line transition-colors hover:bg-surface-4"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
        <FileText size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{a.name}</span>
        <span className="block text-xs text-fg-muted">{formatSize(a.size)}</span>
      </span>
      <Download size={17} className="shrink-0 text-fg-muted" />
    </a>
  );
}

/** Anexos dentro da mensagem: imagem com prévia (clique amplia), vídeo e áudio tocam ali mesmo, o resto é cartão para baixar. */
export function MessageAttachments({ items }: { items: Attachment[] | undefined }) {
  const openModal = useApp((s) => s.openModal);
  if (!items?.length) return null;
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {items.map((a) =>
        a.image ? (
          <button key={a.id} onClick={() => openModal({ type: 'image', src: a.url, alt: a.name })} className="block overflow-hidden rounded-2xl">
            <img src={a.url} alt={a.name} loading="lazy" className="max-h-72 max-w-full rounded-2xl object-contain" />
          </button>
        ) : VIDEO_EXT.test(a.name) ? (
          <VideoAttachment key={a.id} a={a} />
        ) : AUDIO_EXT.test(a.name) ? (
          <AudioAttachment key={a.id} a={a} />
        ) : (
          <FileCard key={a.id} a={a} />
        ),
      )}
    </div>
  );
}
