// Encaminhar mensagens: para canais e conversas privadas, com anexo copiado, marca de "encaminhada" com o autor de
// verdade, e só de onde a pessoa pode ler para onde pode escrever.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type TestServer } from './helpers.ts';

let server: TestServer;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

async function setup() {
  const ana = await signUp(server, 'ana');
  const serverId = (await ana.post('/servers', { name: 'Galera' })).body.id as string;
  const code = (await ana.post(`/servers/${serverId}/invites`, {})).body.code as string;
  const bia = await signUp(server, 'bia');
  assert.equal((await bia.post(`/invites/${code}`)).status, 200);
  const channels = (await ana.get(`/servers/${serverId}`)).body.channels as { id: string; type: string; name: string }[];
  const [geral, outro] = channels.filter((c) => c.type === 'text');
  const dm = (await ana.post('/dms', { userId: bia.id })).body;
  return { ana, bia, serverId, geral, outro, dm };
}

async function upload(c: Awaited<ReturnType<typeof signUp>>, name: string, bytes: Buffer) {
  const res = await fetch(`${c.base}/api/attachments?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  return (await res.json()) as { id: string; url: string };
}

describe('encaminhar mensagem', () => {
  it('encaminha de um canal para outro canal e para uma conversa privada, com o anexo copiado', async () => {
    const { ana, bia, geral, outro, dm } = await setup();
    const file = await upload(bia, 'notas.txt', Buffer.from('olá'));
    const msg = (await bia.post(`/channels/${geral.id}/messages`, { content: 'olha isso @todos', attachments: [file.id] })).body;

    const res = await ana.post('/forward', {
      source: { type: 'channel', messageId: msg.id },
      targets: [
        { type: 'channel', id: outro.id },
        { type: 'dm', id: dm.id },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, 2);

    const inOther = (await ana.get(`/channels/${outro.id}/messages`)).body.at(-1);
    assert.equal(inOther.content, 'olha isso @todos');
    assert.equal(inOther.author.id, ana.id);
    assert.equal(inOther.data.forwarded.authorId, bia.id);
    assert.match(inOther.data.forwarded.from, new RegExp(`#${geral.name}`));
    assert.equal(inOther.attachments.length, 1);
    assert.notEqual(inOther.attachments[0].url, file.url, 'o anexo é uma cópia');

    const inDm = (await bia.get(`/dms/${dm.id}/messages`)).body.at(-1);
    assert.equal(inDm.content, 'olha isso @todos');
    assert.equal(inDm.data.forwarded.authorId, bia.id);

    // apagar a original não estraga a cópia
    assert.equal((await bia.del(`/messages/${msg.id}`)).status, 200);
    const copy = await fetch(`${server.url}${inOther.attachments[0].url}`, { headers: { authorization: `Bearer ${ana.token}` } });
    assert.equal(copy.status, 200);

    // a encaminhada não pode ser editada
    assert.equal((await ana.patch(`/messages/${inOther.id}`, { content: 'mudei' })).status, 400);

    // encaminhar a encaminhada mantém o autor e a origem de verdade
    const again = await bia.post('/forward', { source: { type: 'dm', messageId: inDm.id }, targets: [{ type: 'channel', id: geral.id }] });
    assert.equal(again.status, 200);
    const last = (await bia.get(`/channels/${geral.id}/messages`)).body.at(-1);
    assert.equal(last.data.forwarded.authorId, bia.id);
    assert.match(last.data.forwarded.from, new RegExp(`#${geral.name}`));
  });

  it('não encaminha o que não pode ler nem para onde não pode escrever', async () => {
    const { ana, bia, geral, dm } = await setup();
    const estranho = await signUp(server, 'estranho');
    const msg = (await ana.post(`/channels/${geral.id}/messages`, { content: 'segredo' })).body;
    const own = (await estranho.post('/servers', { name: 'Meu' })).body.id as string;
    const meuCanal = ((await estranho.get(`/servers/${own}`)).body.channels as { id: string; type: string }[]).find((c) => c.type === 'text')!;
    // não é do servidor: não lê a mensagem
    const outsider = await estranho.post('/forward', { source: { type: 'channel', messageId: msg.id }, targets: [{ type: 'channel', id: meuCanal.id }] });
    assert.ok(outsider.status === 403 || outsider.status === 404);
    // conversa privada dos outros
    assert.equal((await estranho.post('/forward', { source: { type: 'channel', messageId: msg.id }, targets: [{ type: 'dm', id: dm.id }] })).status >= 400, true);
    // bia não pode mandar no canal do estranho
    const r = await bia.post('/forward', { source: { type: 'channel', messageId: msg.id }, targets: [{ type: 'channel', id: meuCanal.id }] });
    assert.ok(r.status === 403 || r.status === 404);
    // limites
    assert.equal((await ana.post('/forward', { source: { type: 'channel', messageId: msg.id }, targets: [] })).status, 400);
    const many = Array.from({ length: 6 }, (_, i) => ({ type: 'dm', id: `x${i}` }));
    assert.equal((await ana.post('/forward', { source: { type: 'channel', messageId: msg.id }, targets: many })).status, 400);
  });
});
