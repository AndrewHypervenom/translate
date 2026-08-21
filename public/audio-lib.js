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

// Muchos equipos (Windows con ciertos drivers, iOS) NO admiten forzar el
// AudioContext a 24 kHz y lanzan NotSupportedError. Antes eso reventaba la
// entrada a la sala sin decir nada. Se intenta, y si no se puede se usa la
// frecuencia del equipo y se remuestrea lo que haga falta.
function createAudioContext() {
  try {
    return new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
  } catch {
    return new AudioContext();
  }
}

// Remuestreo lineal a 24 kHz, que es lo único que entiende el modelo. Para voz
// es más que suficiente; no merece la pena algo más caro.
function resampleTo24k(f32, fromRate) {
  if (fromRate === PCM_SAMPLE_RATE) return f32;
  const ratio = fromRate / PCM_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(f32.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = f32[idx];
    const b = idx + 1 < f32.length ? f32[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
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
  constructor(ctx, {
    leadTime = 0.03,
    destination = null,
    // El modelo entrega la voz traducida MÁS RÁPIDO de lo que se puede
    // escuchar. Si cada trozo se encola detrás del anterior sin más, la cola
    // crece intervención tras intervención y la voz se va quedando cada vez
    // más atrás (medido: +1 s por intervención, sin tope). Por eso, cuando hay
    // retraso acumulado se reproduce un poco más deprisa para recuperarlo sin
    // perder ni una palabra.
    catchUpAfter = 0.8,   // segundos de cola a partir de los cuales se acelera
    maxRate = 1.3,        // tope de velocidad: más se nota demasiado
    maxBacklog = 3.5,     // si la cola se dispara, se salta al directo
  } = {}) {
    this.ctx = ctx;
    this.leadTime = leadTime;
    this.destination = destination;
    this.catchUpAfter = catchUpAfter;
    this.maxRate = maxRate;
    this.maxBacklog = maxBacklog;
    this.nextTime = 0;
    this.started = false;
    // Trozos ya programados. Hay que guardarlos para poder CALLARLOS si se
    // salta al directo: si no, el audio nuevo suena encima del viejo y con una
    // cola grande se oyen decenas de voces solapadas a la vez.
    this.programados = new Set();
  }

  // Corta de raíz todo lo que estuviera programado y aún no se ha oído.
  descartarCola() {
    for (const src of this.programados) {
      try { src.stop(); } catch { /* ya terminó */ }
    }
    this.programados.clear();
  }

  // PCM16 en base64: lo que manda el servidor cuando no hay compresión.
  feed(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const samples = bytes.length / 2;
    const channel = new Float32Array(samples);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    this.feedSamples(channel);
  }

  // Punto común de reproducción: por aquí entran tanto el PCM como lo que sale
  // del descompresor de Opus, así la cola y el encadenado son los mismos.
  //
  // El `sampleRate` NO se puede dar por supuesto: Opus trabaja por dentro a
  // 48 kHz y el navegador entrega las muestras a esa frecuencia aunque se le
  // pida 24 kHz. Tratarlas como de 24 kHz reproduce el doble de lento y una
  // octava más grave. El navegador remuestrea solo si el buffer declara bien
  // su frecuencia.
  feedSamples(channel, sampleRate = PCM_SAMPLE_RATE) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const samples = channel.length;
    if (!samples) return;

    const buf = this.ctx.createBuffer(1, samples, sampleRate);
    buf.getChannelData(0).set(channel);

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

    // Cuánta voz hay esperando turno: es exactamente lo que el oyente va por
    // detrás de lo que ya se dijo.
    const cola = this.nextTime - now;
    let rate = 1;
    if (cola > this.maxBacklog) {
      // Descolgados del todo (un parón de red, por ejemplo): se salta a lo que
      // se está diciendo ahora. Se pierde algo, pero es peor oír algo de hace
      // medio minuto. Hay que CALLAR lo ya programado antes de reprogramar, o
      // lo nuevo suena encima de lo viejo.
      this.descartarCola();
      this.nextTime = now + this.leadTime;
    } else if (cola > this.catchUpAfter) {
      // Acelerón suave, proporcional al retraso: recupera sin perder palabras.
      rate = Math.min(this.maxRate, 1 + (cola - this.catchUpAfter) * 0.15);
    }
    if (src.playbackRate) src.playbackRate.value = rate;

    this.programados.add(src);
    src.onended = () => this.programados.delete(src);
    src.start(this.nextTime);
    this.nextTime += samples / sampleRate / rate; // dura menos si se acelera
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

// ── Reproductor de audio comprimido en Opus ───────────────────────────────────
// El servidor manda ~32 kbps en vez de 512, unas 12 veces menos datos, con la
// voz intacta. Descomprime con WebCodecs y entrega las muestras al PCMPlayer,
// que sigue siendo quien encadena y programa la reproducción.
//
// No todos los navegadores traen WebCodecs, así que esto solo se usa cuando
// `opusSupported()` dice que sí; el resto sigue recibiendo PCM.

async function opusSupported() {
  if (typeof AudioDecoder === 'undefined') return false;
  try {
    const { supported } = await AudioDecoder.isConfigSupported({
      codec: 'opus',
      sampleRate: PCM_SAMPLE_RATE,
      numberOfChannels: 1,
    });
    return !!supported;
  } catch {
    return false;
  }
}

class OpusPlayer {
  // onFailure: si el descompresor peta a mitad, avisamos para volver a PCM y
  // que la persona no se quede sin oír nada.
  constructor(ctx, { onFailure = null } = {}) {
    this.pcm = new PCMPlayer(ctx);
    this.timestamp = 0;
    this.broken = false;
    this.onFailure = onFailure;

    this.decoder = new AudioDecoder({
      output: (audioData) => {
        try {
          const samples = new Float32Array(audioData.numberOfFrames);
          audioData.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
          // Se usa la frecuencia REAL que devuelve el descompresor: Opus suele
          // entregar a 48 kHz aunque se configure a 24, y darlo por supuesto
          // hace que la voz suene grave y a cámara lenta.
          this.pcm.feedSamples(samples, audioData.sampleRate || PCM_SAMPLE_RATE);
        } finally {
          audioData.close(); // sin esto se acumula memoria del descompresor
        }
      },
      error: (err) => this.fail(err),
    });
    this.decoder.configure({ codec: 'opus', sampleRate: PCM_SAMPLE_RATE, numberOfChannels: 1 });
  }

  fail(err) {
    if (this.broken) return;
    this.broken = true;
    console.warn('Opus falló, se vuelve a PCM:', err?.message || err);
    this.onFailure?.();
  }

  feed(base64) {
    if (this.broken) return;
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // Todas las tramas de Opus son independientes.
      this.decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: this.timestamp,
        data: bytes,
      }));
      this.timestamp += 20000; // 20 ms por trama, en microsegundos
    } catch (err) {
      this.fail(err);
    }
  }

  pendingMs() { return this.pcm.pendingMs(); }

  close() {
    try { this.decoder.close(); } catch { /* ya cerrado */ }
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
    // Cola tras la última voz. Cada milisegundo aquí es un milisegundo que el
    // oyente espera de más, así que se recorta a lo justo para no comerse la
    // sílaba final.
    holdMs = 400,
    absFloor = 0.006,
    openFactor = 3.0,
    closeFactor = 2.0,
    noiseDoublingMs = 1000,
    // TOPE del piso de ruido. Es LA protección contra quedarse sordo: sin él,
    // en una sala con ruido el umbral trepa pegado a la propia voz hasta
    // superarla y el micrófono deja de oír para siempre, por mucho que hables.
    // Atado al umbral absoluto: la parte adaptativa puede como mucho triplicar
    // el mínimo, nunca subir hasta tapar una voz floja.
    maxNoiseFloor = absFloor,
    // Nadie habla 20 s sin una sola pausa: si la puerta lleva tanto abierta es
    // ruido constante. Se cierra para que el modelo reciba el fin de turno —
    // sin él se queda sin la señal de cerrar la frase y pierde el hilo.
    maxOpenMs = 20000,
  } = {}) {
    this.prerollFrames = Math.max(1, Math.round(prerollMs / frameMs));
    this.holdFrames = Math.max(1, Math.round(holdMs / frameMs));
    this.maxOpenFrames = Math.max(1, Math.round(maxOpenMs / frameMs));
    this.absFloor = absFloor;
    this.openFactor = openFactor;
    this.closeFactor = closeFactor;
    this.maxNoiseFloor = maxNoiseFloor;
    // Cuánto sube el piso de ruido por frame si el nivel nunca baja.
    this.noiseRise = Math.pow(2, frameMs / noiseDoublingMs);

    this.noiseFloor = absFloor / 2;
    this.preroll = [];
    this.hold = 0;
    this.open = false;
    this.openFrames = 0;
  }

  // Devuelve { frames, level, started, ended }. `frames` son los Float32Array
  // que hay que enviar (vacío si es silencio).
  push(f32) {
    const level = rms(f32);
    const openAt = Math.max(this.absFloor, this.noiseFloor * this.openFactor);
    const closeAt = Math.max(this.absFloor * 0.6, this.noiseFloor * this.closeFactor);
    const voiced = this.open ? level > closeAt : level > openAt;

    // Se actualiza SIEMPRE, también con la puerta abierta: si no, un ruido
    // constante la abre una vez y ya no se cierra jamás. El tope es lo que
    // impide que, de tanto subir, acabe por encima de la voz.
    this.noiseFloor = Math.min(
      Math.max(0.0005, Math.min(this.noiseFloor * this.noiseRise, level)),
      this.maxNoiseFloor
    );

    const frames = [];
    let started = false;
    let ended = false;

    if (voiced) {
      if (!this.open) {
        this.open = true;
        this.openFrames = 0;
        started = true;
        frames.push(...this.preroll);
        this.preroll = [];
      }
      this.hold = this.holdFrames;
      frames.push(f32);

      // Lleva demasiado abierta de un tirón: es ruido, no una frase. Se cierra
      // el turno para que el modelo reciba su señal de fin y no pierda el hilo.
      if (++this.openFrames >= this.maxOpenFrames) {
        this.open = false;
        this.hold = 0;
        this.openFrames = 0;
        ended = true;
      }
    } else if (this.hold > 0) {
      this.hold--;
      frames.push(f32);
      if (this.hold === 0) {
        this.open = false;
        this.openFrames = 0;
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
    this.openFrames = 0;
  }
}
