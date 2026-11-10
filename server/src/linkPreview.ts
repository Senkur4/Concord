// Prévia de links no chat: título, descrição e imagem da página (as tags og: que o Discord, o WhatsApp etc. leem),
// e um tratamento especial para YouTube (dá para assistir no chat), X/Twitter e TikTok.
//
// Segurança: é o SERVIDOR que abre o link, então ele não pode ser usado para espiar a rede de dentro. Só vale
// http/https nas portas 80/443, e qualquer endereço interno é recusado, inclusive depois de redirecionamentos e
// na hora de conectar (o nome é resolvido e conferido no momento da conexão): localhost, rede de casa (192.168.x,
// 10.x, 172.16-31.x), Radmin (26.x), CGNAT (100.64.x), metadados de nuvem (169.254.x), IPv6 local etc.
// Cada página é lida só até 512 KB, em no máximo 8 s. As imagens passam por aqui também (endereço assinado), para
// quem está no chat não ser exposto aos sites dos links.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Router } from 'express';
import { config } from './config.ts';
import { fail, uid } from './http.ts';

const allowPrivate = () => process.env.LINK_PREVIEW_ALLOW_PRIVATE === '1'; // só para os testes
const UA = 'Mozilla/5.0 (compatible; ConcordLinkPreview/1.0; +https://github.com/duarteHiago/concord)';

// ---------- endereços proibidos ----------

function v4ToInt(ip: string) {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['26.0.0.0', 8], // Radmin VPN
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3], // multicast e reservados (224-255)
];

export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === v4ToInt(base));
  }
  if (kind === 6) {
    const low = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isBlockedIp(mapped[1]);
    if (low === '::' || low === '::1') return true;
    const first = parseInt(low.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 /* fc00::/7 */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 */ || (first & 0xff00) === 0xff00 /* multicast */;
  }
  return true;
}

class Blocked extends Error {}

/** Resolve o nome e recusa endereço interno, no momento da conexão (não dá para trocar o IP depois de conferido). */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number } | number, cb: (...args: unknown[]) => void) {
  const opts = typeof options === 'number' ? { family: options } : options;
  lookup(hostname, { ...opts, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return cb(err);
    if (!allowPrivate() && addresses.some((a) => isBlockedIp(a.address))) return cb(new Blocked(`endereço interno: ${hostname}`));
    if (opts.all) cb(null, addresses);
    else cb(null, addresses[0].address, addresses[0].family);
  });
}

interface Fetched {
  url: string;
  type: string;
  body: Buffer;
}

/** GET com as proteções acima, seguindo até 4 redirecionamentos (cada um conferido de novo). */
export function safeGet(rawUrl: string, maxBytes: number, accept: string, redirects = 4): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return reject(new Blocked('endereço inválido'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Blocked('só http e https'));
    if (url.username || url.password) return reject(new Blocked('endereço com senha'));
    if (!allowPrivate() && url.port && url.port !== '80' && url.port !== '443') return reject(new Blocked('porta não permitida'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !allowPrivate() && isBlockedIp(host)) return reject(new Blocked('endereço interno'));
    if (!allowPrivate() && /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return reject(new Blocked('endereço interno'));

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      {
        lookup: guardedLookup as never,
        timeout: 8000,
        headers: { 'user-agent': UA, accept, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.7', 'accept-encoding': 'identity' },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Blocked('redirecionamentos demais'));
          return resolve(safeGet(new URL(res.headers.location, url).toString(), maxBytes, accept, redirects - 1));
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`a página respondeu ${status}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          // basta o começo da página (o <head>); imagem grande demais é recusada
          if (size >= maxBytes) {
            req.destroy();
            if (accept.startsWith('image')) reject(new Blocked('imagem grande demais'));
            else resolve({ url: url.toString(), type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).subarray(0, maxBytes) });
          }
        });
        res.on('end', () => resolve({ url: url.toString(), type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('a página demorou demais')));
    req.on('error', reject);
  });
}

// ---------- leitura da página ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

function textOf(f: Fetched) {
  const charset = /charset=["']?([\w-]+)/i.exec(f.type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(f.body.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(f.body);
  } catch {
    return f.body.toString('utf8');
  }
}

/** As <meta> da página: og:*, twitter:*, description, theme-color. */
export function parseMeta(html: string) {
  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (key && content && !(key in meta)) meta[key] = decode(content[1] ?? content[2] ?? '');
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) meta['html:title'] = decode(title);
  return meta;
}

export interface Preview {
  kind: 'page' | 'youtube' | 'tweet' | 'tiktok';
  url: string;
  site: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  /** imagem grande (embaixo) ou miniatura (do lado) */
  large: boolean;
  color: string | null;
  author: string | null;
  videoId?: string;
}

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s) : null);

// ---------- imagens por aqui (endereço assinado: não vira um proxy aberto) ----------

const sign = (u: string) => createHmac('sha256', `${config.jwtSecret}|link-image`).update(u).digest('base64url').slice(0, 24);
export const proxied = (u: string | null | undefined) => {
  if (!u) return null;
  try {
    const abs = new URL(u);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    return `/api/link-preview/img?u=${encodeURIComponent(abs.toString())}&s=${sign(abs.toString())}`;
  } catch {
    return null;
  }
};

// ---------- sites especiais ----------

function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = /^\/(?:shorts|live|embed)\/([\w-]{6,})/.exec(u.pathname);
    if (m) return m[1];
  }
  return null;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const f = await safeGet(url, 256 * 1024, 'application/json');
    return JSON.parse(f.body.toString('utf8')) as T;
  } catch {
    return null;
  }
}

const apis = () => ({
  youtube: process.env.LINK_PREVIEW_YOUTUBE_OEMBED || 'https://www.youtube.com/oembed',
  fxtwitter: process.env.LINK_PREVIEW_FXTWITTER || 'https://api.fxtwitter.com',
  tiktok: process.env.LINK_PREVIEW_TIKTOK_OEMBED || 'https://www.tiktok.com/oembed',
});

async function special(u: URL): Promise<Preview | null> {
  const id = youtubeId(u);
  if (id && /^[\w-]{6,20}$/.test(id)) {
    const o = await json<{ title?: string; author_name?: string }>(`${apis().youtube}?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
    return {
      kind: 'youtube',
      url: u.toString(),
      site: 'YouTube',
      title: clip(o?.title, 200),
      description: null,
      image: proxied(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
      large: true,
      color: '#ff0033',
      author: clip(o?.author_name, 80),
      videoId: id,
    };
  }
  const host = u.hostname.replace(/^(www|mobile)\./, '');
  const tweet = /^\/(\w{1,15})\/status(?:es)?\/(\d{5,25})/.exec(u.pathname);
  if ((host === 'x.com' || host === 'twitter.com' || host === 'fxtwitter.com' || host === 'vxtwitter.com') && tweet) {
    const t = await json<{ tweet?: { text?: string; author?: { name?: string; screen_name?: string }; media?: { photos?: { url: string }[]; videos?: { thumbnail_url?: string }[] } } }>(
      `${apis().fxtwitter}/${tweet[1]}/status/${tweet[2]}`,
    );
    if (t?.tweet) {
      const img = t.tweet.media?.photos?.[0]?.url ?? t.tweet.media?.videos?.[0]?.thumbnail_url;
      return {
        kind: 'tweet',
        url: u.toString(),
        site: 'X (Twitter)',
        title: t.tweet.author ? `${t.tweet.author.name ?? ''} (@${t.tweet.author.screen_name ?? tweet[1]})` : null,
        description: clip(t.tweet.text, 500),
        image: proxied(img),
        large: !!img,
        color: '#1d9bf0',
        author: null,
      };
    }
  }
  if (host === 'tiktok.com' || host === 'vm.tiktok.com') {
    const o = await json<{ title?: string; author_name?: string; thumbnail_url?: string }>(`${apis().tiktok}?url=${encodeURIComponent(u.toString())}`);
    if (o) {
      return { kind: 'tiktok', url: u.toString(), site: 'TikTok', title: clip(o.author_name, 80), description: clip(o.title, 300), image: proxied(o.thumbnail_url), large: false, color: '#fe2c55', author: null };
    }
  }
  return null;
}

async function build(raw: string): Promise<Preview | null> {
  const u = new URL(raw);
  const sp = await special(u);
  if (sp) return sp;
  const page = await safeGet(raw, 512 * 1024, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  // link direto para imagem: o chat já mostra a imagem, não precisa de cartão
  if (!/html|xml/i.test(page.type)) return null;
  const m = parseMeta(textOf(page));
  const title = m['og:title'] ?? m['twitter:title'] ?? m['html:title'];
  const description = m['og:description'] ?? m['twitter:description'] ?? m['description'];
  const image = m['og:image:secure_url'] ?? m['og:image'] ?? m['og:image:url'] ?? m['twitter:image'] ?? m['twitter:image:src'];
  if (!title && !description) return null;
  const color = /^#[0-9a-f]{3,8}$/i.test(m['theme-color'] ?? '') ? m['theme-color'] : null;
  return {
    kind: 'page',
    url: page.url,
    site: clip(m['og:site_name'] ?? new URL(page.url).hostname.replace(/^www\./, ''), 80),
    title: clip(title, 200),
    description: clip(description, 350),
    image: image ? proxied(new URL(image, page.url).toString()) : null,
    large: (m['twitter:card'] ?? '') === 'summary_large_image' || /^(video|article)/.test(m['og:type'] ?? ''),
    color,
    author: null,
  };
}

// ---------- cache e rotas ----------

const cache = new Map<string, { at: number; data: Preview | null }>();
const inflight = new Map<string, Promise<Preview | null>>();
const TTL = 6 * 60 * 60_000;
const perUser = new Map<string, { start: number; count: number }>();

export async function preview(url: string): Promise<Preview | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < (hit.data ? TTL : 30 * 60_000)) return hit.data;
  let p = inflight.get(url);
  if (!p) {
    p = build(url)
      .catch(() => null)
      .finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  const data = await p;
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return data;
}

export function registerLinkPreviewRoutes(api: Router) {
  api.get('/link-preview', async (req, res) => {
    const me = uid(res);
    const url = String(req.query.url ?? '').trim();
    if (!/^https?:\/\//i.test(url) || url.length > 2000) fail(400, 'Link inválido');
    // 60 links novos por minuto por pessoa (o que já está no cache não conta)
    if (!cache.has(url)) {
      const now = Date.now();
      const q = perUser.get(me);
      if (!q || now - q.start > 60_000) perUser.set(me, { start: now, count: 1 });
      else if (++q.count > 60) fail(429, 'Calma: links demais em pouco tempo');
    }
    res.json({ preview: await preview(url) });
  });
}

/** Antes do requireAuth: o <img> não manda o login. O endereço assinado garante que só imagens de prévias passam. */
export function registerLinkPreviewImageRoute(api: Router) {
  // imagens das prévias, por aqui (sem expor o IP de quem está vendo)
  api.get('/link-preview/img', async (req, res) => {
    const u = String(req.query.u ?? '');
    const s = String(req.query.s ?? '');
    const want = Buffer.from(sign(u));
    if (!u || want.length !== Buffer.from(s).length || !timingSafeEqual(want, Buffer.from(s))) return void res.status(403).end();
    try {
      const img = await safeGet(u, 8 * 1024 * 1024, 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8');
      // só imagem de verdade (nada de SVG, que pode ter script)
      if (!/^image\/(png|jpe?g|gif|webp|avif)/i.test(img.type)) return void res.status(415).end();
      res.setHeader('Content-Type', img.type.split(';')[0]);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.end(img.body);
    } catch {
      res.status(404).end();
    }
  });
}
