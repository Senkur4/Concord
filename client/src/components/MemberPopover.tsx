import { Ban, BadgeCheck, Bell, BellOff, Crown, Gamepad2, Gem, Headphones, MessageCircle, MessageSquarePlus, MicOff, MonitorX, Pencil, PhoneOff, Plus, Send, UserRound, UserX, Volume2, X, Zap } from 'lucide-react';
import { sendNudge } from '../lib/nudge';
import { memberName, type Member, type Presence, type PresenceStatus, type Role } from '../lib/types';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { P, has } from '../../../shared/permissions.ts';
import { api } from '../lib/api';
import { memberPosition, useApp } from '../store/app';
import { keepPopoverOpen, releasePopover, usePopover } from '../store/popover';
import { toast } from '../store/toast';
import { useVoice } from '../store/voice';
import { Avatar, RoleDot, VerifiedBadge, cx } from './ui';
import { PATCH_TILTS, PatchBadge } from './PatchBadge';
import { SupporterPatch } from './SupporterPatch';
import { usePatchInspect } from '../store/patchInspect';
import { cardLook } from '../lib/cardBg';
import { ColoredName } from './ColoredName';
import { CardFrame } from './CardFrame';
import { CardDivider } from './CardDivider';

export function MemberPopover() {
  const { userId, serverId, x, y, close } = usePopover();
  const ref = useRef<HTMLDivElement>(null);
  // altura real do cartão (muda com capa, patches, atividade, cargos...), para ele nunca passar da tela
  const [height, setHeight] = useState(0);
  const [nudgeMsgOpen, setNudgeMsgOpen] = useState(false);
  const [nudgeMsg, setNudgeMsg] = useState('');
  const detail = useApp((s) => (serverId ? s.details[serverId] : undefined));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [userId, detail]);
  const me = useApp((s) => s.me);
  const presenceInfo = useApp((s) => (userId ? s.online[userId] : undefined));
  const presence = presenceInfo?.status;
  const online = !!presence;
  const voiceState = useApp((s) => (serverId && userId ? s.voiceStates[serverId]?.find((v) => v.userId === userId) : undefined));
  const myChannel = useVoice((s) => s.channelId);
  const volume = useVoice((s) => (userId ? (s.volumes[userId] ?? 1) : 1));
  const setVolume = useVoice((s) => s.setVolume);
  const toggleLocalMute = useVoice((s) => s.toggleLocalMute);
  const localMuted = useVoice((s) => (userId ? !!s.localMuted[userId] : false));
  const openModal = useApp((s) => s.openModal);
  const saveSettings = useApp((s) => s.saveSettings);
  const openDm = useApp((s) => s.openDm);

  useEffect(() => {
    if (!userId) return;
    setNudgeMsgOpen(false);
    setNudgeMsg('');
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [userId, close]);

  if (!userId || !detail || !me) return null;
  const member = detail.members.find((m) => m.id === userId);
  if (!member) return null;

  const isMe = me.id === member.id;
  const perms = detail.permissions;
  const myPos = memberPosition(detail, me.id);
  const outranks = member.id !== detail.server.ownerId && myPos > memberPosition(detail, member.id);
  const canModerate = !isMe && outranks;
  // o Mecenas tem poderes sobre o alvo dele, com ou sem cargo no servidor
  const mecenasPower = !isMe && me.mecenasPowers?.target.id === member.id;
  const roles = detail.roles.filter((r) => member.roleIds.includes(r.id)).sort((a, b) => b.position - a.position);
  const canManageRoles = has(perms, P.MANAGE_ROLES) && (isMe || outranks);
  const assignable = detail.roles.filter((r) => !r.isDefault && r.position < myPos && !member.roleIds.includes(r.id));
  const name = memberName(member);
  const look = cardLook(member);
  const canNick = isMe
    ? has(perms, P.CHANGE_NICKNAME) || has(perms, P.MANAGE_NICKNAMES)
    : (has(perms, P.MANAGE_NICKNAMES) && outranks) || mecenasPower;

  function editNickname() {
    close();
    openModal({ type: 'nickname', serverId: detail!.server.id, userId: member!.id });
  }
  const sameRoom = voiceState && voiceState.channelId === myChannel;
  const mutedNudges = me.settings.mutedNudges ?? [];
  const nudgeMuted = mutedNudges.includes(member.id);

  async function setRoles(roleIds: string[]) {
    await api.put(`/servers/${detail!.server.id}/members/${member!.id}/roles`, { roleIds }).catch(toast.error);
  }

  async function action(path: string, body: unknown = {}, ok?: string) {
    try {
      await api.post(`/servers/${detail!.server.id}/members/${member!.id}/${path}`, body);
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <div
      ref={ref}
      // aberto passando o mouse: fica enquanto o mouse está no cartão
      onPointerEnter={keepPopoverOpen}
      onPointerLeave={releasePopover}
      className="fixed z-40 w-80 animate-pop-in"
      style={{
        left: x,
        // abre na altura do clique, mas sobe o quanto precisar para caber inteiro na tela
        top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
      }}
    >
      {/* moldura do mini perfil: fica por fora do cartão, então não pode estar dentro da parte que rola */}
      <CardFrame frame={member.cardFrame} />
      <div
        className="max-h-[calc(100vh-16px)] overflow-y-auto rounded-[24px] bg-popover bg-cover bg-center shadow-2xl ring-1 ring-line"
        style={look.style}
      >
      <MiniProfileBody
        member={member}
        serverId={detail.server.id}
        ownerId={detail.server.ownerId}
        roles={roles}
        presence={presence}
        presenceInfo={presenceInfo}
        close={close}
        canNick={canNick}
        editNickname={editNickname}
        canManageRoles={canManageRoles}
        myPos={myPos}
        assignable={assignable}
        setRoles={setRoles}
      >
          {!isMe && (
            <div className="mt-3 flex flex-col gap-2">
              {nudgeMsgOpen && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!online || presence === 'dnd') return;
                    void sendNudge(detail.server.id, member.id, name, nudgeMsg);
                    setNudgeMsg('');
                    setNudgeMsgOpen(false);
                  }}
                  className="flex gap-2"
                >
                  <input
                    autoFocus
                    value={nudgeMsg}
                    maxLength={140}
                    onChange={(e) => setNudgeMsg(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setNudgeMsgOpen(false)}
                    placeholder="Mensagem (opcional)"
                    aria-label="Mensagem para enviar junto da chamada de atenção"
                    className="h-9 min-w-0 flex-1 rounded-full bg-surface-3 px-3.5 text-sm outline-none ring-accent focus:ring-2"
                  />
                  <button
                    type="submit"
                    title="Chamar atenção com essa mensagem"
                    aria-label="Enviar"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
                  >
                    <Send size={15} />
                  </button>
                </form>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    close();
                    useApp.getState().openProfile(member.id, detail.server.id);
                  }}
                  title="Ver o perfil completo"
                  aria-label={`Ver o perfil completo de ${name}`}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-muted transition-colors hover:text-fg"
                >
                  <UserRound size={16} />
                </button>
                <button
                  onClick={() => {
                    close();
                    void openDm(member.id);
                  }}
                  title={`Conversa privada com ${name}`}
                  aria-label={`Mensagem para ${name}`}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-muted transition-colors hover:text-fg"
                >
                  <MessageCircle size={16} />
                </button>
                <button
                  disabled={!online || presence === 'dnd'}
                  onClick={() => void sendNudge(detail.server.id, member.id, name)}
                  title={!online ? `${name} está offline` : presence === 'dnd' ? `${name} está em "Não perturbe"` : 'Faz a tela da pessoa tremer, com som e notificação'}
                  className="flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-accent font-display text-sm font-bold text-on-accent transition-all hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Zap size={16} /> {presence === 'dnd' ? 'Não perturbe' : 'Chamar atenção'}
                </button>
                <button
                  disabled={!online || presence === 'dnd'}
                  onClick={() => setNudgeMsgOpen(!nudgeMsgOpen)}
                  title="Mandar uma mensagem na tela junto da tremida"
                  aria-label="Mandar mensagem junto da chamada de atenção"
                  aria-expanded={nudgeMsgOpen}
                  className={cx(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    nudgeMsgOpen ? 'bg-accent text-on-accent' : 'bg-surface-3 text-fg-muted hover:text-fg',
                  )}
                >
                  <MessageSquarePlus size={16} />
                </button>
                <button
                  onClick={() =>
                    void saveSettings({
                      mutedNudges: nudgeMuted ? mutedNudges.filter((id) => id !== member.id) : [...mutedNudges, member.id],
                    })
                  }
                  title={nudgeMuted ? `Voltar a receber chamadas de atenção de ${name}` : `Não receber chamadas de atenção de ${name}`}
                  aria-label={nudgeMuted ? 'Permitir chamadas de atenção desta pessoa' : 'Silenciar chamadas de atenção desta pessoa'}
                  className={cx(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors',
                    nudgeMuted ? 'bg-danger/15 text-danger' : 'bg-surface-3 text-fg-muted hover:text-fg',
                  )}
                >
                  {nudgeMuted ? <BellOff size={16} /> : <Bell size={16} />}
                </button>
              </div>
            </div>
          )}

          {sameRoom && !isMe && (
            <>
              <div className="mt-3 mb-1 text-[11px] font-bold tracking-wider text-fg-subtle uppercase">Volume do usuário</div>
              <div className="flex items-center gap-2">
                <Volume2 size={16} className="text-fg-muted" />
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.05}
                  value={volume}
                  disabled={localMuted}
                  aria-label="Volume do usuário"
                  onChange={(e) => setVolume(member.id, Number(e.target.value))}
                  className="flex-1 disabled:opacity-40"
                />
                <span className="w-9 text-right text-xs text-fg-muted">{localMuted ? '0%' : `${Math.round(volume * 100)}%`}</span>
              </div>
              <button
                onClick={() => toggleLocalMute(member.id)}
                className={cx(
                  'mt-2 flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-medium transition-colors',
                  localMuted ? 'bg-danger/15 text-danger' : 'text-fg-muted hover:bg-white/10 hover:text-fg',
                )}
              >
                <MicOff size={15} />
                {localMuted ? 'Silenciado para mim (toque para ouvir)' : 'Silenciar para mim'}
              </button>
            </>
          )}

          {me.isAuthority && (
            <div className="mt-3 space-y-1">
              <ModButton
                icon={<BadgeCheck size={15} />}
                label={member.verified ? 'Remover selo de verificado' : 'Marcar como verificado'}
                onClick={() => void api.put(`/users/${member.id}/verified`, { verified: !member.verified }).catch(toast.error)}
              />
            </div>
          )}

          {(canModerate || mecenasPower) && (
            <div className="mt-3 space-y-1">
              {voiceState && ((canModerate && has(perms, P.MUTE_MEMBERS)) || mecenasPower) && (
                <ModButton
                  icon={<MicOff size={15} />}
                  label={voiceState.serverMuted ? 'Remover silenciamento' : 'Silenciar na sala'}
                  onClick={() => void action('voice-mute', { muted: !voiceState.serverMuted })}
                />
              )}
              {canModerate && voiceState?.streaming && has(perms, P.MUTE_MEMBERS) && (
                <ModButton icon={<MonitorX size={15} />} label="Encerrar transmissão" onClick={() => void action('stop-stream', {}, 'Transmissão encerrada')} />
              )}
              {voiceState && ((canModerate && has(perms, P.MOVE_MEMBERS)) || mecenasPower) && (
                <ModButton icon={<PhoneOff size={15} />} label="Desconectar da sala" onClick={() => void action('voice-disconnect')} danger />
              )}
              {canModerate && has(perms, P.KICK_MEMBERS) && (
                <ModButton
                  icon={<UserX size={15} />}
                  label={`Expulsar ${name}`}
                  danger
                  onClick={() => {
                    close();
                    openModal({
                      type: 'confirm',
                      title: `Expulsar ${name}`,
                      message: `${name} será removido do servidor e só poderá voltar com um novo convite.`,
                      confirmLabel: 'Expulsar',
                      danger: true,
                      onConfirm: async () => {
                        await api.del(`/servers/${detail.server.id}/members/${member.id}`);
                      },
                    });
                  }}
                />
              )}
              {canModerate && has(perms, P.BAN_MEMBERS) && (
                <ModButton
                  icon={<Ban size={15} />}
                  label={`Banir ${name}`}
                  danger
                  onClick={() => {
                    close();
                    openModal({ type: 'ban', serverId: detail.server.id, userId: member.id, name });
                  }}
                />
              )}
            </div>
          )}
      </MiniProfileBody>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ o cartão em si (também é a prévia de Meu perfil)

type CardMember = Member & { joinedAt?: number };

/**
 * Capa, foto, patches e as informações do mini perfil. O cartão (MemberPopover) põe as ações embaixo, como
 * children; a prévia de Meu perfil usa este mesmo componente, então mostra exatamente o que os outros veem.
 */
export function MiniProfileBody({
  member,
  serverId,
  ownerId,
  roles,
  presence,
  presenceInfo,
  close = () => {},
  canNick = false,
  editNickname = () => {},
  canManageRoles = false,
  myPos = 0,
  assignable = [],
  setRoles = async () => {},
  children,
}: {
  member: CardMember;
  serverId: string | null;
  ownerId: string | null;
  roles: Role[];
  presence: PresenceStatus | undefined;
  presenceInfo: Presence | undefined;
  close?: () => void;
  canNick?: boolean;
  editNickname?: () => void;
  canManageRoles?: boolean;
  myPos?: number;
  assignable?: Role[];
  setRoles?: (roleIds: string[]) => Promise<void>;
  children?: ReactNode;
}) {
  const openModal = useApp((s) => s.openModal);
  const [addingRole, setAddingRole] = useState(false);
  useEffect(() => setAddingRole(false), [member.id]);
  const name = memberName(member);
  const look = cardLook(member);
  const topColor = member.bannerColor ?? roles.find((r) => r.color)?.color ?? member.avatarColor;
  const detail = { server: { id: serverId ?? '', ownerId } };
  return (
    <>
      {/* capa + divisor do mini perfil na borda de baixo dela */}
      <div className="relative">
      {look.combined ? (
        // capa com fundo: a imagem do cartão aparece aqui em cima; clicar mostra a imagem inteira
        <button
          aria-label="Ver a imagem do perfil em tamanho grande"
          onClick={() => {
            close();
            openModal({ type: 'image', src: member.combinedBgUrl!, alt: `Capa de ${name}` });
          }}
          className="block aspect-[3/1] w-full"
        />
      ) : look.bannerUrl ? (
        <button
          aria-label="Ver capa em tamanho grande"
          onClick={() => {
            close();
            openModal({ type: 'image', src: member.bannerUrl!, alt: `Capa de ${name}` });
          }}
          className="block aspect-[3/1] w-full"
        >
          <img src={look.bannerUrl} alt="" className="h-full w-full object-cover" style={{ objectPosition: look.bannerPosition }} />
        </button>
      ) : (
        <div className="h-16" style={look.hasImage ? undefined : { background: `linear-gradient(135deg, ${topColor}, ${topColor}55)` }} />
      )}
        <CardDivider kind={member.cardDivider} />
      </div>
      <div className="px-4 pb-4">
        <div className="relative z-[2] -mt-9 mb-2 flex items-end justify-between gap-2">
          <button
            aria-label={member.avatarUrl ? 'Ver foto em tamanho grande' : undefined}
            disabled={!member.avatarUrl}
            onClick={() => {
              close();
              openModal({ type: 'image', src: member.avatarUrl!, alt: `Foto de ${name}` });
            }}
            // fundo sólido: o divisor do mini perfil passa por trás da foto e não pode aparecer através dela
            className="rounded-full bg-surface-1 enabled:cursor-zoom-in"
          >
            <Avatar name={name} color={member.avatarColor} src={member.avatarUrl} frame={member.frame} size={72} status={presence ?? 'offline'} className="rounded-full ring-[6px] ring-surface-1" />
          </button>
          {(!!member.patches?.length || member.supporter) && (
            <div aria-label="Patches" className="flex flex-wrap justify-end pb-0.5 pl-2">
              {member.supporter && (
                <button
                  aria-label="Ver de perto o patch de apoiador do Concord"
                  title="Apoiador do Concord: clique para ver de perto"
                  onClick={() => {
                    close();
                    usePatchInspect.getState().openSupporter(member.supporter!.tier, `no perfil de ${name}`);
                  }}
                  className="-ml-1.5 cursor-zoom-in rounded-full"
                >
                  <SupporterPatch tier={member.supporter.tier} size={member.patches && member.patches.length > 3 ? 38 : 44} />
                </button>
              )}
              {(member.patches ?? []).map((p, i) => (
                <button
                  key={p.id}
                  aria-label={`Ver o patch ${p.text || ''} de perto`}
                  title="Clique para ver de perto"
                  onClick={() => {
                    close();
                    usePatchInspect.getState().open(p, `no perfil de ${name}`);
                  }}
                  className="-ml-1.5 cursor-zoom-in rounded-full"
                >
                  <PatchBadge patch={p} size={member.patches!.length > 3 ? 34 : 40} tilt={PATCH_TILTS[i % PATCH_TILTS.length]} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className={cx('rounded-2xl p-3', look.hasImage ? 'bg-surface-0/80 backdrop-blur-md' : 'bg-surface-0')}>
          <div className="flex items-center gap-1.5 text-lg font-bold">
            <ColoredName colors={member.nameColors} className="truncate">
              {name}
            </ColoredName>
            {member.verified && <VerifiedBadge size={16} />}
            {member.mecenas && (
              <span title="Mecenas do Concord" className="flex shrink-0 items-center gap-1 rounded-full bg-warn/15 px-2 text-[10px] leading-5 font-extrabold tracking-wide text-warn">
                <Gem size={11} /> MECENAS
              </span>
            )}
            {member.bot && <span className="shrink-0 rounded bg-accent-2/20 px-1.5 text-[10px] leading-5 font-bold text-accent-2">BOT</span>}
            {detail.server.ownerId === member.id && <Crown size={16} className="shrink-0 text-warn" />}
            {canNick && (
              <button title="Alterar apelido neste servidor" onClick={editNickname} className="ml-auto text-fg-subtle hover:text-fg">
                <Pencil size={14} />
              </button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
            <span className="truncate">
              {member.nickname ? `${member.displayName} · ` : ''}@{member.username}
            </span>
            <Integrations userId={member.id} />
          </div>
          {member.mecenasBy && (
            <div className="mt-1 flex items-center gap-1 text-xs font-semibold text-warn">
              <Gem size={12} /> Mecenas: @{member.mecenasBy}
            </div>
          )}
          {presenceInfo?.customStatus && <p className="mt-2 text-sm break-words">{presenceInfo.customStatus}</p>}
          {!!presenceInfo?.activities?.length && (
            <div className="mt-3 space-y-2">
              {presenceInfo.activities.map((activity, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-xl bg-surface-2 p-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
                    {activity.type === 'playing' ? <Gamepad2 size={18} /> : <Headphones size={18} />}
                  </span>
                  <div className="min-w-0 text-sm leading-tight">
                    <div className="text-[11px] font-bold text-fg-subtle">{activity.type === 'playing' ? 'Jogando' : 'Ouvindo no Spotify'}</div>
                    <div className="truncate font-semibold">{activity.type === 'playing' ? activity.name : activity.details}</div>
                    <div className="text-xs text-fg-muted">há {elapsed(activity.since)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {member.bio && (
            <>
              <div className="my-3 h-px bg-line" />
              <div className="text-[11px] font-bold tracking-wider text-fg-subtle uppercase">Sobre mim</div>
              <p className="mt-1 text-sm break-words whitespace-pre-wrap">{member.bio}</p>
            </>
          )}
          <GameCollection
            userId={member.id}
            onOpen={() => {
              close();
              useApp.getState().openProfile(member.id, detail.server.id);
            }}
          />
          {member.joinedAt !== undefined && (
            <>
          <div className="my-3 h-px bg-line" />
          <div className="text-[11px] font-bold tracking-wider text-fg-subtle uppercase">Membro desde</div>
          <div className="mb-3 text-sm">{new Date(member.joinedAt).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' })}</div>

          <div className="mb-1.5 text-[11px] font-bold tracking-wider text-fg-subtle uppercase">Cargos</div>
          <div className="flex flex-wrap gap-1.5">
            {roles.map((r) => (
              <span key={r.id} className="group flex items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 text-xs font-medium">
                <RoleDot color={r.color} />
                {r.name}
                {canManageRoles && r.position < myPos && (
                  <button
                    title="Remover cargo"
                    className="hidden text-fg-subtle group-hover:block hover:text-danger"
                    onClick={() => void setRoles(member.roleIds.filter((id) => id !== r.id))}
                  >
                    <X size={12} />
                  </button>
                )}
              </span>
            ))}
            {roles.length === 0 && !canManageRoles && <span className="text-xs text-fg-subtle">Nenhum cargo</span>}
            {canManageRoles && assignable.length > 0 && (
              <div className="relative">
                <button
                  title="Adicionar cargo"
                  onClick={() => setAddingRole(!addingRole)}
                  className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-3 text-fg-muted hover:text-fg"
                >
                  <Plus size={14} />
                </button>
                {addingRole && (
                  <div className="absolute top-7 left-0 z-10 w-48 space-y-0.5 rounded-lg border border-line bg-surface-3 p-1 shadow-xl">
                    {assignable.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => {
                          setAddingRole(false);
                          void setRoles([...member.roleIds, r.id]);
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/10"
                      >
                        <RoleDot color={r.color} /> {r.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

            </>
          )}
      {children}
        </div>
      </div>
    </>
  );
}

function ModButton({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
        danger ? 'text-danger hover:bg-danger hover:text-white' : 'text-fg-muted hover:bg-white/10 hover:text-fg',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ------------------------------------------------------------------ coleção de jogos (Steam)

interface SteamSummary {
  linked: boolean;
  profileUrl?: string;
  private?: boolean;
  total?: number;
  featured?: boolean;
  games?: { appid: number; name: string; icon: string | null; playtimeMin: number }[];
}

// o cartão abre toda hora (passar o mouse): guarda o resumo de cada pessoa por alguns minutos
const summaries = new Map<string, { at: number; data: SteamSummary }>();
const SUMMARY_TTL = 5 * 60_000;

function useSteamSummary(userId: string) {
  const cachedNow = summaries.get(userId);
  const [data, setData] = useState<SteamSummary | null>(cachedNow && Date.now() - cachedNow.at < SUMMARY_TTL ? cachedNow.data : null);
  useEffect(() => {
    const hit = summaries.get(userId);
    if (hit && Date.now() - hit.at < SUMMARY_TTL) {
      setData(hit.data);
      return;
    }
    setData(null);
    let alive = true;
    api
      .get<SteamSummary>(`/users/${userId}/steam/summary`)
      .then((d) => {
        summaries.set(userId, { at: Date.now(), data: d });
        if (alive) setData(d);
      })
      .catch(() => alive && setData({ linked: false }));
    return () => {
      alive = false;
    };
  }, [userId]);
  return data;
}

/** Logo da Steam (desenho simples, uma cor). */
export function SteamLogo({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <g fill="none" stroke="#1b2838" strokeLinecap="round">
        <circle cx="15.6" cy="8.6" r="3.5" strokeWidth="1.7" />
        <circle cx="8.3" cy="15.4" r="2.3" strokeWidth="1.6" />
        <path d="M10 14 13.2 10.9" strokeWidth="2.3" />
        <path d="M1.6 12.9 6.1 14.7" strokeWidth="1.7" />
      </g>
      <circle cx="15.6" cy="8.6" r="1.5" fill="#1b2838" />
    </svg>
  );
}

/** Contas conectadas (por enquanto só a Steam): selos logo abaixo do @, como no Discord. */
function Integrations({ userId }: { userId: string }) {
  const steam = useSteamSummary(userId);
  if (!steam?.linked) return null;
  const pill = (
    <>
      <SteamLogo size={11} className="text-[#c7d5e0]" />
      Steam
    </>
  );
  const cls =
    'inline-flex h-[18px] items-center gap-1 rounded-full bg-linear-to-r from-[#171a21] to-[#2a475e] pr-1.5 pl-1 text-[10px] leading-none font-bold text-[#c7d5e0] ring-1 ring-white/10';
  return (
    <div className="flex shrink-0 gap-1" aria-label="Contas conectadas">
      {steam.profileUrl ? (
        <a href={steam.profileUrl} target="_blank" rel="noopener noreferrer" title="Abrir o perfil na Steam" className={cx(cls, 'transition hover:brightness-125')}>
          {pill}
        </a>
      ) : (
        <span className={cls} title="Steam conectada">
          {pill}
        </span>
      )}
    </div>
  );
}

const steamCapsule = (appid: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_sm_120.jpg`;

/** "Coleção de jogos": alguns jogos da Steam da pessoa e quantos tem ao todo; clicar abre o perfil. */
function GameCollection({ userId, onOpen }: { userId: string; onOpen: () => void }) {
  const data = useSteamSummary(userId);
  const games = data?.games ?? [];
  if (!data?.linked || data.private || !games.length) return null;
  const shown = games.slice(0, 3);
  const rest = Math.max(0, (data.total ?? games.length) - shown.length);
  return (
    <>
      <div className="my-3 h-px bg-line" />
      <button
        onClick={onOpen}
        title="Ver os jogos no perfil"
        className="flex w-full items-center gap-2 rounded-xl bg-surface-2 p-2.5 text-left transition-colors hover:bg-surface-3"
      >
        <Gamepad2 size={16} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{data.featured ? 'Favoritos' : 'Jogos'}</span>
        <span className="flex shrink-0 items-center gap-1">
          {shown.map((g) => (
            <img
              key={g.appid}
              src={g.icon ?? steamCapsule(g.appid)}
              alt={g.name}
              title={g.name}
              loading="lazy"
              className="h-7 w-7 rounded-md bg-surface-4 object-cover ring-1 ring-line"
              onError={(e) => {
                // ícone pequeno indisponível: tenta a capa do jogo
                const img = e.currentTarget;
                if (img.src !== steamCapsule(g.appid)) img.src = steamCapsule(g.appid);
              }}
            />
          ))}
          {rest > 0 && <span className="flex h-7 min-w-7 items-center justify-center rounded-md bg-surface-4 px-1 text-[11px] font-bold text-fg-muted">+{rest}</span>}
        </span>
      </button>
    </>
  );
}

function elapsed(since: number) {
  const min = Math.max(1, Math.round((Date.now() - since) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}
