import { ChevronDown, Hash, Volume2 } from 'lucide-react';
import { Frame, Spot, Tag } from '../components/modals/OnboardingArt';
import type { Release } from './index';

function CategoriesArt() {
  const row = (icon: 'text' | 'voice', w: string) => (
    <div className="flex h-5 items-center gap-1.5 rounded-md px-1.5 text-fg-muted">
      {icon === 'text' ? <Hash size={10} /> : <Volume2 size={10} />}
      <div className={`h-1.5 rounded bg-fg-subtle/40 ${w}`} />
    </div>
  );
  return (
    <Frame className="flex h-[170px] items-center justify-center px-6">
      <div className="w-48 space-y-2 rounded-xl bg-surface-3 p-3 ring-1 ring-line">
        <Spot rounded="rounded-md">
          <div className="flex items-center gap-1 px-1 text-[10px] font-bold text-fg">
            <ChevronDown size={10} /> 🎮 Jogos
          </div>
        </Spot>
        <div className="space-y-0.5">
          {row('text', 'w-20')}
          {row('voice', 'w-16')}
        </div>
        <div className="flex items-center gap-1 px-1 text-[10px] font-bold text-fg-subtle">
          <ChevronDown size={10} className="-rotate-90" /> 🍿 Filmes
        </div>
      </div>
      <Tag className="right-3 bottom-3">Arraste para organizar</Tag>
    </Frame>
  );
}

export default {
  id: '2026-11-08-0230',
  title: 'Categorias de canais',
  highlights: [
    {
      kicker: 'Servidor',
      title: 'Organize salas e canais em categorias',
      text: 'Como no Discord: crie categorias no menu do servidor (Criar categoria), arraste canais e salas para dentro delas e clique no nome para recolher. Dá para mudar a ordem arrastando, ou pelas configurações da categoria.',
      art: CategoriesArt,
    },
  ],
  also: [
    'Nomes de canais de texto agora aceitam emoji, e os campos de nome ganharam um botão para escolher um.',
    'Os grupos Salas, Fóruns e Conversas podem ganhar outro nome e mudar de lugar no meio das categorias: arraste o título, ou use a engrenagem.',
    'A conexão com a Steam também fica em Configurações → Conta e segurança, com um atalho para escolher os jogos do seu perfil.',
    'O mini-perfil (ao passar o mouse em alguém) mostra os jogos favoritos da Steam e quantos jogos a pessoa tem.',
    '"Jogando..." agora funciona também pelo navegador: baixe o detector de jogos em Configurações → Privacidade.',
    'Nova opção "Capa com Fundo de Mini-Perfil" em Meu perfil → Visual: uma imagem só no cartão inteiro, sem emenda, e você arrasta para escolher a parte que aparece.',
  ],
  fixes: [],
} satisfies Release;
