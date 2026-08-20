// Sala bidireccional pública: cualquiera abre el enlace en su navegador, elige
// su idioma y escucha. Para hablar hay que pedir la palabra.
//
// Se entra ESCUCHANDO, sin micrófono. En una charla con 50 asistentes, 50
// micrófonos abiertos serían 50 sesiones de traducción disparadas por toses y
// conversaciones de fondo: caos para quien escucha y la factura multiplicada.
// El navegador ni siquiera pide permiso de micrófono hasta que pulsas "Hablar".
//
// El servidor abre una sesión de traducción por cada idioma que escuchen LOS
// DEMÁS, así que nadie recibe nunca su propia voz de vuelta.

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/room`;
const FRAME_SAMPLES = 1024; // ~43 ms a 24 kHz
const FRAME_MS = (FRAME_SAMPLES / PCM_SAMPLE_RATE) * 1000;
const MAX_LINES = 12;

const el = {};
for (const id of ['dot', 'statusText', 'toggle', 'copyBtn', 'meter', 'name', 'room',
  'speakLang', 'listenLang', 'peers', 'subs', 'self', 'antiEcho', 'shareLink',
  'mic', 'micCard', 'micHint']) {
  el[id] = document.getElementById(id);
}

let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let gate = null;
let active = false;      // dentro de la sala (escuchando)
let hasMic = false;      // tenemos la palabra concedida
let micPending = false;  // la hemos pedido y esperamos respuesta
let myPeerId = null;
let rejected = false;    // el servidor nos negó la entrada y explicó por qué
let useOpus = false;     // este navegador sabe descomprimir Opus

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
      const cls = 'peer' + (me ? ' me' : '') + (p.hasMic ? ' talking' : '');
      return `<span class="${cls}">${p.hasMic ? '🎙️ ' : ''}${esc(p.name)}${me ? ' (tú)' : ''}
        <span class="langs">· habla ${esc(langName(p.speakLang))} · oye ${esc(langName(p.listenLang))}</span></span>`;
    })
    .join('');

  const talking = peers.filter((p) => p.hasMic);
  if (!hasMic && !micPending) {
    el.micHint.innerHTML = talking.length
      ? `Hablando ahora: <b>${talking.map((p) => esc(p.name)).join(', ')}</b>.`
      : 'Entras escuchando, con el micrófono apagado. Pulsa <b>Hablar</b> cuando quieras preguntar y vuelve a pulsarlo al terminar.';
  }
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

function renderMicButton() {
  el.mic.disabled = micPending;
  if (hasMic) {
    el.mic.textContent = '🔴 Estás hablando — pulsa para callar';
    el.mic.className = 'mic-on';
  } else {
    el.mic.textContent = micPending ? '⏳ Pidiendo la palabra…' : '🎙️ Hablar';
    el.mic.className = 'mic-off';
  }
}

// ── Reproducción ──────────────────────────────────────────────────────────────

// Un reproductor por interlocutor y por códec: el servidor manda Opus si este
// navegador sabe descomprimirlo, y PCM si no.
function playerFor(peerId, codec) {
  if (!audioCtx) return null;
  const key = `${peerId}:${codec}`;
  let player = players.get(key);
  if (!player) {
    player = codec === 'opus'
      ? new OpusPlayer(audioCtx, { onFailure: fallBackToPcm })
      : new PCMPlayer(audioCtx);
    players.set(key, player);
  }
  return player;
}

// Si el descompresor falla en marcha, se pide al servidor volver a PCM: se
// gasta más ancho de banda, pero la persona sigue oyendo.
function fallBackToPcm() {
  if (!useOpus) return;
  useOpus = false;
  for (const [key, player] of players) {
    if (key.endsWith(':opus')) { player.close?.(); players.delete(key); }
  }
  send({ type: 'set_codec', codec: 'pcm' });
}

// ¿Está sonando ahora mismo la traducción de alguien?
function remoteAudioPending() {
  for (const player of players.values()) {
    if (player.pendingMs() > 60) return true;
  }
  return false;
}

// ── Entrar a la sala (solo escuchar) ──────────────────────────────────────────

async function enter() {
  const roomId = normalizeRoomId(el.room.value);
  if (!roomId) {
    setStatus('Escribe un código de sala para entrar', 'err');
    el.room.focus();
    return;
  }
  el.room.value = roomId;
  refreshShareLink();
  rejected = false;

  // Solo para reproducir. El micrófono se pide al pulsar "Hablar", así los
  // asistentes que únicamente escuchan no ven ni el aviso de permiso.
  audioCtx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
  await audioCtx.resume().catch(() => {});

  active = true;
  el.toggle.textContent = '■ Salir de la sala';
  el.toggle.className = 'stop';
  el.micCard.style.display = 'block';
  renderMicButton();

  ws = new WebSocket(`${WS_URL}?room=${encodeURIComponent(roomId)}`);
  ws.onopen = () => {
    setStatus('Conectando a la sala…', 'wait');
    send({
      type: 'join',
      room: roomId,
      name: el.name.value.trim() || 'Invitado',
      speakLang: el.speakLang.value,
      listenLang: el.listenLang.value,
      codecs: useOpus ? ['opus'] : [], // sin WebCodecs el servidor manda PCM
    });
  };
  ws.onclose = () => {
    // Si el servidor nos rechazó (sala inexistente, llena o caducada) ya mandó
    // el motivo antes de cerrar: no lo pisamos con un "conexión perdida".
    if (!active) return;
    if (rejected) { leave({ keepStatus: true }); return; }
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
      setStatus(`En la sala "${msg.room}" — estás escuchando`, 'live');
      renderPeers(msg.peers);
      break;

    case 'peers':
      renderPeers(msg.peers);
      break;

    case 'audio':
      playerFor(msg.from, msg.codec === 'opus' ? 'opus' : 'pcm')?.feed(msg.chunk);
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

    case 'mic_granted':
      micPending = false;
      hasMic = true;
      renderMicButton();
      el.micHint.textContent = 'Tienes la palabra: habla normal. Pulsa el botón al terminar para dejar el turno libre.';
      setStatus('🎙️ Estás hablando', 'live');
      break;

    case 'mic_denied':
      micPending = false;
      stopCapture();
      renderMicButton();
      el.micHint.textContent = msg.message;
      break;

    case 'mic_released':
      // El servidor nos quitó la palabra (p. ej. por estar callados mucho rato).
      hasMic = false;
      micPending = false;
      stopCapture();
      renderMicButton();
      if (msg.message) el.micHint.textContent = `Se soltó tu micrófono: ${msg.message}.`;
      setStatus('En la sala — estás escuchando', 'live');
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

// ── Micrófono ─────────────────────────────────────────────────────────────────

async function takeMic() {
  if (hasMic || micPending) return;
  micPending = true;
  renderMicButton();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    micPending = false;
    renderMicButton();
    el.micHint.textContent = 'No se pudo acceder al micrófono: ' + err.message;
    return;
  }

  const source = audioCtx.createMediaStreamSource(micStream);
  processor = audioCtx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioCtx.destination);

  gate = new VoiceGate({ frameMs: FRAME_MS });
  processor.onaudioprocess = onAudioFrame;

  send({ type: 'request_mic' });
}

function stopCapture() {
  processor?.disconnect();
  processor = null;
  micStream?.getTracks().forEach((t) => t.stop()); // apaga el piloto de grabación
  micStream = null;
  gate = null;
  el.meter.style.width = '0%';
}

function releaseMic() {
  if (!hasMic && !micPending) return;
  if (hasMic && gate?.open) send({ type: 'speech_end' }); // cierra la última frase
  hasMic = false;
  micPending = false;
  stopCapture();
  send({ type: 'release_mic' });
  renderMicButton();
  setStatus('En la sala — estás escuchando', 'live');
}

function onAudioFrame(e) {
  const f32 = e.inputBuffer.getChannelData(0);
  if (!hasMic) return; // pedida pero aún no concedida: no se manda nada

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

// ── Salir ─────────────────────────────────────────────────────────────────────

// keepStatus: el servidor ya explicó por qué nos echó (sala inexistente, llena,
// caducada…) y ese motivo no se debe pisar con un "Fuera de la sala" genérico.
function leave({ keepStatus = false } = {}) {
  active = false;
  hasMic = false;
  micPending = false;
  stopCapture();
  for (const player of players.values()) player.close?.();
  players.clear();
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  myPeerId = null;
  if (ws) { ws.close(); ws = null; }

  partials.clear();
  el.micCard.style.display = 'none';
  el.toggle.textContent = '🎧 Entrar';
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

async function init() {
  // Se comprueba antes de entrar, para poder decírselo al servidor en el 'join'.
  useOpus = await opusSupported();

  const prefs = loadPrefs();
  fillLangSelect(el.speakLang, prefs.speakLang || 'es');
  fillLangSelect(el.listenLang, prefs.listenLang || 'es');
  el.name.value = prefs.name || '';
  el.antiEcho.checked = prefs.antiEcho ?? false;

  // El código viene en el enlace compartido: /sala/equipo-ventas
  const fromPath = decodeURIComponent(location.pathname.replace(/^\/sala\/?/, ''));
  el.room.value = normalizeRoomId(fromPath);
  refreshShareLink();

  el.toggle.onclick = () => (active ? leave() : enter());
  el.mic.onclick = () => (hasMic || micPending ? releaseMic() : takeMic());

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

  window.addEventListener('beforeunload', () => { if (active) leave(); });
}

init();
