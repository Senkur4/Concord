// Anexos grandes: envio em pedaços direto para o disco, retomada depois de uma queda, conferência de espaço, e
// validade (a mensagem e o arquivo somem sozinhos).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type TestServer } from './helpers.ts';

let server: TestServer;
const dir = mkdtempSync(join(tmpdir(), 'concord-big-'));
const dbPath = join(dir, 'concord.db');
before(async () => {
  server = await startServer({ DB_PATH: dbPath, EXPIRY_SWEEP_MS: '300', ATTACH_DISK_RESERVE_GB: '0' });
});
after(() => server.stop());

type Client = Awaited<ReturnType<typeof signUp>>;

async function putChunk(c: Client, id: string, offset: number, bytes: Uint8Array) {
  const res = await fetch(`${c.base}/api/uploads/${id}/chunk?offset=${offset}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/octet-stream' },
    body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
  });
  return { status: res.status, body: (await res.json()) as { received: number; error?: string } };
}

/** Bytes previsíveis (para conferir que o arquivo final é igual ao enviado). */
function pattern(size: number, seed = 7) {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

async function channelOf(c: Client) {
  const serverId = (await c.post('/servers', { name: 'Arquivos' })).body.id as string;
  const channels = (await c.get(`/servers/${serverId}`)).body.channels as { id: string; type: string }[];
  return channels.find((x) => x.type === 'text')!;
}

describe('envio em pedaços', () => {
  it('manda em pedaços, continua depois de uma queda e vira anexo de mensagem', async () => {
    const me = await signUp(server, 'grande');
    const data = pattern(5 * 1024 * 1024 + 123); // 5 MB e pouco, em pedaços de 2 MB
    const start = await me.post('/uploads', { name: 'jogo.zip', size: data.length });
    assert.equal(start.status, 200);
    const { id } = start.body;
    const CH = 2 * 1024 * 1024;

    assert.equal((await putChunk(me, id, 0, data.subarray(0, CH))).body.received, CH);
    // pedaço fora de ordem: 409 com o número certo
    const wrong = await putChunk(me, id, 0, data.subarray(0, CH));
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.received, CH);
    // "queda": o app pergunta quanto chegou e continua dali
    assert.equal((await me.get(`/uploads/${id}`)).body.received, CH);
    assert.equal((await me.post(`/uploads/${id}/finish`)).status, 409, 'não termina incompleto');
    for (let off = CH; off < data.length; off += CH) {
      const r = await putChunk(me, id, off, data.subarray(off, Math.min(data.length, off + CH)));
      assert.equal(r.status, 200);
    }
    const done = await me.post(`/uploads/${id}/finish`);
    assert.equal(done.status, 200);
    assert.equal(done.body.size, data.length);
    assert.equal(done.body.name, 'jogo.zip');

    const file = new Uint8Array(await (await fetch(`${server.url}${done.body.url}`)).arrayBuffer());
    assert.equal(file.length, data.length);
    assert.ok(Buffer.from(file).equals(Buffer.from(data)), 'o arquivo final é igual ao enviado');

    const ch = await channelOf(me);
    const msg = await me.post(`/channels/${ch.id}/messages`, { content: '', attachments: [done.body.id] });
    assert.equal(msg.status, 200);
    assert.equal(msg.body.attachments[0].size, data.length);
  });

  it('recusa tipo proibido, tamanho inválido, pedaço de outra pessoa e o que não cabe no disco', async () => {
    const me = await signUp(server, 'regras');
    assert.equal((await me.post('/uploads', { name: 'virus.exe', size: 10 })).status, 400);
    assert.equal((await me.post('/uploads', { name: 'a.zip', size: 0 })).status, 400);
    assert.equal((await me.post('/uploads', { name: 'a.zip', size: -5 })).status, 400);
    // 1 petabyte: nenhum disco de teste tem isso livre
    const huge = await me.post('/uploads', { name: 'a.zip', size: 1024 ** 5 });
    assert.equal(huge.status, 507);
    assert.match(huge.body.error, /espaço/);

    const { id } = (await me.post('/uploads', { name: 'b.zip', size: 10 })).body;
    const other = await signUp(server, 'outro');
    assert.equal((await putChunk(other, id, 0, pattern(10))).status, 404);
    // passar do tamanho declarado
    assert.equal((await putChunk(me, id, 0, pattern(20))).status, 413);
    assert.equal((await me.get(`/uploads/${id}`)).body.received, 0, 'o pedaço recusado não fica gravado');
    // desistir
    assert.equal((await me.del(`/uploads/${id}`)).status, 200);
    assert.equal((await me.get(`/uploads/${id}`)).status, 404);
  });

  it('uma conexão pendurada não escreve junto com a nova', async () => {
    const me = await signUp(server, 'pendurado');
    const data = pattern(4 * 1024 * 1024, 3);
    const { id } = (await me.post('/uploads', { name: 'c.zip', size: data.length })).body;
    // conexão "pendurada": manda metade do pedaço e não termina
    let push!: (b: Uint8Array) => void;
    const hanging = new ReadableStream<Uint8Array>({ start: (c) => (push = (b) => c.enqueue(b)) });
    const stuck = fetch(`${me.base}/api/uploads/${id}/chunk?offset=0`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${me.token}`, 'content-type': 'application/octet-stream' },
      body: hanging,
      duplex: 'half',
    } as RequestInit).catch(() => null);
    push(data.subarray(0, 1024 * 1024));
    await new Promise((r) => setTimeout(r, 300));
    // o app tenta de novo o mesmo pedaço por outra conexão: a antiga é encerrada e a nova grava inteira
    let r = await putChunk(me, id, 0, data);
    if (r.status === 409) r = await putChunk(me, id, r.body.received, data.subarray(r.body.received));
    assert.equal(r.status, 200);
    assert.equal(r.body.received, data.length);
    await stuck;
    const done = await me.post(`/uploads/${id}/finish`);
    const file = new Uint8Array(await (await fetch(`${server.url}${done.body.url}`)).arrayBuffer());
    assert.ok(Buffer.from(file).equals(Buffer.from(data)), 'o arquivo não ficou embaralhado');
  });

  it('imagem falsa não passa como imagem', async () => {
    const me = await signUp(server, 'img');
    const bytes = new TextEncoder().encode('isto não é um png de verdade');
    const { id } = (await me.post('/uploads', { name: 'foto.png', size: bytes.length })).body;
    await putChunk(me, id, 0, bytes);
    assert.equal((await me.post(`/uploads/${id}/finish`)).status, 400);
  });
});

describe('validade', () => {
  it('aceita de 1 a 24 horas e de 1 a 30 dias, e recusa o resto', async () => {
    const me = await signUp(server, 'prazo');
    const ch = await channelOf(me);
    for (const ok of [3600, 12 * 3600, 24 * 3600, 86400, 30 * 86400]) {
      const r = await me.post(`/channels/${ch.id}/messages`, { content: 'oi', expiresIn: ok });
      assert.equal(r.status, 200, String(ok));
      assert.ok(Math.abs(r.body.expiresAt - (Date.now() + ok * 1000)) < 10_000);
    }
    // outra pessoa (o anti-flood conta 10 mensagens a cada 10 s)
    const other = await signUp(server, 'prazo2');
    const ch2 = await channelOf(other);
    for (const bad of [0, 60, 25 * 3600 + 1, 31 * 86400, '3600', -3600]) {
      assert.equal((await other.post(`/channels/${ch2.id}/messages`, { content: 'oi', expiresIn: bad })).status, 400, String(bad));
    }
    const plain = await other.post(`/channels/${ch2.id}/messages`, { content: 'para sempre' });
    assert.equal(plain.body.expiresAt, null);
  });

  it('quando vence, a mensagem e o arquivo somem (canal e conversa privada)', async () => {
    const me = await signUp(server, 'vence');
    const ch = await channelOf(me);
    const bytes = pattern(1000);
    const { id } = (await me.post('/uploads', { name: 'notas.txt', size: bytes.length })).body;
    await putChunk(me, id, 0, bytes);
    const att = (await me.post(`/uploads/${id}/finish`)).body;
    const msg = (await me.post(`/channels/${ch.id}/messages`, { content: 'some logo', attachments: [att.id], expiresIn: 3600 })).body;

    const friend = await signUp(server, 'amigo');
    const serverId = (await me.get(`/channels/${ch.id}`)).body.serverId ?? (await me.get('/servers')).body.at(-1).id;
    const code = (await me.post(`/servers/${serverId}/invites`, {})).body.code as string;
    await friend.post(`/invites/${code}`);
    const dm = (await me.post('/dms', { userId: friend.id })).body;
    const dmMsg = (await me.post(`/dms/${dm.id}/messages`, { content: 'privada', expiresIn: 7200 })).body;
    assert.ok(dmMsg.expiresAt > Date.now());

    // "o tempo passa": adianta o vencimento direto no banco
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, msg.id);
    db.prepare('UPDATE dm_messages SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, dmMsg.id);
    db.close();
    await new Promise((r) => setTimeout(r, 1200));

    const left = (await me.get(`/channels/${ch.id}/messages`)).body as { id: string }[];
    assert.ok(!left.some((m) => m.id === msg.id), 'a mensagem do canal sumiu');
    assert.equal((await fetch(`${server.url}${att.url}`)).status, 404, 'o arquivo sumiu do disco');
    const dmLeft = (await me.get(`/dms/${dm.id}/messages`)).body as { id: string }[];
    assert.ok(!dmLeft.some((m) => m.id === dmMsg.id), 'a mensagem privada sumiu');
  });
});
