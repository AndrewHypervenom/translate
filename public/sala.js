// Sala pública: se abre el enlace, se elige idioma y se escucha. Para hablar
// hay que pedir turno.
//
// Se entra ESCUCHANDO, sin micrófono. En una charla con decenas de asistentes,
// otros tantos micrófonos abiertos serían otras tantas sesiones de traducción
// disparadas por toses y ruido de fondo: caos y factura multiplicada. El
// navegador ni siquiera pide permiso hasta que se pulsa "Hablar".
//
// El servidor abre una sesión por cada idioma que escuchen LOS DEMÁS, así que
// nadie recibe nunca su propia voz de vuelta.

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/room`;
const FRAME_SAMPLES = 1024;
const MAX_LINES = 6;

const el = {};
for (const id of ['dot', 'statusText', 'statusBar', 'name', 'speakLang', 'listenLang',
  'enterBtn', 'leaveBtn', 'langBtn', 'langCode', 'echoBtn', 'lobby', 'room',
  'subs', 'mic', 'micLabel', 'meter']) {
  el[id] = document.getElementById(id);
}

let roomCode = '';
let roomLangs = [];
let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let gate = null;
let active = false;
let hasMic = false;
let micPending = false;
let myPeerId = null;
let rejected = false;
let antiEcho = false;

// La traducción se OYE leyendo el texto con el sintetizador del navegador. Es
// instantáneo: no viaja por la red ni se comprime. La voz que genera el modelo
// se descartó porque llegaba con segundos de retraso y rellena de silencio.
let lector = null;

const partials = new Map();
let lines = [];

// ── Utilidades ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Debe coincidir con normalizeRoomId() de server.js.
function normalizeRoomId(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

function setStatus(text, cls = '') {
  el.statusText.textContent = text || '';
  el.dot.className = 'dot' + (cls ? ' ' + cls : '');
  el.statusBar.classList.toggle('alert', cls === 'err');
  el.statusBar.style.visibility = text ? 'visible' : 'hidden';
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ── Subtítulos ────────────────────────────────────────────────────────────────

function renderSubs() {
  const items = [
    ...lines.map((l, i) => ({ ...l, cls: i < lines.length - 2 ? 'old' : '' })),
    ...[...partials.values()].map((p) => ({ ...p, cls: 'live' })),
  ];

  if (!items.length) {
    el.subs.innerHTML = `<div class="empty">${esc(t('room.waiting'))}</div>`;
    return;
  }
  el.subs.innerHTML = items.map((l) => `
    <div class="line ${l.cls}">
      <span class="who">${esc(l.name)}</span>
      <div class="text">${esc(l.text)}</div>
    </div>`).join('');
  el.subs.scrollTop = el.subs.scrollHeight;
}

function renderPeople(count, speaking) {
  if (hasMic || micPending) return; // el estado del micro manda sobre el resto
  const gente = count === 1 ? t('room.person') : t('room.people', { n: count });
  const quien = speaking?.length ? ` · ${t('room.nowSpeaking', { name: speaking[0].name })}` : '';
  setStatus(gente + quien, 'live');
}

// ── Entrar ────────────────────────────────────────────────────────────────────

async function enter() {
  el.enterBtn.disabled = true;
  el.enterBtn.textContent = t('lobby.entering');

  audioCtx = createAudioContext();
  await audioCtx.resume().catch(() => {});
  lector = new LectorDeVoz({ lang: el.listenLang.value });
  lector.calentar(); // deja la voz lista para que la primera frase no tarde

  active = true;
  el.lobby.style.display = 'none';
  el.room.style.display = 'flex';
  el.leaveBtn.hidden = false;
  el.echoBtn.hidden = false;
  renderSubs();
  renderMic();
  openSocket(roomCode);
}

// `retomarMic`: si al caerse la conexión estábamos hablando, se vuelve a pedir
// turno al reconectar para no dejar a nadie con el botón en rojo y mudo.
function openSocket(code, retomarMic = false) {
  ws = new WebSocket(`${WS_URL}?room=${encodeURIComponent(code)}`);
  const socket = ws;

  // Si la conexión ni llega a abrirse, el navegador puede tardar mucho en
  // avisar. Sin esto la persona se queda mirando una pantalla muda.
  const abreTarde = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) setStatus(t('net.blocked'), 'err');
  }, 12000);

  ws.onopen = () => {
    clearTimeout(abreTarde);
    setStatus(t('net.connecting'), 'wait');
    send({
      type: 'join',
      room: code,
      name: el.name.value.trim() || t('room.you'),
      speakLang: el.speakLang.value,
      listenLang: el.listenLang.value,
    });
    if (retomarMic) send({ type: 'request_mic' });
  };
  ws.onclose = () => {
    clearTimeout(abreTarde);
    if (!active) return;
    if (rejected) { leave({ keepStatus: true }); return; }
    scheduleRejoin();
  };
  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleMessage(msg);
  };
}

// Reconexión automática: las caídas pasan (el móvil cambia de wifi a datos, un
// proxy corta una conexión callada) y nadie va a volver a entrar a mano en
// mitad de una charla.
let rejoinTimer = null;
let rejoinAttempts = 0;

function scheduleRejoin() {
  if (rejoinTimer || !active) return;
  const delay = Math.min(1000 * 2 ** rejoinAttempts, 10000);
  rejoinAttempts++;
  setStatus(t('net.lost'), 'wait');
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (!active) return;
    const teniaMic = hasMic;
    hasMic = false; micPending = false;
    openSocket(roomCode, teniaMic);
  }, delay);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      myPeerId = msg.peerId;
      rejoinAttempts = 0;
      applyRoomLangs(msg);
      renderPeople(msg.peers?.length || 1, msg.peers?.filter((p) => p.hasMic));
      break;

    case 'peers':
      renderPeople(msg.count ?? msg.peers?.length ?? 1,
        msg.speaking ?? msg.peers?.filter((p) => p.hasMic));
      break;

    case 'partial':
      partials.set(msg.from, { name: msg.name, text: msg.text });
      lector?.parcial(msg.from, msg.text);
      renderSubs();
      break;

    case 'final':
      lector?.final(msg.from, msg.text);
      partials.delete(msg.from);
      lines.push({ name: msg.name, text: msg.text });
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      renderSubs();
      break;

    case 'langs_set':
      el.speakLang.value = msg.speakLang;
      el.listenLang.value = msg.listenLang;
      break;

    case 'mic_granted':
      micPending = false; hasMic = true;
      renderMic();
      setStatus(t('room.talking'), 'live');
      break;

    case 'mic_denied':
      micPending = false; stopCapture(); renderMic();
      setStatus(tServer(msg), 'wait');
      break;

    case 'mic_released':
      hasMic = false; micPending = false; stopCapture(); renderMic();
      setStatus(tServer(msg), 'wait');
      break;

    case 'notice':
      setStatus(tServer(msg), 'wait');
      break;

    case 'error':
      if (!myPeerId) rejected = true;
      setStatus(tServer(msg), 'err');
      break;
  }
}

// La sala puede venir con los idiomas fijados por quien la creó: se recortan
// los selectores para que nadie elija uno de más (cada idioma extra es otra
// sesión de traducción y multiplica el coste).
function applyRoomLangs(msg) {
  if (Array.isArray(msg.langs) && msg.langs.length) {
    roomLangs = msg.langs;
    fillLangSelect(el.speakLang, msg.speakLang || el.speakLang.value, roomLangs);
    fillLangSelect(el.listenLang, msg.listenLang || el.listenLang.value, roomLangs);
  }
  if (msg.speakLang) el.speakLang.value = msg.speakLang;
  if (msg.listenLang) el.listenLang.value = msg.listenLang;
}

// ── Micrófono ─────────────────────────────────────────────────────────────────

function renderMic() {
  el.mic.disabled = micPending;
  el.mic.className = hasMic ? 'on' : '';
  el.mic.textContent = hasMic ? '⏹' : '🎙️';
  el.micLabel.textContent = micPending ? t('room.requesting')
    : hasMic ? t('room.talking') : t('room.talk');
}

async function takeMic() {
  if (hasMic || micPending) return;
  micPending = true;
  renderMic();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    micPending = false; renderMic();
    setStatus(`${t('mic.denied')}: ${err.message}`, 'err');
    return;
  }

  const source = audioCtx.createMediaStreamSource(micStream);
  processor = audioCtx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioCtx.destination);

  // El AudioContext puede no estar a 24 kHz si el equipo no lo admitía.
  gate = new VoiceGate({ frameMs: (FRAME_SAMPLES / audioCtx.sampleRate) * 1000 });
  processor.onaudioprocess = onAudioFrame;
  send({ type: 'request_mic' });
}

function stopCapture() {
  processor?.disconnect();
  processor = null;
  micStream?.getTracks().forEach((t) => t.stop()); // apaga el piloto de grabación
  micStream = null;
  gate = null;
  el.meter.style.width = '0';
}

function releaseMic() {
  if (!hasMic && !micPending) return;
  if (hasMic && gate?.open) send({ type: 'speech_end' });
  hasMic = false; micPending = false;
  stopCapture();
  send({ type: 'release_mic' });
  renderMic();
  setStatus('', '');
}

// Si el micrófono capta sonido pero el detector de voz no lo deja pasar, la
// persona habla y no sale nada, sin forma de saber por qué. Se avisa.
let framesConSonido = 0;
let framesEnviados = 0;

function watchMicHealth(level, seEnvio) {
  if (level > 0.01) framesConSonido++;
  if (seEnvio) framesEnviados++;
  if (framesConSonido > 120 && framesEnviados === 0) {
    setStatus(t('mic.noVoice'), 'wait');
    framesConSonido = 0;
  }
  if (framesEnviados > 0) { framesConSonido = 0; framesEnviados = 0; }
}

function onAudioFrame(e) {
  const f32 = e.inputBuffer.getChannelData(0);
  if (!hasMic) return;

  const { frames, level, started, ended } = gate.push(f32);
  el.meter.style.width = Math.min(100, level * 400) + '%';
  watchMicHealth(level, frames.length > 0);

  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (started) send({ type: 'speech_start' });
  const rate = audioCtx.sampleRate;
  for (const frame of frames) {
    send({ type: 'audio_chunk', audio: frameToBase64(resampleTo24k(frame, rate)) });
  }
  if (ended) send({ type: 'speech_end' });
}

// ── Salir ─────────────────────────────────────────────────────────────────────

function leave({ keepStatus = false } = {}) {
  active = false; hasMic = false; micPending = false;
  if (rejoinTimer) { clearTimeout(rejoinTimer); rejoinTimer = null; }
  rejoinAttempts = 0;
  stopCapture();
  lector?.callar();
  lector = null;
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  myPeerId = null;
  if (ws) { ws.close(); ws = null; }

  partials.clear();
  lines = [];
  el.room.style.display = 'none';
  el.lobby.style.display = 'flex';
  el.leaveBtn.hidden = true;
  el.echoBtn.hidden = true;
  el.enterBtn.disabled = false;
  el.enterBtn.textContent = t('lobby.enter');
  if (!keepStatus) setStatus('', '');
}

// ── Preferencias ──────────────────────────────────────────────────────────────

const PREFS = 'positivos-sala';

function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({
      name: el.name.value.trim(),
      speakLang: el.speakLang.value,
      listenLang: el.listenLang.value,
      antiEcho,
    }));
  } catch { /* incógnito */ }
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch { return {}; }
}

// ── Arranque ──────────────────────────────────────────────────────────────────

// Se consultan los datos públicos de la sala antes de entrar: así los
// selectores solo ofrecen los idiomas permitidos y se avisa cuanto antes si el
// enlace ya no sirve.
async function loadRoomInfo(code, prefs) {
  let info;
  try {
    info = await (await fetch(`/api/sala/${encodeURIComponent(code)}`)).json();
  } catch {
    return;
  }
  if (!info.exists) {
    setStatus(t('server.room_not_found'), 'err');
    el.enterBtn.disabled = true;
    return;
  }
  if (info.langs?.length) {
    roomLangs = info.langs;
    // El idioma de la interfaz es la mejor pista de qué quiere oír la persona:
    // quien abre el enlace desde Brasil no debería tener que tocar nada.
    const porDefecto = roomLangs.includes(uiLang) ? uiLang : roomLangs[0];
    fillLangSelect(el.speakLang, prefs.speakLang && roomLangs.includes(prefs.speakLang) ? prefs.speakLang : porDefecto, roomLangs);
    fillLangSelect(el.listenLang, prefs.listenLang && roomLangs.includes(prefs.listenLang) ? prefs.listenLang : porDefecto, roomLangs);
  }
  if (info.full) setStatus(t('server.room_full'), 'wait');
}

function cycleUiLang() {
  setUiLang(UI_LANGS[(UI_LANGS.indexOf(uiLang) + 1) % UI_LANGS.length]);
  el.langCode.textContent = uiLang.toUpperCase();
  renderMic();
  if (active) renderSubs();
}

async function init() {
  setUiLang(detectUiLang());
  el.langCode.textContent = uiLang.toUpperCase();

  const prefs = loadPrefs();
  const porDefecto = UI_LANGS.includes(uiLang) ? uiLang : 'es';
  fillLangSelect(el.speakLang, prefs.speakLang || porDefecto);
  fillLangSelect(el.listenLang, prefs.listenLang || porDefecto);
  el.name.value = prefs.name || '';
  antiEcho = prefs.antiEcho ?? false;
  el.echoBtn.classList.toggle('on', antiEcho);
  el.echoBtn.textContent = antiEcho ? '🔈' : '🎧';
  setStatus('', '');

  // El código SIEMPRE viene del enlace; no se puede escribir a mano.
  roomCode = normalizeRoomId(decodeURIComponent(location.pathname.replace(/^\/sala\/?/, '')));
  if (!roomCode) { location.replace('/'); return; }
  loadRoomInfo(roomCode, prefs);

  // enter() es asíncrono: sin este catch, cualquier fallo dentro (por ejemplo
  // que el equipo no admita el AudioContext) se perdía en silencio y la persona
  // pulsaba sin que pasara nada.
  el.enterBtn.onclick = () => enter().catch((err) => {
    console.error(err);
    setStatus(`${t('net.failed')}: ${err?.message || err}`, 'err');
    leave({ keepStatus: true });
  });
  el.leaveBtn.onclick = () => leave();
  el.mic.onclick = () => (hasMic || micPending ? releaseMic() : takeMic());
  el.langBtn.onclick = cycleUiLang;
  el.echoBtn.onclick = () => {
    antiEcho = !antiEcho;
    el.echoBtn.classList.toggle('on', antiEcho);
    el.echoBtn.textContent = antiEcho ? '🔈' : '🎧';
    savePrefs();
  };

  el.name.onchange = savePrefs;
  for (const select of [el.speakLang, el.listenLang]) {
    select.onchange = () => {
      savePrefs();
      lector?.setLang(el.listenLang.value);
      send({ type: 'set_langs', speakLang: el.speakLang.value, listenLang: el.listenLang.value });
    };
  }

  // El navegador solo deja sonar el audio tras un gesto de la persona, y lo
  // suspende si la pestaña pasa a segundo plano. Cualquier toque o volver a la
  // pestaña lo reintenta: si no, se queda viendo subtítulos sin oír nada.
  const reactivarAudio = () => {
    if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  };
  for (const evento of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(evento, reactivarAudio, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reactivarAudio();
  });

  window.addEventListener('beforeunload', () => { if (active) leave(); });
}

init();
