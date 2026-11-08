import { Check, Copy, Crosshair, Gift, ImagePlus, Move, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { FRAMES, MAX_PATCHES } from '../../../../shared/cosmetics.ts';
import { api } from '../../lib/api';
import type { Me, Patch, ServerPatch, ServerSummary } from '../../lib/types';
import { pickImage, prepareImage, uploadImage } from '../../lib/upload';
import { HOME, useApp } from '../../store/app';
import { toast } from '../../store/toast';
import { PATCH_PRESETS, PATCH_TILTS, PatchBadge } from '../PatchBadge';
import { PatchForm } from '../PatchForm';
import { ServerPatchesPanel, equipPatch, newPatchDraft } from '../ServerPatches';
import { Avatar, Button, cx } from '../ui';
import { cardLook } from '../../lib/cardBg';

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
  const [uploading, setUploading] = useState<'banner' | 'bg' | 'combined' | null>(null);

  async function setFrame(frame: string | null) {
    try {
      setMe(await api.patch<Me>('/me/style', { frame }));
    } catch (err) {
      toast.error(err);
    }
  }

  /** Escolhe uma imagem e envia (crop: proporção fixa, ou false para manter a imagem inteira). */
  async function upload(kind: 'banner' | 'bg' | 'combined', path: string, maxSize: number, crop: boolean | number, ok: string) {
    const file = await pickImage();
    if (!file) return;
    setUploading(kind);
    try {
      setMe(await uploadImage<Me>(path, await prepareImage(file, maxSize, crop)));
      toast.success(ok);
    } catch (err) {
      toast.error(err);
    }
    setUploading(null);
  }

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

      <div className={cx('grid gap-5', !embedded && 'sm:grid-cols-[minmax(0,1fr)_240px]')}>
        <div className="space-y-4">
          {/* capa */}
          <ImageOption
            title="Capa"
            hint="A faixa no topo do seu mini perfil. Larga (3:1); GIF animado vale."
            thumb={me.bannerUrl}
            thumbClass="aspect-[3/1] w-36"
            disabledNote={combined ? 'Desligada enquanto a Capa com Fundo de Mini-Perfil estiver em uso.' : undefined}
            loading={uploading === 'banner'}
            pickLabel={me.bannerUrl ? 'Trocar capa' : 'Escolher capa'}
            onPick={() => void upload('banner', '/me/banner', 1200, 3, 'Capa atualizada')}
            onRemove={me.bannerUrl ? () => remove('/me/banner') : undefined}
          />

          {/* fundo do mini perfil */}
          <ImageOption
            title="Fundo de Mini-Perfil"
            hint="Atrás das suas informações no cartão. Em pé (2:3); GIF animado vale."
            thumb={me.cardBgUrl}
            thumbClass="aspect-[2/3] w-16"
            disabledNote={combined ? 'Desligado enquanto a Capa com Fundo de Mini-Perfil estiver em uso.' : undefined}
            loading={uploading === 'bg'}
            pickLabel={me.cardBgUrl ? 'Trocar fundo' : 'Escolher fundo'}
            onPick={() => void upload('bg', '/me/card-bg', 1200, 2 / 3, 'Fundo atualizado')}
            onRemove={me.cardBgUrl ? () => remove('/me/card-bg') : undefined}
          />

          {/* capa com fundo: uma imagem só, sem emenda */}
          <section className={cx('rounded-3xl p-4 ring-1', combined ? 'bg-accent/10 ring-accent/50' : 'bg-surface-0 ring-line')}>
            <Title hint="Uma imagem só para a capa e o fundo, unidas sem emenda. Fica no lugar das duas de cima. Arraste a imagem para escolher a parte que aparece.">
              Capa com Fundo de Mini-Perfil
            </Title>
            {combined && <CombinedPositioner />}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant={combined ? 'secondary' : 'primary'} loading={uploading === 'combined'} onClick={() => void upload('combined', '/me/card-combined', 1600, false, 'Capa com fundo atualizada')}>
                <ImagePlus size={15} /> {combined ? 'Trocar imagem' : 'Escolher imagem ou GIF'}
              </Button>
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
    </div>
  );
}

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
  onRemove,
}: {
  title: string;
  hint: string;
  thumb: string | null | undefined;
  thumbClass: string;
  disabledNote?: string;
  loading: boolean;
  pickLabel: string;
  onPick: () => void;
  onRemove?: () => void;
}) {
  return (
    <section className={cx('flex items-center gap-4 rounded-3xl bg-surface-0 p-4 ring-1 ring-line', disabledNote && 'opacity-60')}>
      <div className={cx('shrink-0 overflow-hidden rounded-xl bg-surface-3 ring-1 ring-line', thumbClass)}>
        {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-fg-subtle"><ImagePlus size={18} /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <Title hint={disabledNote ?? hint}>{title}</Title>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="h-9 px-4" loading={loading} onClick={onPick}>
            <ImagePlus size={15} /> {pickLabel}
          </Button>
          {onRemove && (
            <Button variant="ghost" className="h-9 px-3" onClick={onRemove}>
              <Trash2 size={15} /> Remover
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Ajuste de posição da capa com fundo: um cartão do tamanho do mini perfil, com a linha onde a capa termina.
 * Arrastar move a imagem; soltar salva.
 */
function CombinedPositioner() {
  const me = useApp((s) => s.me)!;
  const setMe = useApp((s) => s.setMe);
  const saved = me.combinedPos ?? { x: 50, y: 30 };
  const [pos, setPos] = useState(saved);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; start: { x: number; y: number } } | null>(null);
  const url = me.combinedBgUrl!;

  useEffect(() => setPos(me.combinedPos ?? { x: 50, y: 30 }), [me.combinedPos?.x, me.combinedPos?.y, url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, [url]);

  /** Quanto a imagem sobra para fora do cartão em cada eixo (em px), com "cover". */
  function overflow() {
    const el = box.current;
    if (!el || !natural) return { x: 0, y: 0 };
    const scale = Math.max(el.clientWidth / natural.w, el.clientHeight / natural.h);
    return { x: natural.w * scale - el.clientWidth, y: natural.h * scale - el.clientHeight };
  }

  async function save(next: { x: number; y: number }) {
    try {
      setMe(await api.patch<Me>('/me/style', { combinedPos: next }));
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

  return (
    <div className="flex flex-wrap items-end gap-4">
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
        className="relative h-[264px] w-48 shrink-0 cursor-grab touch-none overflow-hidden rounded-[20px] ring-1 ring-line select-none active:cursor-grabbing"
        style={{ backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: `${pos.x}% ${pos.y}%` }}
      >
        {/* onde a capa termina e onde fica a sua foto */}
        <div className="pointer-events-none absolute inset-x-0 top-[64px] border-t-2 border-dashed border-white/70" />
        <span className="pointer-events-none absolute top-1.5 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white">Capa</span>
        <div className="pointer-events-none absolute top-[42px] left-[10px] h-[43px] w-[43px] rounded-full border-2 border-dashed border-white/70 bg-black/20" />
        <span className="pointer-events-none absolute right-2 bottom-2 left-2 rounded-xl bg-black/55 px-2 py-1.5 text-center text-[11px] font-semibold text-white">
          <Move size={12} className="mr-1 inline" /> Arraste para ajustar
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

/** Prévia do mini perfil como os outros veem. */
export function CardPreview({ me }: { me: Me }) {
  const name = me.displayName || me.username;
  const patches = me.patches ?? [];
  const top = me.bannerColor ?? me.avatarColor;
  const look = cardLook(me);
  return (
    <div>
      <Title>Prévia</Title>
      <div className="overflow-hidden rounded-[22px] bg-popover bg-cover bg-center ring-1 ring-line" style={look.style}>
        {look.combined ? (
          <div className="aspect-[3/1] w-full" />
        ) : look.bannerUrl ? (
          <img src={look.bannerUrl} alt="" className="aspect-[3/1] w-full object-cover" />
        ) : (
          <div className="h-14" style={look.hasImage ? undefined : { background: `linear-gradient(135deg, ${top}, ${top}55)` }} />
        )}
        <div className="px-3 pb-3">
          <div className="-mt-8 mb-2 flex items-end justify-between gap-1">
            <Avatar name={name} color={me.avatarColor} src={me.avatarUrl} frame={me.frame} size={60} status="online" className="rounded-full ring-[5px] ring-surface-1" />
            <div className="flex flex-wrap justify-end pl-1">
              {patches.map((p, i) => (
                <div key={p.id} className="-ml-1.5">
                  <PatchBadge patch={p} size={patches.length > 4 ? 28 : 34} tilt={PATCH_TILTS[i % PATCH_TILTS.length]} />
                </div>
              ))}
            </div>
          </div>
          <div className={cx('rounded-2xl p-2.5', look.hasImage ? 'bg-surface-0/80 backdrop-blur-md' : 'bg-surface-0')}>
            <div className="truncate font-bold">{name}</div>
            <div className="text-xs text-fg-muted">@{me.username}</div>
            {me.bio && <p className="mt-2 line-clamp-3 text-xs">{me.bio}</p>}
          </div>
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
