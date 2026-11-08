// Envio de anexos em pedaços, direto para o disco.
//
// O envio antigo (/attachments) junta o arquivo inteiro na memória antes de gravar: serve para 20 MB, não para um
// jogo de 10 GB. Aqui o navegador manda o arquivo em pedaços de até 16 MB; cada pedaço vai direto para um arquivo
// temporário no disco, sem passar inteiro pela memória. Se a conexão cair, o navegador pergunta quanto já chegou e
// continua dali. No fim, o arquivo vai para a pasta de anexos e vira um anexo normal.
//
// Sem limite de tamanho fixo (dá para pôr um com ATTACH_MAX_GB): o que limita é o espaço livre do disco. O servidor
// sempre deixa uma folga (ATTACH_DISK_RESERVE_GB, padrão 5 GB) e conta os envios em andamento, para dois envios
// grandes ao mesmo tempo não lotarem o disco.
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync, statfsSync, truncateSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, RequestHandler, Router } from 'express';
import { config } from './config.ts';
import { all, get, run, type AttachmentRow } from './db.ts';
import { fail, uid } from './http.ts';
import { cleanFileName, detectImage, FILE_EXTS, IMAGE_EXTS } from './uploads.ts';

export const CHUNK_MAX = 16 * 1024 * 1024;
const CHUNK_SUGGESTED = 8 * 1024 * 1024;
const GB = 1024 ** 3;
const maxBytes = () => (Number(process.env.ATTACH_MAX_GB) > 0 ? Number(process.env.ATTACH_MAX_GB) * GB : Infinity);
const reserveBytes = () => (process.env.ATTACH_DISK_RESERVE_GB !== undefined && Number(process.env.ATTACH_DISK_RESERVE_GB) >= 0 ? Number(process.env.ATTACH_DISK_RESERVE_GB) : 5) * GB;
/** envio parado há mais que isso é jogado fora */
const STALE_MS = 24 * 60 * 60_000;

interface Session {
  id: string;
  owner_id: string;
  name: string;
  ext: string;
  size: number;
  created_at: number;
  touched_at: number;
}

/** o pedaço sendo gravado agora em cada envio */
const active = new Map<string, { req: Request; done: Promise<void> }>();

const tmpDir = () => {
  const dir = join(config.uploadsDir, 'tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
};
const partPath = (id: string) => join(tmpDir(), `${id}.part`);
const received = (id: string) => {
  try {
    return statSync(partPath(id)).size;
  } catch {
    return 0;
  }
};

/** Espaço livre no disco dos anexos (em bytes). */
export function freeDiskBytes(): number {
  try {
    const s = statfsSync(config.uploadsDir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity; // sistema que não informa: não bloqueia
  }
}

/** Quanto ainda falta chegar dos envios em andamento (esse espaço já está "prometido"). */
function promisedBytes(): number {
  let total = 0;
  for (const s of all<Session>('SELECT * FROM upload_sessions')) total += Math.max(0, s.size - received(s.id));
  return total;
}

const GB_TEXT = (n: number) => `${(n / GB).toFixed(1).replace('.', ',')} GB`;

function ownSession(req: Request, me: string): Session {
  const s = get<Session>('SELECT * FROM upload_sessions WHERE id = ?', String(req.params.id));
  if (!s || s.owner_id !== me) fail(404, 'Envio não encontrado (pode ter expirado). Escolha o arquivo de novo.');
  return s!;
}

/** Lê os primeiros bytes (para conferir se uma "imagem" é imagem mesmo). */
function head(path: string, n = 64): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function registerBigUploadRoutes(
  api: Router,
  deps: { attachmentJson: (a: AttachmentRow) => unknown; allowUpload: (userId: string) => boolean; humansOnly: RequestHandler },
) {
  /** Começa um envio: confere nome, tamanho e espaço livre. */
  api.post('/uploads', deps.humansOnly, (req, res) => {
    const me = uid(res);
    const name = cleanFileName(req.body?.name);
    const size = Number(req.body?.size);
    const ext = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? '').toLowerCase();
    if (!FILE_EXTS.has(ext)) fail(400, 'Tipo de arquivo não permitido');
    if (!Number.isSafeInteger(size) || size <= 0) fail(400, 'Arquivo vazio ou tamanho inválido');
    if (size > maxBytes()) fail(413, `Arquivo grande demais (máximo ${GB_TEXT(maxBytes())} neste servidor)`);
    if (!deps.allowUpload(me)) fail(429, 'Muitos arquivos em pouco tempo. Espere um pouco.');
    const room = freeDiskBytes() - promisedBytes() - reserveBytes();
    if (size > room) {
      fail(507, room > 0 ? `O servidor só tem espaço para mais ${GB_TEXT(room)} agora.` : 'O servidor está sem espaço para anexos agora. Avise quem hospeda.');
    }
    const id = randomUUID();
    const at = Date.now();
    run('INSERT INTO upload_sessions (id, owner_id, name, ext, size, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, me, name, ext, size, at, at);
    // cria o arquivo vazio: "quanto chegou" é sempre o tamanho dele
    closeSync(openSync(partPath(id), 'w'));
    res.json({ id, size, received: 0, chunkSize: CHUNK_SUGGESTED });
  });

  /** Quanto já chegou (para continuar depois de uma queda). */
  api.get('/uploads/:id', (req, res) => {
    const s = ownSession(req, uid(res));
    res.json({ id: s.id, size: s.size, received: received(s.id), chunkSize: CHUNK_SUGGESTED });
  });

  /**
   * Um pedaço. `offset` tem que ser exatamente o que já chegou (senão responde 409 com o número certo, e o
   * navegador continua dali). O corpo vai direto para o disco; se a conexão cair no meio, o pedaço incompleto é
   * descartado para o arquivo nunca ficar com um buraco.
   */
  api.put('/uploads/:id/chunk', async (req, res) => {
    const me = uid(res);
    const s = ownSession(req, me);
    // um pedaço por vez: se uma conexão antiga (que caiu sem avisar) ainda está mandando, ela é encerrada e o
    // pedaço incompleto dela é descartado antes de este começar. Assim duas conexões nunca escrevem juntas.
    const previous = active.get(s.id);
    if (previous) {
      previous.req.destroy();
      await previous.done;
    }
    let finish!: () => void;
    const slot = { req, done: new Promise<void>((r) => (finish = r)) };
    active.set(s.id, slot);
    // conexão parada (sem dados por 60 s) é encerrada: o app continua de onde parou
    req.setTimeout(60_000, () => req.destroy());
    try {
      await writeChunk(req, res, s);
    } finally {
      if (active.get(s.id) === slot) active.delete(s.id);
      finish();
    }
  });

  async function writeChunk(req: Request, res: Parameters<RequestHandler>[1], s: Session) {
    const have = received(s.id);
    const offset = Number(req.query.offset);
    if (!Number.isSafeInteger(offset) || offset !== have) {
      res.status(409).json({ error: 'Posição do pedaço não confere', received: have });
      return;
    }
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && (declared > CHUNK_MAX || have + declared > s.size)) fail(413, 'Pedaço grande demais');

    let count = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        count += chunk.length;
        if (count > CHUNK_MAX || have + count > s.size) return done(Object.assign(new Error('Pedaço grande demais'), { status: 413 }));
        done(null, chunk);
      },
    });
    const out = createWriteStream(partPath(s.id), { flags: 'r+', start: have });
    try {
      await pipeline(req, limit, out);
    } catch (err) {
      // volta ao último pedaço completo
      try {
        truncateSync(partPath(s.id), have);
      } catch {
        // o envio foi cancelado e o arquivo já sumiu
      }
      const status = (err as { status?: number }).status;
      if (status === 413) fail(413, 'Pedaço grande demais');
      if (!res.headersSent && !req.destroyed) res.status(400).json({ error: 'O pedaço não chegou inteiro. Tentando de novo…', received: have });
      return;
    }
    run('UPDATE upload_sessions SET touched_at = ? WHERE id = ?', Date.now(), s.id);
    res.json({ received: have + count });
  }

  /** Terminou de chegar: vira um anexo normal (só aparece para alguém quando for junto de uma mensagem). */
  api.post('/uploads/:id/finish', (req, res) => {
    const me = uid(res);
    const s = ownSession(req, me);
    const have = received(s.id);
    if (have !== s.size) {
      res.status(409).json({ error: 'O arquivo ainda não chegou inteiro', received: have });
      return;
    }
    const src = partPath(s.id);
    let ext = s.ext;
    let image = false;
    if (IMAGE_EXTS.has(ext)) {
      const real = detectImage(head(src));
      if (!real) {
        unlinkSync(src);
        run('DELETE FROM upload_sessions WHERE id = ?', s.id);
        fail(400, 'Imagem inválida');
      }
      ext = real!;
      image = true;
    }
    const dir = join(config.uploadsDir, 'files');
    mkdirSync(dir, { recursive: true });
    const file = `${me}-${randomBytes(16).toString('hex')}.${ext}`;
    renameSync(src, join(dir, file));
    run('DELETE FROM upload_sessions WHERE id = ?', s.id);
    const row: AttachmentRow = { id: randomUUID(), uploader_id: me, url: `/uploads/files/${file}`, name: s.name, size: s.size, image: image ? 1 : 0, message_id: null, created_at: Date.now() };
    run(
      'INSERT INTO attachments (id, uploader_id, url, name, size, image, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      row.id,
      row.uploader_id,
      row.url,
      row.name,
      row.size,
      row.image,
      row.created_at,
    );
    res.json(deps.attachmentJson(row));
  });

  /** Desistiu (tirou o arquivo antes de terminar). */
  api.delete('/uploads/:id', (req, res) => {
    const s = ownSession(req, uid(res));
    dropSession(s.id);
    res.json({ ok: true });
  });
}

function dropSession(id: string) {
  run('DELETE FROM upload_sessions WHERE id = ?', id);
  try {
    if (existsSync(partPath(id))) unlinkSync(partPath(id));
  } catch {
    // já não existe
  }
}

/** Faxina: envios parados há mais de um dia, e arquivos temporários sem envio (sobras de um servidor que caiu). */
export function sweepUploads() {
  for (const s of all<Session>('SELECT * FROM upload_sessions WHERE touched_at < ?', Date.now() - STALE_MS)) dropSession(s.id);
}
