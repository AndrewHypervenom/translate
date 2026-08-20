// Idioma de la interfaz. Se detecta del navegador —que ya sabe si estás en
// Brasil, en Estados Unidos o en Colombia— y se puede cambiar a mano.
//
// Los mensajes que manda el servidor viajan con un `code`, no solo con texto,
// para poder traducirlos aquí. Si llega un código que no conocemos, se usa el
// texto que venga: así nada se queda en blanco.

const UI_LANGS = ['es', 'pt', 'en'];
const UI_LANG_STORE = 'positivos-ui-lang';

const T = {
  es: {
    'app.tagline': 'Traducción de voz en tiempo real',
    'lobby.name': 'Tu nombre',
    'lobby.namePh': 'Escribe tu nombre',
    'lobby.speak': 'Hablo',
    'lobby.listen': 'Escucho',
    'lobby.enter': 'Entrar',
    'lobby.entering': 'Entrando…',
    'room.leave': 'Salir',
    'room.talk': 'Hablar',
    'room.talking': 'Estás hablando',
    'room.requesting': 'Pidiendo turno…',
    'room.listening': 'Escuchando',
    'room.you': 'tú',
    'room.people': '{n} personas',
    'room.person': '1 persona',
    'room.nowSpeaking': '{name} está hablando',
    'room.waiting': 'Esperando a que alguien hable',
    'room.headphones': 'Uso altavoces',
    'room.headphonesHelp': 'Silencia tu micrófono mientras suena la traducción, para que no se acople.',
    'room.youSaid': 'Se te entendió',
    'mic.noVoice': 'Se capta sonido pero no se reconoce voz. Acércate al micrófono.',
    'mic.denied': 'No se pudo usar el micrófono',
    'net.connecting': 'Conectando…',
    'net.lost': 'Conexión perdida. Reconectando…',
    'net.blocked': 'No se puede abrir la conexión. Puede que tu red la bloquee: prueba con datos del móvil.',
    'net.failed': 'No se pudo entrar',
    'server.room_not_found': 'Esta sala no existe o ya se cerró.',
    'server.room_expired': 'Esta sala ha terminado.',
    'server.room_full': 'La sala está llena.',
    'server.budget_exhausted': 'Se alcanzó el límite de uso de hoy.',
    'server.mic_busy': 'Hay alguien hablando. Espera tu turno.',
    'server.mic_idle': 'Se liberó tu micrófono por inactividad.',
    'server.alone': 'Eres la única persona en la sala.',
    'server.no_target': 'Nadie necesita traducción de tu idioma ahora mismo.',
    'server.closed': 'La sala se ha cerrado.',
    'home.enter': 'Entrar',
    'home.codePh': 'Código de la sala',
    'home.help': 'Necesitas el enlace de una sala abierta.',
  },
  pt: {
    'app.tagline': 'Tradução de voz em tempo real',
    'lobby.name': 'Seu nome',
    'lobby.namePh': 'Digite seu nome',
    'lobby.speak': 'Eu falo',
    'lobby.listen': 'Eu ouço',
    'lobby.enter': 'Entrar',
    'lobby.entering': 'Entrando…',
    'room.leave': 'Sair',
    'room.talk': 'Falar',
    'room.talking': 'Você está falando',
    'room.requesting': 'Pedindo a vez…',
    'room.listening': 'Ouvindo',
    'room.you': 'você',
    'room.people': '{n} pessoas',
    'room.person': '1 pessoa',
    'room.nowSpeaking': '{name} está falando',
    'room.waiting': 'Aguardando alguém falar',
    'room.headphones': 'Uso alto-falantes',
    'room.headphonesHelp': 'Silencia seu microfone enquanto toca a tradução, para não haver eco.',
    'room.youSaid': 'Entendemos',
    'mic.noVoice': 'Há som, mas não reconhecemos voz. Aproxime-se do microfone.',
    'mic.denied': 'Não foi possível usar o microfone',
    'net.connecting': 'Conectando…',
    'net.lost': 'Conexão perdida. Reconectando…',
    'net.blocked': 'Não foi possível abrir a conexão. Sua rede pode estar bloqueando: tente com os dados do celular.',
    'net.failed': 'Não foi possível entrar',
    'server.room_not_found': 'Esta sala não existe ou já foi encerrada.',
    'server.room_expired': 'Esta sala terminou.',
    'server.room_full': 'A sala está cheia.',
    'server.budget_exhausted': 'O limite de uso de hoje foi atingido.',
    'server.mic_busy': 'Alguém está falando. Aguarde sua vez.',
    'server.mic_idle': 'Seu microfone foi liberado por inatividade.',
    'server.alone': 'Você é a única pessoa na sala.',
    'server.no_target': 'Ninguém precisa de tradução do seu idioma agora.',
    'server.closed': 'A sala foi encerrada.',
    'home.enter': 'Entrar',
    'home.codePh': 'Código da sala',
    'home.help': 'Você precisa do link de uma sala aberta.',
  },
  en: {
    'app.tagline': 'Real-time voice translation',
    'lobby.name': 'Your name',
    'lobby.namePh': 'Enter your name',
    'lobby.speak': 'I speak',
    'lobby.listen': 'I hear',
    'lobby.enter': 'Join',
    'lobby.entering': 'Joining…',
    'room.leave': 'Leave',
    'room.talk': 'Speak',
    'room.talking': 'You are speaking',
    'room.requesting': 'Requesting turn…',
    'room.listening': 'Listening',
    'room.you': 'you',
    'room.people': '{n} people',
    'room.person': '1 person',
    'room.nowSpeaking': '{name} is speaking',
    'room.waiting': 'Waiting for someone to speak',
    'room.headphones': 'Using speakers',
    'room.headphonesHelp': 'Mutes your mic while the translation plays, to avoid feedback.',
    'room.youSaid': 'We heard',
    'mic.noVoice': 'Sound detected but no speech recognised. Move closer to the microphone.',
    'mic.denied': 'Could not use the microphone',
    'net.connecting': 'Connecting…',
    'net.lost': 'Connection lost. Reconnecting…',
    'net.blocked': 'Cannot open the connection. Your network may be blocking it: try mobile data.',
    'net.failed': 'Could not join',
    'server.room_not_found': 'This room does not exist or has closed.',
    'server.room_expired': 'This room has ended.',
    'server.room_full': 'The room is full.',
    'server.budget_exhausted': "Today's usage limit has been reached.",
    'server.mic_busy': 'Someone is speaking. Wait your turn.',
    'server.mic_idle': 'Your microphone was released after being idle.',
    'server.alone': 'You are the only person in the room.',
    'server.no_target': 'Nobody needs your language translated right now.',
    'server.closed': 'The room has been closed.',
    'home.enter': 'Join',
    'home.codePh': 'Room code',
    'home.help': 'You need the link to an open room.',
  },
};

let uiLang = 'en';

function detectUiLang() {
  try {
    const saved = localStorage.getItem(UI_LANG_STORE);
    if (UI_LANGS.includes(saved)) return saved;
  } catch { /* almacenamiento bloqueado */ }

  // navigator.languages ya refleja el país: pt-BR, en-US, es-CO…
  const preferidos = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  for (const etiqueta of preferidos) {
    const base = String(etiqueta).toLowerCase().split('-')[0];
    if (UI_LANGS.includes(base)) return base;
  }
  return 'en';
}

function setUiLang(lang) {
  uiLang = UI_LANGS.includes(lang) ? lang : 'en';
  try { localStorage.setItem(UI_LANG_STORE, uiLang); } catch { /* incógnito */ }
  document.documentElement.lang = uiLang;
  applyI18n();
}

function t(key, vars) {
  let s = T[uiLang]?.[key] ?? T.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

// Traduce un mensaje del servidor por su código; si no lo conocemos, se usa el
// texto que mandó, que siempre viene.
function tServer(msg) {
  const key = `server.${msg.code}`;
  const traducido = T[uiLang]?.[key] ?? T.en[key];
  return traducido || msg.message || '';
}

function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}
