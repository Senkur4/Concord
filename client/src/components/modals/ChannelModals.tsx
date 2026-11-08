import { ArrowDown, ArrowUp, Check, FolderClosed, Hash, MessagesSquare, Slash, Trash2, Volume2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { P, PERMISSION_INFO, has } from '../../../../shared/permissions.ts';
import { api } from '../../lib/api';
import { useApp } from '../../store/app';
import { toast } from '../../store/toast';
import { Button, Input, Modal, RoleDot, Toggle, cx } from '../ui';
import { NameInput } from '../EmojiPicker';
import type { ServerDetail } from '../../lib/types';

const TYPE_INFO = {
  text: { icon: <Hash size={22} />, label: 'Texto', hint: 'Mensagens, links e imagens' },
  forum: { icon: <MessagesSquare size={22} />, label: 'Fórum', hint: 'Posts com votos e respostas: ideias, bugs, ajuda' },
  voice: { icon: <Volume2 size={22} />, label: 'Sala de voz', hint: 'Voz, câmera e transmissão de tela a 60 fps' },
} as const;

/** Seletor de categoria (some quando o servidor não tem nenhuma). */
function CategorySelect({ detail, value, onChange }: { detail: ServerDetail; value: string | null; onChange: (v: string | null) => void }) {
  const categories = [...(detail.categories ?? [])].sort((a, b) => a.position - b.position);
  if (!categories.length) return null;
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-bold text-fg-muted">Categoria</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-11 w-full rounded-2xl border border-transparent bg-surface-3 px-4 text-sm text-fg outline-none focus:border-accent"
      >
        <option value="">Sem categoria</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CreateChannelModal({ serverId, kind, categoryId: initialCategory = null }: { serverId: string; kind: 'text' | 'voice' | 'forum'; categoryId?: string | null }) {
  const close = useApp((s) => s.closeModal);
  const detail = useApp((s) => s.details[serverId]);
  const [type, setType] = useState(kind);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(initialCategory);
  const [isPrivate, setPrivate] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { id } = await api.post<{ id: string }>(`/servers/${serverId}/channels`, { name, type, private: isPrivate, categoryId });
      await useApp.getState().loadDetail(serverId);
      useApp.getState().openChannel(serverId, id);
      close();
    } catch (err) {
      toast.error(err);
      setLoading(false);
    }
  }

  return (
    <Modal title="Criar canal" onClose={close}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <span className="block text-xs font-bold tracking-wide text-fg-muted uppercase">Tipo de canal</span>
          {(['text', 'forum', 'voice'] as const).map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setType(t)}
              className={cx(
                'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                type === t ? 'border-accent bg-accent/10' : 'border-line bg-surface-0 hover:bg-surface-3',
              )}
            >
              {TYPE_INFO[t].icon}
              <div>
                <div className="font-semibold">{TYPE_INFO[t].label}</div>
                <div className="text-xs text-fg-muted">{TYPE_INFO[t].hint}</div>
              </div>
            </button>
          ))}
        </div>
        <NameInput label="Nome do canal" value={name} onValueChange={setName} placeholder={type === 'voice' ? '🔊 Nova sala' : type === 'forum' ? 'ideias' : 'novo-canal'} autoFocus required maxLength={50} />
        {detail && <CategorySelect detail={detail} value={categoryId} onChange={setCategoryId} />}
        <div className="flex items-center justify-between rounded-xl bg-surface-0 p-3">
          <div>
            <div className="text-sm font-semibold">Canal privado</div>
            <div className="text-xs text-fg-muted">Apenas cargos liberados nas permissões do canal poderão vê-lo.</div>
          </div>
          <Toggle checked={isPrivate} onChange={setPrivate} />
        </div>
        <Button type="submit" loading={loading} className="w-full" disabled={!name.trim()}>
          Criar canal
        </Button>
      </form>
    </Modal>
  );
}

export function ChannelSettingsModal({ serverId, channelId }: { serverId: string; channelId: string }) {
  const close = useApp((s) => s.closeModal);
  const openModal = useApp((s) => s.openModal);
  const detail = useApp((s) => s.details[serverId]);
  const channel = detail?.channels.find((c) => c.id === channelId);
  const [tab, setTab] = useState<'overview' | 'perms'>('overview');
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [userLimit, setUserLimit] = useState(channel?.userLimit ?? 0);
  const [categoryId, setCategoryId] = useState<string | null>(channel?.categoryId ?? null);
  const [saving, setSaving] = useState(false);
  if (!detail || !channel) return null;

  async function save() {
    setSaving(true);
    try {
      const moved = categoryId !== (channel!.categoryId ?? null);
      await api.patch(`/channels/${channelId}`, { name, topic, userLimit, ...(moved ? { categoryId } : {}) });
      toast.success('Canal atualizado');
    } catch (err) {
      toast.error(err);
    }
    setSaving(false);
  }

  return (
    <Modal title={<span className="flex items-center gap-2">{channel.type === 'voice' ? <Volume2 size={20} /> : channel.type === 'forum' ? <MessagesSquare size={20} /> : <Hash size={20} />} {channel.name}</span>} onClose={close} width={720}>
      <div className="mb-5 flex gap-1 border-b border-line">
        {(['overview', 'perms'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx('-mb-px border-b-2 px-3 pb-2 text-sm font-semibold', tab === t ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg')}
          >
            {t === 'overview' ? 'Visão geral' : 'Permissões'}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <div className="space-y-4">
          <NameInput label="Nome" value={name} onValueChange={setName} maxLength={50} />
          <CategorySelect detail={detail} value={categoryId} onChange={setCategoryId} />
          {channel.type !== 'voice' ? (
            <Input label="Tópico" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} placeholder="Do que se trata este canal?" />
          ) : (
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold tracking-wide text-fg-muted uppercase">
                Limite de pessoas: {userLimit === 0 ? 'sem limite' : userLimit}
              </span>
              <input type="range" min={0} max={99} value={userLimit} onChange={(e) => setUserLimit(Number(e.target.value))} className="w-full" />
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} loading={saving}>
              Salvar alterações
            </Button>
            <Button variant="secondary" onClick={() => void api.patch(`/channels/${channelId}`, { move: 'up' }).catch(toast.error)}>
              <ArrowUp size={16} /> Subir
            </Button>
            <Button variant="secondary" onClick={() => void api.patch(`/channels/${channelId}`, { move: 'down' }).catch(toast.error)}>
              <ArrowDown size={16} /> Descer
            </Button>
            <div className="flex-1" />
            <Button
              variant="danger"
              onClick={() =>
                openModal({
                  type: 'confirm',
                  title: `Apagar ${channel.type !== 'voice' ? '#' : ''}${channel.name}`,
                  message: 'Este canal e todo o seu conteúdo serão apagados permanentemente.',
                  confirmLabel: 'Apagar canal',
                  danger: true,
                  onConfirm: async () => {
                    await api.del(`/channels/${channelId}`);
                  },
                })
              }
            >
              <Trash2 size={16} /> Apagar
            </Button>
          </div>
        </div>
      ) : (
        <ChannelPermissions serverId={serverId} channelId={channelId} />
      )}
    </Modal>
  );
}

export function CreateCategoryModal({ serverId }: { serverId: string }) {
  const close = useApp((s) => s.closeModal);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post(`/servers/${serverId}/categories`, { name });
      await useApp.getState().loadDetail(serverId);
      close();
    } catch (err) {
      toast.error(err);
      setLoading(false);
    }
  }

  return (
    <Modal title={<span className="flex items-center gap-2"><FolderClosed size={20} /> Criar categoria</span>} onClose={close}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-fg-muted">Agrupe salas e canais, como no Discord. Depois, arraste os canais para dentro dela, ou escolha a categoria nas configurações do canal.</p>
        <NameInput label="Nome da categoria" value={name} onValueChange={setName} placeholder="🎮 Jogos" autoFocus required maxLength={50} />
        <Button type="submit" loading={loading} className="w-full" disabled={!name.trim()}>
          Criar categoria
        </Button>
      </form>
    </Modal>
  );
}

export function CategorySettingsModal({ serverId, categoryId }: { serverId: string; categoryId: string }) {
  const close = useApp((s) => s.closeModal);
  const openModal = useApp((s) => s.openModal);
  const detail = useApp((s) => s.details[serverId]);
  const category = detail?.categories?.find((c) => c.id === categoryId);
  const [name, setName] = useState(category?.name ?? '');
  const [saving, setSaving] = useState(false);
  if (!detail || !category) return null;
  const inside = detail.channels.filter((c) => c.categoryId === categoryId).length;

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/categories/${categoryId}`, { name });
      toast.success('Categoria atualizada');
    } catch (err) {
      toast.error(err);
    }
    setSaving(false);
  }

  return (
    <Modal title={<span className="flex items-center gap-2"><FolderClosed size={20} /> {category.name}</span>} onClose={close}>
      <div className="space-y-4">
        <NameInput label="Nome" value={name} onValueChange={setName} maxLength={50} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} loading={saving} disabled={!name.trim()}>
            Salvar alterações
          </Button>
          <Button variant="secondary" onClick={() => void api.patch(`/categories/${categoryId}`, { move: 'up' }).catch(toast.error)}>
            <ArrowUp size={16} /> Subir
          </Button>
          <Button variant="secondary" onClick={() => void api.patch(`/categories/${categoryId}`, { move: 'down' }).catch(toast.error)}>
            <ArrowDown size={16} /> Descer
          </Button>
          <div className="flex-1" />
          <Button
            variant="danger"
            onClick={() =>
              openModal({
                type: 'confirm',
                title: `Apagar a categoria "${category.name}"`,
                message: inside
                  ? `Os ${inside === 1 ? '1 canal' : `${inside} canais`} dela não serão apagados: ${inside === 1 ? 'ele volta' : 'eles voltam'} para fora de categoria.`
                  : 'A categoria está vazia.',
                confirmLabel: 'Apagar categoria',
                danger: true,
                onConfirm: async () => {
                  await api.del(`/categories/${categoryId}`);
                },
              })
            }
          >
            <Trash2 size={16} /> Apagar
          </Button>
        </div>
        <p className="text-xs text-fg-subtle">Dica: para mudar a ordem das categorias e dos canais, você também pode arrastar e soltar na barra lateral.</p>
      </div>
    </Modal>
  );
}

export const DEFAULT_GROUP_LABEL = { voice: 'Salas', forum: 'Fóruns', text: 'Conversas' } as const;
const GROUP_HINT = { voice: 'as salas de voz', forum: 'os fóruns', text: 'os canais de texto' } as const;

/** Renomear um grupo padrão (Salas, Fóruns, Conversas). */
export function GroupSettingsModal({ serverId, kind }: { serverId: string; kind: 'voice' | 'forum' | 'text' }) {
  const close = useApp((s) => s.closeModal);
  const detail = useApp((s) => s.details[serverId]);
  const current = detail?.groupLabels?.[kind] ?? '';
  const [name, setName] = useState(current || DEFAULT_GROUP_LABEL[kind]);
  const [saving, setSaving] = useState(false);

  async function save(value: string) {
    setSaving(true);
    try {
      await api.put(`/servers/${serverId}/group-labels`, { [kind]: value === DEFAULT_GROUP_LABEL[kind] ? '' : value });
      await useApp.getState().loadDetail(serverId);
      close();
    } catch (err) {
      toast.error(err);
      setSaving(false);
    }
  }

  return (
    <Modal title={<span className="flex items-center gap-2"><FolderClosed size={20} /> {current || DEFAULT_GROUP_LABEL[kind]}</span>} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(name.trim());
        }}
        className="space-y-4"
      >
        <p className="text-sm text-fg-muted">Este grupo junta {GROUP_HINT[kind]} que não estão em nenhuma categoria. O nome novo aparece para todo mundo do servidor.</p>
        <NameInput label="Nome do grupo" value={name} onValueChange={setName} placeholder={DEFAULT_GROUP_LABEL[kind]} autoFocus required maxLength={50} />
        <div className="flex gap-2">
          <Button type="submit" loading={saving} className="flex-1" disabled={!name.trim()}>
            Salvar
          </Button>
          {current && (
            <Button type="button" variant="secondary" onClick={() => void save('')}>
              Voltar para "{DEFAULT_GROUP_LABEL[kind]}"
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-fg-muted">Posição na barra:</span>
          <Button type="button" variant="secondary" onClick={() => void api.post(`/servers/${serverId}/sidebar-order`, { key: `group:${kind}`, move: 'up' }).catch(toast.error)}>
            <ArrowUp size={16} /> Subir
          </Button>
          <Button type="button" variant="secondary" onClick={() => void api.post(`/servers/${serverId}/sidebar-order`, { key: `group:${kind}`, move: 'down' }).catch(toast.error)}>
            <ArrowDown size={16} /> Descer
          </Button>
        </div>
        <p className="text-xs text-fg-subtle">Dica: você também pode arrastar o título do grupo na barra lateral, como as categorias.</p>
      </form>
    </Modal>
  );
}

function ChannelPermissions({ serverId, channelId }: { serverId: string; channelId: string }) {
  const detail = useApp((s) => s.details[serverId])!;
  const channel = detail.channels.find((c) => c.id === channelId)!;
  const [roleId, setRoleId] = useState(detail.roles.find((r) => r.isDefault)!.id);
  const canEdit = has(detail.permissions, P.MANAGE_ROLES);
  const ow = channel.overwrites.find((o) => o.roleId === roleId) ?? { roleId, allow: 0, deny: 0 };
  const perms = PERMISSION_INFO.filter((p) => p.channel && (channel.type === 'voice' || !['CONNECT', 'SPEAK', 'STREAM', 'MUTE_MEMBERS', 'MOVE_MEMBERS'].includes(p.key)))
    .filter((p) => channel.type !== 'voice' || !['SEND_MESSAGES', 'MANAGE_MESSAGES'].includes(p.key));

  async function set(flag: number, state: 'allow' | 'inherit' | 'deny') {
    let { allow, deny } = ow;
    allow &= ~flag;
    deny &= ~flag;
    if (state === 'allow') allow |= flag;
    if (state === 'deny') deny |= flag;
    await api.put(`/channels/${channelId}/overwrites/${roleId}`, { allow, deny }).catch(toast.error);
  }

  return (
    <div className="flex gap-4">
      <div className="w-48 shrink-0 space-y-0.5">
        <div className="mb-2 text-xs font-bold tracking-wide text-fg-muted uppercase">Cargos</div>
        {detail.roles.map((r) => (
          <button
            key={r.id}
            onClick={() => setRoleId(r.id)}
            className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', roleId === r.id ? 'bg-white/10' : 'hover:bg-white/5')}
          >
            <RoleDot color={r.color} />
            <span className="flex-1 truncate">{r.name}</span>
            {channel.overwrites.some((o) => o.roleId === r.id) && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-1">
        {!canEdit && <p className="mb-2 text-sm text-warn">Você precisa de "Gerenciar cargos" para editar permissões.</p>}
        {perms.map((p) => {
          const flag = P[p.key];
          const state = ow.allow & flag ? 'allow' : ow.deny & flag ? 'deny' : 'inherit';
          return (
            <div key={p.key} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/3">
              <div className="flex-1">
                <div className="text-sm font-semibold">{p.label}</div>
                <div className="text-xs text-fg-muted">{p.description}</div>
              </div>
              <div className="flex overflow-hidden rounded-md border border-line">
                {(
                  [
                    ['deny', <X size={14} />, 'bg-danger text-white'],
                    ['inherit', <Slash size={14} />, 'bg-surface-4 text-fg'],
                    ['allow', <Check size={14} />, 'bg-ok text-white'],
                  ] as const
                ).map(([s, icon, activeCls]) => (
                  <button
                    key={s}
                    disabled={!canEdit}
                    title={s === 'deny' ? 'Negar' : s === 'allow' ? 'Permitir' : 'Herdar do cargo'}
                    onClick={() => void set(flag, s)}
                    className={cx('flex h-7 w-8 items-center justify-center transition-colors', state === s ? activeCls : 'text-fg-subtle hover:bg-white/5')}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
