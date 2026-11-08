import { Check, Copy, Crosshair, Gift, ImagePlus, Move, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { CARD_DIVIDERS, CARD_FRAMES, FRAMES, MAX_PATCHES } from '../../../../shared/cosmetics.ts';
import { api } from '../../lib/api';
import type { Me, Member, Patch, Presence, ServerPatch, ServerSummary } from '../../lib/types';
import { pickImage, prepareImage, uploadImage } from '../../lib/upload';
import { HOME, useApp } from '../../store/app';
import { toast } from '../../store/toast';
import { PATCH_PRESETS, PATCH_TILTS, PatchBadge } from '../PatchBadge';
import { PatchForm } from '../PatchForm';
import { ServerPatchesPanel, equipPatch, newPatchDraft } from '../ServerPatches';
import { Avatar, Button, cx } from '../ui';
import { cardLook } from '../../lib/cardBg';
import { MiniProfileBody } from '../MemberPopover';
import { CARD_FRAME_LABELS, CardFrame } from '../CardFrame';
import { CARD_DIVIDER_LABELS, CardDivider } from '../CardDivider';
import { PinterestButton, PinterestPicker } from '../PinterestPicker';

const FRAME_NAMES: Record<string, string> = {
  neon: 'Neon',
  fire: 'Em chamas',
  rainbow: 'Arco-íris',
  gold: 'Ouro',
  ice: 'Gelo',
  toxic: 'Tóxico',
  galaxy: 'Galáxia',
  pulse: 'Pulso',
  orbit: 'Órbita',
  glitch: 'Glitch',
  hearts: 'Corações',
  sakura: 'Sakura',
  xmas: 'Natal',
  wreath: 'Guirlanda',
};


function Title({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-2">
      <span className="block text-xs font-bold tracking-wide text-fg-muted uppercase">{children}</span>
      {hint && <span className="text-xs text-fg-subtle">{hint}</span>}
    </div>
  );
}


/**
 * Moldura, capa, fundo do mini perfil, "capa com fundo" e patches.
 * Dentro de Meu perfil (`embedded`) a prévia fica na coluna ao lado.
 */
export function StyleTab({ embedded = false }: { embedded?: boolean }) {
  const me = useApp((s) => s.me)!;
  const setMe = useApp((s) => s.setMe);
  const [uploading, setUploading] = useState<Slot | null>(null);

  async function setFrame(frame: string | null) {
    try {
      setMe(await api.patch<Me>('/me/style', { frame }));
    } catch (err) {
      toast.error(err);
    }
  }

  async function setCardDivider(cardDivider: string | null) {
    try {
      setMe(await api.patch<Me>('/me/style', { cardDivider }));
    } catch (err) {
      toast.error(err);
    }
  }

  async function setCardFrame(cardFrame: string | null) {
    try {
      setMe(await api.patch<Me>('/me/style', { cardFrame }));
    } catch (err) {
      toast.error(err);
    }
  }

  /**
   * Envia uma imagem (crop: proporção fixa, ou false para manter a imagem inteira). Sem `given`, abre o seletor de
   * arquivos; com ela (veio do Pinterest), envia direto e repassa o erro para a janela não fechar.
   */
  async function upload(kind: Slot, given?: File) {
    const { path, maxSize, crop, ok } = SLOTS[kind];
    const file = given ?? (await pickImage());
    if (!file) return;
    setUploading(kind);
    try {
      setMe(await uploadImage<Me>(path, await prepareImage(file, maxSize, crop)));
      toast.success(ok);
    } catch (err) {
      toast.error(err);
      if (given) {
        setUploading(null);
        throw err;
      }
    }
    setUploading(null);
  }
  const [pinFor, setPinFor] = useState<Slot | null>(null);

  const remove = (path: string) => void api.del<Me>(path).then(setMe, toast.error);
  const name = me.displayName || me.username;
  const combined = !!me.combinedBgUrl;

  return (
    <div className="space-y-8">
      {/* moldura */}
      <section>
        <Title hint="Em volta da sua foto em todo lugar.">Moldura</Title>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          <FrameOption label="Nenhuma" active={!me.frame} onClick={() => void setFrame(null)}>
            <Avatar name={name} color={me.avatarColor} src={me.avatarUrl} size={44} />
          </FrameOption>
          {FRAMES.map((f) => (
            <FrameOption key={f} label={FRAME_NAMES[f] ?? f} active={me.frame === f} onClick={() => void setFrame(f)}>
              <Avatar name={name} color={me.avatarColor} src={me.avatarUrl} frame={f} size={44} />
            </FrameOption>
          ))}
        </div>
      </section>

      {/* moldura do mini perfil */}
      <section>
        <Title hint="Decoração em volta do seu mini perfil inteiro, por fora da borda.">Moldura do Mini-Perfil</Title>
        <div className="flex flex-wrap gap-2">
          <FrameOption label="Nenhuma" active={!me.cardFrame} onClick={() => void setCardFrame(null)}>
            <MiniCardThumb me={me} frame={null} />
          </FrameOption>
          {CARD_FRAMES.map((f) => (
            <FrameOption key={f} label={CARD_FRAME_LABELS[f] ?? f} active={me.cardFrame === f} onClick={() => void setCardFrame(f)}>
              <MiniCardThumb me={me} frame={f} />
            </FrameOption>
          ))}
        </div>
      </section>

      {/* divisor do mini perfil */}
      <section>
        <Title hint="Decoração na linha entre a capa e as suas informações.">Divisor de Mini-Perfil</Title>
        <div className="flex flex-wrap gap-2">
          <FrameOption label="Nenhum" active={!me.cardDivider} onClick={() => void setCardDivider(null)}>
            <MiniCardThumb me={me} frame={null} divider={null} />
          </FrameOption>
          {CARD_DIVIDERS.map((d) => (
            <FrameOption key={d} label={CARD_DIVIDER_LABELS[d] ?? d} active={me.cardDivider === d} onClick={() => void setCardDivider(d)}>
              <MiniCardThumb me={me} frame={null} divider={d} />
            </FrameOption>
          ))}
        </div>
      </section>

      <div className={cx('grid gap-5', !embedded && 'sm:grid-cols-[minmax(0,1fr)_240px]')}>
        <div className="space-y-4">
          {/* capa */}
          <ImageOption
            title="Capa"
            hint="A faixa no topo do seu mini perfil. Larga (3:1); GIF animado vale. Depois de escolher, arraste para ajustar."
            thumb={me.bannerUrl}
            thumbClass="aspect-[3/1] w-36"
            disabledNote={combined ? 'Desligada enquanto a Capa com Fundo de Mini-Perfil estiver em uso.' : undefined}
            loading={uploading === 'banner'}
            pickLabel={me.bannerUrl ? 'Trocar capa' : 'Escolher capa'}
            onPick={() => void upload('banner')}
            onPinterest={() => setPinFor('banner')}
            onRemove={me.bannerUrl ? () => remove('/me/banner') : undefined}
            positioner={
              me.bannerUrl ? (
                <ImagePositioner
                  url={me.bannerUrl}
                  field="bannerPos"
                  fallback={{ x: 50, y: 50 }}
                  boxClass="aspect-[3/1] w-72 max-w-full rounded-2xl"
                  overlay={<div className="pointer-events-none absolute bottom-[-22px] left-[14px] h-[52px] w-[52px] rounded-full border-2 border-dashed border-white/70 bg-black/20" />}
                />
              ) : undefined
            }
          />

          {/* fundo do mini perfil */}
          <ImageOption
            title="Fundo de Mini-Perfil"
            hint="Atrás das suas informações no cartão. Em pé (2:3); GIF animado vale. Depois de escolher, arraste para ajustar."
            thumb={me.cardBgUrl}
            thumbClass="aspect-[2/3] w-16"
            disabledNote={combined ? 'Desligado enquanto a Capa com Fundo de Mini-Perfil estiver em uso.' : undefined}
            loading={uploading === 'bg'}
            pickLabel={me.cardBgUrl ? 'Trocar fundo' : 'Escolher fundo'}
            onPick={() => void upload('bg')}
            onPinterest={() => setPinFor('bg')}
            onRemove={me.cardBgUrl ? () => remove('/me/card-bg') : undefined}
            positioner={
              me.cardBgUrl ? (
                <ImagePositioner
                  url={me.cardBgUrl}
                  field="cardBgPos"
                  fallback={{ x: 50, y: 50 }}
                  boxClass="h-[264px] w-48 rounded-[20px]"
                  overlay={
                    <>
                      {/* a capa fica por cima do fundo, no topo do cartão */}
                      <div className="pointer-events-none absolute inset-x-0 top-0 h-[64px] border-b-2 border-dashed border-white/70 bg-black/35" />
                      <span className="pointer-events-none absolute top-1.5 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white">
                        {me.bannerUrl ? 'Sua capa fica aqui' : 'Topo'}
                      </span>
                    </>
                  }
                />
              ) : undefined
            }
          />

          {/* capa com fundo: uma imagem só, sem emenda */}
          <section className={cx('rounded-3xl p-4 ring-1', combined ? 'bg-accent/10 ring-accent/50' : 'bg-surface-0 ring-line')}>
            <Title hint="Uma imagem só para a capa e o fundo, unidas sem emenda. Fica no lugar das duas de cima. Arraste a imagem para escolher a parte que aparece.">
              Capa com Fundo de Mini-Perfil
            </Title>
            {combined && <CombinedPositioner />}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant={combined ? 'secondary' : 'primary'} loading={uploading === 'combined'} onClick={() => void upload('combined')}>
                <ImagePlus size={15} /> {combined ? 'Trocar imagem' : 'Escolher imagem ou GIF'}
              </Button>
              <PinterestButton onClick={() => setPinFor('combined')} />
              {combined && (
                <Button variant="ghost" onClick={() => remove('/me/card-combined')}>
                  <Trash2 size={15} /> Remover
                </Button>
              )}
            </div>
          </section>

          <PatchesEditor />
        </div>
        {!embedded && <CardPreview me={me} />}
      </div>
      {pinFor && (
        <PinterestPicker
          title={SLOTS[pinFor].pinTitle}
          target={SLOTS[pinFor].target}
          onUse={(file) => upload(pinFor, file)}
          onClose={() => setPinFor(null)}
        />
      )}
    </div>
  );
}

type Slot = 'banner' | 'bg' | 'combined';
const SLOTS: Record<Slot, { path: string; maxSize: number; crop: boolean | number; ok: string; pinTitle: string; target: string }> = {
  // a imagem vai inteira (sem cortar no envio): a parte que aparece é escolhida arrastando, depois
  banner: { path: '/me/banner', maxSize: 1600, crop: false, ok: 'Capa atualizada', pinTitle: 'Capa do Pinterest', target: 'Capa' },
  bg: { path: '/me/card-bg', maxSize: 1600, crop: false, ok: 'Fundo atualizado', pinTitle: 'Fundo do Pinterest', target: 'Fundo de Mini-Perfil' },
  combined: {
    path: '/me/card-combined',
    maxSize: 1600,
    crop: false,
    ok: 'Capa com fundo atualizada',
    pinTitle: 'Capa com Fundo do Pinterest',
    target: 'Capa com Fundo de Mini-Perfil',
  },
};

/** Uma opção de imagem do perfil: miniatura, explicação e os botões de escolher e remover. */
function ImageOption({
  title,
  hint,
  thumb,
  thumbClass,
  disabledNote,
  loading,
  pickLabel,
  onPick,
  onPinterest,
  onRemove,
  positioner,
}: {
  positioner?: ReactNode;
  title: string;
  hint: string;
  thumb: string | null | undefined;
  thumbClass: string;
  disabledNote?: string;
  loading: boolean;
  pickLabel: string;
  onPick: () => void;
  onPinterest?: () => void;
  onRemove?: () => void;
}) {
  return (
    <section className={cx('rounded-3xl bg-surface-0 p-4 ring-1 ring-line', disabledNote && 'opacity-60')}>
      <div className="flex items-center gap-4">
      <div className={cx('shrink-0 overflow-hidden rounded-xl bg-surface-3 ring-1 ring-line', thumbClass)}>
        {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-fg-subtle"><ImagePlus size={18} /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <Title hint={disabledNote ?? hint}>{title}</Title>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="h-9 px-4" loading={loading} onClick={onPick}>
            <ImagePlus size={15} /> {pickLabel}
          </Button>
          {onPinterest && <PinterestButton onClick={onPinterest} />}
          {onRemove && (
            <Button variant="ghost" className="h-9 px-3" onClick={onRemove}>
              <Trash2 size={15} /> Remover
            </Button>
          )}
        </div>
      </div>
      </div>
      {positioner && !disabledNote && <div className="mt-3">{positioner}</div>}
    </section>
  );
}

type PosField = 'combinedPos' | 'bannerPos' | 'cardBgPos';

/**
 * Ajuste de posição de uma imagem (capa com fundo, capa ou fundo do mini perfil): uma caixa no formato de onde a
 * imagem aparece, com as marcas do cartão. Arrastar move a imagem; soltar salva. Setas do teclado também movem.
 */
function ImagePositioner({ url, field, fallback, boxClass, overlay }: { url: string; field: PosField; fallback: { x: number; y: number }; boxClass: string; overlay?: ReactNode }) {
  const me = useApp((s) => s.me)!;
  const setMe = useApp((s) => s.setMe);
  const saved = me[field] ?? fallback;
  const [pos, setPos] = useState(saved);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; start: { x: number; y: number } } | null>(null);

  useEffect(() => setPos(me[field] ?? fallback), [me[field]?.x, me[field]?.y, url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, [url]);

  /** Quanto a imagem sobra para fora da caixa em cada eixo (em px), com "cover". */
  function overflow() {
    const el = box.current;
    if (!el || !natural) return { x: 0, y: 0 };
    const scale = Math.max(el.clientWidth / natural.w, el.clientHeight / natural.h);
    return { x: natural.w * scale - el.clientWidth, y: natural.h * scale - el.clientHeight };
  }

  async function save(next: { x: number; y: number }) {
    try {
      setMe(await api.patch<Me>('/me/style', { [field]: next }));
    } catch (err) {
      toast.error(err);
    }
  }

  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  const onDown = (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: pos };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const o = overflow();
    // arrastar para a direita mostra mais da esquerda da imagem (a posição em % diminui)
    setPos({
      x: o.x > 0 ? clamp(d.start.x - ((e.clientX - d.x) / o.x) * 100) : 50,
      y: o.y > 0 ? clamp(d.start.y - ((e.clientY - d.y) / o.y) * 100) : 50,
    });
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (pos.x !== saved.x || pos.y !== saved.y) void save(pos);
  };
  const o = natural && box.current ? overflow() : null;
  const fits = o && o.x < 1 && o.y < 1; // a imagem já tem o formato exato: não há o que ajustar

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div
        ref={box}
        role="slider"
        aria-label="Arraste para escolher a parte da imagem que aparece"
        aria-valuetext={`horizontal ${Math.round(pos.x)}%, vertical ${Math.round(pos.y)}%`}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 2;
          const keys: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
          const k = keys[e.key];
          if (!k) return;
          e.preventDefault();
          const next = { x: clamp(pos.x + k[0]), y: clamp(pos.y + k[1]) };
          setPos(next);
          void save(next);
        }}
        className={cx('relative shrink-0 cursor-grab touch-none overflow-hidden ring-1 ring-line select-none active:cursor-grabbing', boxClass)}
        style={{ backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: `${pos.x}% ${pos.y}%` }}
      >
        {overlay}
        <span className="pointer-events-none absolute right-2 bottom-2 left-2 rounded-xl bg-black/55 px-2 py-1 text-center text-[11px] font-semibold text-white">
          <Move size={12} className="mr-1 inline" /> {fits ? 'A imagem já cabe inteira' : 'Arraste para ajustar'}
        </span>
      </div>
      <Button
        variant="ghost"
        className="h-9 px-3"
        onClick={() => {
          const center = { x: 50, y: 50 };
          setPos(center);
          void save(center);
        }}
      >
        <Crosshair size={15} /> Centralizar
      </Button>
    </div>
  );
}

function CombinedPositioner() {
  const me = useApp((s) => s.me)!;
  return (
    <ImagePositioner
      url={me.combinedBgUrl!}
      field="combinedPos"
      fallback={{ x: 50, y: 30 }}
      boxClass="h-[264px] w-48 rounded-[20px]"
      overlay={
        <>
          {/* onde a capa termina e onde fica a sua foto */}
          <div className="pointer-events-none absolute inset-x-0 top-[64px] border-t-2 border-dashed border-white/70" />
          <span className="pointer-events-none absolute top-1.5 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white">Capa</span>
          <div className="pointer-events-none absolute top-[42px] left-[10px] h-[43px] w-[43px] rounded-full border-2 border-dashed border-white/70 bg-black/20" />
        </>
      }
    />
  );
}

/** Cartãozinho de amostra (capa + foto + linhas) para escolher a moldura do mini perfil. */
function MiniCardThumb({ me, frame, divider }: { me: Me; frame: string | null; divider?: string | null }) {
  const name = me.displayName || me.username;
  const look = cardLook(me);
  return (
    <div className="relative m-2 h-[92px] w-[68px]">
      <CardFrame frame={frame} scale={0.5} />
      <div className="h-full w-full overflow-hidden rounded-[12px] bg-popover bg-cover bg-center ring-1 ring-line" style={look.style}>
        <div className="relative">
          {look.bannerUrl ? (
            <img src={look.bannerUrl} alt="" className="block aspect-[3/1] w-full object-cover" style={{ objectPosition: look.bannerPosition }} />
          ) : (
            <div className="h-[22px]" style={look.hasImage ? undefined : { background: me.bannerColor ?? me.avatarColor }} />
          )}
          {/* sem divisor escolhido, usa o da pessoa (a amostra mostra como fica de verdade) */}
          <CardDivider kind={divider === undefined ? me.cardDivider : divider} scale={0.42} />
        </div>
        <div className="relative z-[2] -mt-3 px-1.5">
          <Avatar name={name} color={me.avatarColor} src={me.avatarUrl} size={24} />
          <div className="mt-1.5 h-1.5 w-10 rounded-full bg-fg/60" />
          <div className="mt-1 h-1 w-7 rounded-full bg-fg/30" />
          <div className="mt-2 h-1 w-12 rounded-full bg-fg/20" />
        </div>
      </div>
    </div>
  );
}

function FrameOption({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'flex flex-col items-center gap-2 rounded-2xl p-3 pt-4 text-[11px] font-semibold transition-colors',
        active ? 'bg-accent/15 text-fg ring-2 ring-accent' : 'bg-surface-0 text-fg-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      {children}
      {label}
    </button>
  );
}

/**
 * Prévia do mini perfil: o mesmo cartão que os outros veem ao passar o mouse em você (MiniProfileBody), com o
 * que está sendo editado, a sua atividade e os seus cargos no servidor aberto.
 */
export function CardPreview({ me }: { me: Me }) {
  const activeServerId = useApp((s) => s.activeServerId);
  const details = useApp((s) => s.details);
  const presenceNow = useApp((s) => s.online[me.id]);
  const inActive = activeServerId ? details[activeServerId] : undefined;
  const detail = inActive?.members.some((m) => m.id === me.id) ? inActive : Object.values(details).find((d) => d.members.some((m) => m.id === me.id));
  const self = detail?.members.find((m) => m.id === me.id);
  const member = { ...me, nickname: self?.nickname ?? null, joinedAt: self?.joinedAt, roleIds: self?.roleIds ?? [] } as Member;
  const roles = detail ? detail.roles.filter((r) => member.roleIds.includes(r.id)).sort((a, b) => b.position - a.position) : [];
  const status = me.settings.status === 'dnd' ? 'dnd' : 'online';
  const presence: Presence = { status, activities: presenceNow?.activities ?? [], customStatus: String(me.settings.customStatus ?? '') };
  const look = cardLook(member);
  return (
    <div>
      <Title>Prévia</Title>
      {/* com moldura do mini perfil, sobra espaço em volta para ela aparecer inteira */}
      <div className={cx('relative w-80', me.cardFrame ? 'm-4 max-w-[calc(100%-2rem)]' : 'max-w-full')}>
        <CardFrame frame={me.cardFrame} />
        <div className="overflow-hidden rounded-[24px] bg-popover bg-cover bg-center shadow-2xl ring-1 ring-line" style={look.style}>
          <MiniProfileBody member={member} serverId={detail?.server.id ?? null} ownerId={detail?.server.ownerId ?? null} roles={roles} presence={status} presenceInfo={presence} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ patches

function PatchesEditor() {
  const me = useApp((s) => s.me)!;
  const setMe = useApp((s) => s.setMe);
  const servers = useApp((s) => s.servers);
  const activeServerId = useApp((s) => s.activeServerId);
  const patches = me.patches ?? [];
  const [editing, setEditing] = useState<Patch | null>(null);
  const [gallery, setGallery] = useState(false);
  const [source, setSource] = useState<string>('preset');
  const [shareTo, setShareTo] = useState<string>('');
  const [giftOf, setGiftOf] = useState<Patch | null>(null);
  // links de presente: só admin de servidor cria (o link sai em nome do servidor)
  const [adminServers, setAdminServers] = useState<ServerSummary[]>([]);
  useEffect(() => void api.get<ServerSummary[]>('/me/admin-servers').then(setAdminServers, () => {}), []);
  const full = patches.length >= MAX_PATCHES;
  const isNew = editing ? !patches.some((x) => x.id === editing.id) : false;

  async function save(next: Patch[]) {
    try {
      setMe(await api.patch<Me>('/me/style', { patches: next }));
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    }
  }

  async function commit(p: Patch) {
    if (isNew && shareTo) {
      // cria no servidor (todo mundo de lá pode usar) e costura no perfil
      try {
        const created = await api.post<ServerPatch>(`/servers/${shareTo}/patches`, { patch: p });
        if (await equipPatch(created.patch)) setEditing(null);
        toast.success('Patch criado e compartilhado no servidor');
      } catch (err) {
        toast.error(err);
      }
      return;
    }
    const exists = patches.some((x) => x.id === p.id);
    if (await save(exists ? patches.map((x) => (x.id === p.id ? p : x)) : [...patches, p])) setEditing(null);
  }

  function startCreate() {
    setShareTo(activeServerId && activeServerId !== HOME ? activeServerId : (servers[0]?.id ?? ''));
    setEditing(newPatchDraft());
  }

  return (
    <div className="pt-2">
      <Title hint={`Bordados que ficam costurados no seu cartão (até ${MAX_PATCHES}). Os patches criados num servidor ficam disponíveis para todo mundo de lá.`}>
        Patches
      </Title>

      <div className="flex flex-wrap items-center gap-2">
        {patches.map((p, i) => (
          <div key={p.id} className="group relative">
            <PatchBadge patch={p} size={56} tilt={PATCH_TILTS[i % PATCH_TILTS.length]} />
            <div className="absolute -top-1.5 -right-1.5 hidden gap-0.5 group-focus-within:flex group-hover:flex">
              {!p.drop && adminServers.length > 0 && (
                <button
                  aria-label={`Criar link de presente do patch ${p.text}`}
                  title="Link de presente: amigos resgatam este patch"
                  onClick={() => setGiftOf(p)}
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-on-accent shadow"
                >
                  <Gift size={11} />
                </button>
              )}
              <button
                aria-label={`Editar patch ${p.text}`}
                onClick={() => setEditing(p)}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-4 text-fg shadow"
              >
                <Pencil size={11} />
              </button>
              <button
                aria-label={`Tirar patch ${p.text}`}
                onClick={() => void save(patches.filter((x) => x.id !== p.id))}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-danger text-white shadow"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        ))}
        {!full && (
          <>
            <Button variant="secondary" className="h-10" onClick={() => setGallery(!gallery)}>
              <Plus size={15} /> Escolher
            </Button>
            <Button variant="secondary" className="h-10" onClick={startCreate}>
              <Pencil size={14} /> Criar
            </Button>
          </>
        )}
      </div>

      {gallery && !full && (
        <div className="mt-3 rounded-2xl bg-surface-0 p-3">
          <div role="tablist" className="mb-3 flex flex-wrap gap-1.5">
            {[{ id: 'preset', name: 'Prontos' }, ...servers.map((sv) => ({ id: sv.id, name: sv.name }))].map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={source === t.id}
                onClick={() => setSource(t.id)}
                className={cx(
                  'max-w-40 truncate rounded-full px-3 py-1 text-xs font-semibold',
                  source === t.id ? 'bg-accent text-on-accent' : 'bg-surface-3 text-fg-muted hover:text-fg',
                )}
              >
                {t.name}
              </button>
            ))}
          </div>
          {source === 'preset' ? (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {PATCH_PRESETS.map((p, i) => (
                <button
                  key={i}
                  title={`Costurar "${p.text}"`}
                  onClick={() =>
                    void save([...patches, { ...p, id: newPatchDraft().id }]).then((ok) => ok && patches.length + 1 >= MAX_PATCHES && setGallery(false))
                  }
                  className="flex items-center justify-center rounded-xl p-1 hover:bg-surface-2"
                >
                  <PatchBadge patch={{ ...p, id: `p${i}` }} size={52} />
                </button>
              ))}
            </div>
          ) : (
            <ServerPatchesPanel key={source} serverId={source} compact />
          )}
        </div>
      )}

      {giftOf && <GiftLinks patch={giftOf} servers={adminServers} onClose={() => setGiftOf(null)} />}
      <ClaimedPatches />

      {editing && (
        <PatchForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={commit}
          saveLabel={isNew && shareTo ? 'Criar e compartilhar' : 'Costurar'}
          extra={
            isNew &&
            servers.length > 0 && (
              <label className="flex flex-wrap items-center gap-2 text-xs font-semibold text-fg-muted">
                Compartilhar no servidor
                <select
                  value={shareTo}
                  onChange={(e) => setShareTo(e.target.value)}
                  className="h-8 rounded-lg border border-line bg-surface-2 px-2 text-xs text-fg outline-none focus:border-accent"
                >
                  <option value="">Não, só para mim</option>
                  {servers.map((sv) => (
                    <option key={sv.id} value={sv.id}>
                      {sv.name}
                    </option>
                  ))}
                </select>
              </label>
            )
          }
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ patches de presente

interface DropLink {
  code: string;
  patch: Patch;
  uses: number;
  maxUses: number;
  expiresAt: number | null;
}

const dropUrl = (code: string) => `${location.origin}/resgatar/${code}`;

/** Links de presente de um patch: quem abre o link resgata o patch (uma vez por pessoa). */
function GiftLinks({ patch, servers, onClose }: { patch: Patch; servers: ServerSummary[]; onClose: () => void }) {
  const activeServerId = useApp((s) => s.activeServerId);
  const [serverId, setServerId] = useState(servers.find((s) => s.id === activeServerId)?.id ?? servers[0]?.id ?? '');
  const [links, setLinks] = useState<DropLink[] | null>(null);
  const [maxUses, setMaxUses] = useState(10);
  const [expiresIn, setExpiresIn] = useState(7 * 86400);
  const [copied, setCopied] = useState('');
  const same = (d: DropLink) => JSON.stringify({ ...d.patch, drop: undefined }) === JSON.stringify({ ...patch, id: undefined, drop: undefined });

  const load = () => void api.get<DropLink[]>('/me/drops').then((all) => setLinks(all.filter(same)), toast.error);
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    try {
      const d = await api.post<DropLink>('/me/drops', { patchId: patch.id, serverId, maxUses, expiresIn });
      setLinks((cur) => [d, ...(cur ?? [])]);
      void copy(d.code);
    } catch (err) {
      toast.error(err);
    }
  }
  async function copy(code: string) {
    await navigator.clipboard.writeText(dropUrl(code)).catch(() => {});
    setCopied(code);
    setTimeout(() => setCopied((c) => (c === code ? '' : c)), 2000);
  }

  const sel = 'h-9 rounded-xl border border-line bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent';
  return (
    <div className="mt-3 rounded-2xl bg-surface-0 p-4">
      <div className="mb-3 flex items-center gap-3">
        <PatchBadge patch={patch} size={44} />
        <div className="min-w-0 flex-1">
          <div className="font-bold">Link de presente</div>
          <div className="text-xs text-fg-muted">Quem abrir o link resgata este patch para o próprio perfil. Quem ganhou não consegue repassar.</div>
        </div>
        <button aria-label="Fechar" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Em nome de qual servidor" value={serverId} onChange={(e) => setServerId(e.target.value)} className={sel}>
          {servers.map((sv) => (
            <option key={sv.id} value={sv.id}>
              {sv.name}
            </option>
          ))}
        </select>
        <select aria-label="Quantos resgates" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} className={sel}>
          {[1, 5, 10, 25, 50, 0].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Resgates ilimitados' : n === 1 ? '1 resgate' : `${n} resgates`}
            </option>
          ))}
        </select>
        <select aria-label="Validade" value={expiresIn} onChange={(e) => setExpiresIn(Number(e.target.value))} className={sel}>
          <option value={86400}>Vale 1 dia</option>
          <option value={7 * 86400}>Vale 7 dias</option>
          <option value={30 * 86400}>Vale 30 dias</option>
          <option value={0}>Nunca expira</option>
        </select>
        <Button className="h-9" onClick={() => void create()}>
          <Gift size={14} /> Criar link
        </Button>
      </div>
      {links && links.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {links.map((d) => {
            const expired = !!d.expiresAt && d.expiresAt < Date.now();
            return (
              <li key={d.code} className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <code className={cx('min-w-0 flex-1 truncate', expired && 'line-through opacity-50')}>{dropUrl(d.code)}</code>
                <span className="shrink-0 text-xs text-fg-muted">
                  {d.uses}
                  {d.maxUses ? `/${d.maxUses}` : ''} resgates
                </span>
                {!expired && (
                  <button aria-label="Copiar link" onClick={() => void copy(d.code)} className="flex h-7 w-7 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg">
                    {copied === d.code ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                  </button>
                )}
                {!expired && (
                  <button
                    aria-label="Desativar link"
                    title="Desativar (quem já resgatou continua com o patch)"
                    onClick={() => void api.del(`/me/drops/${d.code}`).then(load, toast.error)}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-danger hover:bg-danger/15"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Patches ganhos de presente que não estão no perfil agora: dá para costurar de novo. */
function ClaimedPatches() {
  const me = useApp((s) => s.me)!;
  const [list, setList] = useState<Patch[]>([]);
  useEffect(() => void api.get<Patch[]>('/me/claimed-patches').then(setList, () => setList([])), []);
  const off = list.filter((p) => !(me.patches ?? []).some((x) => x.id === p.id));
  if (off.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-surface-0 p-3">
      <span className="mr-1 text-xs font-bold text-fg-muted">Ganhos de presente</span>
      {off.map((p) => (
        <button key={p.id} title="Costurar no perfil" onClick={() => void equipPatch(p)} className="rounded-xl p-1 hover:bg-surface-2">
          <PatchBadge patch={p} size={44} />
        </button>
      ))}
    </div>
  );
}
