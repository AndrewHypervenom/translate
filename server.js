require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY no está configurada. Agrega tu clave al archivo .env');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Tres canales WebSocket sobre el mismo servidor HTTP (ruteo manual en 'upgrade'),
// todos usados por la extensión de Chrome:
//   /ws        → traducción 1-a-1 (modo Teams)
//   /broadcast → el emisor: captura su micrófono y envía audio
//   /listen    → cada oyente: elige idioma y recibe audio + subtítulos
const wss = new WebSocketServer({ noServer: true });
const broadcastWss = new WebSocketServer({ noServer: true });
const listenWss = new WebSocketServer({ noServer: true });

const REALTIME_URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';

// ── HTTP routes ───────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
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
  <p class="updated">Última actualización: mayo de 2026</p>

  <p><strong>PositivoS+ en vivo</strong> es una extensión de Chrome que realiza traducción simultánea de voz: transmite tu micrófono para que cada oyente escuche en su idioma, y también traduce reuniones de Microsoft Teams.</p>

  <h2>Datos que se procesan</h2>
  <ul>
    <li><strong>Audio del micrófono (modo Transmitir):</strong> Si eliges transmitir, el audio de tu micrófono se envía a nuestro servidor seguro y se reenvía a la API de OpenAI únicamente para realizar la traducción en tiempo real. Solo se captura mientras la transmisión está activa y no se almacena ningún audio.</li>
    <li><strong>Audio de la reunión (modo Teams):</strong> El audio de la pestaña de Teams se captura localmente en tu navegador, se envía a nuestro servidor seguro y se reenvía a la API de OpenAI únicamente para realizar la traducción en tiempo real. No se almacena ningún audio.</li>
    <li><strong>Configuración:</strong> Tus preferencias de idioma y voz se guardan localmente en Chrome Storage Sync. No se comparten con terceros.</li>
  </ul>

  <h2>Datos que NO recopilamos</h2>
  <ul>
    <li>No recopilamos nombres, correos electrónicos ni ningún dato de identificación personal.</li>
    <li>No guardamos transcripciones ni traducciones en ningún servidor.</li>
    <li>No usamos cookies ni tecnologías de rastreo.</li>
  </ul>

  <h2>Servicios de terceros</h2>
  <p>El audio es procesado por <a href="https://openai.com/policies/privacy-policy" target="_blank">OpenAI</a> exclusivamente para la traducción. Consulta su política de privacidad para más detalles.</p>

  <h2>Permisos de Chrome</h2>
  <ul>
    <li><strong>Micrófono:</strong> Solo si eliges el modo Transmitir; Chrome pide tu autorización explícita antes de capturar.</li>
    <li><strong>tabCapture:</strong> Para capturar el audio de la pestaña de Teams.</li>
    <li><strong>offscreen:</strong> Para procesar el audio en segundo plano.</li>
    <li><strong>storage:</strong> Para guardar tu configuración de idioma localmente.</li>
    <li><strong>activeTab:</strong> Para identificar la pestaña de Teams activa.</li>
  </ul>

  <h2>Contacto</h2>
  <p>Para cualquier consulta sobre privacidad, contacta al desarrollador a través de la Chrome Web Store.</p>
</body>
</html>`);
});

wss.on('connection', (clientWs) => {
  let config = { sourceLang: 'pt', targetLang: 'es' };
  let openaiWs = null;
  let openaiReady = false;
  let audioQueue = [];

  // Reconexión automática a OpenAI si la sesión se cae a mitad de la reunión
  let wantActive = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const MAX_QUEUED_CHUNKS = 120; // ~10 s de audio retenido durante la reconexión

  let currentItemId = null;
  let phraseCount = 0;
  let audioGapTimer = null;
  let inputIdleTimer = null;
  let outputTranscriptBuf = '';
  let inputTranscriptBuf = '';
  let phraseStarted = false;

  function newPhraseId() { return `tr-${++phraseCount}`; }

  function send(data) {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(data));
  }

  function flushQueue() {
    while (audioQueue.length > 0 && openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: audioQueue.shift() }));
    }
  }

  function finishCurrentPhrase() {
    if (audioGapTimer) { clearTimeout(audioGapTimer); audioGapTimer = null; }
    if (inputIdleTimer) { clearTimeout(inputIdleTimer); inputIdleTimer = null; }

    const id = currentItemId;
    const translation = outputTranscriptBuf.trim();
    const original = inputTranscriptBuf.trim();
    currentItemId = null;
    outputTranscriptBuf = '';
    inputTranscriptBuf = '';
    phraseStarted = false;

    // Siempre ocultar "EN VIVO" aunque no haya llegado audio de salida
    send({ type: 'conversation.item.input_audio_transcription.completed', transcript: original });

    if (id) {
      send({ type: 'tts_done', item_id: id });
      if (translation) {
        send({ type: 'translation', item_id: id, original, translation });
        console.log(`[→] ${original || '(sin transcripción)'}`);
        console.log(`[←] ${translation}\n`);
      }
    }
  }

  function scheduleReconnect() {
    if (!wantActive || reconnectTimer) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      send({ type: 'error', message: 'No se pudo restablecer la conexión con OpenAI. Detén y vuelve a iniciar la traducción.' });
      return;
    }
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 8000);
    reconnectAttempts++;
    console.log(`[OpenAI] Reintentando conexión en ${delay} ms (intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (wantActive) connectToOpenAI();
    }, delay);
  }

  function connectToOpenAI() {
    openaiReady = false;
    currentItemId = null;
    outputTranscriptBuf = '';
    inputTranscriptBuf = '';
    phraseStarted = false;

    const sock = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    openaiWs = sock;

    sock.on('open', () => {
      if (sock !== openaiWs) { sock.close(); return; }
      console.log('[OpenAI] Conectado — configurando sesión gpt-realtime-translate');
      sock.send(JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            input: {
              transcription: { model: 'gpt-realtime-whisper' },
            },
            output: { language: config.targetLang },
          },
        },
      }));
      openaiReady = true;
      reconnectAttempts = 0;
      flushQueue();
      send({ type: 'ready' });
    });

    sock.on('message', (raw) => {
      if (sock !== openaiWs) return;
      const event = JSON.parse(raw.toString());

      if (event.type === 'session.output_audio.delta') {
        if (!currentItemId) currentItemId = newPhraseId();
        if (audioGapTimer) clearTimeout(audioGapTimer);
        audioGapTimer = setTimeout(finishCurrentPhrase, 1500);
        send({ type: 'tts_chunk', item_id: currentItemId, audio: event.delta });
      }

      if (event.type === 'session.output_transcript.delta') {
        if (!currentItemId) currentItemId = newPhraseId();
        outputTranscriptBuf += event.delta || '';
        // El texto en streaming también mantiene viva la frase, no solo el audio
        if (audioGapTimer) { clearTimeout(audioGapTimer); audioGapTimer = setTimeout(finishCurrentPhrase, 1500); }
        send({ type: 'translation_partial', item_id: currentItemId, delta: event.delta });
      }

      if (event.type === 'session.input_transcript.delta') {
        if (!phraseStarted) {
          phraseStarted = true;
          send({ type: 'input_audio_buffer.committed' });
        }
        inputTranscriptBuf += event.delta || '';
        send({ type: 'conversation.item.input_audio_transcription.delta', delta: event.delta });
        if (inputIdleTimer) clearTimeout(inputIdleTimer);
        inputIdleTimer = setTimeout(() => {
          inputIdleTimer = null;
          // Red de seguridad: solo cerrar si no hay una traducción en curso;
          // si la hay, su propio done/gap cerrará la frase sin cortarla.
          if (!currentItemId) finishCurrentPhrase();
        }, 3000);
      }

      // Transcripción final del idioma original — reemplaza los deltas provisionales
      if (event.type === 'session.input_transcript.done') {
        if (inputIdleTimer) { clearTimeout(inputIdleTimer); inputIdleTimer = null; }
        const finalText = event.transcript?.trim() || event.text?.trim() || '';
        if (finalText) {
          inputTranscriptBuf = finalText;
          // Reemplazar texto del overlay "EN VIVO" con la versión final corregida
          send({ type: 'source_transcript_final', text: finalText });
        }
      }

      // Transcripción final de la traducción — reemplaza deltas y cierra la frase
      if (event.type === 'session.output_transcript.done') {
        const finalText = event.transcript?.trim() || event.text?.trim() || '';
        if (finalText) outputTranscriptBuf = finalText;
        finishCurrentPhrase();
      }

      if (event.type === 'session.closed') {
        finishCurrentPhrase();
        openaiWs = null;
        openaiReady = false;
        sock.close();
        // Si OpenAI cerró la sesión pero el usuario sigue traduciendo
        // (p. ej. límite de duración), abrir una sesión nueva.
        if (wantActive) scheduleReconnect();
      }

      if (event.type === 'error') {
        const msg = event.error?.message || JSON.stringify(event.error) || 'OpenAI error';
        console.error('[OpenAI] Error:', msg);
        send({ type: 'error', message: msg });
      }
    });

    sock.on('error', (err) => {
      console.error('[OpenAI] WS error:', err?.message || String(err));
    });

    sock.on('close', (code, reason) => {
      if (sock !== openaiWs) return; // socket viejo, ya reemplazado o cerrado a propósito
      openaiWs = null;
      openaiReady = false;
      finishCurrentPhrase();
      const reasonStr = reason?.length ? reason.toString() : '';
      console.log(`[OpenAI] WS cerrado: code=${code}${reasonStr ? ' — ' + reasonStr : ''}`);
      if (code !== 1000 && code !== 1001 && wantActive) {
        // Cierre inesperado a mitad de sesión: reconectar sin molestar al usuario
        scheduleReconnect();
      }
    });
  }

  // ── Mensajes del cliente (extensión) ──────────────────────────────────────────
  clientWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'set_config':
        if (msg.config) {
          config = { ...config, ...msg.config };
          if (openaiReady && openaiWs?.readyState === WebSocket.OPEN && msg.config.targetLang) {
            openaiWs.send(JSON.stringify({
              type: 'session.update',
              session: { audio: { output: { language: config.targetLang } } },
            }));
          }
        }
        break;

      case 'start':
        wantActive = true;
        reconnectAttempts = 0;
        audioQueue = [];
        connectToOpenAI();
        break;

      case 'stop':
        wantActive = false;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        openaiReady = false;
        audioQueue = [];
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'session.close' }));
        } else {
          openaiWs?.close();
          openaiWs = null;
          finishCurrentPhrase();
        }
        break;

      case 'audio_chunk':
        if (!msg.audio) break;
        if (openaiReady && openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: msg.audio }));
        } else if (audioQueue.length < MAX_QUEUED_CHUNKS) {
          // Retener el audio mientras se (re)conecta a OpenAI para no perder frases
          audioQueue.push(msg.audio);
        }
        break;
    }
  });

  clientWs.on('close', () => {
    wantActive = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (audioGapTimer) { clearTimeout(audioGapTimer); audioGapTimer = null; }
    if (inputIdleTimer) { clearTimeout(inputIdleTimer); inputIdleTimer = null; }
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({ type: 'session.close' }));
    }
    openaiWs?.close();
    openaiWs = null;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MODO TRANSMISIÓN: 1 emisor → N oyentes, cada uno en su idioma
// ════════════════════════════════════════════════════════════════════════════
//
// El emisor (/broadcast) envía su audio una sola vez. Por cada idioma que algún
// oyente pida, abrimos una sesión independiente con OpenAI y le reenviamos ese
// mismo audio. La salida (voz traducida + texto) de cada sesión se difunde a
// todos los oyentes suscritos a ese idioma.

const MAX_QUEUED_CHUNKS = 120; // ~10 s de audio retenido mientras conecta OpenAI

// El fin de frase lo marca OpenAI con 'output_transcript.done'. Este temporizador
// es SOLO una red de seguridad por si ese evento nunca llega. Debe ser holgado:
// si es corto, corta la frase a la mitad cuando se habla rápido/continuo y manda
// el subtítulo incompleto.
const PHRASE_SAFETY_MS = 5000;

// Motor único: gpt-realtime-translate (API de traducción dedicada). Solo traduce
// por diseño — no puede responder, conversar ni inventar contenido. Aquí NO se
// usa gpt-realtime (el modelo conversacional).
console.log('[Motor] gpt-realtime-translate (traducción simultánea)');
console.log('[Voz] nativa del modelo — CONSERVA el tono/voz del hablante');

const room = {
  broadcaster: null,          // WS del emisor activo (uno a la vez)
  sessions: new Map(),        // targetLang -> LangSession
  listeners: new Set(),       // WS de todos los oyentes
  sourceLang: 'es',           // idioma que habla el emisor (lo fija en la página)

  setSourceLang(lang) {
    if (!lang || lang === this.sourceLang) return;
    this.sourceLang = lang;
    console.log(`[Room] Idioma del emisor → ${lang}`);
    for (const s of this.sessions.values()) {
      if (typeof s.updateSourceLang === 'function') s.updateSourceLang();
    }
  },

  primarySession() {
    // La primera sesión creada relaya la transcripción del idioma original
    // al emisor (todas transcriben lo mismo; evitamos duplicar).
    return this.sessions.values().next().value || null;
  },

  broadcastToListeners(lang, data) {
    const s = this.sessions.get(lang);
    if (!s) return;
    for (const ws of s.listeners) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    }
  },

  sendToBroadcaster(data) {
    if (this.broadcaster && this.broadcaster.readyState === WebSocket.OPEN) {
      this.broadcaster.send(JSON.stringify(data));
    }
  },

  ensureSession(lang) {
    let s = this.sessions.get(lang);
    if (!s) {
      s = new LangSession(lang);
      this.sessions.set(lang, s);
      s.connect();
    }
    return s;
  },

  appendAudio(base64) {
    for (const s of this.sessions.values()) s.appendAudio(base64);
  },

  removeSessionIfEmpty(lang) {
    const s = this.sessions.get(lang);
    if (s && s.listeners.size === 0) {
      s.close();
      this.sessions.delete(lang);
    }
  },
};

// Una sesión de traducción con OpenAI para un idioma destino concreto.
class LangSession {
  constructor(targetLang) {
    this.targetLang = targetLang;
    this.listeners = new Set();
    this.openaiWs = null;
    this.ready = false;
    this.audioQueue = [];
    this.currentItemId = null;
    this.phraseCount = 0;
    this.outputBuf = '';
    this.inputBuf = '';
    this.gapTimer = null;
  }

  isPrimary() { return room.primarySession() === this; }

  toListeners(data) {
    for (const ws of this.listeners) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    }
  }

  finishPhrase() {
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    const translation = this.outputBuf.trim();
    if (translation) this.toListeners({ type: 'final', text: translation });
    this.currentItemId = null;
    this.outputBuf = '';
    this.inputBuf = '';
  }

  connect() {
    this.ready = false;
    const sock = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    this.openaiWs = sock;

    sock.on('open', () => {
      if (sock !== this.openaiWs) { sock.close(); return; }
      console.log(`[Room] Sesión OpenAI lista → ${this.targetLang}`);
      sock.send(JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            input: {
              transcription: { model: 'gpt-realtime-whisper' },
              // Micrófono cercano: limpia ruido de fondo sin cortar la voz.
              noise_reduction: { type: 'near_field' },
            },
            output: { language: this.targetLang },
          },
        },
      }));
      this.ready = true;
      while (this.audioQueue.length && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: this.audioQueue.shift() }));
      }
      this.toListeners({ type: 'ready', lang: this.targetLang });
    });

    sock.on('message', (raw) => {
      if (sock !== this.openaiWs) return;
      let event; try { event = JSON.parse(raw.toString()); } catch { return; }

      if (event.type === 'session.output_audio.delta') {
        if (!this.currentItemId) this.currentItemId = `p-${++this.phraseCount}`;
        if (this.gapTimer) clearTimeout(this.gapTimer);
        this.gapTimer = setTimeout(() => this.finishPhrase(), PHRASE_SAFETY_MS);
        // Voz nativa del modelo (conserva el tono/voz del hablante) en streaming.
        this.toListeners({ type: 'audio', chunk: event.delta });
      }

      if (event.type === 'session.output_transcript.delta') {
        if (!this.currentItemId) this.currentItemId = `p-${++this.phraseCount}`;
        this.outputBuf += event.delta || '';
        if (this.gapTimer) clearTimeout(this.gapTimer);
        this.gapTimer = setTimeout(() => this.finishPhrase(), PHRASE_SAFETY_MS);
        this.toListeners({ type: 'partial', text: this.outputBuf });
      }

      if (event.type === 'session.output_transcript.done') {
        const t = event.transcript?.trim() || event.text?.trim() || '';
        if (t) this.outputBuf = t;
        this.finishPhrase();
      }

      // La sesión primaria relaya el texto original (lo que dijo el emisor)
      // de vuelta al emisor, como confirmación en pantalla.
      if (event.type === 'session.input_transcript.delta' && this.isPrimary()) {
        this.inputBuf += event.delta || '';
        room.sendToBroadcaster({ type: 'source_partial', text: this.inputBuf });
      }
      if (event.type === 'session.input_transcript.done' && this.isPrimary()) {
        const t = event.transcript?.trim() || event.text?.trim() || '';
        if (t) { this.inputBuf = ''; room.sendToBroadcaster({ type: 'source_final', text: t }); }
      }

      if (event.type === 'session.closed') {
        this.finishPhrase();
        this.openaiWs = null; this.ready = false; sock.close();
        // Si aún hay oyentes, reabrir sesión (p. ej. límite de duración de OpenAI)
        if (this.listeners.size > 0) this.connect();
      }

      if (event.type === 'error') {
        const msg = event.error?.message || 'OpenAI error';
        console.error(`[Room:${this.targetLang}] Error:`, msg);
        this.toListeners({ type: 'error', message: msg });
      }
    });

    sock.on('error', (err) => console.error(`[Room:${this.targetLang}] WS error:`, err?.message || String(err)));
    sock.on('close', (code) => {
      if (sock !== this.openaiWs) return;
      this.openaiWs = null; this.ready = false; this.finishPhrase();
      if (code !== 1000 && code !== 1001 && this.listeners.size > 0) {
        setTimeout(() => { if (this.listeners.size > 0) this.connect(); }, 1000);
      }
    });
  }

  appendAudio(base64) {
    if (this.ready && this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: base64 }));
    } else if (this.audioQueue.length < MAX_QUEUED_CHUNKS) {
      this.audioQueue.push(base64);
    }
  }

  close() {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify({ type: 'session.close' }));
    }
    this.openaiWs?.close();
    this.openaiWs = null;
  }
}

// ── Emisor ────────────────────────────────────────────────────────────────────
broadcastWss.on('connection', (ws) => {
  if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'busy', message: 'Ya hay una transmisión activa.' }));
    ws.close();
    return;
  }
  room.broadcaster = ws;
  console.log('[Room] Emisor conectado');
  ws.send(JSON.stringify({ type: 'broadcaster_ready', listeners: room.listeners.size }));

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'set_source_lang' && msg.lang) room.setSourceLang(msg.lang);
    if (msg.type === 'audio_chunk' && msg.audio) room.appendAudio(msg.audio);
  });

  ws.on('close', () => {
    if (room.broadcaster === ws) room.broadcaster = null;
    console.log('[Room] Emisor desconectado');
    for (const ws2 of room.listeners) {
      if (ws2.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: 'broadcaster_left' }));
    }
  });
});

// ── Oyentes ─────────────────────────────────────────────────────────────────
listenWss.on('connection', (ws) => {
  ws.lang = null;
  room.listeners.add(ws);
  ws.send(JSON.stringify({ type: 'connected', broadcasting: !!room.broadcaster }));

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'set_lang' && msg.lang) {
      // Salir de la sesión anterior
      if (ws.lang && room.sessions.has(ws.lang)) {
        room.sessions.get(ws.lang).listeners.delete(ws);
        room.removeSessionIfEmpty(ws.lang);
      }
      ws.lang = msg.lang;
      const s = room.ensureSession(msg.lang);
      s.listeners.add(ws);
      if (s.ready) ws.send(JSON.stringify({ type: 'ready', lang: msg.lang }));
    }
  });

  ws.on('close', () => {
    room.listeners.delete(ws);
    if (ws.lang && room.sessions.has(ws.lang)) {
      room.sessions.get(ws.lang).listeners.delete(ws);
      room.removeSessionIfEmpty(ws.lang);
    }
  });
});

// ── Ruteo de upgrades WebSocket por ruta ──────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }

  const route = (wsServer) => wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));

  if (pathname === '/ws') route(wss);
  else if (pathname === '/broadcast') route(broadcastWss);
  else if (pathname === '/listen') route(listenWss);
  else socket.destroy();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nTraductorVivo server → ws://localhost:${PORT}/ws`);
  console.log(`Modo transmisión     → ws://localhost:${PORT}/broadcast y /listen (extensión)\n`);
});
