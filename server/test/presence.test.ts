// Detector de jogos (Privacidade): baixar o .bat com uma chave própria, mandar a atividade com ela, e a chave
// antiga parar de valer quando a pessoa baixa outro.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type TestServer } from './helpers.ts';

let server: TestServer;
before(async () => {
  server = await startServer({ PUBLIC_URL: 'http://concord.teste:3000' });
});
after(() => server.stop());

const send = (token: string, body: unknown) =>
  fetch(`${server.url}/api/presence/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Presence ${token}` },
    body: JSON.stringify(body),
  });

describe('detector de jogos', () => {
  it('o .bat vem com o endereço e uma chave que manda a atividade', async () => {
    const me = await signUp(server, 'jogador');
    const res = await me.post('/me/presence-helper', {});
    assert.equal(res.status, 200);
    assert.match(res.body.filename, /\.bat$/);
    const content = res.body.content as string;
    assert.match(content, /^@echo off\r\n/);
    assert.ok(content.includes("$Server = 'http://concord.teste:3000'"));
    const token = /Presence (cp_[A-Za-z0-9_-]+)/.exec(content)![1];

    assert.equal((await send(token, { activities: [{ type: 'playing', name: 'Geometry Dash' }] })).status, 200);
    assert.equal((await send('cp_chave-que-nao-existe-123456789', { activities: [] })).status, 401);

    const games = await fetch(`${server.url}/api/presence/games`, { headers: { authorization: `Presence ${token}` } });
    assert.equal(games.status, 200);
    assert.match(await games.text(), /geometrydash\.exe\tGeometry Dash/);

    // baixar de novo troca a chave: a antiga para de valer
    const again = (await me.post('/me/presence-helper', {})).body.content as string;
    const token2 = /Presence (cp_[A-Za-z0-9_-]+)/.exec(again)![1];
    assert.notEqual(token2, token);
    assert.equal((await send(token, { activities: [] })).status, 401);
    assert.equal((await send(token2, { activities: [] })).status, 200);

    // desligar o detector
    assert.equal((await me.del('/me/presence-helper')).status, 200);
    assert.equal((await send(token2, { activities: [] })).status, 401);
  });

  it('sem a chave do detector não dá para mandar atividade nem com a sessão', async () => {
    const me = await signUp(server, 'outro');
    const res = await fetch(`${server.url}/api/presence/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` },
      body: '{"activities":[]}',
    });
    assert.equal(res.status, 401);
  });
});
