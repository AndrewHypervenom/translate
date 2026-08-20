require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY no está configurada. Agrega tu clave al archivo .env');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Dos canales WebSocket sobre el mismo servidor HTTP (ruteo manual en 'upgrade'):
//   /ws    → traducción 1-a-1: captura el audio de una pestaña y lo traduce a
//            TU idioma. Cada participante lo usa por su cuenta, así que la
//            conversación ya es de doble vía sin coordinación entre ellos.
//   /room  → sala de N participantes: todos hablan y todos escuchan, cada uno
//            en su propio idioma. Bidireccional de verdad.
const wss = new WebSocketServer({ noServer: true });
const roomWss = new WebSocketServer({ noServer: true });

const REALTIME_URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';

// ════════════════════════════════════════════════════════════════════════════
// ANTI-ALUCINACIÓN
// ════════════════════════════════════════════════════════════════════════════
// En conversaciones largas el modelo arrastra contexto y empieza a "rellenar":
// repite grupos de palabras o inventa frases que nadie dijo, sobre todo cuando
// recibe silencio o ruido. Tres defensas, de más barata a más agresiva:
//   1. Solo se le manda audio con voz (el VAD vive en el cliente).
//   2. Se descarta la salida que tenga pinta de invento.
//   3. Se recicla la sesión en un hueco de silencio → borra el contexto.

// Frases que Whisper "oye" cuando no hay voz: créditos de subtítulos, cierres
// de vídeo de YouTube… Solo se descartan si NO hubo transcripción del original,
// es decir, si nadie dijo nada.
const SILENCE_ARTIFACTS = [
  /subt[ií]tul/i,
  /legendas?\s+(pela|por)\b/i,
  /amara\.org/i,
  /subscribe|suscr[ií]b|inscreva-se/i,
  /gracias por (ver|mirar)|thanks? for watching|obrigado por assistir/i,
  /^[\s♪♫♬~\-–—.·,!¡?¿]*$/,
];

function normalizeForCompare(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSilenceArtifact(text) {
  return SILENCE_ARTIFACTS.some((re) => re.test(text));
}

// Bucle de repetición: el modelo se engancha y repite el mismo grupo de
// palabras una y otra vez ("gracias, gracias, gracias…"). Es la firma
// inconfundible de una alucinación, no de alguien hablando.
function hasRepetitionLoop(text) {
  const words = normalizeForCompare(text).split(' ').filter(Boolean);
  if (words.length < 6) return false;

  const sameBlock = (a, b, n) => {
    for (let k = 0; k < n; k++) if (words[a + k] !== words[b + k]) return false;
    return true;
  };

  for (let n = 1; n <= 6; n++) {
    const limit = n === 1 ? 6 : 4; // una palabra suelta puede repetirse más sin ser rara
    for (let start = 0; start + n * limit <= words.length; start++) {
      let reps = 1;
      for (let i = start + n; i + n <= words.length && sameBlock(start, i, n); i += n) reps++;
      if (reps >= limit) return true;
    }
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// CONTROL DE ACCESO Y DE GASTO
// ════════════════════════════════════════════════════════════════════════════
// Todo el audio que entra aquí se reenvía a OpenAI, y eso cuesta dinero. Sin
// estas dos barreras, cualquiera con la URL podría abrir salas sin parar:
//   · Solo el administrador crea salas. Quien tenga el enlace únicamente puede
//     UNIRSE a una sala que ya exista, y solo mientras siga abierta.
//   · Hay un tope de minutos al día. Al alcanzarlo se deja de traducir, se
//     avisa a todo el mundo y no se gasta un céntimo más hasta el día siguiente.

const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(12).toString('hex');
const ADMIN_KEY_IS_TEMPORARY = !process.env.ADMIN_KEY;

// Minutos de audio traducido al día. Ojo: si en una sala hablas 1 minuto y hay
// gente escuchando en 2 idiomas distintos, son 2 minutos de traducción.
const DAILY_LIMIT_MINUTES = Number(process.env.DAILY_LIMIT_MINUTES || 120);
const ROOM_DEFAULT_MINUTES = Number(process.env.ROOM_DEFAULT_MINUTES || 60);
const ROOM_DEFAULT_MAX_PEERS = Number(process.env.ROOM_MAX_PEERS || 8);
const MAX_OPEN_ROOMS = Number(process.env.MAX_OPEN_ROOMS || 20);

// Cuántos ms de audio representa un trozo en base64 de PCM16 mono a 24 kHz.
function audioMsFromBase64(base64) {
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes / 2 / (SAMPLE_RATE / 1000);
}

const billing = {
  day: new Date().toISOString().slice(0, 10),
  usedMs: 0,

  rollOver() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      console.log(`[Gasto] Nuevo día (${today}): contador a cero`);
      this.day = today;
      this.usedMs = 0;
      for (const room of rooms.values()) room.usedMs = 0;
    }
  },

  limitMs() { return DAILY_LIMIT_MINUTES * 60 * 1000; },
  remainingMs() { this.rollOver(); return Math.max(0, this.limitMs() - this.usedMs); },
  exhausted() { return this.remainingMs() <= 0; },

  // Devuelve false si ya no queda presupuesto: el audio no se envía.
  charge(ms, room) {
    this.rollOver();
    if (this.usedMs + ms > this.limitMs()) return false;
    this.usedMs += ms;
    if (room) room.usedMs += ms;
    return true;
  },
};

// ════════════════════════════════════════════════════════════════════════════
// SESIÓN DE TRADUCCIÓN
// ════════════════════════════════════════════════════════════════════════════

const SESSION_MAX_MS = 8 * 60 * 1000; // vida máxima antes de reciclar por contexto
const SESSION_IDLE_MS = 30 * 1000;    // sin audio → dormir la sesión (y no pagarla)
const SILENCE_SETTLE_MS = 1200;       // silencio mínimo para reciclar sin cortar a nadie
const MAX_QUEUED_CHUNKS = 120;        // ~10 s de audio retenido mientras (re)conecta
const MAX_RECONNECT_ATTEMPTS = 5;

// El modelo cierra la frase cuando su VAD oye silencio. Si el audio termina en
// seco —que es justo lo que pasa con un VAD en el cliente, que deja de enviar—
// se queda a medias y la última parte de la frase NUNCA se traduce. Al terminar
// de hablar le damos una cola de silencio real para que cierre el turno.
const SAMPLE_RATE = 24000;      // PCM16 mono, el formato que espera el modelo
const SILENCE_TAIL_MS = 2500;
const SILENCE_CHUNK_MS = 100;
const SILENCE_CHUNK = Buffer.alloc((SAMPLE_RATE / 1000) * SILENCE_CHUNK_MS * 2).toString('base64');

// Esta API no emite `output_transcript.done`: la frase se cierra cuando dejan
// de llegar deltas. Con la cola de silencio, eso ocurre ~1 s tras terminar de
// hablar, así que el temporizador puede ser corto sin partir frases por la mitad.
const PHRASE_SAFETY_MS = 2500;

// Todas las sesiones vivas, para el tick de mantenimiento.
const liveSessions = new Set();

class TranslatorSession {
  constructor(targetLang, handlers = {}) {
    this.targetLang = targetLang;
    this.on = handlers;
    this.label = handlers.label || targetLang;
    this.room = handlers.room || null; // para imputarle el gasto, si viene de una sala
    this.outOfBudget = false;

    this.ws = null;
    this.ready = false;
    this.disposed = false;
    this.queue = [];

    this.openedAt = 0;
    this.lastAudioAt = 0;

    this.phraseActive = false;
    this.itemId = null;
    this.phraseCount = 0;
    this.outputBuf = '';
    this.inputBuf = '';
    this.inputFinal = '';
    this.gapTimer = null;

    this.pendingRecycle = false;
    this.lastFinalNorm = '';
    this.repeatStreak = 0;

    this.tailTimer = null;
    this.tailSent = 0;

    this.reconnectAttempts = 0;
    this.reconnectTimer = null;

    liveSessions.add(this);
  }

  // ── Frases ─────────────────────────────────────────────────────────────────

  beginPhrase(withOutput) {
    if (!this.phraseActive) {
      this.phraseActive = true;
      this.on.onPhraseStart?.();
    }
    if (withOutput && !this.itemId) this.itemId = `p-${++this.phraseCount}`;
    return this.itemId;
  }

  armSafetyTimer() {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => this.finishPhrase(), PHRASE_SAFETY_MS);
  }

  resetPhrase() {
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    this.phraseActive = false;
    this.itemId = null;
    this.outputBuf = '';
    this.inputBuf = '';
    this.inputFinal = '';
  }

  // Devuelve el motivo por el que la traducción parece inventada, o null.
  hallucinationReason(original, translation) {
    if (!translation) return null;
    if (hasRepetitionLoop(translation)) return 'bucle de repetición';
    if (!original && isSilenceArtifact(translation)) return 'texto inventado sobre silencio';

    const norm = normalizeForCompare(translation);
    if (norm && norm === this.lastFinalNorm && norm.split(' ').length >= 3) {
      this.repeatStreak++;
      if (this.repeatStreak >= 3) return 'misma frase repetida 3 veces';
    } else {
      this.lastFinalNorm = norm;
      this.repeatStreak = 1;
    }
    return null;
  }

  finishPhrase() {
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    if (!this.phraseActive) return;

    const itemId = this.itemId;
    const original = (this.inputFinal || this.inputBuf).trim();
    let translation = this.outputBuf.trim();

    this.phraseActive = false;
    this.itemId = null;
    this.outputBuf = '';
    this.inputBuf = '';
    this.inputFinal = '';

    const reason = this.hallucinationReason(original, translation);
    if (reason) {
      console.warn(`[${this.label}] Descartado por ${reason}: "${translation.slice(0, 90)}"`);
      // El contexto ya está contaminado: reciclar en cuanto haya silencio.
      this.pendingRecycle = true;
      translation = '';
    }

    this.on.onPhraseEnd?.({ itemId, original, translation, dropped: !!reason });
  }

  // ── Conexión con OpenAI ────────────────────────────────────────────────────

  connect() {
    if (this.disposed || this.ws) return;
    this.ready = false;

    const sock = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    this.ws = sock;
    this.openedAt = Date.now();

    sock.on('open', () => {
      if (sock !== this.ws) { sock.close(); return; }
      sock.send(JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            input: {
              transcription: { model: 'gpt-realtime-whisper' },
              // Micrófono cercano: limpia ruido de fondo sin cortar la voz. El
              // ruido es justo lo que dispara las alucinaciones.
              noise_reduction: { type: 'near_field' },
            },
            output: { language: this.targetLang },
          },
        },
      }));
      this.ready = true;
      this.openedAt = Date.now();
      this.reconnectAttempts = 0;
      this.flushQueue();
      this.on.onReady?.();
    });

    sock.on('message', (raw) => {
      if (sock !== this.ws) return;
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }

      switch (event.type) {
        case 'session.output_audio.delta': {
          const id = this.beginPhrase(true);
          this.armSafetyTimer();
          this.on.onAudioDelta?.(event.delta, id);
          break;
        }

        case 'session.output_transcript.delta': {
          const id = this.beginPhrase(true);
          this.outputBuf += event.delta || '';
          // El texto en streaming también mantiene viva la frase, no solo el audio.
          this.armSafetyTimer();
          this.on.onOutputDelta?.(event.delta || '', id, this.outputBuf);
          break;
        }

        case 'session.output_transcript.done': {
          const text = (event.transcript || event.text || '').trim();
          if (text) this.outputBuf = text;
          this.finishPhrase();
          break;
        }

        case 'session.input_transcript.delta': {
          this.beginPhrase(false);
          this.inputBuf += event.delta || '';
          this.on.onInputDelta?.(event.delta || '', this.inputBuf);
          break;
        }

        case 'session.input_transcript.done': {
          const text = (event.transcript || event.text || '').trim();
          if (text) {
            this.inputFinal = text;
            this.on.onInputFinal?.(text);
          }
          break;
        }

        case 'session.closed':
          this.finishPhrase();
          this.ws = null;
          this.ready = false;
          sock.close();
          // OpenAI corta la sesión (p. ej. por duración): abrir otra.
          if (!this.disposed) this.connect();
          break;

        case 'error': {
          const msg = event.error?.message || JSON.stringify(event.error) || 'Error de OpenAI';
          console.error(`[${this.label}] ${msg}`);
          this.on.onError?.(msg);
          break;
        }
      }
    });

    sock.on('error', (err) => {
      console.error(`[${this.label}] WS error: ${err?.message || String(err)}`);
    });

    sock.on('close', (code, reason) => {
      if (sock !== this.ws) return; // socket viejo, ya reemplazado a propósito
      this.ws = null;
      this.ready = false;
      this.finishPhrase();
      const detail = reason?.length ? ` — ${reason.toString()}` : '';
      console.log(`[${this.label}] Sesión cerrada: code=${code}${detail}`);
      if (!this.disposed && code !== 1000 && code !== 1001) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.on.onError?.('No se pudo restablecer la conexión con OpenAI. Detén y vuelve a iniciar la traducción.');
      return;
    }
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts++;
    console.log(`[${this.label}] Reintentando en ${delay} ms (${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  flushQueue() {
    while (this.queue.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: this.queue.shift() }));
    }
  }

  pushAudio(base64) {
    // Se cobra aquí, que es el único punto por el que sale audio hacia OpenAI.
    if (!billing.charge(audioMsFromBase64(base64), this.room)) {
      if (!this.outOfBudget) {
        this.outOfBudget = true;
        console.warn(`[${this.label}] Presupuesto diario agotado: se deja de traducir`);
        this.on.onBudgetExhausted?.();
      }
      return;
    }
    this.lastAudioAt = Date.now();
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: base64 }));
    } else if (this.queue.length < MAX_QUEUED_CHUNKS) {
      // Retener el audio mientras (re)conecta para no perder el inicio de la frase.
      this.queue.push(base64);
    }
  }

  appendAudio(base64) {
    if (this.disposed || !base64) return;
    this.cancelSilenceTail(); // volvió a hablar: la cola ya no toca
    // La sesión pudo dormirse por inactividad: despertarla al primer audio.
    if (!this.ws && !this.reconnectTimer) this.connect();
    this.pushAudio(base64);
  }

  cancelSilenceTail() {
    if (this.tailTimer) { clearTimeout(this.tailTimer); this.tailTimer = null; }
    this.tailSent = 0;
  }

  // Fin de turno: se gotea silencio en tiempo real (no de golpe) para que la
  // línea temporal del modelo siga cuadrando si la persona vuelve a hablar.
  endTurn() {
    if (this.disposed || this.tailTimer || !this.ws) return;
    this.tailSent = 0;
    const step = () => {
      this.tailTimer = null;
      if (this.disposed || this.tailSent >= SILENCE_TAIL_MS) return;
      this.pushAudio(SILENCE_CHUNK);
      this.tailSent += SILENCE_CHUNK_MS;
      this.tailTimer = setTimeout(step, SILENCE_CHUNK_MS);
    };
    step();
  }

  setTargetLang(lang) {
    if (!lang || lang === this.targetLang) return;
    this.targetLang = lang;
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: { audio: { output: { language: lang } } },
      }));
    }
  }

  // ── Mantenimiento: reciclado y siesta ──────────────────────────────────────

  closeSocket() {
    const old = this.ws;
    this.ws = null;
    this.ready = false;
    this.queue = [];
    // Un socket nuevo ya trae el contexto limpio: no hay nada que reciclar.
    this.pendingRecycle = false;
    this.cancelSilenceTail();
    this.resetPhrase();
    if (!old) return;
    if (old.readyState === WebSocket.OPEN) {
      try { old.send(JSON.stringify({ type: 'session.close' })); } catch { /* ya se está cerrando */ }
    }
    // Margen para que llegue el 'session.closed' antes del cierre duro.
    setTimeout(() => old.close(), 300);
  }

  recycle(reason) {
    console.log(`[${this.label}] Reciclando sesión: ${reason}`);
    this.pendingRecycle = false;
    this.lastFinalNorm = '';
    this.repeatStreak = 0;
    this.closeSocket();
    this.connect();
  }

  sleep() {
    console.log(`[${this.label}] Sesión en pausa por inactividad`);
    this.closeSocket();
  }

  // Solo actúa en huecos de silencio, así el corte nunca parte una frase.
  tick() {
    if (this.disposed || !this.ws || this.phraseActive) return;
    const now = Date.now();
    const silentFor = now - (this.lastAudioAt || this.openedAt);
    if (silentFor < SILENCE_SETTLE_MS) return;

    if (this.pendingRecycle) return this.recycle('salida sospechosa de alucinación');
    if (now - this.openedAt > SESSION_MAX_MS) return this.recycle('límite de contexto por duración');
    if (silentFor > SESSION_IDLE_MS) this.sleep();
  }

  dispose() {
    this.disposed = true;
    liveSessions.delete(this);
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.closeSocket();
  }
}

setInterval(() => {
  for (const session of liveSessions) {
    try { session.tick(); } catch (err) { console.error('[tick]', err); }
  }
}, 1000);

// ════════════════════════════════════════════════════════════════════════════
// /ws — traducción 1-a-1 (captura de pestaña)
// ════════════════════════════════════════════════════════════════════════════
// Cada participante corre esto en su propio navegador con SU idioma de destino,
// así que la conversación fluye en ambos sentidos sin que nadie coordine nada.

wss.on('connection', (clientWs) => {
  let config = { targetLang: 'es' };
  let session = null;

  const send = (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(data));
  };

  function openSession() {
    session?.dispose();
    session = new TranslatorSession(config.targetLang, {
      label: `ws→${config.targetLang}`,
      onReady: () => send({ type: 'ready' }),
      onPhraseStart: () => send({ type: 'input_audio_buffer.committed' }),
      onInputDelta: (delta) => send({ type: 'conversation.item.input_audio_transcription.delta', delta }),
      onInputFinal: (text) => send({ type: 'source_transcript_final', text }),
      onAudioDelta: (audio, itemId) => send({ type: 'tts_chunk', item_id: itemId, audio }),
      onOutputDelta: (delta, itemId) => send({ type: 'translation_partial', item_id: itemId, delta }),
      onPhraseEnd: ({ itemId, original, translation }) => {
        // Siempre ocultar el "EN VIVO" del overlay, aunque no hubiera traducción.
        send({ type: 'conversation.item.input_audio_transcription.completed', transcript: original });
        if (!itemId) return;
        send({ type: 'tts_done', item_id: itemId });
        if (translation) {
          send({ type: 'translation', item_id: itemId, original, translation });
          console.log(`[→] ${original || '(sin transcripción)'}\n[←] ${translation}\n`);
        }
      },
      onError: (message) => send({ type: 'error', message }),
    });
    session.connect();
  }

  clientWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'set_config':
        if (!msg.config) break;
        config = { ...config, ...msg.config };
        if (msg.config.targetLang) session?.setTargetLang(msg.config.targetLang);
        break;

      case 'start':
        openSession();
        break;

      case 'stop':
        session?.dispose();
        session = null;
        break;

      case 'audio_chunk':
        session?.appendAudio(msg.audio);
        break;

      case 'speech_end':
        session?.endTurn();
        break;
    }
  });

  clientWs.on('close', () => {
    session?.dispose();
    session = null;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /room — sala bidireccional de N participantes
// ════════════════════════════════════════════════════════════════════════════
// Todos hablan y todos escuchan. Cuando alguien habla, se abre una sesión de
// traducción por cada idioma distinto que escuchen LOS DEMÁS, y su salida va
// solo a esos participantes: nadie recibe nunca su propia traducción.

const MAX_TARGET_LANGS_PER_SPEAKER = 6; // tope de coste por hablante

const rooms = new Map();

// Códigos cortos, legibles por teléfono y no adivinables. Sin vocales, para que
// no salgan palabras por accidente, y sin caracteres que se confundan (0/O, 1/l).
const CODE_ALPHABET = 'bcdfghjkmnpqrstvwxyz23456789';
function randomRoomCode(length = 7) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

// Debe coincidir con normalizeRoomId() de room.js, o "mi equipo" escrito en la
// página y "mi equipo" puesto a mano en la URL acabarían en salas distintas.
function normalizeRoomId(raw) {
  const id = String(raw || '').trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
  return id || 'general';
}

class Room {
  constructor(id, { label = '', minutes = ROOM_DEFAULT_MINUTES, maxPeers = ROOM_DEFAULT_MAX_PEERS } = {}) {
    this.id = id;
    this.label = label;
    this.peers = new Map();
    this.createdAt = Date.now();
    this.expiresAt = Date.now() + minutes * 60 * 1000;
    this.maxPeers = maxPeers;
    this.usedMs = 0;
  }

  get expired() { return Date.now() > this.expiresAt; }

  // Cierra la sala y echa a quien quede dentro.
  close(reason) {
    for (const peer of this.peers.values()) {
      peer.send({ type: 'error', message: reason });
      peer.dispose();
      peer.ws.close();
    }
    this.peers.clear();
    rooms.delete(this.id);
    console.log(`[${this.id}] Sala cerrada: ${reason}`);
  }

  summary() {
    return {
      code: this.id,
      label: this.label,
      peers: this.roster(),
      peerCount: this.peers.size,
      maxPeers: this.maxPeers,
      minutesUsed: +(this.usedMs / 60000).toFixed(2),
      minutesLeft: Math.max(0, Math.round((this.expiresAt - Date.now()) / 60000)),
      expired: this.expired,
    };
  }

  // Idiomas a los que hay que traducir a este hablante: los que escuchan los
  // demás, saltando el suyo propio (esos ya lo entienden tal cual).
  targetLangsFor(speaker) {
    const langs = new Set();
    for (const peer of this.peers.values()) {
      if (peer === speaker) continue;
      if (peer.listenLang === speaker.speakLang) continue;
      langs.add(peer.listenLang);
      if (langs.size >= MAX_TARGET_LANGS_PER_SPEAKER) break;
    }
    return langs;
  }

  // Entrega a quienes escuchan en `lang`, nunca al propio hablante.
  sendToListeners(lang, speaker, data) {
    for (const peer of this.peers.values()) {
      if (peer === speaker || peer.listenLang !== lang) continue;
      peer.send(data);
    }
  }

  broadcast(data) {
    for (const peer of this.peers.values()) peer.send(data);
  }

  roster() {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      speakLang: p.speakLang,
      listenLang: p.listenLang,
    }));
  }
}

class RoomPeer {
  constructor(ws, room, { name, speakLang, listenLang }) {
    this.ws = ws;
    this.room = room;
    this.id = crypto.randomUUID().slice(0, 8);
    this.name = name;
    this.speakLang = speakLang;
    this.listenLang = listenLang;
    this.translators = new Map(); // targetLang -> TranslatorSession
  }

  send(data) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  // El primer traductor es el que devuelve al hablante su propia transcripción
  // (todos transcriben lo mismo; no tiene sentido duplicarla).
  isPrimary(translator) {
    return this.translators.values().next().value === translator;
  }

  ensureTranslator(lang) {
    const existing = this.translators.get(lang);
    if (existing) return existing;

    let translator;
    translator = new TranslatorSession(lang, {
      label: `${this.room.id}/${this.name}→${lang}`,
      room: this.room, // para imputar los minutos a esta sala
      onBudgetExhausted: () => this.room.broadcast({
        type: 'error',
        message: 'Se alcanzó el límite de uso de hoy. La traducción se ha detenido.',
      }),
      onAudioDelta: (chunk) =>
        this.room.sendToListeners(lang, this, { type: 'audio', chunk, from: this.id }),
      onOutputDelta: (_delta, _itemId, full) =>
        this.room.sendToListeners(lang, this, { type: 'partial', text: full, from: this.id, name: this.name }),
      onPhraseEnd: ({ original, translation }) => {
        if (translation) {
          this.room.sendToListeners(lang, this, { type: 'final', text: translation, from: this.id, name: this.name });
        }
        if (this.isPrimary(translator)) this.send({ type: 'self_final', text: original });
      },
      onInputDelta: (_delta, full) => {
        if (this.isPrimary(translator)) this.send({ type: 'self_partial', text: full });
      },
      onError: (message) => this.send({ type: 'error', message }),
    });

    this.translators.set(lang, translator);
    translator.connect();
    return translator;
  }

  // Ajusta las sesiones abiertas a quién hay ahora mismo en la sala.
  syncTranslators() {
    const targets = this.room.targetLangsFor(this);
    for (const [lang, translator] of this.translators) {
      if (!targets.has(lang)) {
        translator.dispose();
        this.translators.delete(lang);
      }
    }
    for (const lang of targets) this.ensureTranslator(lang);
  }

  appendAudio(base64) {
    for (const translator of this.translators.values()) translator.appendAudio(base64);
  }

  dispose() {
    for (const translator of this.translators.values()) translator.dispose();
    this.translators.clear();
  }
}

roomWss.on('connection', (ws, req) => {
  let peer = null;

  const send = (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  function reject(message) {
    send({ type: 'error', message });
    ws.close();
  }

  function join(msg) {
    const roomId = normalizeRoomId(msg.room || new URL(req.url, 'http://x').searchParams.get('room'));

    // Las salas NO se crean al conectar: solo las abre el administrador. Así
    // nadie puede ponerse a gastar por su cuenta con solo inventarse un código.
    const room = rooms.get(roomId);
    if (!room) {
      return reject('Esta sala no existe o ya se cerró. Pide un enlace nuevo a quien te invitó.');
    }
    if (room.expired) {
      room.close('La sala ha caducado.');
      return reject('Esta sala ha caducado. Pide un enlace nuevo a quien te invitó.');
    }
    if (room.peers.size >= room.maxPeers) {
      return reject(`La sala está llena (máximo ${room.maxPeers} personas).`);
    }
    if (billing.exhausted()) {
      return reject('Se alcanzó el límite de uso de hoy. Vuelve a intentarlo mañana.');
    }

    peer = new RoomPeer(ws, room, {
      name: String(msg.name || 'Invitado').slice(0, 40),
      speakLang: msg.speakLang || 'es',
      listenLang: msg.listenLang || 'es',
    });
    room.peers.set(peer.id, peer);
    console.log(`[${roomId}] + ${peer.name} (habla ${peer.speakLang}, escucha ${peer.listenLang}) — ${room.peers.size} en sala`);

    send({ type: 'joined', peerId: peer.id, room: roomId, peers: room.roster() });
    room.broadcast({ type: 'peers', peers: room.roster() });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      if (!peer) join(msg);
      return;
    }
    if (!peer) return; // todo lo demás exige haber entrado a la sala

    switch (msg.type) {
      case 'set_langs':
        if (msg.speakLang) peer.speakLang = msg.speakLang;
        if (msg.listenLang) peer.listenLang = msg.listenLang;
        peer.room.broadcast({ type: 'peers', peers: peer.room.roster() });
        break;

      case 'speech_start':
        // Abrir aquí (y no al entrar) evita pagar sesiones de quien solo escucha.
        peer.syncTranslators();
        // Sin esto, quien deja los idiomas por defecto habla al vacío y cree
        // que la extensión está rota: nadie necesita traducción de lo que dice.
        if (peer.translators.size === 0) {
          peer.send({
            type: 'notice',
            message: peer.room.peers.size <= 1
              ? 'Eres la única persona en la sala. Comparte el código para que alguien entre.'
              : `Nadie necesita traducción: los demás ya escuchan en ${peer.speakLang}. Cambia tu idioma o pídeles que cambien el suyo.`,
          });
        }
        break;

      case 'audio_chunk':
        // Red de seguridad por si llega audio sin un 'speech_start' previo.
        if (peer.translators.size === 0) peer.syncTranslators();
        peer.appendAudio(msg.audio);
        break;

      case 'speech_end':
        // Cola de silencio para que el modelo cierre el turno y no se coma el
        // final de la frase. Las sesiones se duermen solas más tarde.
        for (const translator of peer.translators.values()) translator.endTurn();
        break;
    }
  });

  ws.on('close', () => {
    if (!peer) return;
    const room = peer.room;
    peer.dispose();
    room.peers.delete(peer.id);
    console.log(`[${room.id}] - ${peer.name} — ${room.peers.size} en sala`);
    // La sala NO se borra al quedarse vacía: sigue abierta hasta que caduque o
    // el administrador la cierre, para poder volver a entrar con el mismo enlace.
    room.broadcast({ type: 'peers', peers: room.roster() });
    peer = null;
  });
});

// ── HTTP ──────────────────────────────────────────────────────────────────────
// La sala es una web pública: se comparte por enlace y se entra desde cualquier
// navegador, también en el móvil. Instalar la extensión solo hace falta para el
// otro modo, el de traducir el audio de una pestaña.

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// /sala y /sala/<código> sirven la misma página; el código lo lee del path.
app.get(['/sala', '/sala/:code'], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'sala.html'));
});

// ── Administración ────────────────────────────────────────────────────────────
// Solo desde aquí se abren salas. La página /admin es estática; lo que está
// protegido es la API, que es la que puede gastar dinero.

app.use(express.json());

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.key;
  // Comparación en tiempo constante para no filtrar la clave a base de reintentos.
  // Se comparan los BYTES, no la longitud del texto: con acentos o emojis dos
  // cadenas del mismo largo pueden ocupar distinto, y timingSafeEqual reventaría.
  const given = Buffer.from(String(key ?? ''), 'utf8');
  const expected = Buffer.from(ADMIN_KEY, 'utf8');
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return res.status(401).json({ error: 'Clave de administrador incorrecta.' });
  next();
}

app.get('/admin/api/state', requireAdmin, (_req, res) => {
  sweepRooms();
  res.json({
    rooms: [...rooms.values()].map((r) => r.summary()),
    budget: {
      limitMinutes: DAILY_LIMIT_MINUTES,
      usedMinutes: +(billing.usedMs / 60000).toFixed(2),
      remainingMinutes: +(billing.remainingMs() / 60000).toFixed(2),
      day: billing.day,
    },
    defaults: { minutes: ROOM_DEFAULT_MINUTES, maxPeers: ROOM_DEFAULT_MAX_PEERS },
  });
});

app.post('/admin/api/rooms', requireAdmin, (req, res) => {
  sweepRooms();
  if (rooms.size >= MAX_OPEN_ROOMS) {
    return res.status(429).json({ error: `Ya hay ${MAX_OPEN_ROOMS} salas abiertas. Cierra alguna antes de crear otra.` });
  }
  if (billing.exhausted()) {
    return res.status(429).json({ error: 'Se alcanzó el límite de minutos de hoy.' });
  }

  const code = req.body?.code ? normalizeRoomId(req.body.code) : randomRoomCode();
  if (rooms.has(code)) {
    return res.status(409).json({ error: `Ya existe una sala con el código "${code}".` });
  }

  const minutes = Math.min(480, Math.max(5, Number(req.body?.minutes) || ROOM_DEFAULT_MINUTES));
  const maxPeers = Math.min(16, Math.max(2, Number(req.body?.maxPeers) || ROOM_DEFAULT_MAX_PEERS));
  const label = String(req.body?.label || '').slice(0, 60);

  const room = new Room(code, { label, minutes, maxPeers });
  rooms.set(code, room);
  console.log(`[admin] Sala creada "${code}" — ${minutes} min, hasta ${maxPeers} personas`);
  res.json({ ...room.summary(), url: `${req.protocol}://${req.get('host')}/sala/${code}` });
});

app.post('/admin/api/rooms/:code/close', requireAdmin, (req, res) => {
  const room = rooms.get(normalizeRoomId(req.params.code));
  if (!room) return res.status(404).json({ error: 'Esa sala no existe.' });
  room.close('El administrador cerró la sala.');
  res.json({ ok: true });
});

app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// Cierra sola cualquier sala que haya pasado de su hora.
function sweepRooms() {
  for (const room of [...rooms.values()]) {
    if (room.expired) room.close('La sala ha caducado.');
  }
}
setInterval(sweepRooms, 30000);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    peers: [...rooms.values()].reduce((n, r) => n + r.peers.size, 0),
    sessions: liveSessions.size,
  });
});

app.get('/privacy', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Política de Privacidad — PositivoS+ en vivo</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 760px; margin: 60px auto; padding: 0 24px; color: #1a1a2e; line-height: 1.7; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    h2 { font-size: 18px; margin-top: 36px; margin-bottom: 8px; }
    p, li { font-size: 15px; color: #333; }
    ul { padding-left: 20px; }
    .updated { color: #888; font-size: 13px; margin-bottom: 40px; }
    a { color: #5b6bdd; }
  </style>
</head>
<body>
  <h1>Política de Privacidad</h1>
  <p class="updated">Última actualización: agosto de 2026</p>

  <p><strong>PositivoS+ en vivo</strong> es una extensión de Chrome que realiza traducción simultánea de voz en cualquier sitio web: traduce el audio de la pestaña a tu idioma, y permite salas donde todos hablan y escuchan en el suyo.</p>

  <h2>Datos que se procesan</h2>
  <ul>
    <li><strong>Audio del micrófono (modo Sala):</strong> Solo mientras hablas, tu audio se envía a nuestro servidor y se reenvía a la API de OpenAI únicamente para traducirlo en tiempo real. No se almacena ningún audio.</li>
    <li><strong>Audio de la pestaña (modo Traducir):</strong> El audio de la pestaña se captura localmente en tu navegador, se envía a nuestro servidor y se reenvía a la API de OpenAI únicamente para traducirlo en tiempo real. No se almacena ningún audio.</li>
    <li><strong>Configuración:</strong> Tus preferencias de idioma se guardan localmente en Chrome Storage Sync. No se comparten con terceros.</li>
  </ul>

  <h2>Datos que NO recopilamos</h2>
  <ul>
    <li>No recopilamos correos electrónicos ni datos de identificación personal. El nombre que escribes en una sala solo existe mientras dura la sala.</li>
    <li>No guardamos transcripciones ni traducciones en ningún servidor.</li>
    <li>No usamos cookies ni tecnologías de rastreo.</li>
  </ul>

  <h2>Servicios de terceros</h2>
  <p>El audio es procesado por <a href="https://openai.com/policies/privacy-policy" target="_blank">OpenAI</a> exclusivamente para la traducción. Consulta su política de privacidad para más detalles.</p>

  <h2>Permisos de Chrome</h2>
  <ul>
    <li><strong>Micrófono:</strong> Solo en el modo Sala; Chrome pide tu autorización explícita antes de capturar.</li>
    <li><strong>tabCapture:</strong> Para capturar el audio de la pestaña que estás traduciendo.</li>
    <li><strong>offscreen:</strong> Para procesar el audio en segundo plano.</li>
    <li><strong>scripting y acceso a sitios:</strong> Para mostrar los subtítulos sobre la página que estás traduciendo. El código solo se inyecta en la pestaña donde tú inicias la traducción.</li>
    <li><strong>storage:</strong> Para guardar tu configuración de idioma localmente.</li>
  </ul>

  <h2>Contacto</h2>
  <p>Para cualquier consulta sobre privacidad, contacta al desarrollador a través de la Chrome Web Store.</p>
</body>
</html>`);
});

// ── Ruteo de upgrades WebSocket por ruta ──────────────────────────────────────

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }

  const route = (wsServer) =>
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));

  if (pathname === '/ws') {
    // Este canal también gasta dinero y no tiene sala que lo limite, así que
    // exige la clave. La extensión la lleva en config.js; solo la usas tú.
    const key = new URL(req.url, 'http://localhost').searchParams.get('key');
    if (key !== ADMIN_KEY) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    route(wss);
  } else if (pathname === '/room') route(roomWss);
  else socket.destroy();
});

console.log('[Motor] gpt-realtime-translate — solo traduce, conserva la voz del hablante');

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nPanel de administración → http://localhost:${PORT}/admin`);
  console.log(`Tope de gasto           → ${DAILY_LIMIT_MINUTES} min de traducción al día`);
  if (ADMIN_KEY_IS_TEMPORARY) {
    console.log(`\n⚠  ADMIN_KEY no está configurada. Clave TEMPORAL de esta sesión:\n   ${ADMIN_KEY}`);
    console.log('   Cambia de valor en cada reinicio. Ponla en las variables de entorno.\n');
  }
});
