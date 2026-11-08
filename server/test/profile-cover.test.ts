// "Capa com Fundo de Mini-Perfil": uma imagem que cobre o cartão inteiro, com a posição escolhida.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type TestServer } from './helpers.ts';

let server: TestServer;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

// PNG de 1×1 pixel
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('capa com fundo de mini-perfil', () => {
  it('envia a imagem, ajusta a posição e remove', async () => {
    const me = await signUp(server, 'capista');
    const up = await fetch(`${server.url}/api/me/card-combined`, {
      method: 'POST',
      headers: { authorization: `Bearer ${me.token}`, 'content-type': 'application/octet-stream' },
      body: PNG,
    });
    assert.equal(up.status, 200);
    const body = await up.json();
    assert.match(body.combinedBgUrl, /^\/uploads\//);
    assert.deepEqual(body.combinedPos, { x: 50, y: 30 });

    const moved = await me.patch('/me/style', { combinedPos: { x: 12.345, y: 140 } });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.combinedPos, { x: 12.3, y: 100 }, 'arredonda e limita a 0–100');
    assert.equal((await me.patch('/me/style', { combinedPos: { x: 'meio' } })).status, 400);

    // quem divide servidor vê a imagem e a posição no mini-perfil
    const serverId = (await me.post('/servers', { name: 'Servidor' })).body.id;
    const member = (await me.get(`/servers/${serverId}`)).body.members.find((m: { id: string }) => m.id === me.id);
    assert.equal(member.combinedBgUrl, body.combinedBgUrl);
    assert.deepEqual(member.combinedPos, { x: 12.3, y: 100 });

    const del = await me.del('/me/card-combined');
    assert.equal(del.status, 200);
    assert.equal(del.body.combinedBgUrl, null);
  });
});

describe('posição da capa e do fundo do mini perfil', () => {
  it('ajusta, valida e volta ao centro quando troca a imagem', async () => {
    const me = await signUp(server, 'ajusta');
    const send = (path: string) =>
      fetch(`${server.url}/api${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${me.token}`, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(PNG),
      }).then((r) => r.json());
    for (const [path, field] of [
      ['/me/banner', 'bannerPos'],
      ['/me/card-bg', 'cardBgPos'],
    ] as const) {
      assert.deepEqual((await send(path))[field], { x: 50, y: 50 });
      const moved = await me.patch('/me/style', { [field]: { x: 20, y: 80 } });
      assert.equal(moved.status, 200);
      assert.deepEqual(moved.body[field], { x: 20, y: 80 });
      assert.equal((await me.patch('/me/style', { [field]: { x: 'esquerda', y: 1 } })).status, 400);
      // imagem nova começa centralizada
      assert.deepEqual((await send(path))[field], { x: 50, y: 50 });
    }
  });
});
