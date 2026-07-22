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
