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
// frase: en cuanto hay una coma, un punto o suficientes palabras sueltas.
// Así se empieza a oír mientras la persona sigue hablando.
const CORTE = /[.,;:!?…]+\s|[.,;:!?…]+$/;
const PALABRAS_MINIMAS = 7;

class LectorDeVoz {
  constructor({ lang = 'es', rate = 1.05 } = {}) {
    this.lang = lang;
    this.rate = rate;
    this.dicho = new Map();   // quién -> cuánto texto suyo se ha leído ya
    this.hablando = false;
  }

  setLang(lang) { this.lang = lang; }

  // Texto parcial: se lee solo lo nuevo que ya forme una unidad con sentido.
  parcial(from, texto) {
    const yaDicho = this.dicho.get(from) || 0;
    const nuevo = texto.slice(yaDicho);
    if (!nuevo) return;

    // ¿Hay un corte natural en lo nuevo? Se lee hasta ahí.
    const corte = nuevo.search(CORTE);
    if (corte >= 0) {
      const m = nuevo.slice(corte).match(CORTE);
      const hasta = corte + (m ? m[0].length : 1);
      this.decir(nuevo.slice(0, hasta));
      this.dicho.set(from, yaDicho + hasta);
      return;
    }
    // Sin corte, pero ya son bastantes palabras: se lee igual para no esperar.
    const palabras = nuevo.trim().split(/\s+/);
    if (palabras.length >= PALABRAS_MINIMAS) {
      const hasta = nuevo.lastIndexOf(' ');
      if (hasta > 0) {
        this.decir(nuevo.slice(0, hasta));
        this.dicho.set(from, yaDicho + hasta);
      }
    }
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
