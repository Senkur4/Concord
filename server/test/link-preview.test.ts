// Prévia de links: leitura das tags og:, sites especiais e, principalmente, que o servidor não abre endereço interno.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { isBlockedIp, parseMeta } from '../src/linkPreview.ts';
import { signUp, startServer, type TestServer } from './helpers.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
let site: Server;
let siteUrl = '';

before(async () => {
  site = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/noticia') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><title>Título da aba</title>
        <meta property="og:title" content="Concord ganha prévia de links &amp; mais">
        <meta content="Agora os links mostram título, descrição e imagem." property="og:description">
        <meta property="og:image" content="/capa.png"><meta property="og:site_name" content="Jornal do Teste">
        <meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#ff8800">
        </head><body>texto</body></html>`);
    }
    if (u.pathname === '/so-titulo') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><head><title>Só o título</title></head></html>');
    }
    if (u.pathname === '/pagina-svg') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<meta property="og:title" content="Com SVG"><meta property="og:image" content="/svg">');
    }
    if (u.pathname === '/svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end('<svg onload="alert(1)"/>');
    }
    if (u.pathname === '/capa.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    if (u.pathname === '/oembed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ title: 'Clipe de teste', author_name: 'Canal do Teste' }));
    }
    if (u.pathname === '/fx/fulano/status/12345') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ tweet: { text: 'olá do X', author: { name: 'Fulano', screen_name: 'fulano' }, media: { photos: [{ url: `${siteUrl}/capa.png` }] } } }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});
after(() => site.close());

describe('prévia de links: endereços proibidos', () => {
  it('recusa rede interna, Radmin, localhost, metadados de nuvem e IPv6 local', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.5.4', '172.31.255.255', '26.125.194.51', '100.64.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1']) {
      assert.equal(isBlockedIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '200.147.67.142', '2606:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
  });

  it('lê og: em qualquer ordem de atributos e decodifica &amp;', () => {
    const m = parseMeta(`<meta content="B &amp; C" property="og:title"><meta name='description' content='desc'><title> Aba </title>`);
    assert.equal(m['og:title'], 'B & C');
    assert.equal(m['description'], 'desc');
    assert.equal(m['html:title'], 'Aba');
  });
});

describe('prévia de links: o servidor não abre endereço interno', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer({});
  });
  after(() => srv.stop());

  it('link para o próprio PC / rede de casa: sem prévia, e a imagem assinada também não passa', async () => {
    const me = await signUp(srv, 'ssrf');
    for (const url of [`${siteUrl}/noticia`, 'http://localhost:3000/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://26.125.194.51/', 'file:///etc/passwd']) {
      const res = await me.get(`/link-preview?url=${encodeURIComponent(url)}`);
      if (url.startsWith('file')) assert.equal(res.status, 400);
      else assert.equal(res.body.preview, null, url);
    }
  });
});

describe('prévia de links: páginas e sites especiais', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer({ LINK_PREVIEW_ALLOW_PRIVATE: '1', LINK_PREVIEW_YOUTUBE_OEMBED: `${siteUrl}/oembed`, LINK_PREVIEW_FXTWITTER: `${siteUrl}/fx` });
  });
  after(() => srv.stop());

  it('página comum: título, descrição, site, cor e imagem (passando por aqui)', async () => {
    const me = await signUp(srv, 'prev');
    const { preview } = (await me.get(`/link-preview?url=${encodeURIComponent(`${siteUrl}/noticia`)}`)).body;
    assert.equal(preview.kind, 'page');
    assert.equal(preview.title, 'Concord ganha prévia de links & mais');
    assert.equal(preview.description, 'Agora os links mostram título, descrição e imagem.');
    assert.equal(preview.site, 'Jornal do Teste');
    assert.equal(preview.color, '#ff8800');
    assert.equal(preview.large, true);
    assert.match(preview.image, /^\/api\/link-preview\/img\?u=/);
    // a imagem vem pelo servidor, sem login (o <img> não manda), mas só com a assinatura certa
    const img = await fetch(`${srv.url}${preview.image}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${srv.url}${preview.image.replace(/s=[^&]+/, 's=falsa')}`)).status, 403);

    const onlyTitle = (await me.get(`/link-preview?url=${encodeURIComponent(`${siteUrl}/so-titulo`)}`)).body.preview;
    assert.equal(onlyTitle.title, 'Só o título');
    assert.equal(onlyTitle.image, null);
  });

  it('YouTube (com o vídeo para tocar no chat) e X/Twitter', async () => {
    const me = await signUp(srv, 'yt');
    for (const link of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'https://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ']) {
      const yt = (await me.get(`/link-preview?url=${encodeURIComponent(link)}`)).body.preview;
      assert.equal(yt.kind, 'youtube', link);
      assert.equal(yt.videoId, 'dQw4w9WgXcQ');
      assert.equal(yt.title, 'Clipe de teste');
      assert.equal(yt.author, 'Canal do Teste');
    }
    const tw = (await me.get(`/link-preview?url=${encodeURIComponent('https://x.com/fulano/status/12345')}`)).body.preview;
    assert.equal(tw.kind, 'tweet');
    assert.equal(tw.title, 'Fulano (@fulano)');
    assert.equal(tw.description, 'olá do X');
    assert.ok(tw.image);
  });

  it('imagem que não é imagem de verdade (SVG, que pode ter script) não passa', async () => {
    const me = await signUp(srv, 'svg');
    const { preview } = (await me.get(`/link-preview?url=${encodeURIComponent(`${siteUrl}/pagina-svg`)}`)).body;
    assert.ok(preview.image);
    assert.equal((await fetch(`${srv.url}${preview.image}`)).status, 415);
  });
});
