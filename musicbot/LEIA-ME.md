# Bot de música e vídeo para o Concord

Toca o áudio de vídeos do YouTube na sala de voz, ou transmite o vídeo (720p, 30 fps) para todo mundo assistir junto. Ele aparece na lista da sala com o nome que você deu, e cada pessoa pode ajustar o volume dele como faz com qualquer um.

## Comandos

| Comando | O que faz |
|---|---|
| `!play <link do YouTube>` | toca a música (só o áudio) agora ou põe na fila |
| `!play <nome da música>` | busca no YouTube e toca o primeiro resultado |
| `!assistir <link ou nome>` | transmite o vídeo com som para a sala (também: `!video`, `!watch`) |
| `!skip` | pula o que está tocando |
| `!pause` / `!resume` | pausa e continua |
| `!pular <tempo>` | vai para um ponto: `!pular 1:30` ou `!pular 90` |
| `!fila` | mostra o que está tocando e a fila |
| `!volume <0-100>` | volume do bot para todo mundo (padrão 50) |
| `!stop` | limpa a fila e tira o bot da sala |
| `!ajuda` | lista os comandos |

Entre numa sala de voz antes de pedir: o bot vai para a sala de quem pediu.

**Para assistir um vídeo:** depois do `!assistir`, o bot aparece "transmitindo" na sala de voz. Clique na transmissão dele, como faz com a tela de um amigo, e use tela cheia se quiser. Música e vídeo dividem a mesma fila. Ele sai sozinho 30 segundos depois que todo mundo sair, ou 2 minutos depois que a fila acabar.

## Instalação

### 1. Criar o bot no Concord

1. No Concord, abra **Configurações → Bots** e clique em **Criar bot**. Dê o nome que quiser (ex.: DJ).
2. **Copie o token** (começa com `cb_`). Ele só aparece uma vez.
3. Em **Adicionar a um servidor**, escolha o seu servidor.

### 2. Colocar a pasta do bot

Extraia este ZIP para dentro da pasta do Concord, de forma que fique assim:

```
concord-main\
  docker-compose.dev.yml
  musicbot\
    bot.mjs
    Dockerfile
    package.json
    ...
```

### 3. Adicionar o bot no docker-compose.dev.yml

Abra o `docker-compose.dev.yml` e cole este bloco no final do arquivo, **depois** do bloco `app:`, com o mesmo recuo de `app:` e `livekit:` (2 espaços, sem Tab):

```yaml
  musicbot:
    build: ./musicbot
    restart: unless-stopped
    environment:
      CONCORD_URL: http://app:3000
      CONCORD_TOKEN: COLE_O_TOKEN_DO_BOT_AQUI
      LIVEKIT_URL: ws://livekit:7880
      LIVEKIT_API_KEY: devkey
      LIVEKIT_API_SECRET: A_MESMA_SENHA_DO_LIVEKIT_API_SECRET_DO_APP
    depends_on:
      - app
      - livekit
```

- Em `CONCORD_TOKEN`, cole o token `cb_...` do passo 1.
- Em `LIVEKIT_API_SECRET`, coloque **a mesma senha** que está no `LIVEKIT_API_SECRET` do bloco `app:`.

> O token é a senha do bot. Não mande para ninguém.

### 4. Subir

Na pasta do Concord:

```
docker compose -f docker-compose.dev.yml up -d --build
```

A primeira vez demora alguns minutos (baixa o ffmpeg e o yt-dlp). Depois, entre numa sala de voz e digite `!play` com um link no chat.

## Se algo der errado

Veja o que o bot está dizendo:

```
docker compose -f docker-compose.dev.yml logs musicbot
```

- **"Falta a variável ..."**: alguma linha do `environment:` ficou vazia.
- **"Erro 401" / "unauthorized"**: o token está errado. Gere outro em Configurações → Bots → **Novo token**.
- **O bot entra na sala, mas ninguém ouve**: confira se o `LIVEKIT_API_SECRET` é idêntico ao do app e mande o log.
- **"Sign in to confirm you're not a bot" ou erros do YouTube**: o YouTube mudou algo. Reinicie o bot (`docker compose -f docker-compose.dev.yml restart musicbot`): ele atualiza o yt-dlp toda vez que liga.

## Sobre o modo vídeo

- O vídeo é baixado, decodificado e recodificado no seu PC em tempo real. Em 720p a 30 fps funciona bem na maioria dos computadores, mas usa bastante processador.
- Cada amigo assistindo recebe o vídeo a partir do seu PC: conte uns 2 a 3 Mbps de upload por pessoa.
- Para mudar a qualidade, adicione no `environment:` do musicbot, por exemplo, `VIDEO_HEIGHT: 480` e `VIDEO_WIDTH: 854` (mais leve) ou `VIDEO_BITRATE_KBPS: 4000` (mais nítido, mais upload).

## Aviso

Os termos de uso do YouTube não permitem baixar ou reproduzir vídeos fora do player deles. Use só entre amigos, por sua conta.
