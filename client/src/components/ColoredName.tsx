import type { CSSProperties, ReactNode } from 'react';

/**
 * Nome com a cor que a pessoa escolheu: 1 cor (sólida) ou 2 a 3 (degradê da esquerda para a direita).
 * Sem cor própria, usa `fallback` (a cor do cargo no servidor) ou a cor normal do texto.
 * O degradê fica num span interno: assim ele acompanha o tamanho do texto, e não o da caixa (que pode ser bem maior).
 */
export function ColoredName({ colors, fallback, className, children }: { colors?: string[] | null; fallback?: string; className?: string; children: ReactNode }) {
  if (!colors?.length) return <span className={className} style={fallback ? { color: fallback } : undefined}>{children}</span>;
  if (colors.length === 1) return <span className={className} style={{ color: colors[0] }}>{children}</span>;
  return (
    // a cor de fora é a do fim do degradê: é a das reticências quando o nome não cabe
    <span className={className} style={{ color: colors[colors.length - 1] }}>
      <span style={gradientText(colors)}>{children}</span>
    </span>
  );
}

export function gradientText(colors: string[]): CSSProperties {
  return {
    backgroundImage: `linear-gradient(90deg, ${colors.join(', ')})`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    color: 'transparent',
    // sem isto, letras com "perna" (g, j, p) cortam embaixo
    paddingBottom: '0.08em',
  };
}
