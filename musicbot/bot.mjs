// Bot de música e vídeo para o Concord.
// Entra na sala de voz de quem pediu e toca o áudio de vídeos do YouTube, ou transmite o vídeo
// (720p, 30 fps) como uma transmissão de tela, para todo mundo assistir junto.
//
// Comandos (no chat de qualquer canal que o bot veja):
//   !play <link ou nome>       toca só o áudio (música)
//   !assistir <link ou nome>   transmite o vídeo com som
//   !skip                      pula o que está tocando
//   !pause / !resume           pausa e continua
//   !pular <tempo>             vai para um ponto (ex.: !pular 1:30, !pular 90)
//   !stop                      limpa a fila e sai da sala
//   !fila                      mostra a fila
//   !volume <0-100>            volume do bot
//   !ajuda                     lista os comandos
//
// Variáveis de ambiente:
//   CONCORD_URL, CONCORD_TOKEN                       -> API do Concord (token do bot, começa com cb_)
//   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET -> mesmo LiveKit e mesmas chaves do Concord
//   PREFIX (padrão "!"), BOT_NAME (padrão "DJ"), DEFAULT_VOLUME (padrão 50)
//   VIDEO_WIDTH / VIDEO_HEIGHT / VIDEO_FPS (padrão 1280 / 720 / 30), VIDEO_BITRATE_KBPS (padrão 2500)

import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { AccessToken } from 'livekit-server-sdk';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoSource,
  dispose,
} from '@livekit/rtc-node';

const env = process.env;
const CONCORD_URL = env.CONCORD_URL;
const CONCORD_TOKEN = env.CONCORD_TOKEN;
const LIVEKIT_URL = env.LIVEKIT_URL;
const LIVEKIT_API_KEY = env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = env.LIVEKIT_API_SECRET;
const PREFIX = env.PREFIX || '!';
const BOT_NAME = env.BOT_NAME || 'DJ';
const DEFAULT_VOLUME = Math.min(100, Math.max(0, Number(env.DEFAULT_VOLUME ?? 50)));
const VIDEO_W = Number(env.VIDEO_WIDTH) || 1280;
const VIDEO_H = Number(env.VIDEO_HEIGHT) || 720;
const VIDEO_FPS = Number(env.VIDEO_FPS) || 30;
const VIDEO_BITRATE = (Number(env.VIDEO_BITRATE_KBPS) || 2500) * 1000;
const LEAVE_WHEN_IDLE_MS = 2 * 60_000; // sai da sala depois de 2 min sem tocar nada
const LEAVE_WHEN_ALONE_MS = 30_000; // sai 30 s depois que todo mundo sair da sala

for (const [k, v] of Object.entries({ CONCORD_URL, CONCORD_TOKEN, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET })) {
  if (!v) {
    console.error(`Falta a variável ${k}. Veja o LEIA-ME do bot.`);
    process.exit(1);
  }
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = SAMPLE_RATE / 100; // 10 ms por quadro de áudio
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // s16le
const VIDEO_FRAME_BYTES = (VIDEO_W * VIDEO_H * 3) / 2; // I420

// ---------- API do Concord ----------

async function api(method, path, body) {
  const res = await fetch(`${CONCORD_URL}/api${path}`, {
    method,
    headers: { Authorization: `Bot ${CONCORD_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data;
}

const say = (channelId, content) => api('POST', `/channels/${channelId}/messages`, { content: content.slice(0, 2000) }).catch((err) => console.error('Falha ao enviar mensagem:', err.message));

// ---------- quem está em cada sala de voz ----------

const voiceStates = new Map(); // serverId -> [{ userId, channelId, ... }]

function voiceChannelOf(userId) {
  for (const states of voiceStates.values()) {
    const s = states.find((v) => v.userId === userId);
    if (s) return s.channelId;
  }
  return null;
}

function peopleIn(channelId) {
  let n = 0;
  for (const states of voiceStates.values()) n += states.filter((v) => v.channelId === channelId && v.userId !== me.id).length;
  return n;
}

// ---------- YouTube (yt-dlp) ----------

// o YouTube exige um interpretador de JavaScript: o yt-dlp usa o próprio Node do contêiner
const YTDLP_BASE = ['--no-playlist', '--no-warnings', '--js-runtimes', 'node'];
// o YouTube separa vídeo e áudio: baixa os dois em paralelo. H.264 primeiro (mais leve para decodificar que AV1)
const VIDEO_ONLY_FORMAT = `bv*[height<=${VIDEO_H}][vcodec^=avc1]/bv*[height<=${VIDEO_H}][vcodec^=vp09]/bv*[height<=${VIDEO_H}]/b[height<=${VIDEO_H}]/b`;
const VIDEO_AUDIO_FORMAT = 'ba/b';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${cmd} saiu com código ${code}`))));
  });
}

/** Resolve um link ou uma busca em { url, title, duration }. */
async function resolveTrack(query) {
  const isUrl = /^https?:\/\//i.test(query);
  const target = isUrl ? query : `ytsearch1:${query}`;
  const out = await run('yt-dlp', [...YTDLP_BASE, '--print', '%(webpage_url)s\t%(title)s\t%(duration)s', target]);
  const line = out.trim().split('\n')[0];
  if (!line) throw new Error('Nada encontrado.');
  const [url, title, duration] = line.split('\t');
  return { url: url || query, title: title || query, duration: Number(duration) || 0 };
}

function formatDuration(s) {
  if (!s && s !== 0) return '';
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "1:30" -> 90, "1:02:03" -> 3723, "90" -> 90 */
function parseTime(text) {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(text)) return null;
  return text.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

const killAll = (...procs) => procs.forEach((p) => p && p.exitCode === null && p.kill('SIGKILL'));

/** Áudio: yt-dlp | ffmpeg -> PCM s16le 48 kHz estéreo no stdout do ffmpeg. */
function startAudioDecoder(url) {
  const ytdlp = spawn('yt-dlp', [...YTDLP_BASE, '-q', '-f', 'bestaudio/best', '-o', '-', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdin.on('error', () => {}); // ffmpeg fechou antes (skip): ignora
  ytdlp.stderr.on('data', (d) => console.error('[yt-dlp]', String(d).trim()));
  ffmpeg.stderr.on('data', (d) => console.error('[ffmpeg]', String(d).trim()));
  return { audio: ffmpeg.stdout, video: null, kill: () => killAll(ytdlp, ffmpeg) };
}

/**
 * Vídeo: dois yt-dlp (vídeo e áudio) alimentam um ffmpeg, que solta quadros I420 no fd 4 e PCM no stdout.
 * O ffmpeg roda o mais rápido que conseguir; quem dá o ritmo de tempo real é o bot (ver runOnce).
 * Para pular para um ponto, o ffmpeg decodifica e descarta tudo antes dele (-ss na saída).
 */
function startVideoDecoder(url, startAt) {
  const yt = (format) => {
    const p = spawn('yt-dlp', [...YTDLP_BASE, '-q', '-f', format, '-o', '-', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr.on('data', (d) => console.error('[yt-dlp]', String(d).trim()));
    return p;
  };
  const ytVideo = yt(VIDEO_ONLY_FORMAT);
  const ytAudio = yt(VIDEO_AUDIO_FORMAT);
  const seek = startAt > 0 ? ['-ss', String(startAt)] : [];
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-i', 'pipe:3',
    '-map', '0:v:0', ...seek,
    '-vf', `scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=decrease,pad=${VIDEO_W}:${VIDEO_H}:(ow-iw)/2:(oh-ih)/2,fps=${VIDEO_FPS},format=yuv420p`,
    '-f', 'rawvideo', 'pipe:4',
    '-map', '1:a:0', ...seek,
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1',
  ];
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  ffmpeg.stderr.on('data', (d) => console.error('[ffmpeg]', String(d).trim()));
  ytVideo.stdout.pipe(ffmpeg.stdin);
  ytAudio.stdout.pipe(ffmpeg.stdio[3]);
  ffmpeg.stdin.on('error', () => {});
  ffmpeg.stdio[3].on('error', () => {});
  return { audio: ffmpeg.stdout, video: ffmpeg.stdio[4], kill: () => killAll(ytVideo, ytAudio, ffmpeg) };
}

// ---------- tocador (o bot fica em uma sala por vez, como uma pessoa) ----------

class Player {
  constructor(voiceChannelId, textChannelId) {
    this.voiceChannelId = voiceChannelId;
    this.textChannelId = textChannelId; // onde avisar "tocando agora"
    this.queue = [];
    this.current = null;
    this.volume = DEFAULT_VOLUME / 100;
    this.paused = false;
    this.position = 0; // segundos do item atual
    this.seekTo = null; // pedido de !pular
    this.room = null;
    this.musicSource = null;
    this.screen = null; // { video, audio, pubs } enquanto transmite
    this.decoder = null;
    this.idleTimer = null;
    this.aloneTimer = null;
  }

  async connect() {
    // avisa o Concord que o bot entrou na sala: assim ele aparece na lista da sala, como uma pessoa
    const joined = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'sem resposta' }), 5000);
      socket.emit('voice:join', { channelId: this.voiceChannelId }, (r) => {
        clearTimeout(timer);
        resolve(r ?? { ok: false });
      });
    });
    if (!joined.ok) console.warn('O Concord não registrou o bot na sala (segue tocando mesmo assim):', joined.error);

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: me.id,
      name: me.displayName ?? BOT_NAME,
      metadata: JSON.stringify({ avatarColor: me.avatarColor, username: me.username }),
      ttl: '24h',
    });
    // "agent": a faxina das salas do Concord não expulsa o bot mesmo se o registro acima falhar
    at.kind = 'agent';
    at.addGrant({ room: this.voiceChannelId, roomJoin: true, canPublish: true, canSubscribe: false, canPublishData: false });
    const token = await at.toJwt();

    this.room = new Room();
    await this.room.connect(LIVEKIT_URL, token, { autoSubscribe: false, dynacast: false });
    this.musicSource = new AudioSource(SAMPLE_RATE, CHANNELS);
    const track = LocalAudioTrack.createAudioTrack('musica', this.musicSource);
    await this.room.localParticipant.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, audioEncoding: { maxBitrate: 128_000n }, dtx: false }),
    );
    console.log(`Entrei na sala ${this.voiceChannelId}`);
  }

  /** Começa a "transmitir a tela": vídeo + áudio da transmissão (só quem clica para assistir recebe). */
  async startScreen() {
    if (this.screen) return;
    const video = new VideoSource(VIDEO_W, VIDEO_H);
    const audio = new AudioSource(SAMPLE_RATE, CHANNELS, 200);
    const lp = this.room.localParticipant;
    const vPub = await lp.publishTrack(
      LocalVideoTrack.createVideoTrack('video', video),
      new TrackPublishOptions({
        source: TrackSource.SOURCE_SCREENSHARE,
        videoCodec: VideoCodec.VP8,
        simulcast: false,
        videoEncoding: { maxBitrate: BigInt(VIDEO_BITRATE), maxFramerate: VIDEO_FPS },
      }),
    );
    const aPub = await lp.publishTrack(
      LocalAudioTrack.createAudioTrack('video-audio', audio),
      new TrackPublishOptions({ source: TrackSource.SOURCE_SCREENSHARE_AUDIO, audioEncoding: { maxBitrate: 128_000n }, dtx: false }),
    );
    this.screen = { video, audio, pubs: [vPub.sid, aPub.sid] };
    socket.emit('voice:update', { streaming: true });
  }

  async stopScreen() {
    const s = this.screen;
    if (!s) return;
    this.screen = null;
    socket.emit('voice:update', { streaming: false });
    for (const sid of s.pubs) await this.room?.localParticipant.unpublishTrack(sid).catch(() => {});
  }

  async enqueue(item) {
    this.queue.push(item);
    this.clearIdle();
    if (!this.current) void this.playNext();
  }

  async playNext() {
    this.current = this.queue.shift() ?? null;
    if (!this.current) {
      await this.stopScreen();
      this.scheduleIdle();
      return;
    }
    const item = this.current;
    console.log(`Tocando: ${item.title} (${item.video ? 'vídeo' : 'música'})`);
    const icon = item.video ? '📺 Transmitindo' : '🎵 Tocando agora';
    const hint = item.video ? '\nClique na transmissão do bot na sala de voz para assistir.' : '';
    void say(this.textChannelId, `${icon}: **${item.title}** ${item.duration ? `(${formatDuration(item.duration)})` : ''} — pedido por ${item.requester}${hint}`);
    try {
      if (item.video) await this.startScreen();
      else await this.stopScreen();
      await this.stream(item);
    } catch (err) {
      console.error('Erro tocando', item.url, err);
      void say(this.textChannelId, `⚠️ Não consegui tocar **${item.title}**: ${err.message}`);
    }
    if (this.current === item) void this.playNext();
  }

  /** Toca o item do começo ao fim, reabrindo no ponto certo quando há !pular. */
  async stream(item) {
    let startAt = 0;
    for (;;) {
      this.seekTo = null;
      this.position = startAt;
      const finished = await this.runOnce(item, startAt);
      if (process.env.DEBUG) console.log('runOnce terminou', { finished, seekTo: this.seekTo, position: this.position.toFixed(1) });
      if (this.current !== item) return; // pulou ou parou
      if (this.seekTo !== null) {
        startAt = this.seekTo;
        continue;
      }
      return;
    }
  }

  /** Uma passada do decodificador. Devolve true se chegou ao fim do arquivo. */
  async runOnce(item, startAt) {
    const decoder = item.video ? startVideoDecoder(item.url, startAt) : startAudioDecoder(item.url);
    this.decoder = decoder;
    const alive = () => this.decoder === decoder && this.current === item && this.seekTo === null;
    let audioSent = 0; // segundos de áudio já entregues ao LiveKit: é o relógio do vídeo
    let audioDone = false;
    let audioDoneAt = 0; // quando o áudio acabou (o relógio segue pelo relógio de parede a partir daí)
    let received = 0;
    // música não tem como pular para frente dentro do yt-dlp: descarta o áudio até o ponto pedido
    let skipBytes = item.video ? 0 : Math.floor(startAt * SAMPLE_RATE) * CHANNELS * 2;

    const pumpAudio = async () => {
      const target = item.video ? this.screen?.audio : this.musicSource;
      if (!target) return;
      let pending = Buffer.alloc(0);
      for await (let chunk of decoder.audio) {
        if (!alive()) break;
        received += chunk.length;
        if (skipBytes) {
          const drop = Math.min(skipBytes, chunk.length);
          skipBytes -= drop;
          chunk = chunk.subarray(drop);
          if (!chunk.length) continue;
        }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= FRAME_BYTES) {
          // pausa: segura o áudio aqui mesmo (o vídeo para junto, porque segue o relógio do áudio)
          while (this.paused && alive()) await new Promise((r) => setTimeout(r, 100));
          if (!alive()) break;
          const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
          for (let i = 0; i < samples.length; i++) samples[i] = Math.round(pending.readInt16LE(i * 2) * this.volume);
          pending = pending.subarray(FRAME_BYTES);
          // captureFrame espera quando o buffer do LiveKit enche: isso dá o ritmo de tempo real na música
          await target.captureFrame(new AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
          this.position += 0.01;
          audioSent += 0.01;
        }
      }
      audioDone = true;
      audioDoneAt = Date.now() / 1000;
    };

    const pumpVideo = async () => {
      if (!decoder.video) return;
      // os quadros são lidos assim que o ffmpeg solta (para ele nunca travar esperando) e enviados
      // quando o relógio do áudio chega no tempo deles; sem áudio, segue o relógio de parede
      const queue = [];
      let readDone = false;
      let wallStart = null;
      const AUDIO_LATENCY = 0.15; // o áudio fica um pouco no buffer antes de sair
      const clock = () => {
        if (!audioDone) return audioSent - AUDIO_LATENCY;
        if (audioSent > 0) return audioSent - AUDIO_LATENCY + (Date.now() / 1000 - audioDoneAt); // áudio acabou antes da imagem
        wallStart ??= Date.now() / 1000; // vídeo sem som
        return Date.now() / 1000 - wallStart;
      };
      const sender = (async () => {
        let sent = 0;
        while (alive() && (!readDone || queue.length)) {
          while (queue.length && sent / VIDEO_FPS <= clock() && alive()) {
            this.screen?.video.captureFrame(new VideoFrame(queue.shift(), VIDEO_W, VIDEO_H, VideoBufferType.I420));
            sent++;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      let frame = new Uint8Array(VIDEO_FRAME_BYTES);
      let filled = 0;
      for await (const chunk of decoder.video) {
        if (!alive()) break;
        received += chunk.length;
        let off = 0;
        while (off < chunk.length) {
          const n = Math.min(VIDEO_FRAME_BYTES - filled, chunk.length - off);
          frame.set(chunk.subarray(off, off + n), filled);
          filled += n;
          off += n;
          if (filled === VIDEO_FRAME_BYTES) {
            queue.push(frame);
            frame = new Uint8Array(VIDEO_FRAME_BYTES);
            filled = 0;
          }
        }
        // segurança: se o vídeo disparar muito na frente do áudio, espera (evita encher a memória)
        while (queue.length > VIDEO_FPS * 3 && alive()) await new Promise((r) => setTimeout(r, 20));
      }
      readDone = true;
      await sender;
    };

    let completed = false; // chegou ao fim sem ninguém pular, parar ou pausar
    try {
      await Promise.all([pumpAudio(), pumpVideo()]);
      completed = alive();
    } catch (err) {
      if (alive()) throw err; // erro de verdade; se pulou/parou no meio, ignora
    } finally {
      decoder.kill();
      if (this.decoder === decoder) this.decoder = null;
    }
    if (completed && !received) throw new Error('o YouTube não entregou o áudio/vídeo (veja o log do bot)');
    return completed;
  }

  skip() {
    this.paused = false;
    this.decoder?.kill();
    this.decoder = null;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  seek(seconds) {
    this.seekTo = Math.max(0, seconds);
    this.decoder?.kill();
  }

  async stop() {
    this.queue = [];
    this.current = null;
    this.skip();
    this.clearIdle();
    clearTimeout(this.aloneTimer);
    if (player === this) player = null;
    await this.stopScreen();
    socket.emit('voice:leave');
    try {
      await this.room?.disconnect();
    } catch {
      // já desconectado
    }
    console.log(`Saí da sala ${this.voiceChannelId}`);
  }

  scheduleIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      void say(this.textChannelId, '👋 Fila vazia, saindo da sala.');
      void this.stop();
    }, LEAVE_WHEN_IDLE_MS);
  }

  clearIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  checkAlone() {
    if (peopleIn(this.voiceChannelId) > 0) {
      clearTimeout(this.aloneTimer);
      this.aloneTimer = null;
    } else if (!this.aloneTimer) {
      this.aloneTimer = setTimeout(() => {
        if (peopleIn(this.voiceChannelId) === 0) void this.stop();
      }, LEAVE_WHEN_ALONE_MS);
    }
  }
}

let player = null;

// ---------- comandos ----------

const HELP = [
  `**Comandos do ${BOT_NAME}:**`,
  `\`${PREFIX}play <link ou nome>\` toca a música (só áudio)`,
  `\`${PREFIX}assistir <link ou nome>\` transmite o vídeo para a sala assistir junto`,
  `\`${PREFIX}skip\` pula · \`${PREFIX}pause\` / \`${PREFIX}resume\` pausa e continua · \`${PREFIX}pular 1:30\` vai para um ponto`,
  `\`${PREFIX}stop\` para tudo e sai · \`${PREFIX}fila\` mostra a fila · \`${PREFIX}volume <0-100>\``,
  'Entre numa sala de voz antes de pedir.',
].join('\n');

const PLAY_CMDS = ['play', 'p'];
const WATCH_CMDS = ['assistir', 'video', 'vídeo', 'watch'];
const KNOWN = [...PLAY_CMDS, ...WATCH_CMDS, 'skip', 'pause', 'resume', 'stop', 'fila', 'queue', 'volume', 'vol', 'pular', 'seek'];

async function handle(msg) {
  const text = msg.content.trim();
  if (!text.startsWith(PREFIX)) return;
  const [rawCmd, ...rest] = text.slice(PREFIX.length).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ').trim();
  const who = msg.author.displayName || msg.author.username;

  if (cmd === 'ajuda' || cmd === 'help') return say(msg.channelId, HELP);
  if (!KNOWN.includes(cmd)) return;

  const voiceId = voiceChannelOf(msg.author.id);

  if (PLAY_CMDS.includes(cmd) || WATCH_CMDS.includes(cmd)) {
    const video = WATCH_CMDS.includes(cmd);
    if (!arg) return say(msg.channelId, `Use \`${PREFIX}${cmd} <link ou nome>\`.`);
    if (!voiceId) return say(msg.channelId, `${who}, entra numa sala de voz primeiro que eu vou atrás. 🎧`);
    let item;
    try {
      item = { ...(await resolveTrack(arg)), requester: who, video };
    } catch (err) {
      return say(msg.channelId, `⚠️ Não achei isso: ${err.message}`);
    }
    if (player && player.voiceChannelId !== voiceId) {
      if (player.current || player.queue.length) return say(msg.channelId, `🎧 Já estou tocando em outra sala. Use ${PREFIX}stop lá ou entre na mesma sala.`);
      await player.stop();
    }
    if (!player) {
      player = new Player(voiceId, msg.channelId);
      try {
        await player.connect();
      } catch (err) {
        console.error(err);
        await player.stop();
        return say(msg.channelId, `⚠️ Não consegui entrar na sala de voz: ${err.message}`);
      }
    }
    player.textChannelId = msg.channelId;
    if (player.current) await say(msg.channelId, `➕ Na fila (#${player.queue.length + 1}): ${video ? '📺 ' : ''}**${item.title}**`);
    return player.enqueue(item);
  }

  if (!player || player.voiceChannelId !== voiceId) return say(msg.channelId, voiceId ? 'Não estou tocando nada na sua sala.' : 'Entra na sala de voz onde estou tocando para usar esse comando.');

  if (cmd === 'skip') {
    if (!player.current) return say(msg.channelId, 'Nada tocando.');
    await say(msg.channelId, `⏭️ Pulando **${player.current.title}**`);
    return player.skip();
  }
  if (cmd === 'pause') {
    if (!player.current) return say(msg.channelId, 'Nada tocando.');
    player.pause();
    return say(msg.channelId, `⏸️ Pausado em ${formatDuration(player.position)}.`);
  }
  if (cmd === 'resume') {
    player.resume();
    return say(msg.channelId, '▶️ Continuando.');
  }
  if (cmd === 'pular' || cmd === 'seek') {
    if (!player.current) return say(msg.channelId, 'Nada tocando.');
    const t = parseTime(arg);
    if (t === null) return say(msg.channelId, `Use \`${PREFIX}pular 1:30\` (minutos:segundos) ou \`${PREFIX}pular 90\` (segundos).`);
    if (player.current.duration && t >= player.current.duration) return say(msg.channelId, `Esse vídeo só tem ${formatDuration(player.current.duration)}.`);
    player.seek(t);
    return say(msg.channelId, `⏩ Indo para ${formatDuration(t)} (pode levar alguns segundos).`);
  }
  if (cmd === 'stop') {
    await say(msg.channelId, '⏹️ Parei e saí da sala.');
    return player.stop();
  }
  if (cmd === 'fila' || cmd === 'queue') {
    const lines = [];
    if (player.current) {
      const cur = player.current;
      lines.push(`${cur.video ? '📺' : '🎵'} Agora: **${cur.title}** ${formatDuration(player.position)}${cur.duration ? ` / ${formatDuration(cur.duration)}` : ''}${player.paused ? ' (pausado)' : ''}`);
    }
    player.queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.video ? '📺 ' : ''}${t.title} — ${t.requester}`));
    if (player.queue.length > 10) lines.push(`...e mais ${player.queue.length - 10}`);
    return say(msg.channelId, lines.length ? lines.join('\n') : 'Fila vazia.');
  }
  if (cmd === 'volume' || cmd === 'vol') {
    const v = Number(arg);
    if (!arg || Number.isNaN(v)) return say(msg.channelId, `🔊 Volume: ${Math.round(player.volume * 100)}`);
    player.volume = Math.min(100, Math.max(0, v)) / 100;
    return say(msg.channelId, `🔊 Volume: ${Math.round(player.volume * 100)}`);
  }
}

// ---------- conexão com o Concord ----------

const me = await api('GET', '/me');
const socket = io(CONCORD_URL, { auth: { token: CONCORD_TOKEN }, transports: ['websocket'] });

socket.on('connect', () => {
  console.log(`Conectado ao Concord como ${me.displayName ?? me.username} (@${me.username})`);
  // a conexão caiu e voltou no meio de uma música: registra o bot na sala de novo
  if (player) {
    socket.emit('voice:join', { channelId: player.voiceChannelId }, () => {
      if (player?.screen) socket.emit('voice:update', { streaming: true });
    });
  }
});
socket.on('connect_error', (err) => console.error('Não foi possível conectar ao Concord:', err.message));

socket.on('voice:states', ({ serverId, states }) => {
  voiceStates.set(serverId, states);
  player?.checkAlone();
});

socket.on('message:new', (msg) => {
  if (msg.author.id === me.id || msg.author.bot) return;
  handle(msg).catch((err) => console.error('Erro no comando:', err));
});

async function shutdown() {
  await player?.stop();
  socket.close();
  await dispose();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
