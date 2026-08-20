// Idiomas soportados, compartidos por el popup y la sala.
const LANGUAGES = [
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português (BR)' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'zh', name: '中文' },
  { code: 'ko', name: '한국어' },
  { code: 'ru', name: 'Русский' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'pl', name: 'Polski' },
];

function langName(code) {
  return LANGUAGES.find((l) => l.code === code)?.name || code;
}

// `only` limita las opciones a esos códigos: en una sala solo se ofrecen los
// idiomas que permitió quien la creó, en vez de la lista entera de 15.
function fillLangSelect(el, selected, only) {
  const opciones = only?.length ? LANGUAGES.filter((l) => only.includes(l.code)) : LANGUAGES;
  el.innerHTML = opciones
    .map((l) => `<option value="${l.code}"${l.code === selected ? ' selected' : ''}>${l.name}</option>`)
    .join('');
}
