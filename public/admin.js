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
        label: el('label').value.trim(),
        minutes: Number(el('minutes').value),
        maxPeers: Number(el('maxPeers').value),
        maxSpeakers: Number(el('maxSpeakers').value),
        langs: el('langs').value,
      }),
    });
    el('label').value = '';
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
