// "Buscar no Pinterest": só aceita endereços do Pinterest (também em cada redirecionamento), acha a imagem do pin
// na página e prefere a versão original. O fetch é trocado por um falso: os testes não saem para a internet.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { findPinImage, isPinterestHost, parsePinterestUrl, resolvePinterestImage } from '../src/pinterest.ts';
import { signUp, startServer, type TestServer } from './helpers.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

describe('endereços do Pinterest', () => {
  it('aceita pin.it, pinterest.* e pinimg.com', () => {
    for (const h of ['pin.it', 'pinterest.com', 'br.pinterest.com', 'www.pinterest.com.br', 'pinterest.co.uk', 'i.pinimg.com']) {
      assert.ok(isPinterestHost(h), h);
    }
  });
  it('recusa o resto, inclusive imitações e a rede local', () => {
    for (const h of ['evilpinterest.com', 'pinterest.com.evil.io', 'pinimg.com.evil.io', 'localhost', '127.0.0.1', '26.125.194.51', 'example.com']) {
      assert.ok(!isPinterestHost(h), h);
    }
    assert.throws(() => parsePinterestUrl('http://127.0.0.1:3000/api'), /Pinterest/);
    assert.throws(() => parsePinterestUrl('https://user:pw@pinterest.com/pin/1'));
    assert.throws(() => parsePinterestUrl('https://pinterest.com:8080/pin/1'));
    assert.equal(parsePinterestUrl('br.pinterest.com/pin/123/').toString(), 'https://br.pinterest.com/pin/123/');
  });
});

describe('imagem da página do pin', () => {
  it('lê o og:image', () => {
    const html = '<html><head><meta property="og:image" content="https://i.pinimg.com/736x/aa/bb/cc/abc.jpg"></head></html>';
    assert.equal(findPinImage(html), 'https://i.pinimg.com/736x/aa/bb/cc/abc.jpg');
  });
  it('sem og:image, pega a primeira imagem grande do pinimg (mesmo escapada em JSON)', () => {
    const html = '<script>{"url":"https:\\/\\/i.pinimg.com\\/originals\\/aa\\/bb\\/abc.png"}</script>';
    assert.equal(findPinImage(html), 'https://i.pinimg.com/originals/aa/bb/abc.png');
  });
});

describe('resolver o link', () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  it('pin.it -> página do pin -> imagem original', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = input.toString();
      seen.push(url);
      if (url === 'https://pin.it/abc') return new Response(null, { status: 301, headers: { location: 'https://br.pinterest.com/pin/42/' } });
      if (url === 'https://br.pinterest.com/pin/42/')
        return new Response('<meta property="og:image" content="https://i.pinimg.com/736x/aa/bb/x.png">', { headers: { 'content-type': 'text/html' } });
      if (url === 'https://i.pinimg.com/originals/aa/bb/x.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const buf = await resolvePinterestImage('https://pin.it/abc');
    assert.deepEqual(buf, PNG);
    assert.deepEqual(seen, ['https://pin.it/abc', 'https://br.pinterest.com/pin/42/', 'https://i.pinimg.com/originals/aa/bb/x.png']);
  });

  it('se a original falhar, usa o tamanho da página', async () => {
    globalThis.fetch = (async (input: string | URL) => {
      const url = input.toString();
      if (url.includes('/originals/')) return new Response('', { status: 403 });
      if (url === 'https://i.pinimg.com/736x/aa/x.png') return new Response(PNG);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    assert.deepEqual(await resolvePinterestImage('https://i.pinimg.com/736x/aa/x.png'), PNG);
  });

  it('um redirecionamento para fora do Pinterest é barrado', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      seen.push(input.toString());
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3000/api/me' } });
    }) as typeof fetch;
    await assert.rejects(resolvePinterestImage('https://pin.it/x'), /Pinterest/);
    assert.deepEqual(seen, ['https://pin.it/x']);
  });

  it('o que não é imagem é recusado', async () => {
    globalThis.fetch = (async () => new Response('<html>oi</html>')) as typeof fetch;
    await assert.rejects(resolvePinterestImage('https://i.pinimg.com/736x/a.png'), /baixar a imagem/);
  });
});

describe('rota /pinterest/image', () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(() => server.stop());

  it('precisa de login e recusa links que não são do Pinterest', async () => {
    const anon = await fetch(`${server.url}/api/pinterest/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"https://pin.it/a"}' });
    assert.equal(anon.status, 401);
    const me = await signUp(server, 'pinner');
    const res = await me.post('/pinterest/image', { url: 'https://example.com/a.png' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Pinterest/);
  });
});
