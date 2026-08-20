// Audio compartido por el offscreen (captura de pestaña) y la sala (micrófono).
// Todo el pipeline trabaja en PCM16 mono a 24 kHz, que es lo que espera el
// modelo de traducción.

const PCM_SAMPLE_RATE = 24000;

function f32ToI16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}

function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function frameToBase64(f32) {
  return bufToBase64(f32ToI16(f32).buffer);
}

function rms(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  return Math.sqrt(sum / f32.length);
}

// ── Reproductor PCM en streaming ──────────────────────────────────────────────
// Encadena los trozos que van llegando sobre un AudioContext compartido: uno
// por interlocutor, para que dos personas hablando a la vez no se pisen la cola.
// Chrome limita el número de AudioContext por página, así que nunca se crea uno
// por reproductor.

class PCMPlayer {
  constructor(ctx, { leadTime = 0.03, destination = null } = {}) {
    this.ctx = ctx;
    this.leadTime = leadTime;
    this.destination = destination;
    this.nextTime = 0;
    this.started = false;
  }

  feed(base64) {
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const samples = bytes.length / 2;
    const buf = this.ctx.createBuffer(1, samples, PCM_SAMPLE_RATE);
    const channel = buf.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.destination || this.ctx.destination);

    const now = this.ctx.currentTime;
    // Colchón inicial corto: si se oyen chasquidos por jitter de red, subirlo.
    if (!this.started) {
      this.nextTime = now + this.leadTime;
      this.started = true;
    } else if (this.nextTime < now) {
      this.nextTime = now + 0.01;
    }
    src.start(this.nextTime);
    this.nextTime += samples / PCM_SAMPLE_RATE;
  }

  // Milisegundos de audio aún encolado.
  pendingMs() {
    return Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
  }

  reset() {
    this.started = false;
    this.nextTime = 0;
  }
}

// ── VAD (detección de voz) ────────────────────────────────────────────────────
// Mandar silencio o ruido de fondo al modelo es LA causa de que invente
// palabras: sin voz que traducir, rellena. Este filtro solo deja pasar audio
// con voz, con un umbral que se adapta al ruido de cada sala en vez de un valor
// fijo (un umbral fijo o deja pasar ruido constante, o se come las voces
// suaves).
//
//   · piso de ruido estimado por mínimo reciente: baja al instante cuando la
//     sala se calla y sube poco a poco mientras el nivel se mantenga alto. La
//     voz tiene pausas entre palabras que lo devuelven abajo; un ruido constante
//     (ventilador, línea, aire acondicionado) no las tiene, así que el umbral
//     acaba subiendo por encima y se cierra la puerta, en vez de quedarse
//     abierta mandando ruido al modelo para siempre.
//   · histéresis: cuesta más abrir que cerrar, así no parpadea a mitad de frase.
//   · pre-roll: se guardan los últimos frames de silencio y se envían al abrir,
//     porque el arranque de una frase siempre queda por debajo del umbral.
//   · cola (hold): se sigue enviando un rato tras la última voz para no cortar
//     la sílaba final.

class VoiceGate {
  constructor({
    frameMs = 43,
    prerollMs = 300,
    holdMs = 600,
    absFloor = 0.006,
    openFactor = 3.0,
    closeFactor = 1.6,
    noiseDoublingMs = 1000,
  } = {}) {
    this.prerollFrames = Math.max(1, Math.round(prerollMs / frameMs));
    this.holdFrames = Math.max(1, Math.round(holdMs / frameMs));
    this.absFloor = absFloor;
    this.openFactor = openFactor;
    this.closeFactor = closeFactor;
    // Cuánto sube el piso de ruido por frame si el nivel nunca baja.
    this.noiseRise = Math.pow(2, frameMs / noiseDoublingMs);

    this.noiseFloor = absFloor / 2;
    this.preroll = [];
    this.hold = 0;
    this.open = false;
  }

  // Devuelve { frames, level, started, ended }. `frames` son los Float32Array
  // que hay que enviar (vacío si es silencio).
  push(f32) {
    const level = rms(f32);
    const openAt = Math.max(this.absFloor, this.noiseFloor * this.openFactor);
    const closeAt = Math.max(this.absFloor * 0.6, this.noiseFloor * this.closeFactor);
    const voiced = this.open ? level > closeAt : level > openAt;

    // Se actualiza SIEMPRE, también con la puerta abierta: si no, un ruido
    // constante la abre una vez y ya no se cierra jamás.
    this.noiseFloor = Math.min(
      Math.max(0.0005, Math.min(this.noiseFloor * this.noiseRise, level)),
      0.05
    );

    const frames = [];
    let started = false;
    let ended = false;

    if (voiced) {
      if (!this.open) {
        this.open = true;
        started = true;
        frames.push(...this.preroll);
        this.preroll = [];
      }
      this.hold = this.holdFrames;
      frames.push(f32);
    } else if (this.hold > 0) {
      this.hold--;
      frames.push(f32);
      if (this.hold === 0) {
        this.open = false;
        ended = true;
      }
    } else {
      this.preroll.push(new Float32Array(f32));
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
    }

    return { frames, level, started, ended };
  }

  reset() {
    this.preroll = [];
    this.hold = 0;
    this.open = false;
  }
}
