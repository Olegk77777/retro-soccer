// Общий звуковой контекст на всю игру.
//
// Зал (src/crowd.js) и свисток (src/sfx.js) обязаны жить в ОДНОМ
// AudioContext. Два контекста на iOS — это два аппаратных потока: они не
// синхронизированы между собой, второй часто остаётся спящим после жеста
// пользователя, а на старых устройствах просто не создаётся (лимит).
//
// Политика автоплея (iOS/Chrome): до первого касания или клавиши контекст
// «спит», и всё, что мы в него отправим, не прозвучит. Поэтому здесь же
// живёт разблокировка первым жестом и очередь тех, кто хочет завестись
// сразу после неё (зал подхватывает петли, интро добирает свисток).

let ctx = null;
let unlocked = false;
const waiting = [];

export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  return ctx;
}

// Контекст, готовый звучать прямо сейчас. null — значит жеста ещё не было
// и посылать в него что-либо бессмысленно.
export function audioLive() {
  const c = audioCtx();
  return c && c.state === 'running' ? c : null;
}

// Позвать fn, когда звук разрешат. Если он уже разрешён — сразу.
export function onAudioUnlock(fn) {
  if (unlocked && audioLive()) fn();
  else waiting.push(fn);
}

function unlock() {
  const c = audioCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  // resume асинхронный: проверяем состояние уже после его обещания, иначе
  // очередь сработает вхолостую на первом же касании
  Promise.resolve(c.state === 'running' ? null : c.resume()).then(() => {
    if (c.state !== 'running' || unlocked) return;
    unlocked = true;
    for (const fn of waiting.splice(0)) {
      try { fn(); } catch (e) { console.warn('[audio] подписчик разблокировки упал:', e); }
    }
  }).catch(() => { /* браузер ещё не считает жест достаточным — ждём следующего */ });
}

for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, unlock, { passive: true });
}
