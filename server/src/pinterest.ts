// "Buscar no Pinterest": a pessoa acha a imagem no Pinterest (numa aba ao lado) e cola aqui o link do pin.
// O Pinterest não deixa outro site embutir a busca dele, e não tem API pública de pesquisa; então quem pega a
// imagem é o servidor: abre a página do pin, lê a imagem dela (og:image) e devolve os bytes para a prévia.
// Depois o navegador envia essa imagem pelas rotas de sempre (/me/avatar, /me/banner...), com as mesmas regras.
//
// Só fala com endereços do Pinterest (pin.it, pinterest.*, *.pinimg.com), conferidos a cada redirecionamento,
// para a rota não virar um jeito de fazer o servidor acessar qualquer endereço (inclusive da rede local).
import express, { type Router } from 'express';
import { fail, uid } from './http.ts';
import { limiter } from './recovery.ts';
import { detectImage } from './uploads.ts';

const MAX_IMAGE = 9 * 1024 * 1024;
const MAX_PAGE = 3 * 1024 * 1024;
const MAX_HOPS = 5;
const UA = 'Mozilla/5.0 (compatible; Concord/1.0; +https://github.com/duarteHiago/concord)';

/** pin.it, pinterest.com, br.pinterest.com, pinterest.com.br, pinterest.co.uk..., i.pinimg.com */
export function isPinterestHost(host: string) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'pin.it') return true;
  if (h === 'pinimg.com' || h.endsWith('.pinimg.com')) return true;
  return /(^|\.)pinterest\.(com|[a-z]{2}|com?\.[a-z]{2})$/.test(h);
}

const isImageHost = (host: string) => /(^|\.)pinimg\.com$/i.test(host);

export function parsePinterestUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2000) fail(400, 'Cole o link de um pin do Pinterest');
  let text = (raw as string).trim();
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail(400, 'Esse link não parece um endereço. Copie o link do pin de novo.');
  }
  url = url!;
  if (!isPinterestHost(url.hostname)) fail(400, 'Só dá para usar links do Pinterest (pinterest.com, pin.it ou pinimg.com)');
  if (url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) fail(400, 'Link inválido');
  url.protocol = 'https:';
  url.port = '';
  return url;
}

/** Busca seguindo redirecionamentos na mão, conferindo que cada um continua no Pinterest. */
async function fetchPinterest(start: URL): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': UA, Accept: 'text/html,image/avif,image/webp,image/*,*/*;q=0.8', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      void res.body?.cancel();
      if (!next) fail(502, 'O Pinterest não respondeu direito. Tente de novo.');
      url = parsePinterestUrl(new URL(next!, url).toString());
      continue;
    }
    return { res, url };
  }
  return fail(502, 'O link do pin redireciona demais');
}

async function readLimited(res: Response, max: number, tooBig: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    void res.body?.cancel();
    fail(413, tooBig);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel();
      fail(413, tooBig);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/gi, '/').replace(/&#39;/g, "'").replace(/\\u002F/gi, '/').replace(/\\\//g, '/');

/** A imagem principal da página do pin: og:image, ou a primeira imagem grande do pinimg que aparecer. */
export function findPinImage(html: string): string | null {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metas) {
    if (!/(property|name)\s*=\s*["'](og:image(:secure_url)?|twitter:image(:src)?)["']/i.test(tag)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (content) return decode(content);
  }
  const big = html.match(/https:(?:\/|\\\/|\\u002F){2}i\.pinimg\.com(?:\/|\\\/|\\u002F)(?:originals|736x|564x)[^"'\s<>]*?\.(?:jpe?g|png|gif|webp)/i);
  return big ? decode(big[0]) : null;
}

/** Tenta a versão original (maior) da imagem antes do tamanho que a página mostra. */
function candidates(img: URL): URL[] {
  const list: URL[] = [];
  const m = img.pathname.match(/^\/(\d+x\d*|originals)\/(.+)$/);
  if (m && m[1] !== 'originals') {
    const orig = new URL(img);
    orig.pathname = `/originals/${m[2]}`;
    list.push(orig);
  }
  list.push(img);
  return list;
}

async function downloadImage(img: URL): Promise<Buffer> {
  let lastError: unknown;
  for (const url of candidates(img)) {
    try {
      const { res } = await fetchPinterest(url);
      if (!res.ok) {
        void res.body?.cancel();
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const buf = await readLimited(res, MAX_IMAGE, 'A imagem desse pin é grande demais (máximo 9 MB)');
      if (detectImage(buf)) return buf;
      lastError = new Error('não é imagem');
    } catch (err) {
      if ((err as { status?: number }).status === 413) throw err;
      lastError = err;
    }
  }
  void lastError;
  return fail(422, 'Não consegui baixar a imagem desse pin. Tente abrir o pin e copiar o link dele de novo.');
}

/** Link do pin (ou da imagem) -> bytes da imagem. */
export async function resolvePinterestImage(raw: unknown): Promise<Buffer> {
  const start = parsePinterestUrl(raw);
  if (isImageHost(start.hostname)) return downloadImage(start);

  let page: { res: Response; url: URL };
  try {
    page = await fetchPinterest(start);
  } catch (err) {
    if ((err as { status?: number }).status) throw err;
    fail(502, 'Não consegui abrir o Pinterest agora. Confira a internet do servidor e tente de novo.');
  }
  const { res, url } = page!;
  if (!res.ok) {
    void res.body?.cancel();
    fail(422, res.status === 404 ? 'Esse pin não existe mais (ou é privado).' : 'O Pinterest não deixou abrir esse pin agora. Tente de novo.');
  }
  // o redirecionamento pode ter caído direto na imagem
  if (isImageHost(url.hostname) || (res.headers.get('content-type') ?? '').startsWith('image/')) {
    const buf = await readLimited(res, MAX_IMAGE, 'A imagem desse pin é grande demais (máximo 9 MB)');
    if (detectImage(buf)) return buf;
    fail(422, 'Esse link não leva a uma imagem');
  }
  const html = (await readLimited(res, MAX_PAGE, 'A página do pin é grande demais')).toString('utf8');
  const found = findPinImage(html);
  if (!found) fail(422, 'Não achei uma imagem nesse link. Use o link de um pin (aquele que abre a imagem sozinha).');
  let img: URL;
  try {
    img = parsePinterestUrl(found);
  } catch {
    fail(422, 'Não achei uma imagem nesse link.');
  }
  return downloadImage(img!);
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const perUser = limiter(40, 60 * 60_000);

export function registerPinterestRoutes(api: Router) {
  api.post('/pinterest/image', express.json({ limit: '8kb' }), async (req, res) => {
    const me = uid(res);
    if (!perUser(me)) fail(429, 'Muitas buscas no Pinterest em pouco tempo. Espere um pouco.');
    const buf = await resolvePinterestImage((req.body as { url?: unknown } | undefined)?.url);
    const ext = detectImage(buf)!;
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });
}
