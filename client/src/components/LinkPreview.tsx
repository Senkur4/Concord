import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { cx } from './ui';

/**
 * Cartões de prévia embaixo das mensagens com links (como no Discord): site, título, descrição e imagem. Vídeo do
 * YouTube toca ali mesmo, no player sem cookies de rastreio. Quem busca a página é o servidor (ver linkPreview.ts),
 * e as imagens vêm por ele: quem está no chat não fala direto com o site do link.
 */

export interface Preview {
  kind: 'page' | 'youtube' | 'tweet' | 'tiktok';
  url: string;
  site: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  large: boolean;
  color: string | null;
  author: string | null;
  videoId?: string;
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;
// link direto de imagem já aparece como imagem no chat
const IMG_RE = /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i;
const MAX = 3;

// a mesma prévia para todas as mensagens com o mesmo link (e só um pedido por link)
const cache = new Map<string, Promise<Preview | null>>();
function load(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = api
      .get<{ preview: Preview | null }>(`/link-preview?url=${encodeURIComponent(url)}`)
      .then((r) => r.preview)
      .catch(() => {
        cache.delete(url);
        return null;
      });
    cache.set(url, p);
  }
  return p;
}

export function linksIn(text: string, exclude: (string | undefined)[] = []): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const u = m[1];
    if (IMG_RE.test(u) || exclude.includes(u) || seen.has(u)) continue;
    seen.add(u);
    if (seen.size >= MAX) break;
  }
  return [...seen];
}

/** imagem que não carregou (site fora do ar, link vencido): some, em vez do ícone de imagem quebrada */
const hideBroken = (e: { currentTarget: HTMLImageElement }) => {
  e.currentTarget.style.display = 'none';
};

function YouTubeCard({ p }: { p: Preview }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="w-[440px] max-w-full overflow-hidden rounded-2xl border-l-4 bg-surface-2 ring-1 ring-line" style={{ borderLeftColor: p.color ?? undefined }}>
      <div className="px-3.5 pt-2.5 pb-2">
        <div className="text-xs text-fg-muted">{p.author ? `YouTube · ${p.author}` : 'YouTube'}</div>
        {p.title && (
          <a href={p.url} target="_blank" rel="noreferrer noopener" className="mt-0.5 line-clamp-2 block font-semibold text-accent hover:underline">
            {p.title}
          </a>
        )}
      </div>
      <div className="relative aspect-video bg-black">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${p.videoId}?autoplay=1&rel=0`}
            title={p.title ?? 'Vídeo do YouTube'}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <button onClick={() => setPlaying(true)} aria-label="Assistir aqui" className="group absolute inset-0">
            {p.image && <img src={p.image} alt="" loading="lazy" onError={hideBroken} className="h-full w-full object-cover" />}
            <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/35">
              <span className="flex h-14 w-20 items-center justify-center rounded-2xl bg-[#ff0033] text-white shadow-lg transition-transform group-hover:scale-110">
                <Play size={26} fill="currentColor" />
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function PageCard({ p }: { p: Preview }) {
  const big = p.large && !!p.image;
  return (
    <div className="w-[440px] max-w-full overflow-hidden rounded-2xl border-l-4 border-l-fg-subtle bg-surface-2 ring-1 ring-line" style={{ borderLeftColor: p.color ?? undefined }}>
      <div className="flex gap-3 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          {p.site && <div className="truncate text-xs text-fg-muted">{p.site}</div>}
          {p.title && (
            <a href={p.url} target="_blank" rel="noreferrer noopener" className="mt-0.5 line-clamp-2 block font-semibold text-accent hover:underline">
              {p.title}
            </a>
          )}
          {p.description && <p className={cx('mt-1 text-sm leading-snug whitespace-pre-line text-fg/80', p.kind === 'tweet' ? 'line-clamp-6' : 'line-clamp-3')}>{p.description}</p>}
        </div>
        {!big && p.image && <img src={p.image} alt="" loading="lazy" onError={hideBroken} className="h-20 w-20 shrink-0 rounded-xl object-cover" />}
      </div>
      {big && (
        <a href={p.url} target="_blank" rel="noreferrer noopener" className="block">
          <img src={p.image!} alt="" loading="lazy" onError={hideBroken} className="max-h-72 w-full object-cover" />
        </a>
      )}
    </div>
  );
}

function OnePreview({ url }: { url: string }) {
  const [p, setP] = useState<Preview | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void load(url).then((r) => alive && setP(r));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!p) return null;
  return p.kind === 'youtube' && p.videoId ? <YouTubeCard p={p} /> : <PageCard p={p} />;
}

/** Até 3 prévias, dos links da mensagem (links de imagem e os que já têm cartão próprio ficam de fora). */
export function LinkPreviews({ text, exclude, className }: { text: string; exclude?: (string | undefined)[]; className?: string }) {
  const links = linksIn(text, exclude);
  if (!links.length) return null;
  return (
    <div className={cx('mt-1.5 flex flex-col gap-1.5', className)}>
      {links.map((u) => (
        <OnePreview key={u} url={u} />
      ))}
    </div>
  );
}
