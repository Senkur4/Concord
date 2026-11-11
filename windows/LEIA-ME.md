# Concord no Windows, sem Docker

Tudo roda direto no Windows: Node, LiveKit, ffmpeg e yt-dlp.
Usa o mesmo `.env`, a mesma pasta `data-dev` (contas, mensagens, uploads) e a mesma pasta `videos`.

## Primeira vez

Dê dois cliques em `instalar.bat`. Ele:

1. instala o Node (via winget) se não tiver;
2. confere o `.env` (cria as senhas que faltarem e acha o IP do Radmin);
3. baixa o LiveKit, o ffmpeg e o yt-dlp para `windows\bin`;
4. instala as dependências e monta o site;
5. pergunta se libera o firewall (só para o Radmin e a rede de casa);
6. pergunta se liga junto com o Windows;
7. liga o Concord.

## Dia a dia

| Arquivo | O que faz |
|---|---|
| `iniciar.bat` | liga o Concord (se já estiver ligado, não faz nada) |
| `parar.bat` | desliga tudo |
| `atualizar.bat` | depois de um `git am`: desliga, reinstala o que mudou, monta o site e liga de novo |
| `atualizar.bat -Programas` | o mesmo, e baixa de novo LiveKit, ffmpeg e yt-dlp |
| `firewall.bat` | cria de novo as regras do firewall |

Se um pedaço cair (servidor, LiveKit ou bots), ele é religado sozinho em poucos segundos.

Para não ligar mais junto com o Windows:
`powershell -ExecutionPolicy Bypass -File windows\ligar-com-windows.ps1 -Desligar`

## Liberar só os seus amigos no firewall

No `.env`, coloque os IPs do Radmin de cada amigo (aparecem do lado do nome dele no Radmin), separados por vírgula:

```
AMIGOS_RADMIN=26.11.22.33, 26.44.55.66
LIBERAR_REDE_DE_CASA=sim
```

Depois rode `firewall.bat` de novo. Entrou um amigo novo? Acrescente o IP dele e rode outra vez.
Com `AMIGOS_RADMIN` vazio, qualquer pessoa de qualquer rede do Radmin em que você estiver consegue acessar.
`LIBERAR_REDE_DE_CASA=nao` bloqueia também os outros aparelhos da sua casa.

## Se algo der errado

Os registros ficam em `windows\logs` (`concord.log`, `concord.erros.log`, `livekit.log`...).
