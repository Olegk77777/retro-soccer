// Синтезированный свисток арбитра (WebAudio, без файлов): классическая
// «горошина» — два прямоугольных генератора ~2,3 кГц с трелью 36 Гц через
// полосовой фильтр. Живые сэмплы и комментатор придут в Фазе 4 (Howler);
// этот модуль — их дешёвый ретро-предшественник.
//
// Политика автоплея (iOS/Chrome): до первого касания или клавиши звуковой
// контекст «спит» — тогда playWhistle честно возвращает false, а вызывающий
// может повторить свисток позже (интро добирает его в момент розыгрыша).

let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  return ctx;
}

// Разблокировка звука первым жестом пользователя — слушатели живут всегда:
// система дешёвая, а свистки после первого же тапа начинают звучать
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => {
    const c = getCtx();
    if (c && c.state === 'suspended') c.resume();
  }, { passive: true });
}

// ===== Гул трибун (синтез, без единого mp3) =====
// Стадион звучит как отфильтрованный шум: ровный гул + всплески на моментах.
// Синтез, а не сэмплы: файлов качать не надо, зацикливать нечего, и звук
// живой — громкость и тембр ведёт сама игра. Комментатор (ElevenLabs) придёт
// отдельно, он про голос, а не про фон.

let crowd = null;

// Розовый шум (спад ~3 дБ/октаву) — ближе к голосу толпы, чем белый
function makeNoiseBuffer(c, seconds = 4) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
  }
  // Сшиваем края кроссфейдом, иначе на стыке петли слышен щелчок
  const fade = Math.floor(c.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[i] = d[i] * k + d[len - fade + i] * (1 - k);
  }
  return buf;
}

// Заводится сама при первом же звуке: до жеста пользователя браузер молчит
function ensureCrowd() {
  const c = getCtx();
  if (!c || c.state !== 'running') return null;
  if (crowd) return crowd;

  const src = c.createBufferSource();
  src.buffer = makeNoiseBuffer(c);
  src.loop = true;

  // Тембр: далёкая трибуна — почти без верха
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 760;
  lp.Q.value = 0.6;
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 120;

  const gain = c.createGain();
  gain.gain.value = 0.055;   // ровный фон

  // Медленное «дыхание» зала: гул никогда не стоит на месте
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.08;
  const lfoDepth = c.createGain();
  lfoDepth.gain.value = 0.016;
  lfo.connect(lfoDepth);
  lfoDepth.connect(gain.gain);

  src.connect(hp);
  hp.connect(lp);
  lp.connect(gain);
  gain.connect(c.destination);
  src.start();
  lfo.start();

  crowd = { ctx: c, gain, lp, base: 0.055 };
  return crowd;
}

// Напряжение эпизода 0..1: атака у ворот — зал гудит громче и «ближе»
export function setCrowdIntensity(x) {
  const cr = ensureCrowd();
  if (!cr) return;
  const k = Math.max(0, Math.min(1, x));
  const t = cr.ctx.currentTime;
  cr.gain.gain.setTargetAtTime(cr.base * (1 + k * 1.6), t, 0.6);
  cr.lp.frequency.setTargetAtTime(760 + k * 900, t, 0.8);
}

// Взрыв трибун: гол (strength 1), опасный момент (0.4–0.6).
// Резкая атака и долгий спад — так и ревёт стадион.
export function crowdCheer(strength = 1) {
  const cr = ensureCrowd();
  if (!cr) return;
  const s = Math.max(0.2, Math.min(1, strength));
  const t = cr.ctx.currentTime;
  const peak = cr.base * (1 + s * 7);
  cr.gain.gain.cancelScheduledValues(t);
  cr.gain.gain.setValueAtTime(cr.gain.gain.value, t);
  cr.gain.gain.linearRampToValueAtTime(peak, t + 0.18 + (1 - s) * 0.4);
  cr.gain.gain.setTargetAtTime(cr.base, t + 0.5 + s * 1.5, 1.2 + s * 2.5);
  cr.lp.frequency.cancelScheduledValues(t);
  cr.lp.frequency.setValueAtTime(cr.lp.frequency.value, t);
  cr.lp.frequency.linearRampToValueAtTime(760 + s * 2400, t + 0.2); // рёв ярче гула
  cr.lp.frequency.setTargetAtTime(760, t + 1.2, 2.2);
}

// Шипение файеров на трибуне: пиротехника горит с характерным «пшшш».
// Синтез тот же, что у толпы, — розовый шум, но полоса высокая и узкая:
// шипение живёт в 2–5 кГц, ниже начинается гул зала и мешает ему.
// Звук ДАЛЁКИЙ (сектор в сотне метров), поэтому громкость скромная, а
// нарастание медленное: пачка файеров разгорается пару секунд.
export function flareHiss(count = 1, seconds = 12) {
  const c = getCtx();
  if (!c || c.state !== 'running') return false;
  const n = Math.max(1, Math.min(10, count));
  const t0 = c.currentTime + 0.05;

  const src = c.createBufferSource();
  src.buffer = makeNoiseBuffer(c, 3);
  src.loop = true;

  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3100;
  bp.Q.value = 0.9;
  // Розовый шум завален по верхам — поднимаем «песок», иначе выйдет шорох
  const tilt = c.createBiquadFilter();
  tilt.type = 'highshelf';
  tilt.frequency.value = 2600;
  tilt.gain.value = 9;

  const out = c.createGain();
  const peak = 0.012 * Math.sqrt(n);   // вдвое больше факелов ≠ вдвое громче
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.linearRampToValueAtTime(peak, t0 + 1.6);
  out.gain.setValueAtTime(peak, t0 + seconds * 0.6);
  out.gain.setTargetAtTime(0.0001, t0 + seconds * 0.6, seconds * 0.25);

  src.connect(tilt);
  tilt.connect(bp);
  bp.connect(out);
  out.connect(c.destination);
  src.start(t0);
  src.stop(t0 + seconds + 2);
  return true;
}

// Свисток длиной duration сек. Возвращает true, если реально зазвучал.
export function playWhistle(duration = 0.8) {
  const c = getCtx();
  if (!c) return false;
  if (c.state === 'suspended') {
    c.resume(); // асинхронно; если жеста ещё не было — останется спящим
    if (c.state !== 'running') return false;
  }
  const t0 = c.currentTime + 0.02;
  const t1 = t0 + duration;

  // Тон: пара генераторов с расстройкой ~100 Гц — биения дают «металл»
  const osc1 = c.createOscillator();
  osc1.type = 'square';
  osc1.frequency.setValueAtTime(2320, t0);
  osc1.frequency.linearRampToValueAtTime(2250, t1); // дыхание садится — тон плывёт вниз
  const osc2 = c.createOscillator();
  osc2.type = 'square';
  osc2.frequency.value = 2418;

  // Трель «горошины»: громкость дрожит ~36 Гц
  const am = c.createGain();
  am.gain.value = 0.55;
  const trill = c.createOscillator();
  trill.type = 'sine';
  trill.frequency.value = 36;
  const trillDepth = c.createGain();
  trillDepth.gain.value = 0.45;
  trill.connect(trillDepth);
  trillDepth.connect(am.gain);

  // Полосовой фильтр вычищает квадратные гармоники до свистка
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2330;
  bp.Q.value = 4.5;

  // Огибающая: резкая атака, ровное тело, быстрый спад
  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
  out.gain.setValueAtTime(0.3, Math.max(t0 + 0.02, t1 - 0.1));
  out.gain.exponentialRampToValueAtTime(0.0001, t1);

  osc1.connect(am);
  osc2.connect(am);
  am.connect(bp);
  bp.connect(out);
  out.connect(c.destination);
  osc1.start(t0);
  osc2.start(t0);
  trill.start(t0);
  osc1.stop(t1 + 0.05);
  osc2.stop(t1 + 0.05);
  trill.stop(t1 + 0.05);
  return true;
}
