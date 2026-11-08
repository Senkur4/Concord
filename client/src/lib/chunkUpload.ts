// Envio de anexo em pedaços (ver server/src/bigupload.ts): cada pedaço vai direto para o disco do servidor.
// Se a conexão cair, pergunta ao servidor quanto já chegou e continua dali, sem recomeçar do zero.
import { getToken } from './api';
import type { Attachment } from './types';

export interface UploadProgress {
  sent: number;
  total: number;
  /** caiu e está tentando de novo */
  retrying: boolean;
  /** bytes por segundo (média dos últimos segundos) */
  speed: number;
}

const auth = (): Record<string, string> => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `Erro ${res.status}`), { status: res.status, data });
  return data as T;
}

/** Um pedaço via XHR (o fetch não informa o progresso do envio). */
function putChunk(url: string, body: Blob, onBytes: (n: number) => void, signal: AbortSignal): Promise<{ status: number; data: { received?: number; error?: string } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(auth())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // resposta vazia
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(Object.assign(new Error('Sem conexão com o servidor'), { network: true }));
    xhr.ontimeout = xhr.onerror;
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    xhr.onabort = () => reject(new DOMException('cancelado', 'AbortError'));
    xhr.send(body);
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('cancelado', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * Envia o arquivo e devolve o anexo pronto. `signal` cancela (e avisa o servidor para jogar fora o que chegou).
 * Quedas de conexão são tentadas de novo por até ~10 minutos seguidos sem progresso.
 */
export async function uploadInChunks(file: File, onProgress: (p: UploadProgress) => void, signal: AbortSignal): Promise<Attachment> {
  const start = await json<{ id: string; chunkSize: number }>(
    await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth() },
      body: JSON.stringify({ name: file.name || 'arquivo', size: file.size }),
      signal,
    }),
  );
  const { id } = start;
  const chunk = start.chunkSize || 8 * 1024 * 1024;
  let offset = 0;
  let failures = 0;
  let lastProgressAt = Date.now();
  // velocidade: janela dos últimos ~5 s
  const samples: { t: number; sent: number }[] = [];
  const report = (sent: number, retrying = false) => {
    const t = Date.now();
    samples.push({ t, sent });
    while (samples.length > 2 && t - samples[0].t > 5000) samples.shift();
    const first = samples[0];
    const speed = t > first.t ? ((sent - first.sent) * 1000) / (t - first.t) : 0;
    onProgress({ sent, total: file.size, retrying, speed: Math.max(0, speed) });
  };

  const cancel = () => void fetch(`/api/uploads/${id}`, { method: 'DELETE', headers: auth(), keepalive: true }).catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });

  try {
    report(0);
    while (offset < file.size) {
      const end = Math.min(file.size, offset + chunk);
      try {
        const r = await putChunk(`/api/uploads/${id}/chunk?offset=${offset}`, file.slice(offset, end), (n) => report(offset + n), signal);
        if (r.status === 200 && typeof r.data.received === 'number') {
          offset = r.data.received;
          failures = 0;
          lastProgressAt = Date.now();
          report(offset);
          continue;
        }
        if (r.status === 409 && typeof r.data.received === 'number') {
          offset = r.data.received; // o servidor tem outro número: continua de lá
          continue;
        }
        if (r.status === 404 || r.status === 413 || r.status === 401 || r.status === 403) throw new Error(r.data.error ?? `Erro ${r.status}`);
        throw Object.assign(new Error(r.data.error ?? `Erro ${r.status}`), { network: true });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        if (!(err as { network?: boolean }).network) throw err;
        // queda: espera um pouco, pergunta quanto chegou e continua
        failures++;
        if (Date.now() - lastProgressAt > 10 * 60_000) throw new Error('A conexão caiu por muito tempo. Tente enviar de novo.');
        report(offset, true);
        await sleep(Math.min(15_000, 1000 * 2 ** Math.min(failures - 1, 4)), signal);
        try {
          const st = await json<{ received: number }>(await fetch(`/api/uploads/${id}`, { headers: auth(), signal }));
          offset = st.received;
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e;
          if ((e as { status?: number }).status === 404) throw new Error('O envio expirou no servidor. Escolha o arquivo de novo.');
          // servidor ainda fora: tenta de novo no próximo giro
        }
      }
    }
    // terminar também tenta de novo se a conexão oscilar
    for (let attempt = 0; ; attempt++) {
      try {
        return await json<Attachment>(await fetch(`/api/uploads/${id}/finish`, { method: 'POST', headers: auth(), signal }));
      } catch (err) {
        if ((err as Error).name === 'AbortError' || (err as { status?: number }).status || attempt >= 5) throw err;
        await sleep(2000, signal);
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
