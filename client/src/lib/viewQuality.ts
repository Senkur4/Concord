// Qualidade de quem ASSISTE uma transmissão (como no YouTube): automática, a original de quem transmite, ou uma
// menor fixa. Vale para todas as transmissões e fica salva no navegador.
//
// O LiveKit tem um modo "adaptiveStream" que escolhe a qualidade sozinho pelo tamanho do vídeo na tela; nele o
// tamanho do quadro sempre manda (num quadro pequeno vinha 240p mesmo pedindo a melhor). Por isso o Concord não usa
// esse modo e pede a qualidade direto: no automático, pelo tamanho do quadro (o mesmo que o modo fazia); nas outras
// opções, a camada escolhida, não importa o tamanho do quadro.
import { RemoteTrackPublication, VideoQuality, type TrackPublication } from 'livekit-client';
import { useEffect } from 'react';
import { create } from 'zustand';

/** 'auto' | 'source' (a melhor que a pessoa está transmitindo) | altura fixa em pixels (720, 480...) */
export type ViewQuality = 'auto' | 'source' | number;

const KEY = 'concord.viewQuality';

function load(): ViewQuality {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '"auto"');
    return raw === 'source' || raw === 'auto' || (typeof raw === 'number' && raw > 0) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export const useViewQuality = create<{ quality: ViewQuality; setQuality: (q: ViewQuality) => void }>((set) => ({
  quality: load(),
  setQuality: (quality) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(quality));
    } catch {
      // sem armazenamento: vale até fechar
    }
    set({ quality });
  },
}));

const remote = (pub: TrackPublication | undefined): RemoteTrackPublication | null => (pub instanceof RemoteTrackPublication ? pub : null);

/**
 * Liga o vídeo remoto enquanto o quadro está na tela (e desliga ao sair, para não gastar internet à toa) e pede a
 * qualidade: `quality` fixa (transmissão) ou automática pelo tamanho do elemento (câmeras e transmissão no automático).
 */
export function useRemoteVideoQuality(el: HTMLElement | null, pub: TrackPublication | undefined, quality: ViewQuality, keepEnabledOnUnmount?: () => boolean) {
  const rp = remote(pub);

  useEffect(() => {
    if (!rp) return;
    rp.setEnabled(true);
    return () => {
      if (!keepEnabledOnUnmount?.()) rp.setEnabled(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rp]);

  useEffect(() => {
    if (!rp || !el) return;
    const byElement = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return; // escondido: não muda nada
      const d = Math.min(2, window.devicePixelRatio || 1);
      rp.setVideoDimensions({ width: Math.round(r.width * d), height: Math.round(r.height * d) });
    };
    if (quality === 'source') {
      rp.setVideoQuality(VideoQuality.HIGH);
      return;
    }
    if (typeof quality === 'number') {
      rp.setVideoDimensions({ width: Math.round((quality * 16) / 9), height: quality });
      return;
    }
    byElement();
    const ro = new ResizeObserver(byElement);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rp, el, quality]);
}

/** Camadas que quem transmite está enviando (a original e as menores), da maior para a menor. */
export function streamLayers(pub: TrackPublication | undefined): { width: number; height: number }[] {
  const layers = remote(pub)?.trackInfo?.layers ?? [];
  const seen = new Set<number>();
  return layers
    .map((l) => ({ width: l.width, height: l.height }))
    .filter((l) => l.height > 0 && !seen.has(l.height) && seen.add(l.height))
    .sort((a, b) => b.height - a.height);
}
