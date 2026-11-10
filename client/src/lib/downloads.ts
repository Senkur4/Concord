import { useSyncExternalStore } from 'react';
import { desktop, type DesktopDownloadProgress } from './desktop';

/**
 * Downloads dos anexos com progresso (porcentagem, velocidade, terminou, falhou), que continuam se você trocar de
 * canal. Três jeitos, do melhor para o mais simples:
 *  1. app desktop: o próprio app baixa direto na pasta Downloads (arquivo de qualquer tamanho);
 *  2. navegador com "salvar como" direto no disco (Chrome, Edge): a página grava pedaço por pedaço, e se a
 *     internet cair dá para continuar de onde parou;
 *  3. os outros navegadores: o download normal do navegador (que mostra o progresso dele).
 */

export type DownloadStatus = 'downloading' | 'done' | 'failed';

export interface DownloadState {
  status: DownloadStatus;
  received: number;
  total: number;
  /** bytes por segundo */
  speed: number;
  error?: string;
  /** só no app desktop: dá para abrir o arquivo e a pasta */
  desktopId?: string;
  fileName?: string;
}

const states = new Map<string, DownloadState>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (url: string, s: DownloadState | null) => {
  if (s) states.set(url, s);
  else states.delete(url);
  emit();
};

export function useDownload(url: string): DownloadState | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => states.get(url),
  );
}

/** velocidade suavizada (média dos últimos segundos), para o número não ficar pulando */
function speedometer() {
  let lastT = performance.now();
  let lastB = 0;
  let speed = 0;
  return (bytes: number) => {
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    if (dt >= 0.5) {
      const inst = (bytes - lastB) / dt;
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      lastT = now;
      lastB = bytes;
    }
    return speed;
  };
}

// ---------- 1. app desktop ----------

const desktopUrls = new Map<string, string>(); // id do app -> endereço
let desktopHooked = false;
function hookDesktop() {
  if (desktopHooked || !desktop?.onDownloadProgress) return;
  desktopHooked = true;
  const meters = new Map<string, ReturnType<typeof speedometer>>();
  desktop.onDownloadProgress((p: DesktopDownloadProgress) => {
    const url = desktopUrls.get(p.id);
    if (!url) return;
    if (!meters.has(p.id)) meters.set(p.id, speedometer());
    const cur = states.get(url);
    const total = p.total || cur?.total || 0;
    if (p.state === 'progressing') set(url, { status: 'downloading', received: p.received, total, speed: meters.get(p.id)!(p.received), desktopId: p.id, fileName: p.fileName });
    else if (p.state === 'completed') set(url, { status: 'done', received: total || p.received, total: total || p.received, speed: 0, desktopId: p.id, fileName: p.fileName });
    else if (p.state === 'cancelled') set(url, null);
    else set(url, { status: 'failed', received: p.received, total, speed: 0, error: 'A conexão caiu no meio do download.', desktopId: p.id, fileName: p.fileName });
    if (p.state !== 'progressing') meters.delete(p.id);
  });
}

// ---------- 2. navegador gravando direto no disco ----------

interface Job {
  handle: FileSystemFileHandle;
  abort: AbortController;
}
const jobs = new Map<string, Job>();

type SavePicker = (opts: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
const savePicker = () => (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;

async function streamToDisk(url: string, job: Job, from: number, total: number) {
  const meter = speedometer();
  let received = from;
  set(url, { status: 'downloading', received, total, speed: 0 });
  const writable = await job.handle.createWritable({ keepExistingData: from > 0 });
  try {
    const res = await fetch(url, { signal: job.abort.signal, headers: from > 0 ? { range: `bytes=${from}-` } : undefined });
    if (!res.ok || !res.body) throw new Error(`O servidor respondeu ${res.status}`);
    // pediu para continuar e o servidor mandou tudo de novo: recomeça do zero
    if (from > 0 && res.status !== 206) {
      received = 0;
      await writable.truncate(0);
    } else if (from > 0) {
      await writable.seek(from);
    }
    total = Number(res.headers.get('content-length') ?? 0) + received || total;
    const reader = res.body.getReader();
    let lastEmit = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      const now = performance.now();
      if (now - lastEmit > 200) {
        lastEmit = now;
        set(url, { status: 'downloading', received, total, speed: meter(received) });
      }
    }
    // a conexão caiu e o navegador terminou o download como se estivesse completo: não é "baixado"
    if (total && received < total) throw new Error('A conexão caiu no meio do download.');
    await writable.close();
    jobs.delete(url);
    set(url, { status: 'done', received, total: total || received, speed: 0 });
  } catch (err) {
    if (job.abort.signal.aborted) {
      await writable.abort().catch(() => {});
      jobs.delete(url);
      return set(url, null);
    }
    // guarda o que já veio, para "Tentar de novo" continuar de onde parou
    await writable.close().catch(() => {});
    set(url, { status: 'failed', received, total, speed: 0, error: err instanceof Error && !/fetch|network/i.test(err.message) ? err.message : 'A conexão caiu no meio do download.' });
  }
}

// ---------- 3. download comum ----------

function plainDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- o que os botões chamam ----------

/** true = este navegador/app mostra o progresso aqui; false = vai pelo download comum do navegador */
export const canTrackDownloads = () => !!desktop?.downloadStart || !!savePicker();

export async function startDownload(url: string, name: string, size: number) {
  const cur = states.get(url);
  if (cur?.status === 'downloading') return;
  if (desktop?.downloadStart) {
    hookDesktop();
    set(url, { status: 'downloading', received: 0, total: size, speed: 0 });
    try {
      const id = await desktop.downloadStart(new URL(url, location.href).toString(), name);
      desktopUrls.set(id, url);
    } catch (err) {
      set(url, { status: 'failed', received: 0, total: size, speed: 0, error: err instanceof Error ? err.message : 'Não deu para baixar' });
    }
    return;
  }
  const picker = savePicker();
  if (!picker) return plainDownload(url, name);
  let handle: FileSystemFileHandle;
  try {
    handle = await picker({ suggestedName: name });
  } catch (err) {
    // fechou a janela de salvar: não faz nada. Outro erro (navegador bloqueou): download comum
    if ((err as DOMException)?.name !== 'AbortError') plainDownload(url, name);
    return;
  }
  const job: Job = { handle, abort: new AbortController() };
  jobs.set(url, job);
  await streamToDisk(url, job, 0, size);
}

/** Depois de falhar: continua de onde parou (navegador) ou recomeça (app). */
export async function retryDownload(url: string, name: string, size: number) {
  const cur = states.get(url);
  const job = jobs.get(url);
  if (job && cur) {
    job.abort = new AbortController();
    return streamToDisk(url, job, cur.received, cur.total || size);
  }
  set(url, null);
  return startDownload(url, name, size);
}

export function cancelDownload(url: string) {
  const cur = states.get(url);
  if (cur?.desktopId && desktop?.downloadCancel) return void desktop.downloadCancel(cur.desktopId);
  const job = jobs.get(url);
  if (job) job.abort.abort();
  else set(url, null);
}

export function dismissDownload(url: string) {
  jobs.delete(url);
  set(url, null);
}

export const openDownloaded = (s: DownloadState) => s.desktopId && desktop?.downloadOpen?.(s.desktopId);
export const showDownloaded = (s: DownloadState) => s.desktopId && desktop?.downloadShow?.(s.desktopId);
