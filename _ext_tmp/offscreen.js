// Offscreen Document — motor de audio
// Captura audio de la pestaña, envía PCM al servidor, reproduce TTS con ducking

// ── PCMPlayer (copiado de client/src/hooks/useRealtime.js) ───────────────────
class PCMPlayer {
  constructor(itemId) {
    this.itemId = itemId;
    this.ctx = new AudioContext({ sampleRate: 24000 });
    this.nextTime = 0;
    this.started = false;
  }

  feed(base64) {
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const samples = bytes.length / 2;
    const buf = this.ctx.createBuffer(1, samples, 24000);
    const channelData = buf.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples; i++) channelData[i] = view.getInt16(i * 2, true) / 32768;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (!this.started) {
      this.nextTime = now + 0.04;
      this.started = true;
    } else if (this.nextTime < now) {
      this.nextTime = now + 0.01;
    }
    src.start(this.nextTime);
    this.nextTime += samples / 24000;
  }

  scheduleClose() {
    const remaining = Math.max(0, this.nextTime - this.ctx.currentTime) * 1000 + 300;
    setTimeout(() => this.ctx.close().catch(() => {}), remaining);
    return remaining;
  }

  close() { this.ctx.close().catch(() => {}); }
}

// ── Helpers PCM (copiados de useRealtime.js) ──────────────────────────────────

function f32ToI16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return i16;
}

function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function sendToBackground(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── VAD (Voice Activity Detection) ───────────────────────────────────────────
// Evita enviar silencio al servidor — reduce costos ~50-70%

const VAD_THRESHOLD = 0.012; // RMS mínimo para detectar voz
const VAD_HOLD_FRAMES = 4;   // ~340 ms de cola tras el último frame con voz

function hasVoice(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  return Math.sqrt(sum / f32.length) > VAD_THRESHOLD;
}

// ── Estado ────────────────────────────────────────────────────────────────────

let ws = null;
let audioCtx = null;
let captureStream = null;
let processor = null;
let passthroughGain = null; // controla el volumen del audio de Teams en los parlantes
let config = { sourceLang: 'pt', targetLang: 'es', duckLevel: 50 };

// ── TTS continuo ──────────────────────────────────────────────────────────────
// Un solo player por sesión; el duck se libera 1.5 s después del último chunk.

let ttsPlayer = null;
let ttsActive = false;
let ttsIdleTimer = null;
const TTS_IDLE_MS = 1500;
let vadHoldCount = 0;

function duckGainValue() {
  return 1 - Math.max(0, Math.min(100, config.duckLevel ?? 50)) / 100;
}

function onTtsAudio(audio) {
  if (!ttsPlayer) ttsPlayer = new PCMPlayer('session');
  if (!ttsActive) {
    ttsActive = true;
    if (passthroughGain) passthroughGain.gain.value = duckGainValue();
    sendToBackground({ type: 'TTS_START', itemId: 'session' });
  }
  ttsPlayer.feed(audio);

  if (ttsIdleTimer) clearTimeout(ttsIdleTimer);
  ttsIdleTimer = setTimeout(onTtsIdle, TTS_IDLE_MS);
}

function onTtsIdle() {
  ttsIdleTimer = null;
  ttsActive = false;
  if (passthroughGain) passthroughGain.gain.value = 1.0;
  sendToBackground({ type: 'TTS_END', itemId: 'session' });
  if (ttsPlayer) { ttsPlayer.scheduleClose(); ttsPlayer = null; }
}

function stopTtsAll() {
  if (ttsIdleTimer) { clearTimeout(ttsIdleTimer); ttsIdleTimer = null; }
  ttsActive = false;
  if (ttsPlayer) { ttsPlayer.close(); ttsPlayer = null; }
  if (passthroughGain) passthroughGain.gain.value = 1.0;
}

// ── Manejador de mensajes del servidor ───────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'ready':
      sendToBackground({ type: 'STATUS_UPDATE', status: 'active' });
      break;

    case 'input_audio_buffer.committed':
      sendToBackground({
        type: 'TRANSLATION_UPDATE',
        payload: { type: 'committed' },
      });
      break;

    case 'conversation.item.input_audio_transcription.delta':
      sendToBackground({
        type: 'TRANSLATION_UPDATE',
        payload: { type: 'partial', delta: msg.delta ?? '' },
      });
      break;

    case 'source_transcript_final':
      sendToBackground({
        type: 'TRANSLATION_UPDATE',
        payload: { type: 'source_final', text: msg.text },
      });
      break;

    case 'conversation.item.input_audio_transcription.completed':
      sendToBackground({
        type: 'TRANSLATION_UPDATE',
        payload: { type: 'transcript_done' },
      });
      break;

    case 'translation_partial':
      sendToBackground({
        type: 'TRANSLATION_UPDATE',
        payload: { type: 'translation_partial', itemId: msg.item_id, delta: msg.delta },
      });
      break;

    case 'translation':
      sendToBackground({
        type: 'TRANSLATION_UPDATE',
        payload: {
          type: 'translation',
          itemId: msg.item_id,
          original: msg.original,
          translation: msg.translation,
        },
      });
      break;

    case 'tts_chunk':
      onTtsAudio(msg.audio);
      break;

    case 'tts_done':
    case 'tts_cancel':
      // Manejado por el timer de inactividad
      break;

    case 'error':
      sendToBackground({ type: 'ERROR', message: msg.message });
      break;
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
// Cambia esta URL por la de tu servidor desplegado en Railway (o similar).
// Formato: wss://TU-PROYECTO.up.railway.app/ws
const SERVER_WS_URL = 'wss://translate-xtub.onrender.com/ws';

function connectWebSocket() {
  ws = new WebSocket(SERVER_WS_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'set_config', config }));
    ws.send(JSON.stringify({ type: 'start' }));
  };

  ws.onmessage = ({ data }) => {
    try { handleServerMessage(JSON.parse(data)); } catch { /* ignorar frames inválidos */ }
  };

  ws.onclose = () => {
    sendToBackground({ type: 'STATUS_UPDATE', status: 'disconnected' });
    // Reconectar solo si la captura sigue activa
    if (captureStream) {
      setTimeout(connectWebSocket, 3000);
    }
  };

  ws.onerror = () => {
    sendToBackground({
      type: 'ERROR',
      message: 'No se puede conectar al servidor de traducción. Contacta al administrador.',
    });
  };
}

// ── Captura de audio de la pestaña ────────────────────────────────────────────

async function startCapture(streamId) {
  // Formato de constraints obligatorio para chromeMediaSource (legacy Chrome API)
  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  audioCtx = new AudioContext({ sampleRate: 24000 });
  const source = audioCtx.createMediaStreamSource(captureStream);
  processor = audioCtx.createScriptProcessor(2048, 1, 1);

  // Passthrough: reproduce el audio de Teams con volumen controlable (duck)
  // tabCapture redirige el audio de la pestaña a este contexto, así que si no
  // lo reproducimos aquí el usuario no escucha a los participantes.
  passthroughGain = audioCtx.createGain();
  passthroughGain.gain.value = 1.0;
  source.connect(passthroughGain);
  passthroughGain.connect(audioCtx.destination);

  // Procesador para enviar al servidor (silenciado para no duplicar)
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  vadHoldCount = 0;

  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const f32 = e.inputBuffer.getChannelData(0);

    if (hasVoice(f32)) {
      vadHoldCount = VAD_HOLD_FRAMES;
    } else if (vadHoldCount > 0) {
      vadHoldCount--;
    } else {
      return; // silencio puro — no enviar
    }

    const i16 = f32ToI16(f32);
    ws.send(JSON.stringify({ type: 'audio_chunk', audio: bufToBase64(i16.buffer) }));
  };
}

// ── Limpieza ──────────────────────────────────────────────────────────────────

function stopAll() {
  processor?.disconnect();
  processor = null;
  passthroughGain = null;
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  captureStream?.getTracks().forEach(t => t.stop());
  captureStream = null;

  if (ws) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
    ws.close();
    ws = null;
  }

  stopTtsAll();
}

// ── Listener de mensajes del background ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') {
    if (msg.config) config = { ...config, ...msg.config };
    startCapture(msg.streamId)
      .then(() => connectWebSocket())
      .catch(err => sendToBackground({
        type: 'ERROR',
        message: `Error al capturar audio: ${err.message}`,
      }));
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    stopAll();
  }

  if (msg.type === 'OFFSCREEN_SET_CONFIG') {
    config = { ...config, ...msg.config };
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_config', config }));
    }
    // Si hay TTS activo, actualizar el duck en tiempo real
    if (ttsActive && passthroughGain) {
      passthroughGain.gain.value = duckGainValue();
    }
  }
});
