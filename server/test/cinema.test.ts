// Sala de cinema: canal, biblioteca da pasta, arquivo com chave assinada, pedaços (Range) e limite de banda.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { signUp, startServer, type Client, type TestServer } from './helpers.ts';
import { startFakeTmdb } from './fakeTmdb.ts';

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

// precisa do ffmpeg na máquina dos testes; sem ele, pula
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('sala de cinema: troca de faixa de áudio', { skip: !hasFfmpeg && 'sem ffmpeg nesta máquina' }, () => {
  it('lê as faixas, prepara (vídeo copiado + cada áudio separado) e entrega em pedaços', async () => {
    spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=14',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=14',
      '-map', '0', '-map', '1', '-map', '2',
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '24',
      '-c:a:0', 'libopus', '-c:a:1', 'ac3',
      '-metadata:s:a:0', 'language=por', '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=Original',
      join(dir, 'Dublado.mkv'),
    ]);
    const { dono, channelId } = await cinemaRoom();
    const lib = (await dono.get(`/channels/${channelId}/cinema?refresh=1`)).body;
    const film = lib.films.find((f: { name: string }) => f.name === 'Dublado');
    assert.deepEqual(film.audio, [
      { label: 'Português', codec: 'opus' },
      { label: 'Original', codec: 'ac3' },
    ]);
    assert.equal(film.needsPrep, true);
    assert.equal(film.prep, null);
    // filme comum (uma faixa que o navegador toca) não precisa de preparo
    assert.equal(lib.films.find((f: { name: string }) => f.name === 'Filme A').needsPrep, false);

    assert.equal((await dono.post(`/channels/${channelId}/cinema/films/${film.id}/prepare`)).status, 200);
    let prep = null;
    for (let i = 0; i < 100 && prep?.state !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      prep = (await dono.get(`/channels/${channelId}/cinema`)).body.films.find((f: { id: string }) => f.id === film.id).prep;
      assert.notEqual(prep?.state, 'failed');
    }
    assert.equal(prep?.state, 'ready');

    const base = `${server.url}/api/cinema/hls/${lib.key}/${film.id}`;
    const master = await (await fetch(`${base}/master.m3u8`)).text();
    assert.equal((master.match(/TYPE=AUDIO/g) ?? []).length, 2);
    assert.match(master, /NAME="Português",LANGUAGE="por",DEFAULT=YES/);
    assert.match(master, /NAME="Original",LANGUAGE="eng",DEFAULT=NO/);
    const audio1 = await (await fetch(`${base}/a1.m3u8`)).text();
    assert.match(audio1, /#EXT-X-MAP:URI="a1_init.mp4"/);
    const seg = await fetch(`${base}/v_00000.m4s`);
    assert.equal(seg.status, 200);
    assert.ok((await seg.arrayBuffer()).byteLength > 1000);
    assert.equal((await fetch(`${base}/..%2F..%2Fconcord.db`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/cinema/hls/chave-falsa/${film.id}/master.m3u8`)).status, 403);
  });
});

describe('sala de cinema: capas e detalhes (TMDB)', () => {
  let tmdb: Awaited<ReturnType<typeof startFakeTmdb>>;
  let srv: TestServer;
  let films: string;
  before(async () => {
    tmdb = await startFakeTmdb();
    films = mkdtempSync(join(tmpdir(), 'cinema-meta-'));
    writeFileSync(join(films, 'Summer.Ghost.2021.1080p.WEB-DL.mp4'), Buffer.alloc(100));
    writeFileSync(join(films, 'Godzilla Minus One (2023) Dublado.mkv'), Buffer.alloc(100));
    mkdirSync(join(films, 'Frieren', 'Season 1'), { recursive: true });
    writeFileSync(join(films, 'Frieren', 'Season 1', '[SubsPlease] Sousou no Frieren - S01E02 (1080p).mkv'), Buffer.alloc(100));
    writeFileSync(join(films, 'Video da viagem.mp4'), Buffer.alloc(100));
    srv = await startServer({ CINEMA_DIR: films, TMDB_API_KEY: 'chave-de-teste', TMDB_BASE_URL: `${tmdb.url}/3`, TMDB_IMAGE_BASE: `${tmdb.url}/t/p` });
  });
  after(async () => {
    await srv.stop();
    tmdb.server.close();
    rmSync(films, { recursive: true, force: true });
  });

  async function room() {
    const dono = await signUp(srv, 'meta');
    const serverId = (await dono.post('/servers', { name: 'Cine' })).body.id as string;
    const channelId = (await dono.post(`/servers/${serverId}/channels`, { name: 'Cinema', type: 'cinema' })).body.id as string;
    return { dono, channelId, serverId };
  }
  type F = { file: string; id: string; meta: Record<string, any> | null };
  async function libraryWithMeta(c: Client, channelId: string) {
    for (let i = 0; i < 50; i++) {
      const lib = (await c.get(`/channels/${channelId}/cinema`)).body;
      if (lib.films.every((f: F) => f.meta)) return lib as { films: F[]; key: string; canEdit: boolean; tmdb: boolean };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('os detalhes não chegaram');
  }

  it('reconhece filme, série e episódio pelo nome do arquivo, em português', async () => {
    const { dono, channelId } = await room();
    const lib = await libraryWithMeta(dono, channelId);
    assert.equal(lib.tmdb, true);
    assert.equal(lib.canEdit, true);
    const by = (start: string) => lib.films.find((f) => f.file.startsWith(start))!.meta!;
    const summer = by('Summer');
    assert.equal(summer.kind, 'movie');
    assert.equal(summer.title, 'Summer Ghost');
    assert.equal(summer.year, 2021);
    assert.deepEqual(summer.genres, ['Animação', 'Drama']);
    assert.equal(summer.runtime, 40);
    assert.equal(summer.rating, 7.4);
    assert.match(summer.poster, /^\/api\/cinema\/img\//);
    // sem sinopse em português: usa a em inglês
    assert.match(by('Godzilla').overview, /Post-war Japan/);
    const ep = by('Frieren');
    assert.equal(ep.kind, 'tv');
    assert.equal(ep.title, 'Frieren e a Jornada para o Além');
    assert.equal(ep.season, 1);
    assert.equal(ep.episode, 2);
    assert.equal(ep.episodeTitle, 'Não precisava ser magia');
    assert.ok(ep.still);
    const other = by('Video');
    assert.equal(other.kind, 'video');
    assert.equal(other.source, 'none');
    assert.equal(other.title, 'Video da viagem');

    // a capa é servida daqui, com a chave
    const poster = await fetch(`${srv.url}${summer.poster}`);
    assert.equal(poster.status, 200);
    assert.match(Buffer.from(await poster.arrayBuffer()).toString('latin1'), /summer_p\.jpg/);
    assert.equal((await fetch(`${srv.url}/api/cinema/img/chave-falsa/${summer.poster.split('/').pop()}`)).status, 403);
    // o TMDB foi consultado em português, com a chave
    assert.ok(tmdb.requests.some((r) => r.startsWith('/3/movie/1?') && r.includes('language=pt-BR') && r.includes('api_key=chave-de-teste')));
  });

  it('só quem gerencia corrige: busca, liga ao TMDB, dados e capa próprios, volta ao automático', async () => {
    const { dono, channelId, serverId } = await room();
    const lib = await libraryWithMeta(dono, channelId);
    const video = lib.films.find((f) => f.file.startsWith('Video'))!;

    const amigo = await signUp(srv, 'amigo');
    const code = (await dono.post(`/servers/${serverId}/invites`, {})).body.code;
    await amigo.post(`/invites/${code}`);
    assert.equal((await amigo.get(`/channels/${channelId}/cinema`)).body.canEdit, false);
    assert.equal((await amigo.put(`/channels/${channelId}/cinema/films/${video.id}/meta`, { title: 'Hackeado' })).status, 403);

    const found = (await dono.get(`/channels/${channelId}/cinema/search?q=godzilla`)).body.results;
    assert.equal(found[0].title, 'Godzilla Minus One');
    assert.match(found[0].poster, /w185\/godzilla_p\.jpg$/);

    const linked = await dono.put(`/channels/${channelId}/cinema/films/${video.id}/meta`, { kind: 'movie', tmdbId: 2 });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.meta.title, 'Godzilla Minus One');
    assert.equal(linked.body.meta.source, 'manual');

    const custom = await dono.put(`/channels/${channelId}/cinema/films/${video.id}/meta`, { title: 'Viagem pra praia', year: 2025, overview: 'Férias de 2025.' });
    assert.equal(custom.body.meta.title, 'Viagem pra praia');
    assert.equal(custom.body.meta.year, 2025);
    assert.equal((await dono.put(`/channels/${channelId}/cinema/films/${video.id}/meta`, { title: '' })).status, 400);

    const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(40)]);
    const up = await fetch(`${srv.url}/api/channels/${channelId}/cinema/films/${video.id}/poster`, { method: 'POST', headers: { authorization: `Bearer ${dono.token}` }, body: png });
    assert.equal(up.status, 200);
    assert.ok((await up.json()).meta.poster);
    const bad = await fetch(`${srv.url}/api/channels/${channelId}/cinema/films/${video.id}/poster`, { method: 'POST', headers: { authorization: `Bearer ${dono.token}` }, body: 'não é imagem' });
    assert.equal(bad.status, 400);

    assert.equal((await dono.del(`/channels/${channelId}/cinema/films/${video.id}/meta`)).status, 200);
    const back = (await libraryWithMeta(dono, channelId)).films.find((f) => f.id === video.id)!.meta!;
    assert.equal(back.title, 'Video da viagem');
    assert.equal(back.source, 'none');
  });
});
