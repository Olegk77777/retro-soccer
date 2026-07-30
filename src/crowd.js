// Живой стадион из записей (ElevenLabs Sound Effects, банк audio/crowd/).
//
// До 30.07.2026 зал синтезировался розовым шумом прямо в WebAudio. Синтез
// честно давал «шум», но не давал ГОЛОСОВ: отфильтрованный шум одинаков в
// любую секунду, а настоящая трибуна всё время что-то делает — гудит,
// охает, хлопает, дудит. Теперь фон играют записи, а игра ими дирижирует.
//
// Устройство слоями (все крутятся в одном такте, слышимость решает гейн):
//   base        — ровный гул, крутится весь матч;
//   murmur_high — тот же зал взвинченный, подмешивается на атаках;
//   horns/drums — фанатский сектор, приходит ВОЛНАМИ в спокойные минуты;
//   события     — гол, «ах» на сейве, аплодисменты, свист — разово поверх.
//
// Смена настроения — это КРОССФЕЙД ДВУХ ЗАПИСЕЙ, а не фильтр на одной:
// у взвинченного зала другой не только объём, но и состав звука (крики,
// хлопки), и подъёмом среза такого не получишь.
//
// Весь звук идёт через тракт телевизора (моно, узкая полоса, компрессия) —
// та же мысль, что у CRT-прохода в картинке: стилизация маскирует бедность
// материала. Восемь клипов не могут звучать как настоящий стадион, но
// восемь клипов ЧЕРЕЗ ДИНАМИК ТЕЛЕВИЗОРА 98-го — вполне.

import { CONFIG } from './config.js';
import { audioCtx, audioLive, onAudioUnlock } from './audioctx.js';

const DIR = 'audio/crowd/';

// loop — вечная петля (ElevenLabs сшил её концы), у остальных одиночный запуск.
// early — грузится первой волной: без этих двух зала нет вообще.
const BANK = {
  base: { file: 'base.mp3', loop: true, early: true },
  murmur_high: { file: 'murmur_high.mp3', loop: true, early: true },
  horns: { file: 'horns.mp3', loop: true },
  drums_chant: { file: 'drums_chant.mp3', loop: true },
  goal_roar: { file: 'goal_roar.mp3' },
  near_miss: { file: 'near_miss.mp3' },
  applause: { file: 'applause.mp3' },
  whistles: { file: 'whistles.mp3' },
};

const buffers = {};        // имя → AudioBuffer
let mix = null;            // узлы микшера, пока звук не разрешён — null
let started = false;       // петли фона уже запущены
let loading = false;
let intensity = 0;         // 0..1, куда ведёт игра
let ultras = null;         // состояние волны фанатского сектора
let muted = false;
let ticks = 0;             // кадров пришло из главного цикла (диагностика)
const fired = {};          // сколько раз сыграно каждое событие (приёмка)

// ===== Загрузка =====

// Сколько каналов держать в памяти. Тракт телевизора всё равно сводит звук
// в моно, а decodeAudioData отдаёт стерео в частоте контекста: банк из
// восьми клипов занимал 61 МБ, из них ровно половина — второй канал,
// который выбрасывался на первом же узле. Сводим сами, при подготовке.
function readers(buf) {
  const mono = CONFIG.audio.tv.mono;
  const n = buf.numberOfChannels;
  if (!mono || n === 1) {
    return { count: n, at: (ch, i) => buf.getChannelData(ch)[i] };
  }
  const chans = [];
  for (let ch = 0; ch < n; ch++) chans.push(buf.getChannelData(ch));
  return {
    count: 1,
    at: (_ch, i) => { let s = 0; for (const c of chans) s += c[i]; return s / n; },
  };
}

// MP3 нельзя зациклить встык: кодер добавляет тишину-задержку в начало
// (~1105 сэмплов) и добивает нулями хвост, и на стыке петли слышен провал.
// Заголовок Xing про это знает, но браузеры чтят его по-разному, поэтому не
// полагаемся на декодер: срезаем по фрейму с каждого края сами и сшиваем
// края коротким кроссфейдом — тем же приёмом, которым сшивался синтетический
// шум до появления записей. Замер: скачок на стыке 7.3 шага сэмпла у сырого
// буфера из декодера против 1.1 после подготовки.
function prepareLoop(ctx, buf) {
  const A = CONFIG.audio.loopTrim;
  const cut = Math.round(A.padSamples);
  const cross = Math.round(ctx.sampleRate * A.crossfade);
  const len = buf.length - cut * 2;
  if (len <= cross * 2) return buf;              // клип короче обрезки — не трогаем

  const src = readers(buf);
  const out = ctx.createBuffer(src.count, len - cross, ctx.sampleRate);
  for (let ch = 0; ch < src.count; ch++) {
    const dst = out.getChannelData(ch);
    for (let i = 0; i < dst.length; i++) dst[i] = src.at(ch, cut + i);
    // Хвост, оставшийся за краем петли, вливаем в её начало по косинусу:
    // равная мощность, иначе на стыке проседает громкость
    for (let i = 0; i < cross; i++) {
      const k = 0.5 - 0.5 * Math.cos((i / cross) * Math.PI);
      dst[i] = dst[i] * k + src.at(ch, cut + len - cross + i) * (1 - k);
    }
  }
  return out;
}

// У разового клипа хвост трогать нельзя (он и есть спад), режем только
// ведущую тишину декодера — иначе событие приходит с задержкой в 25 мс.
function prepareOneShot(ctx, buf) {
  const cut = Math.round(CONFIG.audio.loopTrim.padSamples);
  if (buf.length <= cut * 2) return buf;
  const src = readers(buf);
  const out = ctx.createBuffer(src.count, buf.length - cut, ctx.sampleRate);
  for (let ch = 0; ch < src.count; ch++) {
    const dst = out.getChannelData(ch);
    for (let i = 0; i < dst.length; i++) dst[i] = src.at(ch, cut + i);
  }
  return out;
}

async function fetchClip(name) {
  const spec = BANK[name];
  const ctx = audioCtx();
  if (!ctx || buffers[name]) return;
  try {
    const res = await fetch(DIR + spec.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.arrayBuffer();
    // decodeAudioData работает и на спящем контексте — ждать жеста не надо
    const buf = await ctx.decodeAudioData(raw);
    buffers[name] = spec.loop ? prepareLoop(ctx, buf) : prepareOneShot(ctx, buf);
  } catch (e) {
    // Один потерянный клип не должен утаскивать за собой весь зал:
    // без него просто не будет своего события, остальное играет
    console.warn(`[crowd] не загрузился ${spec.file}:`, e.message);
  }
}

// Стартует загрузку банка. Фон — первой волной, всё остальное следом:
// на планшете по сотовой сети важно, чтобы гул появился как можно раньше,
// а дудки и аплодисменты подождут.
export function loadCrowd() {
  if (loading) return;
  loading = true;
  const early = Object.keys(BANK).filter((n) => BANK[n].early);
  const rest = Object.keys(BANK).filter((n) => !BANK[n].early);
  Promise.all(early.map(fetchClip))
    .then(() => { ensureMix(); startBeds(); })
    .then(() => Promise.all(rest.map(fetchClip)))
    .catch((e) => console.warn('[crowd] банк не собрался:', e));
  // Файлы могут доехать раньше первого касания — тогда петли заводит жест
  onAudioUnlock(() => { ensureMix(); startBeds(); });
}

// Есть ли чем играть зал. false — значит sfx.js крутит синтез как раньше.
export function crowdReady() {
  return !!buffers.base;
}

// ===== Микшер =====

function ensureMix() {
  const ctx = audioLive();
  if (!ctx || mix) return mix;
  const A = CONFIG.audio;

  const master = ctx.createGain();
  master.gain.value = muted ? 0 : A.master;

  // Тракт телевизора. Компрессор стоит ПЕРЕД полосой намеренно: в вещании
  // сигнал жмут до передатчика, и именно компрессия делает рёв гола
  // «плотным», а не просто громким.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = A.tv.compThreshold;
  comp.ratio.value = A.tv.compRatio;
  comp.attack.value = 0.008;
  comp.release.value = 0.28;

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = A.tv.hp;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = A.tv.lp;
  lp.Q.value = 0.7;

  // Свод в моно без единого лишнего узла: WebAudio сам делает down-mix,
  // когда у входа явно задан один канал. Телевизор 98-го — моно динамик,
  // и стереопанорама в кадре с кинескопом звучит «современно»
  const bus = ctx.createGain();
  if (A.tv.mono) {
    bus.channelCount = 1;
    bus.channelCountMode = 'explicit';
    bus.channelInterpretation = 'speakers';
  }

  bus.connect(comp);
  comp.connect(hp);
  hp.connect(lp);
  lp.connect(master);
  master.connect(ctx.destination);

  const layer = (v) => { const g = ctx.createGain(); g.gain.value = v; g.connect(bus); return g; };
  mix = {
    ctx, master, bus, lp,
    base: layer(0), hot: layer(0), ultras: layer(0), event: layer(1),
  };
  return mix;
}

function playLoop(name, dest, offset = 0) {
  const buf = buffers[name];
  if (!buf || !mix) return null;
  const src = mix.ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(dest);
  src.start(0, offset);
  return src;
}

// Фоновые петли: заводятся один раз и крутятся до конца матча.
// Взвинченный слой стартует со СВОЕЙ точки буфера — иначе оба слоя дышат
// в такт и на кроссфейде слышно, что это одна и та же запись
function startBeds() {
  if (started || !mix || !buffers.base) return;
  playLoop('base', mix.base);
  // Взвинченный слой входит со СВОЕЙ точки буфера: обе записи сделаны одной
  // моделью и дышат похоже, а стартовав вместе, они дышали бы В ТАКТ — на
  // кроссфейде было бы слышно, что это одна и та же дорожка
  if (buffers.murmur_high) {
    playLoop('murmur_high', mix.hot, buffers.murmur_high.duration * 0.37);
  }
  started = true;
  applyIntensity(CONFIG.audio.crowd.settle);  // въезжаем в гул, а не включаем рубильником
}

function applyIntensity(tau) {
  if (!mix) return;
  const A = CONFIG.audio.crowd;
  const k = Math.max(0, Math.min(1, intensity));
  const t = mix.ctx.currentTime;
  // Ровный слой немного уступает место взвинченному, но не уходит совсем:
  // зал не превращается в другой зал, он заводится
  mix.base.gain.setTargetAtTime(A.base * (1 - A.baseDuck * k), t, tau);
  mix.hot.gain.setTargetAtTime(A.hot * Math.pow(k, A.hotCurve), t, tau);
  // Верх полосы открывается вместе с напряжением: дальний ровный гул глухой,
  // а крик ближе и ярче. Тот же приём, что был у синтеза
  mix.lp.frequency.setTargetAtTime(
    CONFIG.audio.tv.lp * (1 + A.brighten * k), t, tau * 1.4);
}

// ===== Публичное управление =====

// Напряжение эпизода 0..1: атака у ворот — зал гудит громче и злее.
export function setCrowdIntensity(x) {
  intensity = Math.max(0, Math.min(1, x));
  if (!mix) { ensureMix(); startBeds(); }
  applyIntensity(CONFIG.audio.crowd.settle);
}

// Разовое событие поверх фона. gain — доля от штатной громкости события.
function fire(name, gain = 1, rate = 1) {
  fired[name] = (fired[name] || 0) + 1;   // приёмка: что зал успел сыграть за матч
  if (!mix || !buffers[name]) return false;
  const src = mix.ctx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = rate;
  const g = mix.ctx.createGain();
  g.gain.value = gain;
  src.connect(g);
  g.connect(mix.event);
  src.start();
  src.onended = () => { try { g.disconnect(); } catch (e) { /* уже отцеплен */ } };
  return true;
}

// Гол: рёв поверх фона, и сам фон на минуту остаётся взвинченным.
export function crowdGoal() {
  const A = CONFIG.audio.events;
  ensureMix();
  startBeds();
  if (!fire('goal_roar', A.goal)) return false;
  // Записи мало: она кончится, а стадион после гола гудит ещё долго.
  // Держим взвинченный слой поднятым и отпускаем его медленно
  if (mix) {
    const t = mix.ctx.currentTime;
    mix.hot.gain.cancelScheduledValues(t);
    mix.hot.gain.setValueAtTime(mix.hot.gain.value, t);
    mix.hot.gain.linearRampToValueAtTime(CONFIG.audio.crowd.hot * A.goalHot, t + 0.4);
    mix.hot.gain.setTargetAtTime(CONFIG.audio.crowd.hot * 0.35, t + A.goalHold, A.goalTail);
  }
  if (ultras) ultras.wait = A.goalUltrasPause;   // дудки не лезут в рёв
  return true;
}

// Опасный момент: сейв, штанга, промах в считанных сантиметрах.
export function crowdGasp(strength = 1) {
  ensureMix();
  return fire('near_miss', CONFIG.audio.events.gasp * strength);
}

// Аплодисменты: выход команд, хорошая комбинация, конец матча.
export function crowdApplause(strength = 1) {
  ensureMix();
  return fire('applause', CONFIG.audio.events.applause * strength);
}

// Свист и улюлюканье: грубый подкат, снос сзади.
export function crowdJeer(strength = 1) {
  ensureMix();
  return fire('whistles', CONFIG.audio.events.jeer * strength);
}

// ===== Фанатский сектор =====

// Дудки и барабан приходят ВОЛНАМИ, а не гудят ровным слоем. Вираж не
// поёт непрерывно все девяносто минут: он заводится, тянет минуту-другую
// и замолкает. Ровный слой на всём матче читается «зациклили дорожку»,
// и это первое, что слышно в дешёвой игре.
export function updateCrowd(dt) {
  ticks++;
  if (!mix || !started) return;
  const A = CONFIG.audio.ultras;
  if (!ultras) ultras = { on: false, wait: A.firstGap, left: 0 };

  if (ultras.on) {
    ultras.left -= dt;
    if (ultras.left <= 0) {
      const t = mix.ctx.currentTime;
      mix.ultras.gain.setTargetAtTime(0, t, A.fadeOut);
      if (ultras.src) {
        const src = ultras.src;
        // stop с запасом: обрываем уже после того, как гейн доехал до нуля
        try { src.stop(t + A.fadeOut * 5); } catch (e) { /* уже остановлен */ }
        ultras.src = null;
      }
      ultras.on = false;
      ultras.wait = A.minGap + Math.random() * (A.maxGap - A.minGap);
    }
    return;
  }

  ultras.wait -= dt;
  if (ultras.wait > 0) return;
  // В острый момент вираж не запевает — там зал орёт, а не поёт
  if (intensity > A.calmBelow) { ultras.wait = A.retry; return; }

  const pick = Math.random() < A.drumShare ? 'drums_chant' : 'horns';
  if (!buffers[pick]) { ultras.wait = A.retry; return; }
  const src = playLoop(pick, mix.ultras);
  if (!src) { ultras.wait = A.retry; return; }
  const t = mix.ctx.currentTime;
  mix.ultras.gain.setValueAtTime(0.0001, t);
  mix.ultras.gain.setTargetAtTime(A.gain * (0.7 + Math.random() * 0.5), t, A.fadeIn);
  ultras.src = src;
  ultras.on = true;
  ultras.left = A.minLen + Math.random() * (A.maxLen - A.minLen);
}

// ===== Громкость =====

// Ползунок в меню. 0 — зал молчит совсем (и петли не крутятся зря).
export function setCrowdVolume(v) {
  CONFIG.audio.master = Math.max(0, Math.min(1, v));
  muted = CONFIG.audio.master <= 0.001;
  if (!mix) return;
  mix.master.gain.setTargetAtTime(muted ? 0 : CONFIG.audio.master, mix.ctx.currentTime, 0.05);
}

// Подготовленный буфер клипа — для стендов. Шов петли проверяется по нему,
// а не по исходному файлу: щёлкает как раз то, что доехало до микшера.
export function crowdBuffer(name) {
  return buffers[name] || null;
}

// Уровень на выходе зала — приёмка микса. У каждого слоя должен быть свой
// числовой эталон, иначе после любой правки тракта громкость молча уедет, а
// на слух это читается расплывчатым «стало тише». Анализатор создаётся
// лениво: в обычной игре его нет вовсе.
let meter = null;
export function crowdPeak() {
  if (!mix) return null;
  if (!meter) {
    meter = mix.ctx.createAnalyser();
    meter.fftSize = 2048;
    mix.master.connect(meter);       // ответвление, звук идёт своим путём
  }
  const d = new Float32Array(meter.fftSize);
  meter.getFloatTimeDomainData(d);
  let peak = 0, sum = 0;
  for (const v of d) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
  return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4) };
}

// Для отладки и стендов: чем сейчас звучит зал.
export function crowdDebug() {
  if (!mix) return { ready: crowdReady(), mix: false };
  return {
    ready: crowdReady(),
    loaded: Object.keys(buffers),
    intensity,
    ticks,
    fired: { ...fired },                                    // 0 — значит главный цикл не зовёт updateCrowd
    wave: ultras ? { on: ultras.on, wait: +ultras.wait.toFixed(1), left: +ultras.left.toFixed(1) } : null,
    base: +mix.base.gain.value.toFixed(3),
    hot: +mix.hot.gain.value.toFixed(3),
    ultras: +mix.ultras.gain.value.toFixed(3),
    master: +mix.master.gain.value.toFixed(3),
    lp: Math.round(mix.lp.frequency.value),
  };
}
