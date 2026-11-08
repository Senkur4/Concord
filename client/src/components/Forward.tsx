import { Check, Copy, CornerUpRight, Hash, Search, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { P, has } from '../../../shared/permissions.ts';
import { api } from '../lib/api';
import type { Message, ServerDetail } from '../lib/types';
import { useApp } from '../store/app';
import { toast } from '../store/toast';
import { Avatar, Button, IconButton, Modal, Spinner, cx } from './ui';

/**
 * Encaminhar uma mensagem para outras conversas (até 5 de uma vez) e copiar o texto dela.
 * A cópia encaminhada leva o texto, os anexos e quem escreveu de verdade (ver /forward no servidor).
 */

export interface Forwarded {
  authorId: string;
  authorName: string;
  from: string;
  at: number;
}

export const forwardedOf = (m: Pick<Message, 'data'>) => (m.data as { forwarded?: Forwarded } | null | undefined)?.forwarded ?? null;

/** Dá para encaminhar: texto (com ou sem anexos) e figurinhas. */
export const canForward = (m: Message) => (m.kind ?? 'text') === 'text' || m.kind === 'sticker';

type Source = { type: 'channel' | 'dm'; message: Message };
const useForward = create<{ source: Source | null; open: (s: Source) => void; close: () => void }>((set) => ({
  source: null,
  open: (source) => set({ source }),
  close: () => set({ source: null }),
}));

export function ForwardButton({ type, message }: { type: 'channel' | 'dm'; message: Message }) {
  return (
    <IconButton label="Encaminhar" className="h-8 w-8" onClick={() => useForward.getState().open({ type, message })}>
      <Send size={14} />
    </IconButton>
  );
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // sem a API (endereço http sem a liberação do navegador): o jeito antigo
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  }
}

export function CopyTextButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Copiado!' : 'Copiar texto'}
      className={cx('h-8 w-8', done && 'text-ok hover:text-ok')}
      onClick={() =>
        void copyText(text).then((ok) => {
          if (!ok) return toast.error('Não consegui copiar. Selecione o texto e use Ctrl+C.');
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}

/** Linha "Encaminhada" acima do conteúdo de uma mensagem encaminhada. */
export function ForwardedTag({ forwarded }: { forwarded: Forwarded }) {
  const when = new Date(forwarded.at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' });
  return (
    <div className="mb-1 flex max-w-full items-center gap-1.5 text-xs text-fg-subtle">
      <CornerUpRight size={13} className="shrink-0" />
      <span className="font-semibold italic">Encaminhada</span>
      <span className="truncate">
        · de <b className="font-semibold text-fg-muted not-italic">{forwarded.authorName}</b> em {forwarded.from} · {when}
      </span>
    </div>
  );
}

// ---------- a janela ----------

interface Target {
  key: string;
  type: 'channel' | 'dm';
  id: string;
  label: string;
  sub: string;
  avatar?: { name: string; color: string; src: string | null };
}

const MAX = 5;
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export function ForwardHost() {
  const source = useForward((s) => s.source);
  return source ? <ForwardModal key={source.message.id} source={source} /> : null;
}

function ForwardModal({ source }: { source: Source }) {
  const close = useForward((s) => s.close);
  const dms = useApp((s) => s.dms);
  const servers = useApp((s) => s.servers);
  const [details, setDetails] = useState<ServerDetail[] | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all(servers.map((s) => api.get<ServerDetail>(`/servers/${s.id}`).catch(() => null))).then(
      (list) => alive && setDetails(list.filter(Boolean) as ServerDetail[]),
    );
    return () => {
      alive = false;
    };
  }, [servers]);

  const targets = useMemo(() => {
    const list: Target[] = [];
    for (const dm of dms ?? []) {
      if (source.type === 'dm' && dm.id === source.message.channelId) continue;
      list.push({
        key: `dm:${dm.id}`,
        type: 'dm',
        id: dm.id,
        label: dm.user.displayName,
        sub: `@${dm.user.username} · conversa privada`,
        avatar: { name: dm.user.displayName, color: dm.user.avatarColor, src: dm.user.avatarUrl },
      });
    }
    for (const d of details ?? []) {
      for (const c of d.channels) {
        if (c.type !== 'text' || !has(c.permissions, P.SEND_MESSAGES)) continue;
        if (source.type === 'channel' && c.id === source.message.channelId) continue;
        list.push({ key: `channel:${c.id}`, type: 'channel', id: c.id, label: c.name, sub: d.server.name });
      }
    }
    return list;
  }, [dms, details, source]);

  const q = norm(query.trim());
  const shown = q ? targets.filter((t) => norm(`${t.label} ${t.sub}`).includes(q)) : targets;
  const byKey = new Map(targets.map((t) => [t.key, t]));

  function toggle(key: string) {
    if (picked.includes(key)) return setPicked(picked.filter((k) => k !== key));
    if (picked.length >= MAX) return toast.info(`Dá para encaminhar para até ${MAX} conversas de uma vez.`);
    setPicked([...picked, key]);
  }

  async function send() {
    if (!picked.length) return;
    setSending(true);
    try {
      const chosen = picked.map((k) => byKey.get(k)!).filter(Boolean);
      await api.post('/forward', { source: { type: source.type, messageId: source.message.id }, targets: chosen.map((t) => ({ type: t.type, id: t.id })) });
      toast.success(chosen.length === 1 ? `Encaminhada para ${chosen[0].type === 'channel' ? '#' : ''}${chosen[0].label}` : `Encaminhada para ${chosen.length} conversas`);
      close();
    } catch (err) {
      toast.error(err);
    }
    setSending(false);
  }

  const m = source.message;
  const preview =
    m.kind === 'sticker' ? 'Figurinha' : m.content || (m.attachments?.length ? `${m.attachments.length} anexo${m.attachments.length > 1 ? 's' : ''}` : '');

  return (
    <Modal
      title="Encaminhar mensagem"
      subtitle={`Escolha até ${MAX} conversas.`}
      width={480}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancelar
          </Button>
          <Button disabled={!picked.length} loading={sending} onClick={() => void send()}>
            <Send size={15} /> Encaminhar{picked.length > 1 ? ` (${picked.length})` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* a mensagem que vai */}
        <div className="flex gap-3 rounded-2xl bg-surface-0 p-3 ring-1 ring-line">
          <Avatar name={m.author.displayName} color={m.author.avatarColor} src={m.author.avatarUrl} size={32} />
          <div className="min-w-0 text-sm">
            <div className="font-bold">{forwardedOf(m)?.authorName ?? m.author.displayName}</div>
            <p className="line-clamp-3 break-words whitespace-pre-wrap text-fg-muted">{preview}</p>
            {!!m.attachments?.length && m.content && <p className="mt-1 text-xs text-fg-subtle">+ {m.attachments.length} anexo(s)</p>}
          </div>
        </div>

        <label className="flex h-10 items-center gap-2 rounded-2xl bg-surface-0 px-3 ring-1 ring-line focus-within:ring-accent">
          <Search size={15} className="shrink-0 text-fg-subtle" />
          <span className="sr-only">Procurar conversa</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Procurar pessoa, canal ou servidor"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
          />
        </label>

        <div className="-mx-2 max-h-[340px] overflow-y-auto px-2">
          {!details && !targets.length ? (
            <div className="flex justify-center py-8">
              <Spinner size={22} />
            </div>
          ) : !shown.length ? (
            <p className="py-8 text-center text-sm text-fg-subtle">{q ? `Nada com “${query.trim()}”.` : 'Nenhuma conversa para encaminhar.'}</p>
          ) : (
            <ul className="space-y-0.5" aria-label="Conversas">
              {shown.map((t) => {
                const on = picked.includes(t.key);
                return (
                  <li key={t.key}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggle(t.key)}
                      className={cx('flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors', on ? 'bg-accent/12' : 'hover:bg-surface-3')}
                    >
                      {t.avatar ? (
                        <Avatar name={t.avatar.name} color={t.avatar.color} src={t.avatar.src} size={34} />
                      ) : (
                        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl bg-surface-3 text-fg-muted">
                          <Hash size={17} />
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{t.label}</span>
                        <span className="block truncate text-xs text-fg-subtle">{t.sub}</span>
                      </span>
                      <span
                        className={cx(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-2 transition-colors',
                          on ? 'bg-accent text-on-accent ring-accent' : 'ring-line-strong',
                        )}
                      >
                        {on && <Check size={13} strokeWidth={3} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
