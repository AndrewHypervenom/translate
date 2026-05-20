// Popup — controles de la extensión

const LANGUAGES = [
  { code: 'pt', name: 'Português (BR)' },
  { code: 'es', name: 'Español' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ja', name: '日本語' },
  { code: 'zh', name: '中文' },
  { code: 'it', name: 'Italiano' },
  { code: 'ar', name: 'العربية' },
  { code: 'ko', name: '한국어' },
  { code: 'ru', name: 'Русский' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'pl', name: 'Polski' },
];

// Estado local del popup
let state = {
  sourceLang: 'pt',
  targetLang: 'es',
  duckLevel: 50, // % de reducción (0 = sin reducción, 100 = silencio total)
  isCapturing: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTeamsUrl(url) {
  return (
    url?.startsWith('https://teams.microsoft.com') ||
    url?.startsWith('https://teams.live.com')
  );
}

async function findTeamsTab() {
  // Primero: pestaña activa en la ventana actual
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && isTeamsUrl(activeTab.url)) return activeTab;

  // Fallback: cualquier pestaña de Teams
  const tabs = await chrome.tabs.query({
    url: ['https://teams.microsoft.com/*', 'https://teams.live.com/*'],
  });
  return tabs[0] || null;
}

function buildConfig() {
  return {
    sourceLang: state.sourceLang,
    targetLang: state.targetLang,
    duckLevel: state.duckLevel,
  };
}

// ── UI ────────────────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  stopped:    { dotClass: '',            label: 'Detenido',      btnClass: 'start', btnText: 'Iniciar Traducción',  disabled: false },
  connecting: { dotClass: 'connecting',  label: 'Conectando…',  btnClass: 'start', btnText: 'Conectando…',         disabled: true  },
  active:     { dotClass: 'active',      label: 'Traduciendo',  btnClass: 'stop',  btnText: 'Detener Traducción',  disabled: false },
  error:      { dotClass: 'error',       label: 'Error',         btnClass: 'start', btnText: 'Reintentar',          disabled: false },
};

function setUI(status) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.stopped;
  document.getElementById('statusDot').className = `status-dot ${cfg.dotClass}`.trim();
  document.getElementById('statusLabel').textContent = cfg.label;

  const btn = document.getElementById('mainBtn');
  btn.className = `main-btn ${cfg.btnClass}`;
  btn.textContent = cfg.btnText;
  btn.disabled = cfg.disabled;

  if (status === 'active') {
    btn.onclick = handleStop;
  } else if (!cfg.disabled) {
    btn.onclick = handleStart;
  }
}

function showError(msg) {
  const box = document.getElementById('error-box');
  box.textContent = msg;
  box.style.display = 'block';
  setTimeout(() => { box.style.display = 'none'; }, 8000);
}

function populateSelect(id, selected) {
  const el = document.getElementById(id);
  el.innerHTML = LANGUAGES
    .map(l => `<option value="${l.code}"${l.code === selected ? ' selected' : ''}>${l.name}</option>`)
    .join('');
}

function refreshDuckSlider() {
  const slider = document.getElementById('duckSlider');
  const label  = document.getElementById('duckLabel');
  if (!slider || !label) return;
  slider.value = state.duckLevel;
  if (state.duckLevel === 0) {
    label.textContent = 'Sin reducción';
  } else if (state.duckLevel === 100) {
    label.textContent = 'Silencio total';
  } else {
    label.textContent = `${state.duckLevel}% reducción`;
  }
}

// ── Inicio / parada ───────────────────────────────────────────────────────────

async function handleStart() {
  const tab = await findTeamsTab();
  if (!tab) {
    showError('No se encontró ninguna pestaña de Microsoft Teams. Abre una reunión primero.');
    return;
  }

  setUI('connecting');
  document.getElementById('error-box').style.display = 'none';

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'START',
      tabId: tab.id,
      config: buildConfig(),
    });
  } catch (err) {
    showError(`Error al iniciar: ${err.message}`);
    setUI('stopped');
    return;
  }

  if (!response?.ok) {
    showError(response?.error || 'No se pudo iniciar la captura.');
    setUI('stopped');
    return;
  }

  state.isCapturing = true;
  // La UI cambia a 'active' cuando llegue STATUS_UPDATE:active desde el offscreen
}

async function handleStop() {
  try {
    await chrome.runtime.sendMessage({ type: 'STOP' });
  } catch { /* ignorar si el SW ya no responde */ }
  state.isCapturing = false;
  setUI('stopped');
}

// ── Guardar / cargar configuración ───────────────────────────────────────────

async function saveConfig() {
  await chrome.storage.sync.set({
    sourceLang: state.sourceLang,
    targetLang: state.targetLang,
    duckLevel: state.duckLevel,
  });

  if (state.isCapturing) {
    chrome.runtime.sendMessage({ type: 'SET_CONFIG', config: buildConfig() }).catch(() => {});
  }
}

async function loadConfig() {
  const saved = await chrome.storage.sync.get(['sourceLang', 'targetLang', 'duckLevel']);
  state.sourceLang = saved.sourceLang || 'pt';
  state.targetLang = saved.targetLang || 'es';
  state.duckLevel  = saved.duckLevel  ?? 50;
}

// ── Mensajes del background (actualizaciones de estado) ──────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') {
    if (msg.status === 'active')       setUI('active');
    if (msg.status === 'disconnected') setUI('error');
  }
  if (msg.type === 'ERROR') {
    showError(msg.message);
    setUI('error');
    state.isCapturing = false;
  }
});

// ── Inicialización ────────────────────────────────────────────────────────────

async function init() {
  await loadConfig();

  // Poblar selectores
  populateSelect('sourceLang', state.sourceLang);
  populateSelect('targetLang', state.targetLang);
  refreshDuckSlider();

  // Consultar estado actual al background
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }).catch(() => null);
  if (status?.isCapturing) {
    state.isCapturing = true;
    setUI('active');
  } else {
    setUI('stopped');
  }

  // Habilitar botón principal
  document.getElementById('mainBtn').disabled = false;

  // ── Listeners ───────────────────────────────────────────────────────────────

  document.getElementById('sourceLang').addEventListener('change', (e) => {
    state.sourceLang = e.target.value;
    saveConfig();
  });

  document.getElementById('targetLang').addEventListener('change', (e) => {
    state.targetLang = e.target.value;
    saveConfig();
  });

  document.getElementById('swapBtn').addEventListener('click', () => {
    [state.sourceLang, state.targetLang] = [state.targetLang, state.sourceLang];
    populateSelect('sourceLang', state.sourceLang);
    populateSelect('targetLang', state.targetLang);
    saveConfig();
  });

  document.getElementById('duckSlider').addEventListener('input', (e) => {
    state.duckLevel = Number(e.target.value);
    refreshDuckSlider();
    saveConfig();
  });

  document.getElementById('mainBtn').addEventListener('click', () => {
    if (state.isCapturing) {
      handleStop();
    } else {
      handleStart();
    }
  });
}

init();
