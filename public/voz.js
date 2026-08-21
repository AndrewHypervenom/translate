// Lector de texto en voz alta con el sintetizador del propio navegador.
//
// La voz que genera el modelo llega tarde y a trompicones: el modelo la produce
// más rápido de lo que se puede escuchar, la rellena con silencio y hay que
// comprimirla, mandarla y descomprimirla. El TEXTO, en cambio, llega perfecto y
// en tiempo real. Leerlo aquí mismo es instantáneo: no viaja por la red, no se
// comprime y no cuesta nada.
//
// A cambio, se pierde el tono de quien habla: es una voz sintética. Es el
// intercambio que hace falta para que una reunión fluya.

function vozDisponible() {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

// Corta el texto en trozos que ya se pueden leer sin esperar al final de la
// frase, para empezar a oír mientras la persona sigue hablando.
//
// Cada trozo es una lectura independiente y el sintetizador mete una pausa
// entre lecturas: cuantos más trozos, más entrecortado suena. Por eso se corta
// LO MENOS posible — solo en final de frase, o en una coma si el trozo ya se
// ha hecho largo — en vez de en cada coma.
const FIN_DE_FRASE = /[.!?…]+(\s|$)/;
const PAUSA_MENOR = /[,;:]+(\s|$)/;
const PALABRAS_PARA_CORTAR = 10;  // sin puntuación, se corta al llegar aquí
const PALABRAS_PARA_COMA = 10;    // por debajo de esto, una coma no justifica cortar
// El ARRANQUE va aparte: en cuanto hay unas pocas palabras se empieza a leer,
// para que la voz salga a la vez que el texto. Los umbrales altos de arriba se
// aplican al resto de la frase, que es donde importa que suene fluido.
const PALABRAS_PARA_EMPEZAR = 1;

class LectorDeVoz {
  constructor({ lang = 'es', rate = 1.25 } = {}) {
    this.lang = lang;
    this.rate = rate;
    this.dicho = new Map();   // quién -> cuánto texto suyo se ha leído ya
    this.hablando = false;
  }

  setLang(lang) { this.lang = lang; }

  // La primera lectura tarda en arrancar porque el navegador carga la voz justo
  // entonces, y eso se nota como retraso aunque el texto ya esté. Se le da un
  // empujón mudo al entrar para que la voz esté lista antes de la primera frase.
  calentar() {
    if (!vozDisponible()) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.lang = IDIOMA_VOZ[this.lang] || this.lang;
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  // Texto parcial: se lee solo lo nuevo que ya forme una unidad con sentido.
  parcial(from, texto) {
    const yaDicho = this.dicho.get(from) || 0;
    const nuevo = texto.slice(yaDicho);
    if (!nuevo) return;

    const palabras = nuevo.trim() ? nuevo.trim().split(/\s+/).length : 0;
    const arrancando = yaDicho === 0; // aún no se ha leído nada de esta frase

    // Final de frase: siempre se lee, ahí la pausa es natural.
    const hasta = this.buscarCorte(nuevo, FIN_DE_FRASE);
    if (hasta > 0) return this.soltar(from, yaDicho, nuevo, hasta);

    // Coma o punto y coma. Al arrancar basta con unas pocas palabras, para que
    // la voz salga a la vez que el texto; después se exige más para no
    // trocear la frase y que suene entrecortada.
    const minimo = arrancando ? PALABRAS_PARA_EMPEZAR : PALABRAS_PARA_COMA;
    if (palabras >= minimo) {
      const coma = this.buscarCorte(nuevo, PAUSA_MENOR);
      if (coma > 0) return this.soltar(from, yaDicho, nuevo, coma);
    }

    // Sin puntuación a la vista: se corta en un espacio para no hacer esperar.
    if (palabras >= (arrancando ? PALABRAS_PARA_EMPEZAR + 1 : PALABRAS_PARA_CORTAR)) {
      const espacio = nuevo.lastIndexOf(' ');
      if (espacio > 0) this.soltar(from, yaDicho, nuevo, espacio);
    }
  }

  buscarCorte(texto, patron) {
    const pos = texto.search(patron);
    if (pos < 0) return -1;
    const m = texto.slice(pos).match(patron);
    return pos + (m ? m[0].length : 1);
  }

  soltar(from, yaDicho, nuevo, hasta) {
    this.decir(nuevo.slice(0, hasta));
    this.dicho.set(from, yaDicho + hasta);
  }

  // Frase cerrada: se lee lo que quede sin leer y se olvida a esa persona.
  final(from, texto) {
    const yaDicho = this.dicho.get(from) || 0;
    const resto = texto.slice(yaDicho).trim();
    if (resto) this.decir(resto);
    this.dicho.delete(from);
  }

  decir(texto) {
    const limpio = texto.trim();
    if (!limpio || !vozDisponible()) return;
    const u = new SpeechSynthesisUtterance(limpio);
    u.lang = IDIOMA_VOZ[this.lang] || this.lang;
    u.rate = this.rate;
    u.onstart = () => { this.hablando = true; };
    u.onend = u.onerror = () => { this.hablando = speechSynthesis.speaking; };
    speechSynthesis.speak(u); // el navegador ya encola por su cuenta
  }

  callar() {
    this.dicho.clear();
    this.hablando = false;
    if (vozDisponible()) speechSynthesis.cancel();
  }
}

// El sintetizador quiere etiquetas completas para elegir bien la voz.
const IDIOMA_VOZ = {
  es: 'es-ES', pt: 'pt-BR', en: 'en-US', fr: 'fr-FR', de: 'de-DE',
  it: 'it-IT', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR', ru: 'ru-RU',
  ar: 'ar-SA', hi: 'hi-IN', nl: 'nl-NL', tr: 'tr-TR', pl: 'pl-PL',
};
