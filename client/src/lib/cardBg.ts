// Fundo do mini perfil, igual no cartão de verdade e na prévia de Meu perfil.
import type { CSSProperties } from 'react';

interface CardLooks {
  bannerUrl?: string | null;
  cardBgUrl?: string | null;
  combinedBgUrl?: string | null;
  combinedPos?: { x: number; y: number };
}

/**
 * combined: uma imagem só cobre o cartão inteiro (a parte de cima faz o papel da capa), sem emenda.
 * Senão, o fundo do mini perfil (se houver) fica atrás de tudo e a capa por cima, como antes.
 */
export function cardLook(u: CardLooks): { style: CSSProperties; combined: boolean; hasImage: boolean; bannerUrl: string | null } {
  if (u.combinedBgUrl) {
    const pos = u.combinedPos ?? { x: 50, y: 30 };
    return {
      combined: true,
      hasImage: true,
      bannerUrl: null,
      style: {
        // a parte de cima fica limpa (é a "capa"); escurece um pouco embaixo para o texto
        backgroundImage: `linear-gradient(rgb(0 0 0 / 0) 0%, rgb(0 0 0 / 0) 20%, rgb(0 0 0 / 0.4) 100%), url("${u.combinedBgUrl}")`,
        backgroundSize: 'cover',
        backgroundPosition: `${pos.x}% ${pos.y}%`,
      },
    };
  }
  return {
    combined: false,
    hasImage: !!u.cardBgUrl,
    bannerUrl: u.bannerUrl ?? null,
    style: u.cardBgUrl ? { backgroundImage: `linear-gradient(rgb(0 0 0 / 0.15), rgb(0 0 0 / 0.45)), url("${u.cardBgUrl}")` } : {},
  };
}
