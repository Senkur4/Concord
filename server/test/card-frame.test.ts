// Moldura do mini perfil: só as que existem, e visível para os outros membros do servidor.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type TestServer } from './helpers.ts';

let server: TestServer;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

describe('moldura do mini perfil', () => {
  it('liga, desliga e recusa as que não existem', async () => {
    const me = await signUp(server, 'natal');
    const on = await me.patch('/me/style', { cardFrame: 'christmas' });
    assert.equal(on.status, 200);
    assert.equal(on.body.cardFrame, 'christmas');
    for (const bad of ['halloween', 1, ['christmas']]) {
      assert.equal((await me.patch('/me/style', { cardFrame: bad })).status, 400, JSON.stringify(bad));
    }
    const off = await me.patch('/me/style', { cardFrame: null });
    assert.equal(off.body.cardFrame, null);
  });

  it('não mexe na moldura da foto (e vice-versa)', async () => {
    const me = await signUp(server, 'natal');
    await me.patch('/me/style', { frame: 'gold' });
    const res = await me.patch('/me/style', { cardFrame: 'christmas' });
    assert.equal(res.body.frame, 'gold');
    assert.equal(res.body.cardFrame, 'christmas');
  });

  it('aparece para os outros membros do servidor', async () => {
    const dono = await signUp(server, 'dono');
    const serverId = (await dono.post('/servers', { name: 'Natal' })).body.id as string;
    const code = (await dono.post(`/servers/${serverId}/invites`, {})).body.code as string;
    const amigo = await signUp(server, 'amigo');
    await amigo.post(`/invites/${code}`);
    await dono.patch('/me/style', { cardFrame: 'christmas' });
    const members = (await amigo.get(`/servers/${serverId}`)).body.members as { id: string; cardFrame: string | null }[];
    assert.equal(members.find((m) => m.id === dono.id)!.cardFrame, 'christmas');
  });

  it('divisor: pisca-pisca e neve, e recusa os que não existem', async () => {
    const me = await signUp(server, 'divisor');
    for (const d of ['lights', 'snow']) {
      const res = await me.patch('/me/style', { cardDivider: d });
      assert.equal(res.status, 200);
      assert.equal(res.body.cardDivider, d);
    }
    assert.equal((await me.patch('/me/style', { cardDivider: 'fire' })).status, 400);
    assert.equal((await me.patch('/me/style', { cardDivider: null })).body.cardDivider, null);
  });
});
