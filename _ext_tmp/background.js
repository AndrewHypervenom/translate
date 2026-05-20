// Service Worker — coordina captura de pestaña, offscreen document y mensajes

let activeTabId = null;
let isCapturing = false;

// ── Lifecycle del offscreen document ──────────────────────────────────────────

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'Capturar audio de la pestaña de Teams para traducción en tiempo real',
  });
}

async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// ── Flujo de inicio ────────────────────────────────────────────────────────────

async function handleStart(tabId, config) {
  activeTabId = tabId;

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    return { ok: false, error: `Error al capturar la pestaña: ${err.message}` };
  }

  await ensureOffscreen();

  await chrome.storage.session.set({ captureState: { isCapturing: true, tabId } });

  // chrome.offscreen.createDocument() espera a que el documento esté listo,
  // por lo que el listener del offscreen ya está registrado cuando llegamos aquí.
  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START',
    streamId,
    config,
    tabId,
  }).catch(() => {});

  if (config.duckLevel !== undefined) {
    chrome.tabs.sendMessage(tabId, { type: 'SET_DUCK_LEVEL', duckLevel: config.duckLevel }).catch(() => {});
  }

  isCapturing = true;
  return { ok: true };
}

// ── Flujo de parada ────────────────────────────────────────────────────────────

async function handleStop() {
  isCapturing = false;

  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
  await closeOffscreen();
  await chrome.storage.session.set({ captureState: { isCapturing: false } });

  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'HIDE_OVERLAY' }).catch(() => {});
  }
  activeTabId = null;
}

// ── Bus de mensajes ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START') {
    handleStart(msg.tabId, msg.config).then(sendResponse);
    return true;
  }

  if (msg.type === 'STOP') {
    handleStop().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'SET_CONFIG') {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_SET_CONFIG', config: msg.config }).catch(() => {});
    if (msg.config.duckLevel !== undefined && activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { type: 'SET_DUCK_LEVEL', duckLevel: msg.config.duckLevel }).catch(() => {});
    }
    return false;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({ isCapturing, activeTabId });
    return false;
  }

  // Mensajes del offscreen — relay al content script y al popup
  if (
    msg.type === 'TRANSLATION_UPDATE' ||
    msg.type === 'TTS_START' ||
    msg.type === 'TTS_END'
  ) {
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
    }
    return false;
  }

  if (msg.type === 'STATUS_UPDATE' || msg.type === 'ERROR') {
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }
});

// ── Limpiar si la pestaña de Teams se cierra ──────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    handleStop();
  }
});

// ── Restaurar estado al reiniciar el SW ───────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  const { captureState } = await chrome.storage.session.get('captureState');
  if (captureState?.isCapturing) {
    await chrome.storage.session.set({ captureState: { isCapturing: false } });
    isCapturing = false;
    activeTabId = null;
  }
});
