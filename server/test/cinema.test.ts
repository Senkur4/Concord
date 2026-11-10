// Sala de cinema: canal, biblioteca da pasta, arquivo com chave assinada, pedaços (Range) e limite de banda.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let dir: string;
const movie = Buffer.alloc(600 * 1024, 7);
movie.write('INICIO', 0);
movie.write('FIM', movie.length - 3);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cinema-'));
  writeFileSync(join(dir, 'Filme A.mp4'), movie);
  mkdirSync(join(dir, 'Série'));
  writeFileSync(join(dir, 'Série', 'Episódio 2.mkv'), Buffer.alloc(10));
  writeFileSync(join(dir, 'Série', 'Episódio 10.mkv'), Buffer.alloc(10));
  writeFileSync(join(dir, 'leia.txt'), 'não é filme');
  // 0,8 Mbps = 100 KB/s, para medir o limite
  server = await startServer({ CINEMA_DIR: dir, CINEMA_MAX_MBPS: '0.8' });
});
after(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function cinemaRoom(): Promise<{ dono: Client; channelId: string; serverId: string }> {
  const dono = await signUp(server, 'cine');
  const serverId = (await dono.post('/servers', { name: 'Cine' })).body.id as string;
  const created = await dono.post(`/servers/${serverId}/channels`, { name: 'Cinema', type: 'cinema' });
  assert.equal(created.status, 200);
  return { dono, channelId: created.body.id, serverId };
}

describe('sala de cinema', () => {
  it('é uma sala de voz marcada como cinema', async () => {
    const { dono, channelId, serverId } = await cinemaRoom();
    const ch = (await dono.get(`/servers/${serverId}`)).body.channels.find((c: { id: string }) => c.id === channelId);
    assert.equal(ch.type, 'voice');
    assert.equal(ch.cinema, true);
    assert.equal(ch.name, 'Cinema');
  });

  it('lista só os vídeos da pasta e subpastas, em ordem natural', async () => {
    const { dono, channelId } = await cinemaRoom();
    const res = await dono.get(`/channels/${channelId}/cinema`);
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, true);
    assert.deepEqual(
      res.body.films.map((f: { file: string }) => f.file),
      ['Filme A.mp4', 'Série/Episódio 2.mkv', 'Série/Episódio 10.mkv'],
    );
    assert.equal(res.body.films[0].size, movie.length);
    assert.equal(res.body.state.fileId, null);
    assert.match(res.body.key, /\./);
  });

  it('recusa canal que não é cinema e quem não é do servidor', async () => {
    const { dono, channelId, serverId } = await cinemaRoom();
    const voz = (await dono.post(`/servers/${serverId}/channels`, { name: 'Voz', type: 'voice' })).body.id;
    assert.equal((await dono.get(`/channels/${voz}/cinema`)).status, 400);
    const estranho = await signUp(server, 'fora');
    assert.notEqual((await estranho.get(`/channels/${channelId}/cinema`)).status, 200);
  });

  it('entrega o arquivo só com a chave, inteiro ou em pedaços', async () => {
    const { dono, channelId } = await cinemaRoom();
    const { films, key } = (await dono.get(`/channels/${channelId}/cinema`)).body;
    const url = `${server.url}/api/cinema/file/${films[0].id}`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(`${url}?k=${key}x`)).status, 403);
    assert.equal((await fetch(`${server.url}/api/cinema/file/naoexiste?k=${key}`)).status, 404);

    const head = await fetch(`${url}?k=${key}`, { headers: { range: 'bytes=0-5' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), `bytes 0-5/${movie.length}`);
    assert.equal(head.headers.get('content-type'), 'video/mp4');
    assert.equal(await head.text(), 'INICIO');

    const tail = await fetch(`${url}?k=${key}`, { headers: { range: 'bytes=-3' } });
    assert.equal(await tail.text(), 'FIM');
    assert.equal((await fetch(`${url}?k=${key}`, { headers: { range: `bytes=${movie.length}-` } })).status, 416);
  });

  it('respeita o limite de banda (CINEMA_MAX_MBPS)', async () => {
    const { dono, channelId } = await cinemaRoom();
    const { films, key } = (await dono.get(`/channels/${channelId}/cinema`)).body;
    const started = Date.now();
    const body = Buffer.from(await (await fetch(`${server.url}/api/cinema/file/${films[0].id}?k=${key}`)).arrayBuffer());
    const secs = (Date.now() - started) / 1000;
    assert.equal(body.length, movie.length);
    assert.ok(body.equals(movie));
    // 600 KB a 100 KB/s, com 1 s de folga no começo: uns 5 s (sem limite seria instantâneo)
    assert.ok(secs > 3.5, `foi rápido demais: ${secs.toFixed(1)} s`);
  });
});
