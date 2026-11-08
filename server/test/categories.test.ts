// Categorias de canais: criar, renomear, ordenar, mover canais (com arrastar e soltar), apagar sem perder canais,
// quem pode mexer e quem vê. E nomes de canais com emoji.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type TestServer } from './helpers.ts';

let server: TestServer;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

let n = 0;
async function setup() {
  const owner = await signUp(server, `dono${++n}`);
  const serverId = (await owner.post('/servers', { name: 'Servidor' })).body.id as string;
  const code = (await owner.post(`/servers/${serverId}/invites`, {})).body.code as string;
  const detail = async (c = owner) => (await c.get(`/servers/${serverId}`)).body;
  const join = async (name: string) => {
    const c = await signUp(server, `${name}${n}`);
    assert.equal((await c.post(`/invites/${code}`)).status, 200);
    return c;
  };
  return { owner, serverId, detail, join };
}

const names = (channels: { name: string; categoryId: string | null; position: number }[], categoryId: string | null) =>
  channels
    .filter((c) => c.categoryId === categoryId)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.name);

describe('categorias de canais', () => {
  it('cria categoria, cria canal dentro dela e lista no servidor', async () => {
    const { owner, serverId, detail } = await setup();
    const res = await owner.post(`/servers/${serverId}/categories`, { name: '🎮 Jogos' });
    assert.equal(res.status, 200);
    const catId = res.body.id as string;

    const ch = await owner.post(`/servers/${serverId}/channels`, { name: 'Minecraft', type: 'voice', categoryId: catId });
    assert.equal(ch.status, 200);

    const d = await detail();
    assert.deepEqual(
      d.categories.map((c: { name: string }) => c.name),
      ['🎮 Jogos'],
    );
    assert.equal(d.channels.find((c: { id: string }) => c.id === ch.body.id).categoryId, catId);
    // os canais antigos continuam sem categoria
    assert.ok(d.channels.filter((c: { categoryId: string | null }) => c.categoryId === null).length >= 4);
  });

  it('move canal para a categoria, antes de outro canal, e tira dela', async () => {
    const { owner, serverId, detail } = await setup();
    const catId = (await owner.post(`/servers/${serverId}/categories`, { name: 'Filmes' })).body.id;
    const a = (await owner.post(`/servers/${serverId}/channels`, { name: 'a', categoryId: catId })).body.id;
    const b = (await owner.post(`/servers/${serverId}/channels`, { name: 'b', categoryId: catId })).body.id;
    const c = (await owner.post(`/servers/${serverId}/channels`, { name: 'c' })).body.id;

    // arrasta "c" para antes de "b" dentro de Filmes
    assert.equal((await owner.patch(`/channels/${c}`, { categoryId: catId, beforeId: b })).status, 200);
    assert.deepEqual(names((await detail()).channels, catId), ['a', 'c', 'b']);

    // "a" desce uma posição dentro da categoria
    await owner.patch(`/channels/${a}`, { move: 'down' });
    assert.deepEqual(names((await detail()).channels, catId), ['c', 'a', 'b']);

    // tira "a" da categoria
    await owner.patch(`/channels/${a}`, { categoryId: null });
    const d = await detail();
    assert.deepEqual(names(d.channels, catId), ['c', 'b']);
    assert.equal(d.channels.find((x: { id: string }) => x.id === a).categoryId, null);
  });

  it('renomeia e reordena categorias (setas e arrastar)', async () => {
    const { owner, serverId, detail } = await setup();
    const x = (await owner.post(`/servers/${serverId}/categories`, { name: 'X' })).body.id;
    const y = (await owner.post(`/servers/${serverId}/categories`, { name: 'Y' })).body.id;
    const z = (await owner.post(`/servers/${serverId}/categories`, { name: 'Z' })).body.id;
    const order = async () => (await detail()).categories.map((c: { name: string }) => c.name);

    await owner.patch(`/categories/${z}`, { beforeId: x });
    assert.deepEqual(await order(), ['Z', 'X', 'Y']);
    await owner.patch(`/categories/${z}`, { move: 'down' });
    assert.deepEqual(await order(), ['X', 'Z', 'Y']);
    await owner.patch(`/categories/${x}`, { beforeId: null });
    assert.deepEqual(await order(), ['Z', 'Y', 'X']);
    await owner.patch(`/categories/${y}`, { name: '🍿 Filmes' });
    assert.deepEqual(await order(), ['Z', '🍿 Filmes', 'X']);
  });

  it('apagar a categoria não apaga os canais: eles voltam para fora', async () => {
    const { owner, serverId, detail } = await setup();
    const catId = (await owner.post(`/servers/${serverId}/categories`, { name: 'Temporária' })).body.id;
    const ch = (await owner.post(`/servers/${serverId}/channels`, { name: 'fica', categoryId: catId })).body.id;
    assert.equal((await owner.del(`/categories/${catId}`)).status, 200);
    const d = await detail();
    assert.equal(d.categories.length, 0);
    assert.equal(d.channels.find((c: { id: string }) => c.id === ch).categoryId, null);
  });

  it('membro comum não mexe em categorias e não vê categoria vazia', async () => {
    const { owner, serverId, detail, join } = await setup();
    const comum = await join('comum');
    const vazia = (await owner.post(`/servers/${serverId}/categories`, { name: 'Vazia' })).body.id;
    const cheia = (await owner.post(`/servers/${serverId}/categories`, { name: 'Cheia' })).body.id;
    await owner.post(`/servers/${serverId}/channels`, { name: 'papo', categoryId: cheia });

    assert.equal((await comum.post(`/servers/${serverId}/categories`, { name: 'Minha' })).status, 403);
    assert.equal((await comum.patch(`/categories/${cheia}`, { name: 'Hackeada' })).status, 403);
    assert.equal((await comum.del(`/categories/${cheia}`)).status, 403);

    const seen = (await detail(comum)).categories.map((c: { id: string }) => c.id);
    assert.deepEqual(seen, [cheia], 'só a categoria com canal visível');
    assert.ok((await detail()).categories.some((c: { id: string }) => c.id === vazia), 'quem gerencia vê a vazia');
  });

  it('não aceita categoria de outro servidor', async () => {
    const a = await setup();
    const b = await setup();
    const alheia = (await b.owner.post(`/servers/${b.serverId}/categories`, { name: 'Alheia' })).body.id;
    assert.equal((await a.owner.post(`/servers/${a.serverId}/channels`, { name: 'x', categoryId: alheia })).status, 400);
  });
});

describe('nomes dos grupos padrão', () => {
  it('renomeia Salas e Conversas, volta ao padrão, e só quem gerencia canais pode', async () => {
    const { owner, serverId, detail, join } = await setup();
    const comum = await join('comumgrupos');
    assert.deepEqual((await detail()).groupLabels, {});
    assert.equal((await owner.req('PUT', `/servers/${serverId}/group-labels`, { voice: '🔊 Calls', text: '💬 Papo' })).status, 200);
    assert.deepEqual((await detail(comum)).groupLabels, { voice: '🔊 Calls', text: '💬 Papo' }, 'todo mundo vê o nome novo');
    await owner.req('PUT', `/servers/${serverId}/group-labels`, { voice: '' });
    assert.deepEqual((await detail()).groupLabels, { text: '💬 Papo' });
    assert.equal((await comum.req('PUT', `/servers/${serverId}/group-labels`, { text: 'Hackeado' })).status, 403);
  });
});

describe('ordem da barra lateral', () => {
  it('grupos padrão mudam de lugar junto com as categorias (arrastar e setas)', async () => {
    const { owner, serverId, detail, join } = await setup();
    const comum = await join('comumordem');
    const cat = (await owner.post(`/servers/${serverId}/categories`, { name: 'Jogos' })).body.id;
    assert.deepEqual((await detail()).sidebarOrder, ['group:voice', 'group:forum', 'group:text', `cat:${cat}`]);

    // arrasta Salas para o fim
    assert.equal((await owner.post(`/servers/${serverId}/sidebar-order`, { key: 'group:voice', beforeKey: null })).status, 200);
    assert.deepEqual((await detail()).sidebarOrder, ['group:forum', 'group:text', `cat:${cat}`, 'group:voice']);

    // Conversas desce uma posição: pula para depois de Jogos
    await owner.post(`/servers/${serverId}/sidebar-order`, { key: 'group:text', move: 'down' });
    assert.deepEqual((await detail()).sidebarOrder, ['group:forum', `cat:${cat}`, 'group:text', 'group:voice']);

    // a seta da categoria troca de lugar com o grupo vizinho; Fóruns (vazio, escondido) não conta como vizinho
    await owner.patch(`/categories/${cat}`, { move: 'down' });
    assert.deepEqual((await detail()).sidebarOrder, ['group:forum', 'group:text', `cat:${cat}`, 'group:voice']);
    await owner.patch(`/categories/${cat}`, { move: 'up' });
    await owner.patch(`/categories/${cat}`, { move: 'up' }); // já é a primeira visível: fica onde está
    assert.deepEqual((await detail()).sidebarOrder, ['group:forum', `cat:${cat}`, 'group:text', 'group:voice']);

    // quem não gerencia canais vê a mesma ordem, mas não muda
    assert.deepEqual((await detail(comum)).sidebarOrder, ['group:forum', `cat:${cat}`, 'group:text', 'group:voice'].filter((k) => k !== `cat:${cat}`));
    assert.equal((await comum.post(`/servers/${serverId}/sidebar-order`, { key: 'group:text', move: 'up' })).status, 403);
    assert.equal((await owner.post(`/servers/${serverId}/sidebar-order`, { key: 'cat:nao-existe', move: 'up' })).status, 400);
  });
});

describe('nomes de canais com emoji', () => {
  it('canal de texto mantém emojis (inclusive compostos) e sala de voz aceita tudo', async () => {
    const { owner, serverId, detail } = await setup();
    const t = (await owner.post(`/servers/${serverId}/channels`, { name: '🎮 Jogos da Galera 👨‍👩‍👧 🇧🇷' })).body.id;
    const v = (await owner.post(`/servers/${serverId}/channels`, { name: '🔊 Sala do Rolê', type: 'voice' })).body.id;
    const d = await detail();
    assert.equal(d.channels.find((c: { id: string }) => c.id === t).name, '🎮-jogos-da-galera-👨‍👩‍👧-🇧🇷');
    assert.equal(d.channels.find((c: { id: string }) => c.id === v).name, '🔊 Sala do Rolê');
  });
});
