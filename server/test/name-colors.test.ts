// Cor do nome: sólida ou degradê (2 a 3 cores), validada, e visível para os outros no servidor.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type TestServer } from './helpers.ts';

let server: TestServer;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

describe('cor do nome', () => {
  it('salva sólida, degradê de 2 e de 3 cores, e volta ao padrão', async () => {
    const me = await signUp(server, 'cores');
    for (const colors of [['#FF8F70'], ['#ff8f70', '#3ad7ff'], ['#ffd000', '#ff7a00', '#ff1f4b']]) {
      const res = await me.patch('/me/style', { nameColors: colors });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.nameColors, colors.map((c) => c.toLowerCase()));
    }
    const off = await me.patch('/me/style', { nameColors: null });
    assert.equal(off.body.nameColors, null);
  });

  it('recusa formato errado, cor demais ou de menos', async () => {
    const me = await signUp(server, 'cores');
    for (const bad of [[], ['#fff'], ['red'], ['#ff8f70', '#ff8f70', '#ff8f70', '#ff8f70'], '#ff8f70', [1]]) {
      assert.equal((await me.patch('/me/style', { nameColors: bad })).status, 400, JSON.stringify(bad));
    }
  });

  it('aparece para os outros membros do servidor', async () => {
    const dono = await signUp(server, 'dono');
    const serverId = (await dono.post('/servers', { name: 'Cores' })).body.id as string;
    const code = (await dono.post(`/servers/${serverId}/invites`, {})).body.code as string;
    const amigo = await signUp(server, 'amigo');
    await amigo.post(`/invites/${code}`);
    await dono.patch('/me/style', { nameColors: ['#7cffb2', '#b46bff'] });
    const members = (await amigo.get(`/servers/${serverId}`)).body.members as { id: string; nameColors: string[] | null }[];
    assert.deepEqual(members.find((m) => m.id === dono.id)!.nameColors, ['#7cffb2', '#b46bff']);
  });
});
