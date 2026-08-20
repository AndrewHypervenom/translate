// Panel de administración: crear salas, ver el consumo y cerrarlas.
// La clave nunca se manda en la URL (quedaría en logs e historial): viaja en
// la cabecera x-admin-key y se guarda solo en este navegador.

const KEY_STORE = 'positivos-admin-key';
const el = (id) => document.getElementById(id);

let key = '';
let timer = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function show(id, text) {
  const box = el(id);
  box.innerHTML = text;
  box.style.display = text ? 'block' : 'none';
  if (id === 'ok' && text) setTimeout(() => { box.style.display = 'none'; }, 20000);
}

async function api(path, options = {}) {
  const res = await fetch(`/admin/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ── Idiomas permitidos ────────────────────────────────────────────────────────
// Se eligen marcándolos, no escribiéndolos: un dedazo aquí sale caro. Cada
// idioma extra es otra sesión de traducción por cada persona que hable, así
// que se avisa del multiplicador en el momento.

const LANGS_STORE = 'positivos-admin-langs';
const PRESELECCION = ['es', 'pt'];

function idiomasElegidos() {
  return [...document.querySelectorAll('#langs input:checked')].map((i) => i.value);
}

function refreshLangsHint() {
  const elegidos = idiomasElegidos();
  const hint = el('langsHint');

  if (elegidos.length === 0) {
    hint.className = 'muted warnbox';
    hint.innerHTML = '<b>Sin marcar nada, cada persona elige el idioma que quiera.</b> '
      + 'En una sala grande eso puede multiplicar el coste varias veces. Marca los que vayáis a usar.';
    return;
  }
  if (elegidos.length === 1) {
    hint.className = 'muted warnbox';
    hint.innerHTML = 'Con un solo idioma no hay nada que traducir: todos escucharían el original. Marca al menos dos.';
    return;
  }

  // Quien habla necesita una sesión por cada OTRO idioma que se escuche.
  const multiplicador = elegidos.length - 1;
  const nombres = elegidos.map(langName).join(', ');
  hint.className = 'muted';
  hint.innerHTML = `<b>${nombres}.</b> Cada minuto que alguien hable cuesta `
    + `<b>${multiplicador} ${multiplicador === 1 ? 'minuto' : 'minutos'}</b> de traducción`
    + (multiplicador === 1 ? '.' : `, porque hay que traducirlo a ${multiplicador} idiomas a la vez.`)
    + ' No depende de cuánta gente haya.';
}

function renderLangChips() {
  let guardados;
  try { guardados = JSON.parse(localStorage.getItem(LANGS_STORE)); } catch { /* incógnito */ }
  const marcados = Array.isArray(guardados) ? guardados : PRESELECCION;

  el('langs').innerHTML = LANGUAGES.map((l) => `
    <label class="chip${marcados.includes(l.code) ? ' on' : ''}">
      <input type="checkbox" value="${l.code}"${marcados.includes(l.code) ? ' checked' : ''}>
      <span class="tick">✓</span>${esc(l.name)}
    </label>`).join('');

  for (const input of document.querySelectorAll('#langs input')) {
    input.onchange = () => {
      input.closest('.chip').classList.toggle('on', input.checked);
      try { localStorage.setItem(LANGS_STORE, JSON.stringify(idiomasElegidos())); } catch { /* incógnito */ }
      refreshLangsHint();
    };
  }
  refreshLangsHint();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderBudget(budget) {
  const pct = budget.limitMinutes ? Math.min(100, (budget.usedMinutes / budget.limitMinutes) * 100) : 0;
  el('usedLabel').textContent = `${budget.usedMinutes} / ${budget.limitMinutes} min`;
  const bar = el('bar');
  bar.className = 'bar' + (pct >= 100 ? ' over' : pct >= 75 ? ' warn' : '');
  bar.firstElementChild.style.width = pct + '%';
  el('budgetHint').textContent = budget.remainingMinutes > 0
    ? `Quedan ${budget.remainingMinutes} minutos de traducción hoy. El contador se reinicia mañana.`
    : 'Límite alcanzado: la traducción está detenida hasta mañana.';
}

function renderRooms(list) {
  if (!list.length) {
    el('rooms').innerHTML = '<div class="muted">No hay ninguna sala abierta. Crea una arriba.</div>';
    return;
  }
  el('rooms').innerHTML = `
    <table>
      <thead><tr><th>Código</th><th>Dentro</th><th>Hablando</th><th>Gastado</th><th>Le queda</th><th></th></tr></thead>
      <tbody>${list.map(roomRow).join('')}</tbody>
    </table>`;

  for (const room of list) {
    el(`copy-${room.code}`).onclick = () => copyLink(room.code);
    el(`close-${room.code}`).onclick = () => closeRoom(room.code);
  }
}

function roomRow(room) {
  const who = room.peers.length
    ? room.peers.map((p) => `${esc(p.name)} (habla ${esc(langName(p.speakLang))}, oye ${esc(langName(p.listenLang))})`).join(' · ')
    : 'nadie dentro';
  const talking = room.speaking?.length
    ? `🎙️ ${room.speaking.map(esc).join(', ')}`
    : '<span class="who">nadie</span>';
  return `
    <tr>
      <td class="code">${esc(room.code)}
        ${room.label ? `<span class="who">${esc(room.label)}</span>` : ''}
      </td>
      <td>${room.peerCount}/${room.maxPeers}<span class="who">${who}</span></td>
      <td>${talking}<span class="who">máx. ${room.maxSpeakers} a la vez${
        room.langs?.length ? ` · solo ${room.langs.join('/')}` : ' · idiomas libres'}</span></td>
      <td>${room.minutesUsed} min</td>
      <td>${room.minutesLeft} min</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="ghost" id="copy-${esc(room.code)}">Copiar enlace</button>
        <button class="danger" id="close-${esc(room.code)}">Cerrar</button>
      </td>
    </tr>`;
}

// ── Acciones ──────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const state = await api('/state');
    renderBudget(state.budget);
    renderRooms(state.rooms);
    show('err', '');
  } catch (e) {
    show('err', esc(e.message));
  }
}

async function createRoom() {
  try {
    const room = await api('/rooms', {
      method: 'POST',
      body: JSON.stringify({
        code: el('code').value.trim(), // vacío = al azar
        label: el('label').value.trim(),
        minutes: Number(el('minutes').value),
        maxPeers: Number(el('maxPeers').value),
        maxSpeakers: Number(el('maxSpeakers').value),
        langs: idiomasElegidos().join(','),
      }),
    });
    el('label').value = '';
    el('code').value = '';
    show('ok', `Sala creada. Comparte este enlace:<code>${esc(room.url)}</code>`);
    await copyLink(room.code);
    refresh();
  } catch (e) {
    show('err', esc(e.message));
  }
}

async function copyLink(code) {
  const url = `${location.origin}/sala/${code}`;
  try { await navigator.clipboard.writeText(url); } catch { /* sin permiso de portapapeles */ }
  const btn = el(`copy-${code}`);
  if (btn) {
    btn.textContent = '¡Copiado!';
    setTimeout(() => { btn.textContent = 'Copiar enlace'; }, 1800);
  }
}

async function closeRoom(code) {
  if (!confirm(`¿Cerrar la sala "${code}"? Se echará a quien esté dentro.`)) return;
  try {
    await api(`/rooms/${code}/close`, { method: 'POST' });
    refresh();
  } catch (e) {
    show('err', esc(e.message));
  }
}

// ── Entrada ───────────────────────────────────────────────────────────────────

async function unlock(candidate) {
  key = candidate;
  try {
    await api('/state');
  } catch (e) {
    key = '';
    show('gateErr', esc(e.message));
    return false;
  }
  try { localStorage.setItem(KEY_STORE, candidate); } catch { /* incógnito */ }
  el('gate').style.display = 'none';
  el('panel').style.display = 'block';
  renderLangChips();
  refresh();
  timer = setInterval(refresh, 5000); // el consumo se mueve mientras hablan
  return true;
}

el('enter').onclick = () => unlock(el('key').value.trim());
el('key').onkeydown = (e) => { if (e.key === 'Enter') unlock(el('key').value.trim()); };
el('create').onclick = createRoom;
el('refresh').onclick = refresh;

// Si ya entraste en este navegador, no vuelve a pedir la clave.
const saved = (() => { try { return localStorage.getItem(KEY_STORE); } catch { return null; } })();
if (saved) unlock(saved);
