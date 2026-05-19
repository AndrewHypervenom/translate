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
const wss = new WebSocketServer({ server, path: '/ws' });

// ── Kill switch global ────────────────────────────────────────────────────────
let serviceEnabled = true;

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

const LANG_NAMES = {
  es: 'Spanish', en: 'English', fr: 'French', de: 'German',
  ja: 'Japanese', zh: 'Chinese (Simplified)', pt: 'Portuguese (Brazilian)',
  it: 'Italian', ar: 'Arabic', ko: 'Korean', ru: 'Russian',
  hi: 'Hindi', nl: 'Dutch', tr: 'Turkish', pl: 'Polish',
};

const VOICE_MAP = { male: 'echo', female: 'shimmer' };

// Instrucciones para el intérprete simultáneo
function buildInstructions(sourceLang, targetLang) {
  const src = LANG_NAMES[sourceLang] || sourceLang;
  const tgt = LANG_NAMES[targetLang] || targetLang;
  return (
    `You are a silent real-time speech translator. ` +
    `Your ONLY job: when you hear ${src}, output the ${tgt} translation and nothing else. ` +
    `ABSOLUTE RULES — breaking any of these is a critical failure: ` +
    `(1) NEVER say "I couldn't hear you", "Could you repeat", "I'm sorry", or ANY phrase that is not a direct translation. ` +
    `(2) If the audio is silent, unclear, or contains only noise — output NOTHING. Complete silence. Zero words. ` +
    `(3) NEVER ask for clarification or repetition. ` +
    `(4) NEVER greet, introduce yourself, or acknowledge the user. ` +
    `(5) Output ONLY the translated words. No punctuation changes, no added commentary. ` +
    `You are not a conversational assistant. You are a translation machine. Silence is always better than a wrong response.`
  );
}

// Alucinaciones conocidas de Whisper — se usan para suprimir respuestas vacías
const HALLUCINATION_EXACT = new Set([
  'chao', 'chau', 'bye', 'goodbye', 'ok', 'okay',
  'gracias', 'thanks', 'thank you', 'merci', 'obrigado', 'obrigada',
  'suscríbete', 'subscribe', 'subtitles by', 'subtitles created',
  'um', 'uh', 'hmm', 'eh', 'you', 'the', 'a', 'i',
]);

const HALLUCINATION_CONTAINS = [
  'amara.org', 'subtitles created by', 'like and subscribe',
  'transcribed by', 'closed captions', 'www.', '.com', '.org',
];

function isHallucination(transcript) {
  const clean = transcript.trim().toLowerCase().replace(/[.,!?¿¡'"]/g, '').trim();
  if (clean.length <= 2) return true;
  if (HALLUCINATION_EXACT.has(clean)) return true;
  if (HALLUCINATION_CONTAINS.some(s => clean.includes(s))) return true;
  return false;
}

// Frases que el modelo genera cuando no escucha nada — nunca deben salir al usuario
const FILLER_PHRASES = [
  "i couldn't hear", "could you say that", "could you repeat",
  "i didn't catch", "i'm sorry", "pardon", "come again",
  "please repeat", "can you speak", "speak up",
  "no pude escuchar", "podría repetir", "no te escuché",
  "lo siento", "no entendí",
];

function isFiller(text) {
  const low = text.toLowerCase();
  return FILLER_PHRASES.some(f => low.includes(f));
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── Admin HTTP routes ─────────────────────────────────────────────────────────

app.use('/api/status', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use('/admin/toggle', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

function requireAdminToken(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return res.status(500).json({ error: 'ADMIN_TOKEN no está configurado en el servidor.' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${adminToken}`) {
    return res.status(401).json({ error: 'Token de administrador incorrecto.' });
  }
  next();
}

app.get('/api/status', (_req, res) => {
  res.json({ enabled: serviceEnabled, clients: wss.clients.size });
});

app.post('/admin/toggle', express.json(), requireAdminToken, (_req, res) => {
  serviceEnabled = !serviceEnabled;
  console.log(`[Admin] Servicio ${serviceEnabled ? 'HABILITADO ✓' : 'DESHABILITADO ✗'}`);
  if (!serviceEnabled) {
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) {
        c.send(JSON.stringify({ type: 'error', message: 'El servicio fue deshabilitado por el administrador.' }));
        c.close(1008, 'Service disabled');
      }
    });
  }
  res.json({ enabled: serviceEnabled });
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

  <p><strong>PositivoS+ en vivo</strong> es una extensión de Chrome que realiza traducción simultánea de voz en reuniones de Microsoft Teams.</p>

  <h2>Datos que se procesan</h2>
  <ul>
    <li><strong>Audio de la reunión:</strong> El audio de la pestaña de Teams se captura localmente en tu navegador, se envía a nuestro servidor seguro y se reenvía a la API de OpenAI únicamente para realizar la traducción en tiempo real. No se almacena ningún audio.</li>
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

app.get('/admin', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PositivoS+ — Panel de Control</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e1e4e8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .card {
      background: #1c2030;
      border-radius: 16px;
      padding: 40px 36px;
      width: 100%;
      max-width: 440px;
      border: 1px solid #2d3148;
      text-align: center;
    }
    .brand {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: #5b6bdd;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 32px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 12px 22px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .status-badge.enabled {
      background: rgba(52,211,153,0.12);
      color: #34d399;
      border: 1px solid rgba(52,211,153,0.3);
    }
    .status-badge.disabled {
      background: rgba(239,68,68,0.12);
      color: #ef4444;
      border: 1px solid rgba(239,68,68,0.3);
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
    }
    .dot.pulse { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
    .clients {
      font-size: 12px;
      color: #7c85a2;
      margin-bottom: 32px;
      height: 16px;
    }
    .field { text-align: left; margin-bottom: 16px; }
    label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: #7c85a2;
      margin-bottom: 7px;
    }
    input[type=password] {
      width: 100%;
      padding: 11px 13px;
      background: #0f1117;
      border: 1px solid #2d3148;
      border-radius: 8px;
      color: #e1e4e8;
      font-size: 14px;
      outline: none;
      transition: border-color .2s;
    }
    input[type=password]:focus { border-color: #5b6bdd; }
    button#toggleBtn {
      width: 100%;
      padding: 13px;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: filter .15s, opacity .15s;
      letter-spacing: .3px;
    }
    button#toggleBtn:hover:not(:disabled) { filter: brightness(1.1); }
    button#toggleBtn:disabled { opacity: .55; cursor: not-allowed; }
    button#toggleBtn.btn-disable { background: #ef4444; color: #fff; }
    button#toggleBtn.btn-enable  { background: #34d399; color: #000; }
    .msg {
      margin-top: 16px;
      font-size: 13px;
      min-height: 18px;
      transition: color .2s;
    }
    .msg.ok  { color: #34d399; }
    .msg.err { color: #ef4444; }
    .footer {
      margin-top: 28px;
      font-size: 11px;
      color: #3d4561;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">PositivoS+ en vivo</div>
    <h1>Panel de Control</h1>

    <div id="statusBadge" class="status-badge">
      <span class="dot" id="dot"></span>
      <span id="statusText">Cargando…</span>
    </div>
    <div class="clients" id="clients"></div>

    <form id="form">
      <div class="field">
        <label for="token">Token de administrador</label>
        <input type="password" id="token" placeholder="••••••••••••" autocomplete="off">
      </div>
      <button type="submit" id="toggleBtn" disabled>Cargando…</button>
    </form>

    <div class="msg" id="msg"></div>
    <div class="footer">Estado actualizado automáticamente cada 5 s</div>
  </div>

  <script>
    var currentEnabled = null;

    function updateUI(enabled, clients) {
      currentEnabled = enabled;
      var badge = document.getElementById('statusBadge');
      var dot   = document.getElementById('dot');
      var text  = document.getElementById('statusText');
      var btn   = document.getElementById('toggleBtn');
      var cli   = document.getElementById('clients');

      badge.className = 'status-badge ' + (enabled ? 'enabled' : 'disabled');
      dot.className   = 'dot' + (enabled ? ' pulse' : '');
      text.textContent = enabled
        ? 'ACTIVO — consumiendo tokens'
        : 'DESACTIVADO — sin consumo de tokens';
      btn.className   = enabled ? 'btn-disable' : 'btn-enable';
      btn.textContent = enabled ? 'Desactivar servicio' : 'Activar servicio';
      btn.disabled    = false;

      if (typeof clients === 'number') {
        cli.textContent = clients === 0
          ? 'Sin usuarios conectados'
          : clients + ' usuario' + (clients === 1 ? '' : 's') + ' conectado' + (clients === 1 ? '' : 's');
      }
    }

    function setMsg(text, type) {
      var el = document.getElementById('msg');
      el.textContent = text;
      el.className = 'msg ' + (type || '');
      if (text) setTimeout(function() { el.textContent = ''; el.className = 'msg'; }, 5000);
    }

    function fetchStatus() {
      fetch('/api/status')
        .then(function(r) { return r.json(); })
        .then(function(d) { updateUI(d.enabled, d.clients); })
        .catch(function() { setMsg('No se puede conectar al servidor', 'err'); });
    }

    document.getElementById('form').addEventListener('submit', function(e) {
      e.preventDefault();
      var token = document.getElementById('token').value.trim();
      if (!token) { setMsg('Ingresa el token de administrador', 'err'); return; }

      var btn = document.getElementById('toggleBtn');
      btn.disabled = true;
      btn.textContent = 'Procesando…';

      fetch('/admin/toggle', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
      })
        .then(function(r) {
          if (r.status === 401) {
            setMsg('Token incorrecto', 'err');
            fetchStatus();
            return null;
          }
          return r.json();
        })
        .then(function(d) {
          if (!d) return;
          updateUI(d.enabled);
          setMsg(
            d.enabled ? 'Servicio activado correctamente' : 'Servicio desactivado — tokens protegidos',
            'ok'
          );
        })
        .catch(function() {
          setMsg('Error al conectar con el servidor', 'err');
          fetchStatus();
        });
    });

    fetchStatus();
    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>`);
});

wss.on('connection', (clientWs) => {
  if (!serviceEnabled) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'El servicio está deshabilitado por el administrador.' }));
    clientWs.close(1008, 'Service disabled');
    return;
  }

  let config = { sourceLang: 'pt', targetLang: 'es', gender: 'male' };
  let openaiWs = null;
  let openaiReady = false;
  let audioQueue = [];

  let pendingOriginal = '';
  let currentItemId = null;
  let partialTranslationBuf = '';
  let fillerCancelled = false;
  let manualResponsePending = false;

  let responseActive = false;
  const transcriptQueue = [];

  function processNextTranscript() {
    if (responseActive || transcriptQueue.length === 0) return;
    const next = transcriptQueue.shift();
    pendingOriginal = next.original;
    createTranslationResponse();
  }

  function releaseResponse() {
    responseActive = false;
    processNextTranscript();
  }

  function send(data) {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(data));
  }

  function flushQueue() {
    while (audioQueue.length > 0 && openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioQueue.shift() }));
    }
  }

  function sessionConfig() {
    return {
      modalities: ['text', 'audio'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      voice: VOICE_MAP[config.gender] || 'echo',
      input_audio_transcription: { model: 'whisper-1', language: config.sourceLang },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 150,
        silence_duration_ms: 300,
      },
    };
  }

  function createTranslationResponse() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    responseActive = true;
    manualResponsePending = true;
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        output_audio_format: 'pcm16',
        voice: VOICE_MAP[config.gender] || 'echo',
        instructions: buildInstructions(config.sourceLang, config.targetLang),
        max_output_tokens: 512,
      },
    }));
    partialTranslationBuf = '';
    fillerCancelled = false;
    currentItemId = null;
  }

  function connectToOpenAI() {
    openaiReady = false;
    audioQueue = [];
    pendingOriginal = '';

    openaiWs = new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    });

    openaiWs.on('open', () => {
      console.log('[OpenAI] Conectado — configurando sesión de intérprete');
      openaiWs.send(JSON.stringify({ type: 'session.update', session: sessionConfig() }));
    });

    openaiWs.on('message', (raw) => {
      const event = JSON.parse(raw.toString());

      // ── Sesión lista ─────────────────────────────────────────────────────────
      if (event.type === 'session.updated') {
        openaiReady = true;
        flushQueue();
        send({ type: 'ready' });
        return;
      }

      // ── Respuesta creada ──────────────────────────────────────────────────────
      if (event.type === 'response.created') {
        if (manualResponsePending) {
          // Es la nuestra — marcar como consumida
          manualResponsePending = false;
          console.log(`[response.created] Nuestra respuesta: ${event.response?.id}`);
        } else if (openaiWs?.readyState === WebSocket.OPEN) {
          // Auto-creada por VAD — cancelar inmediatamente
          console.log(`[response.created] VAD auto-response cancelada: ${event.response?.id}`);
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        }
        return;
      }

      // ── Transcripción del audio de entrada (lo que dijeron en el idioma original) ──
      if (event.type === 'input_audio_buffer.committed') {
        broadcastAll(event);
      }

      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        broadcastAll(event);
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        broadcastAll(event);
        const t = event.transcript?.trim();
        if (t && !isHallucination(t)) {
          if (responseActive) {
            // Ya hay una respuesta en curso — encolar para traducir después
            transcriptQueue.push({ original: t });
            console.log(`[COLA +1] "${t}" (cola: ${transcriptQueue.length})`);
          } else {
            pendingOriginal = t;
            createTranslationResponse();
          }
        } else {
          if (t) console.log(`[HALLUC ignorado] "${t}"`);
        }
      }

      // ── Audio de la traducción en streaming (sale mientras el modelo habla) ──
      if (event.type === 'response.audio.delta') {
        if (!fillerCancelled) {
          currentItemId = event.item_id;
          send({ type: 'tts_chunk', item_id: event.item_id, audio: event.delta });
        }
      }

      if (event.type === 'response.audio.done') {
        if (!fillerCancelled) {
          send({ type: 'tts_done', item_id: event.item_id });
        }
      }

      // ── Texto de la traducción en streaming ──────────────────────────────────
      if (event.type === 'response.audio_transcript.delta') {
        if (fillerCancelled) return;

        partialTranslationBuf += event.delta || '';

        // Cancelar tan pronto como el acumulador deje claro que es una frase de relleno
        if (partialTranslationBuf.length >= 8 && isFiller(partialTranslationBuf)) {
          fillerCancelled = true;
          console.warn(`[FILLER cancelado] "${partialTranslationBuf.trim()}"`);
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          // Decirle al cliente que descarte el audio ya enviado de este item
          if (currentItemId) {
            send({ type: 'tts_cancel', item_id: currentItemId });
          }
          return;
        }

        send({ type: 'translation_partial', item_id: event.item_id, delta: event.delta });
      }

      if (event.type === 'response.audio_transcript.done') {
        const translation = event.transcript?.trim();
        if (translation && !isFiller(translation)) {
          send({
            type: 'translation',
            item_id: event.item_id,
            original: pendingOriginal,
            translation,
          });
          console.log(`[→] ${pendingOriginal || '(sin transcripción)'}`);
          console.log(`[←] ${translation}\n`);
        } else if (translation) {
          console.warn(`[FILLER suprimido] ${translation}`);
        }
        pendingOriginal = '';
        // Este evento solo llega para respuestas que generaron output real (las nuestras).
        // VAD responses canceladas no generan transcript — este es el reset principal.
        releaseResponse();
      }

      // ── Fin de respuesta (fallback) ──────────────────────────────────────────
      // audio_transcript.done es el reset normal para respuestas completadas.
      // response.done cubre los casos donde ese evento no llega:
      //   - status=failed: respuesta falló antes de generar output
      //   - status=cancelled + fillerCancelled: nosotros la cancelamos por filler
      // status=cancelled + !fillerCancelled = VAD auto-response que cancelamos,
      // no somos dueños del lock — no liberar.
      if (event.type === 'response.done') {
        const status = event.response?.status;
        console.log(`[response.done] status=${status} fillerCancelled=${fillerCancelled} responseActive=${responseActive}`);
        if (responseActive) {
          if (status === 'failed') {
            const err = event.response?.last_error;
            const errMsg = err?.message || err?.code || 'sin detalle';
            console.warn(`[response.done] Respuesta falló (${errMsg}) — liberando responseActive`);
            if (err) console.warn('[response.done] last_error completo:', JSON.stringify(err));
            releaseResponse();
          } else if (status === 'cancelled' && fillerCancelled) {
            releaseResponse();
          }
        }
      }

      // ── Errores ──────────────────────────────────────────────────────────────
      if (event.type === 'error') {
        const msg = event.error?.message || JSON.stringify(event.error) || 'OpenAI error';
        console.error('[OpenAI] Error:', msg);
        send({ type: 'error', message: msg });
      }
    });

    openaiWs.on('error', (err) => {
      const message = err?.message || String(err) || 'OpenAI WebSocket error';
      console.error('[OpenAI] WS error:', message);
      send({ type: 'error', message });
    });

    openaiWs.on('close', (code, reason) => {
      openaiReady = false;
      const reasonStr = reason?.length ? reason.toString() : '';
      console.log(`[OpenAI] WS cerrado: code=${code}${reasonStr ? ' — ' + reasonStr : ''}`);
      if (code !== 1000 && code !== 1001) {
        send({ type: 'error', message: `OpenAI desconectado (${code})${reasonStr ? ': ' + reasonStr : ''}` });
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
          if (openaiReady && openaiWs?.readyState === WebSocket.OPEN) {
            const patch = {};
            if (msg.config.sourceLang) patch.input_audio_transcription = { model: 'whisper-1', language: config.sourceLang };
            if (msg.config.gender) patch.voice = VOICE_MAP[config.gender] || 'echo';
            if (Object.keys(patch).length > 0) {
              openaiWs.send(JSON.stringify({ type: 'session.update', session: patch }));
            }
          }
        }
        break;

      case 'start':
        connectToOpenAI();
        break;

      case 'stop':
        openaiWs?.close();
        openaiWs = null;
        openaiReady = false;
        audioQueue = [];
        pendingOriginal = '';
        partialTranslationBuf = '';
        fillerCancelled = false;
        currentItemId = null;
        manualResponsePending = false;
        responseActive = false;
        transcriptQueue.length = 0;
        break;

      case 'audio_chunk':
        if (!msg.audio) break;
        if (openaiReady && openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.audio }));
        } else if (audioQueue.length < 12) {
          audioQueue.push(msg.audio);
        }
        break;
    }
  });

  clientWs.on('close', () => openaiWs?.close());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nTraductorVivo server → ws://localhost:${PORT}/ws\n`);
});
