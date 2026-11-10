// Um TMDB de mentira para os testes da sala de cinema (o de verdade precisa de internet e chave).
// Também roda sozinho para testar no navegador: node test/fakeTmdb.ts 3299 [pasta-com-imagens]
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

const MOVIES: Record<number, object> = {
  1: { id: 1, title: 'Summer Ghost', release_date: '2021-11-12', overview: 'Três jovens procuram o fantasma que aparece quando se acendem fogos de artifício.', genres: [{ name: 'Animação' }, { name: 'Drama' }], runtime: 40, vote_average: 7.36, poster_path: '/summer_p.jpg', backdrop_path: '/summer_b.jpg' },
  2: { id: 2, title: 'Godzilla Minus One', release_date: '2023-11-03', overview: '', genres: [{ name: 'Ficção científica' }, { name: 'Ação' }], runtime: 125, vote_average: 7.6, poster_path: '/godzilla_p.jpg', backdrop_path: '/godzilla_b.jpg' },
};
const EN_OVERVIEW: Record<string, string> = { '/movie/2': 'Post-war Japan is at its lowest point when a new crisis emerges in the form of a giant monster.' };
const TV = { id: 10, name: 'Frieren e a Jornada para o Além', first_air_date: '2023-09-29', overview: 'A maga elfa Frieren e seus amigos derrotaram o Rei Demônio.', genres: [{ name: 'Animação' }, { name: 'Fantasia' }], vote_average: 8.8, poster_path: '/frieren_p.jpg', backdrop_path: '/frieren_b.jpg', episode_run_time: [24] };
const SEASON1 = {
  episodes: [
    { episode_number: 1, name: 'O fim da jornada', overview: 'O grupo do herói volta para casa.', still_path: '/frieren_e1.jpg', runtime: 25 },
    { episode_number: 2, name: 'Não precisava ser magia', overview: 'Frieren aceita uma aprendiz.', still_path: '/frieren_e2.jpg', runtime: 24 },
  ],
};

function search(q: string, kind: 'movie' | 'tv') {
  const s = q.toLowerCase();
  if (kind === 'movie') {
    if (s.includes('summer ghost')) return [MOVIES[1]];
    if (s.includes('godzilla')) return [MOVIES[2]];
    return [];
  }
  return s.includes('frieren') ? [TV] : [];
}

export function startFakeTmdb(port = 0, imagesDir?: string): Promise<{ url: string; requests: string[]; server: Server }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push(url.pathname + url.search);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/t/p/')) {
      const name = url.pathname.split('/').pop()!;
      const file = imagesDir && join(imagesDir, name);
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(file && existsSync(file) ? readFileSync(file) : Buffer.from(`\xff\xd8\xff imagem ${name}`, 'latin1'));
    }
    const authed = url.searchParams.get('api_key') === 'chave-de-teste' || req.headers.authorization === 'Bearer eyJtoken-de-teste';
    if (!authed) return json(401, { status_message: 'Invalid API key' });
    const path = url.pathname.replace(/^\/3/, '');
    const en = url.searchParams.get('language') === 'en-US';
    if (path === '/search/movie') return json(200, { results: search(url.searchParams.get('query') ?? '', 'movie') });
    if (path === '/search/tv') return json(200, { results: search(url.searchParams.get('query') ?? '', 'tv') });
    const movie = /^\/movie\/(\d+)$/.exec(path);
    if (movie && MOVIES[Number(movie[1])]) return json(200, en ? { ...MOVIES[Number(movie[1])], overview: EN_OVERVIEW[path] ?? '' } : MOVIES[Number(movie[1])]);
    if (path === '/tv/10') return json(200, TV);
    if (path === '/tv/10/season/1') return json(200, SEASON1);
    json(404, { status_message: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, server })));
}

if (process.argv[1]?.endsWith('fakeTmdb.ts') && process.argv[2]) {
  void startFakeTmdb(Number(process.argv[2]), process.argv[3]).then(({ url }) => console.log(`TMDB falso em ${url}`));
}
