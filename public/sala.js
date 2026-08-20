// Sala bidireccional pública: cualquiera abre el enlace en su navegador, elige
// su idioma y habla. No hace falta instalar la extensión.
//
// El servidor abre una sesión de traducción por cada idioma que escuchen LOS
// DEMÁS, así que nadie recibe nunca su propia voz de vuelta.

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/room`;
const FRAME_SAMPLES = 1024; // ~43 ms a 24 kHz
const FRAME_MS = (FRAME_SAMPLES / PCM_SAMPLE_RATE) * 1000;
const MAX_LINES = 12;

const el = {};
for (const id of ['dot', 'statusText', 'toggle', 'copyBtn', 'meter', 'name', 'room',
  'speakLang', 'listenLang', 'peers', 'subs', 'self', 'antiEcho', 'shareLink']) {
  el[id] = document.getElementById(id);
}

let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let gate = null;
let active = false;
let myPeerId = null;
let rejected = false; // el servidor nos negó la entrada y explicó por qué

const players = new Map();  // peerId -> PCMPlayer (uno por interlocutor)
const partials = new Map(); // peerId -> texto en curso
let lines = [];             // subtítulos ya cerrados

// ── Utilidades ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Debe coincidir con normalizeRoomId() de server.js.
function normalizeRoomId(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
}

function setStatus(text, cls = '') {
  el.statusText.textContent = text;
  el.dot.className = 'dot' + (cls ? ' ' + cls : '');
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function shareUrl() {
  const code = normalizeRoomId(el.room.value);
  return code ? `${location.origin}/sala/${code}` : '';
}

function refreshShareLink() {
  const url = shareUrl();
  el.shareLink.textContent = url || 'Escribe un código de sala para generar el enlace';
  el.copyBtn.disabled = !url;
  // La barra de direcciones sigue al código, así se puede copiar desde ahí.
  if (url) history.replaceState(null, '', `/sala/${normalizeRoomId(el.room.value)}`);
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderPeers(peers) {
  if (!peers.length) {
    el.peers.innerHTML = '<span class="hint">Nadie todavía.</span>';
    return;
  }
  el.peers.innerHTML = peers
    .map((p) => {
      const me = p.id === myPeerId;
      return `<span class="peer${me ? ' me' : ''}">${esc(p.name)}${me ? ' (tú)' : ''}
        <span class="langs">· habla ${esc(langName(p.speakLang))} · oye ${esc(langName(p.listenLang))}</span></span>`;
    })
    .join('');
}

function renderSubs() {
  el.subs.innerHTML = [
    ...lines.map((l) => `<div class="line"><span class="who">${esc(l.name)}</span>${esc(l.text)}</div>`),
    ...[...partials.values()].map(
      (p) => `<div class="line"><span class="who">${esc(p.name)}</span><span class="partial">${esc(p.text)}</span></div>`
    ),
  ].join('');
  el.subs.scrollTop = el.subs.scrollHeight;
}

// ── Reproducción ──────────────────────────────────────────────────────────────

function playerFor(peerId) {
  if (!audioCtx) return null;
  let player = players.get(peerId);
  if (!player) {
    player = new PCMPlayer(audioCtx);
    players.set(peerId, player);
  }
  return player;
}

// ¿Está sonando ahora mismo la traducción de alguien?
function remoteAudioPending() {
  for (const player of players.values()) {
    if (player.pendingMs() > 60) return true;
  }
  return false;
}

// ── Conexión ──────────────────────────────────────────────────────────────────

async function start() {
  const roomId = normalizeRoomId(el.room.value);
  if (!roomId) {
    setStatus('Escribe un código de sala para entrar', 'err');
    el.room.focus();
    return;
  }
  el.room.value = roomId;
  refreshShareLink();
  rejected = false;

  setStatus('Pidiendo permiso para el micrófono…', 'wait');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    setStatus('No se pudo acceder al micrófono: ' + err.message, 'err');
    return;
  }

  // Un solo AudioContext para capturar y reproducir: el navegador limita
  // cuántos puede tener una página, y aquí hay un reproductor por interlocutor.
  audioCtx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
  await audioCtx.resume().catch(() => {});
  const source = audioCtx.createMediaStreamSource(micStream);
  processor = audioCtx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioCtx.destination);

  gate = new VoiceGate({ frameMs: FRAME_MS });
  processor.onaudioprocess = onAudioFrame;

  active = true;
  el.toggle.textContent = '■ Salir de la sala';
  el.toggle.className = 'stop';

  ws = new WebSocket(`${WS_URL}?room=${encodeURIComponent(roomId)}`);
  ws.onopen = () => {
    setStatus('Conectando a la sala…', 'wait');
    send({
      type: 'join',
      room: roomId,
      name: el.name.value.trim() || 'Invitado',
      speakLang: el.speakLang.value,
      listenLang: el.listenLang.value,
    });
  };
  ws.onclose = () => {
    // Si el servidor nos rechazó (sala inexistente, llena o caducada) ya mandó
    // el motivo antes de cerrar: no lo pisamos con un "conexión perdida".
    if (!active) return;
    if (rejected) { stop({ keepStatus: true }); return; }
    setStatus('Conexión perdida — vuelve a entrar', 'err');
  };
  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      myPeerId = msg.peerId;
      setStatus(`En la sala "${msg.room}" — habla cuando quieras`, 'live');
      renderPeers(msg.peers);
      break;

    case 'peers':
      renderPeers(msg.peers);
      break;

    case 'audio':
      playerFor(msg.from)?.feed(msg.chunk);
      break;

    case 'partial':
      partials.set(msg.from, { name: msg.name, text: msg.text });
      renderSubs();
      break;

    case 'final':
      partials.delete(msg.from);
      lines.push({ name: msg.name, text: msg.text });
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      renderSubs();
      break;

    case 'self_partial':
    case 'self_final':
      el.self.textContent = msg.text || '—';
      break;

    case 'notice':
      setStatus(msg.message, 'wait');
      break;

    case 'error':
      if (!myPeerId) rejected = true; // nos rechazó antes de dejarnos entrar
      setStatus(msg.message, 'err');
      break;
  }
}

function onAudioFrame(e) {
  const f32 = e.inputBuffer.getChannelData(0);

  // Con altavoces, el micrófono recaptura la traducción y se realimenta. Para
  // evitarlo no se ABRE el micrófono mientras suena la voz de otra persona (si
  // ya estabas hablando, sigues; no te corta a mitad de frase). Con auriculares
  // no hace falta, y desactivarlo da doble vía real: puedes interrumpir.
  if (el.antiEcho.checked && remoteAudioPending() && !gate.open) {
    el.meter.style.width = '0%';
    return;
  }

  const { frames, level, started, ended } = gate.push(f32);
  el.meter.style.width = Math.min(100, level * 400) + '%';

  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (started) send({ type: 'speech_start' });
  for (const frame of frames) send({ type: 'audio_chunk', audio: frameToBase64(frame) });
  if (ended) send({ type: 'speech_end' });
}

// keepStatus: el servidor ya explicó por qué nos echó (sala inexistente, llena,
// caducada…) y ese motivo no se debe pisar con un "Fuera de la sala" genérico.
function stop({ keepStatus = false } = {}) {
  active = false;
  processor?.disconnect();
  processor = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  players.clear();
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  gate = null;
  myPeerId = null;
  if (ws) { ws.close(); ws = null; }

  partials.clear();
  el.meter.style.width = '0%';
  el.toggle.textContent = '🎙️ Entrar y hablar';
  el.toggle.className = '';
  if (!keepStatus) setStatus('Fuera de la sala', '');
  renderPeers([]);
}

// ── Preferencias (en este navegador) ──────────────────────────────────────────

const PREFS = 'positivos-sala';

function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({
      name: el.name.value.trim(),
      speakLang: el.speakLang.value,
      listenLang: el.listenLang.value,
      antiEcho: el.antiEcho.checked,
    }));
  } catch { /* modo incógnito o almacenamiento bloqueado */ }
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch { return {}; }
}

function init() {
  const prefs = loadPrefs();
  fillLangSelect(el.speakLang, prefs.speakLang || 'es');
  fillLangSelect(el.listenLang, prefs.listenLang || 'es');
  el.name.value = prefs.name || '';
  el.antiEcho.checked = prefs.antiEcho ?? false;

  // El código viene en el enlace compartido: /sala/equipo-ventas
  const fromPath = decodeURIComponent(location.pathname.replace(/^\/sala\/?/, ''));
  el.room.value = normalizeRoomId(fromPath);
  refreshShareLink();

  el.toggle.onclick = () => (active ? stop() : start());

  el.copyBtn.onclick = async () => {
    const url = shareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      el.copyBtn.textContent = '¡Copiado!';
    } catch {
      el.copyBtn.textContent = 'Copia el enlace de arriba';
    }
    setTimeout(() => { el.copyBtn.textContent = 'Copiar enlace'; }, 1800);
  };

  el.room.oninput = refreshShareLink;
  el.name.onchange = savePrefs;
  el.antiEcho.onchange = savePrefs;

  // Cambiar idiomas en caliente: el servidor reajusta las sesiones en la
  // siguiente frase que hable cada quien.
  for (const select of [el.speakLang, el.listenLang]) {
    select.onchange = () => {
      savePrefs();
      send({ type: 'set_langs', speakLang: el.speakLang.value, listenLang: el.listenLang.value });
    };
  }

  window.addEventListener('beforeunload', () => { if (active) stop(); });
}

init();
