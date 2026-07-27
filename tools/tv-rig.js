// Стенд для замеров ТВ-картинки. Собран 28.07.2026, когда чинили тракт
// «свет → тонмаппинг → гамма → грейдинг»: настраивать картинку на глаз по
// живой игре нельзя — кадр каждый раз другой.
//
// Что делает: замораживает матч (цикл встаёт, физика молчит), ставит камеру
// в ФИКСИРОВАННЫЕ точки съёмки и считает числа прямо по нарисованному кадру.
//
// Как пользоваться из консоли браузера:
//   await import('/tools/tv-rig.js'); const rig = await window.__rig;
//   rig.shoot('tv');                       // общий план рабочей ТВ-камеры
//   rig.stats({ газон: [0.5, 0.45] });     // средняя, гистограмма, пробы точек
//   rig.area(0.3, 0.86, 0.7, 0.95);        // средний цвет области (доли кадра,
//                                          // отсчёт от ЛЕВОГО НИЖНЕГО угла)
//   rig.bench('tv', 60);                   // мс на кадр
//   rig.crt.setPreset(p); rig.crt.cut();   // примерить пресет без правки файла
//
// Две грабли, ради которых стенд и написан (см. База-знаний):
//   1) в скрытой вкладке requestAnimationFrame ОСТАНАВЛИВАЕТСЯ совсем, поэтому
//      кадры рисуем руками, а resize зовём сами (fit) — штатный обработчик
//      main.js ходит через rAF и в таком состоянии не срабатывает;
//   2) gl.finish() в браузере не синхронизирует, и замеры времени врут в сто
//      раз — точка синхронизации в bench это readPixels одного пикселя.
window.__rig = (async () => {
  const rl = await import('/src/rimlight.js');
  const { scene, camera, ball, match, crt, renderer, CONFIG } = DBG;

  // Замораживаем игру целиком: цикл ещё крутится, но ничего не двигает
  if (!window.__rigFrozen) {
    window.__rigFrozen = true;
    if (match.state === 'intro') { match.beginIntroKickoff(); match.introCam = null; }
    match.update = () => {};
    ball.update = () => null;
    DBG.goals.update = () => {};
    window.requestAnimationFrame = () => 0;      // главный цикл встал
  }
  ball.mesh.position.set(0, CONFIG.ball.radius, 0);
  ball.vel.set(0, 0, 0);
  document.body.classList.add('tv-full');

  // Размер стекла считаем САМИ: обработчик resize в main.js ходит через
  // requestAnimationFrame, а мы его только что выключили — да и в скрытой
  // вкладке кадры не приходят вовсе.
  const tv = await import('/src/tvset.js');
  function fit() {
    tv.invalidateScreenRect();
    const r = tv.screenRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    crt.resize(w, h);
    return [w, h];
  }
  fit();

  // Точки съёмки. tv — рабочая ТВ-камера, close — план повтора, wide — общий
  const SHOTS = {
    tv:    { pos: [0, 27, 55],    look: [0, 1, 0],  fov: 33 },
    box:   { pos: [22, 22, 46],   look: [38, 1, 0], fov: 33 },
    close: { pos: [4, 2.4, 9],    look: [0, 1.1, 0], fov: 38 },
    stand: { pos: [0, 14, 40],    look: [0, 14, -70], fov: 40 },
  };

  function shoot(name = 'tv') {
    const s = SHOTS[name] || SHOTS.tv;
    camera.fov = s.fov;
    camera.updateProjectionMatrix();
    camera.position.set(...s.pos);
    camera.lookAt(...s.look);
    camera.updateMatrixWorld();
    rl.updateRim(camera);
    crt.render(scene, camera, performance.now() / 1000);
    // два кадра: буфер послесвечения должен успеть наполниться
    crt.render(scene, camera, performance.now() / 1000);
  }

  // Числа по последнему нарисованному кадру
  function stats(probes) {
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const hist = new Array(16).fill(0);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const l = (0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2]) / 255;
      hist[Math.min(15, Math.floor(l * 16))]++;
      sum += l;
    }
    const n = buf.length / 4;
    // ВНИМАНИЕ: у stats проба задаётся СВЕРХУ вниз (fy = 0 — верх кадра),
    // а у area — СНИЗУ вверх, как отдаёт readPixels. Разъезд намеренно
    // оставлен и подписан: точку удобнее тыкать по скриншоту, а область —
    // по координатам буфера. Путать нельзя, проба уедет в другую половину.
    const px = (fx, fy) => {
      const x = Math.round(fx * w), y = Math.round(fy * h);
      const i = ((h - 1 - y) * w + x) * 4;
      return [buf[i], buf[i + 1], buf[i + 2]];
    };
    const out = { size: [w, h], mean: +(sum / n).toFixed(3), hist: hist.map(v => +(v / n * 100).toFixed(1)) };
    for (const k in (probes || {})) out[k] = px(probes[k][0], probes[k][1]);
    return out;
  }

  // Средняя яркость прямоугольной области кадра (0..1 в долях кадра)
  function area(x0, y0, x1, y1) {
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const X = Math.round(x0 * w), Y = Math.round((1 - y1) * h);
    const W = Math.max(1, Math.round((x1 - x0) * w)), H = Math.max(1, Math.round((y1 - y0) * h));
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(X, h - Y - H, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
    const n = buf.length / 4;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  // Цена кадра: сколько миллисекунд занимает полный проход.
  // Синхронизация — readPixels одного пикселя, а НЕ gl.finish(): последний в
  // браузере часто не блокирует, и замер выходит в сто раз оптимистичнее
  // (получали 0.004 мс на полноэкранный проход 1600×900).
  function bench(name = 'tv', frames = 60) {
    const gl = renderer.getContext();
    const one = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
    shoot(name);
    sync();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) shoot(name);
    sync();
    return +((performance.now() - t0) / frames).toFixed(3);
  }

  // --- Замеры СВЕТОТЕНИ ---------------------------------------------------
  // Оба написаны 28.07.2026 по жалобе Олега «во всех режимах освещение стало
  // плоским». Оказалось, что дело не в грейдинге и не в газоне: гамма подняла
  // средние тона, а тень и контровая кайма кладут в кадр ФИКСИРОВАННУЮ
  // прибавку — на светлом основании она читается слабее. Чтобы такое ловить,
  // нужны числа, сравнимые между сборками, а не «кажется темнее».

  // Контраст «газон / тень под игроком». Меряется выключением самого меша
  // теней, поэтому не зависит ни от ракурса, ни от расстановки игроков.
  // Опорные значения на общем плане: до появления гаммы 1.28, сразу после
  // неё 1.19 (вот она, потеря), после подъёма непрозрачности до 0.78 — 1.29.
  function shadowContrast() {
    let mesh = null;
    scene.traverse((o) => { if (!mesh && o.isInstancedMesh) mesh = o; });
    if (!mesh) return { ошибка: 'меш теней не найден' };
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const grab = () => {
      const b = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      return b;
    };
    const draw = () => { crt.cut(); for (let i = 0; i < 3; i++) shoot('tv'); return grab(); };
    const on = draw();
    mesh.visible = false;
    const off = draw();
    mesh.visible = true;
    draw();
    const L = (b, i) => 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    let n = 0, sOn = 0, sOff = 0, peak = 0;
    for (let i = 0; i < on.length; i += 4) {
      const a = L(off, i), b = L(on, i);
      if (a - b > 5) { n++; sOn += b; sOff += a; if (a - b > peak) peak = a - b; }
    }
    if (!n) return { пикселейТени: 0 };
    return {
      пикселейТени: n,
      газон: Math.round(sOff / n),
      тень: Math.round(sOn / n),
      пикПровала: Math.round(peak),
      контраст: +((sOff / n) / (sOn / n)).toFixed(2),
    };
  }

  // Пик контровой каймы на фигуре: А/Б с выключенной силой. Эталон сессии 47
  // (снятый ДО появления гаммы) — 110…122 из 255; после гаммы при прежней
  // силе 1.35 пик упал до 87, при 2.0 вернулся к 113.
  async function rimPeak(shotName = 'hero') {
    const rl = await import('/src/rimlight.js');
    const R = CONFIG.atmosphere.rim;
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const grab = () => {
      const b = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      return b;
    };
    const draw = () => { crt.cut(); for (let i = 0; i < 3; i++) shoot(shotName); return grab(); };
    const set = (s) => rl.rimRig.uRim.value.set(s, R.power, R.back, R.tint);
    set(0);
    const off = draw();
    set(R.strength);
    const on = draw();
    const L = (b, i) => 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    let n = 0, peak = 0;
    for (let i = 0; i < on.length; i += 4) {
      const d = L(on, i) - L(off, i);
      if (d > 20) n++;
      if (d > peak) peak = d;
    }
    return { сила: R.strength, пикселей: n, пик: Math.round(peak) };
  }

  return { shoot, stats, area, bench, fit, shadowContrast, rimPeak, SHOTS, camera, crt, scene, CONFIG };
})();
