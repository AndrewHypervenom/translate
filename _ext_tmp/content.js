// Content Script — se inyecta en teams.microsoft.com
// Crea el overlay de traducción y maneja el ducking de audio

// ── Overlay ───────────────────────────────────────────────────────────────────

const MAX_HISTORY = 3;
let duckLevel = 0.20; // 80% de reducción de volumen (configurable desde el popup)
let overlayEl = null;
let historyEntries = [];
let partialText = '';
let currentTranslation = { itemId: null, text: '', speaker: null };
const originalVolumes = new WeakMap(); // element -> volumen ORIGINAL (antes de cualquier duck)
let isDucking = false;

// ── Detección del hablante activo en Teams ────────────────────────────────────

let currentSpeaker = null;

function detectActiveSpeaker() {
  // Teams marca al hablante dominante con distintos atributos según la versión.
  // Probamos múltiples selectores de más a menos específicos.
  const candidates = [
    document.querySelector('[aria-label$=" is speaking"]'),
    document.querySelector('[aria-label$=" está hablando"]'),
    document.querySelector('[data-tid="calling-participant-item--dominant"]'),
    document.querySelector('[class*="dominant-speaker"]'),
    document.querySelector('[class*="dominantSpeaker"]'),
    document.querySelector('[class*="activeSpeaker"]'),
    document.querySelector('[class*="active-speaker"]'),
  ];
  for (const el of candidates) {
    if (!el) continue;
    // Intentar extraer nombre del aria-label
    const label = el.getAttribute('aria-label') || '';
    const fromLabel = label
      .replace(/ is speaking$/i, '')
      .replace(/ está hablando$/i, '')
      .trim();
    if (fromLabel) return fromLabel;
    // Buscar elemento de nombre dentro del card
    const nameEl = el.querySelector(
      '[class*="name"], [class*="Name"], [data-tid*="name"], [class*="displayName"]'
    );
    const fromEl = nameEl?.textContent?.trim();
    if (fromEl) return fromEl;
  }
  return null;
}

const speakerObserver = new MutationObserver(() => {
  const speaker = detectActiveSpeaker();
  if (speaker) currentSpeaker = speaker;
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildOverlay() {
  if (document.getElementById('traductorVivo-overlay')) {
    return document.getElementById('traductorVivo-overlay');
  }

  const el = document.createElement('div');
  el.id = 'traductorVivo-overlay';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div id="tv-history"></div>
    <div id="tv-current" class="tv-entry tv-current" style="display:none">
      <div class="tv-live-badge">
        <span class="tv-live-dot"></span>
        <span class="tv-live-label">TRADUCIENDO</span>
      </div>
      <div id="tv-current-speaker" class="tv-speaker" style="display:none"></div>
      <div id="tv-current-text" class="tv-translation-text"></div>
    </div>
    <div id="tv-partial" class="tv-entry tv-partial" style="display:none">
      <div class="tv-live-badge">
        <span class="tv-live-dot"></span>
        <span class="tv-live-label">EN VIVO</span>
      </div>
      <div class="tv-partial-text"></div>
    </div>
  `;

  document.body.appendChild(el);
  return el;
}

function renderHistory() {
  const histEl = document.getElementById('tv-history');
  if (!histEl) return;

  histEl.innerHTML = '';
  const recent = historyEntries.slice(-MAX_HISTORY).reverse();
  recent.forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = `tv-entry tv-age-${Math.min(i, 2)}`;
    div.innerHTML = `
      ${entry.speaker ? `<div class="tv-speaker">${escapeHtml(entry.speaker)}</div>` : ''}
      <div class="tv-translation-text">${escapeHtml(entry.translation)}</div>
      <div class="tv-original-text">${escapeHtml(entry.original)}</div>
    `;
    histEl.appendChild(div);
  });
}

// ── Ducking de audio ──────────────────────────────────────────────────────────
// Reduce el volumen de los <audio>/<video> de Teams al DUCK_LEVEL (80% reducción).
// MutationObserver cubre elementos creados DESPUÉS de que empiece el ducking.

function duckElement(el) {
  // Solo guardar el volumen original la PRIMERA vez (antes de cualquier duck)
  if (!originalVolumes.has(el)) originalVolumes.set(el, el.volume);
  el.volume = duckLevel;
}

function applyDucking() {
  isDucking = true;
  document.querySelectorAll('audio, video').forEach(duckElement);
}

function restoreVolume() {
  isDucking = false;
  document.querySelectorAll('audio, video').forEach(el => {
    const original = originalVolumes.get(el);
    if (original !== undefined) el.volume = original;
  });
}

// Cubre <audio> que Teams añade dinámicamente durante el ducking
const audioDomObserver = new MutationObserver((mutations) => {
  if (!isDucking) return;
  for (const m of mutations) {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.matches('audio, video')) duckElement(node);
      node.querySelectorAll?.('audio, video').forEach(duckElement);
    });
  }
});

// ── Mensajes del background ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {

    case 'SET_DUCK_LEVEL':
      // msg.duckLevel: % de reducción (0-100). 80 → volumen queda en 0.20
      duckLevel = 1 - Math.max(0, Math.min(100, msg.duckLevel)) / 100;
      if (isDucking) {
        document.querySelectorAll('audio, video').forEach(el => { el.volume = duckLevel; });
      }
      break;


    case 'TRANSLATION_UPDATE': {
      const { payload } = msg;
      if (!overlayEl) return;
      overlayEl.style.display = 'block';

      if (payload.type === 'committed') {
        partialText = '…';
        const partialEl = document.getElementById('tv-partial');
        const textEl = partialEl?.querySelector('.tv-partial-text');
        if (textEl) textEl.textContent = partialText;
        if (partialEl) partialEl.style.display = 'block';
      }

      if (payload.type === 'partial') {
        if (partialText === '…') partialText = '';
        partialText += payload.delta || '';
        const partialEl = document.getElementById('tv-partial');
        const textEl = partialEl?.querySelector('.tv-partial-text');
        if (textEl) textEl.textContent = partialText;
        if (partialEl) partialEl.style.display = 'block';
      }

      if (payload.type === 'source_final') {
        partialText = payload.text || '';
        const partialEl = document.getElementById('tv-partial');
        const textEl = partialEl?.querySelector('.tv-partial-text');
        if (textEl) textEl.textContent = partialText;
      }

      if (payload.type === 'transcript_done') {
        partialText = '';
        const partialEl = document.getElementById('tv-partial');
        if (partialEl) partialEl.style.display = 'none';
      }

      // Traducción construyéndose en tiempo real (streaming)
      if (payload.type === 'translation_partial') {
        if (currentTranslation.itemId !== payload.itemId) {
          currentTranslation = { itemId: payload.itemId, text: '', speaker: currentSpeaker };
        }
        currentTranslation.text += payload.delta || '';
        const currentEl = document.getElementById('tv-current');
        const currentText = document.getElementById('tv-current-text');
        const currentSpeakerEl = document.getElementById('tv-current-speaker');
        if (currentEl) currentEl.style.display = 'block';
        if (currentText) currentText.textContent = currentTranslation.text;
        if (currentSpeakerEl) {
          if (currentTranslation.speaker) {
            currentSpeakerEl.textContent = currentTranslation.speaker;
            currentSpeakerEl.style.display = 'block';
          } else {
            currentSpeakerEl.style.display = 'none';
          }
        }
      }

      if (payload.type === 'translation') {
        const currentEl = document.getElementById('tv-current');
        if (currentEl) currentEl.style.display = 'none';
        const speaker = currentTranslation.speaker || currentSpeaker || null;
        currentTranslation = { itemId: null, text: '', speaker: null };

        historyEntries.push({
          itemId: payload.itemId,
          translation: payload.translation,
          original: payload.original,
          speaker,
        });
        if (historyEntries.length > MAX_HISTORY) historyEntries.shift();
        renderHistory();
      }
      break;
    }

    case 'TTS_START':
      applyDucking();
      break;

    case 'TTS_END':
      restoreVolume();
      break;

    case 'HIDE_OVERLAY':
      if (overlayEl) overlayEl.style.display = 'none';
      historyEntries = [];
      partialText = '';
      currentTranslation = { itemId: null, text: '', speaker: null };
      renderHistory();
      restoreVolume();
      break;
  }
});

// ── Inicialización ────────────────────────────────────────────────────────────

function init() {
  overlayEl = buildOverlay();

  // Detectar hablante activo en cambios del DOM de Teams
  speakerObserver.observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['aria-label', 'class', 'data-tid'],
  });

  // Cubrir <audio>/<video> dinámicos durante el ducking
  audioDomObserver.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
