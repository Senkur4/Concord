# Bot de filmes do Concord

Um bot separado do bot de música. Ele transmite vídeos que estão numa pasta do seu PC para a sala de voz, como se fosse uma transmissão de tela, na qualidade que você escolher no comando. Legendas e faixas de áudio dos arquivos MKV funcionam.

Use com vídeos que vocês têm o direito de assistir: gravações de vocês, filmes em domínio público, vídeos liberados pelos criadores e arquivos comprados sem proteção.

## Comandos

| Comando | O que faz |
|---|---|
| `!filmes` | lista os vídeos da pasta, numerados (`!filmes 2` vai para a próxima página) |
| `!filmes <busca>` | procura pelo nome: `!filmes frieren` |
| `!playmovie <nome ou número> [qualidade]` | transmite agora, ou põe na fila |
| `!faixas <nome ou número>` | mostra os áudios e legendas do arquivo |
| `!pausemovie` / `!resumemovie` | pausa e continua |
| `!seekmovie <tempo>` | vai para um ponto: `!seekmovie 12:30`, `!seekmovie 1:02:03`, `!seekmovie +30`, `!seekmovie -1:00` |
| `!skipmovie` | pula para o próximo da fila |
| `!moviequeue` | o que está passando, em que minuto, e a fila |
| `!volmovie <0-100>` | volume do bot |
| `!stopmovie` | limpa a fila e tira o bot da sala |
| `!ajudafilme` | lista os comandos no chat |

### Qualidade

Escreva depois do nome, do jeito que preferir:

```
!playmovie 3                    -> padrão (1080p, 30 fps)
!playmovie 3 720p               -> 720p, 30 fps
!playmovie 3 1080p60            -> 1080p, 60 fps
!playmovie frieren 12 720p 60fps
!playmovie interestelar 480p    -> para quem está com a internet ruim
```

Resoluções: `360p` `480p` `540p` `720p` `900p` `1080p`. Fps: `24` `25` `30` `48` `50` `60`.

O bot nunca aumenta além do arquivo: um vídeo 720p pedido em 1080p sai em 720p, e um filme de 24 fps pedido em 60 sai em 24, porque aumentar não melhora a imagem. A mensagem do bot avisa quando isso acontece.

### Áudio, legenda e início

```
!playmovie frieren 12 audio:jpn legenda:por
!playmovie 5 audio:2              -> segunda faixa de áudio
!playmovie 5 legenda:nao          -> sem legenda
!playmovie 5 1080p inicio:45:00   -> começa no minuto 45
```

Sem escolher nada, o bot usa a legenda em português se o arquivo tiver uma. Também funciona a legenda num arquivo separado com o mesmo nome do vídeo, como `Filme.srt` ou `Filme.pt-BR.srt`, na mesma pasta. Use `!faixas` para ver o que cada arquivo tem.

## Instalação

### 1. Criar o bot no Concord

1. No Concord, abra **Configurações → Bots** e clique em **Criar bot**. Dê um nome (ex.: Cine).
2. **Copie o token** (começa com `cb_`). Ele só aparece uma vez.
3. Em **Adicionar a um servidor**, escolha o seu servidor.

### 2. Colocar o token no `.env`

Abra o arquivo `.env` da pasta do Concord e acrescente uma linha:

```
MOVIEBOT_TOKEN=cb_o_token_que_voce_copiou
```

Não mande esse token para ninguém, nem cole no chat.

### 3. Criar a pasta dos vídeos

Crie uma pasta chamada `videos` dentro da pasta do Concord, ao lado do `docker-compose.dev.yml`, e coloque os arquivos lá. Pode organizar em subpastas, como `videos\Animes\Frieren\`. Os formatos comuns funcionam: MKV, MP4, AVI, WEBM, MOV, TS.

A pasta `videos` está no `.gitignore`, então ela nunca vai para o GitHub junto com o `git push`.

### 4. Ligar

No PowerShell, na pasta do Concord:

```
docker compose -f docker-compose.dev.yml up -d --build
```

Para ver se ligou: `docker compose -f docker-compose.dev.yml logs moviebot --tail 20`. Deve aparecer "Conectado ao Concord como Cine".

Vídeos novos na pasta aparecem no `!filmes` na hora, sem reiniciar nada.

## Ajustes opcionais (no `.env`)

| Linha | Para que serve |
|---|---|
| `MOVIEBOT_QUALITY=720p30` | qualidade usada quando ninguém escreve uma no comando (padrão `1080p30`) |
| `MOVIEBOT_MAX_KBPS=6000` | limite de dados por segundo de cada transmissão, em kbps (padrão `8000`). Abaixe se o seu upload for baixo |

Depois de mudar, rode o `up -d --build` de novo.

**Quanto de internet:** cada amigo assistindo recebe uma cópia saindo do seu PC. 1080p a 30 fps usa uns 6 Mbps por pessoa; 720p uns 3 Mbps; 480p uns 1,2 Mbps. Some pelo número de pessoas e compare com o seu upload.

## Problemas comuns

- **"A pasta de vídeos está vazia"**: confira se a pasta se chama `videos` (minúsculo) e se está ao lado do `docker-compose.dev.yml`.
- **O vídeo trava ou fica lento**: peça uma qualidade menor (`720p`) ou 30 fps em vez de 60.
- **Legenda não aparece**: rode `!faixas` para ver se o arquivo tem legenda e qual o número dela, e peça com `legenda:N`.
- **O bot não responde**: veja o log com o comando do passo 4. Se aparecer "Falta CONCORD_TOKEN", o `MOVIEBOT_TOKEN` não está no `.env`.
