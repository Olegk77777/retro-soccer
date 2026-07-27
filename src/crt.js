// ТВ-тракт: сцена рендерится во внутреннюю текстуру (высота — CONFIG.render
// .targetHeight), затем ОДИН полноэкранный шейдерный проход превращает её в
// телевизионную картинку.
//
// Полноэкранный проход по-прежнему один — это принципиально, каждый лишний
// бьёт по GPU планшета (см. База-знаний). Halation («расплывание» белого в
// стекле экрана) считают три МИКРОпрохода на четверти разрешения: вместе они
// стоят меньше 5% от главного прохода, а без них картинка остаётся плоской.
//
// ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА (28.07.2026): сцена приходит сюда в ЛИНЕЙНОМ
// свете и с яркостями ВЫШЕ единицы, а уходит на экран в ДИСПЛЕЙНОМ. Между
// этими двумя пространствами стоит тонмаппинг, и порядок операций менять
// нельзя:
//
//   [линейное] выборки → цветность композита → послесвечение → halation
//              → экспозиция → тонмаппинг
//   [дисплейное] гамма → грейдинг канала → строчность, зерно, виньетка, рамка
//
// До 28.07.2026 тонмаппинга и гаммы тут не было вовсе: линейные значения
// уходили прямо на экран, который читает их как sRGB. Газон с линейных 0.31
// показывался как 0.35 вместо честных 0.60 — картинка была вдвое темнее
// задуманной, 73% кадра сваливалось в две корзины гистограммы из шестнадцати,
// а свет мачт, дымка и полутени тонули в этой каше. Ровно это Олег и назвал
// «ТВ-режим пожирает свет и дымку».
//
// Строчность, зерно и КОМПОЗИТНЫЕ АРТЕФАКТЫ не привязаны к разрешению
// рендера: кинескоп 90-х — это ~480 строк, сколько бы пикселей мы ни рисовали.
// Всё меряется в «телевизионных пикселях» (uScanRes × аспект), поэтому
// переключение чёткости 240p↔1080p меняет чёткость и НЕ меняет характер ТВ.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Яркая часть кадра с мягким порогом. Заодно уменьшение вчетверо: берём
// четыре билинейных отсчёта, поэтому усредняем сразу 16 исходных пикселей.
// Считается в ЛИНЕЙНОМ HDR — именно поэтому лампы и файеры со значениями
// больше единицы дают настоящий ореол, а не плоское белое пятно.
const BRIGHT_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;        // размер пикселя ИСХОДНОГО буфера
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb
           + texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb
           + texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb
           + texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
    c *= 0.25;

    float luma = max(c.r, max(c.g, c.b));
    // Мягкое колено вместо ступеньки: иначе на границе порога видна «фольга»
    float soft = clamp(luma - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 0.0001);
    float w = max(soft, luma - uThreshold) / max(luma, 0.0001);
    gl_FragColor = vec4(c * w, 1.0);
  }
`;

// Разделимое гауссово размытие: 9 отсчётов, шаг задаётся uDir.
const BLUR_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D tDiffuse;
  uniform vec2 uDir;          // шаг в UV: (texel.x*r, 0) или (0, texel.y*r)
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270;
    c += (texture2D(tDiffuse, vUv + uDir * 1.3846153).rgb
        + texture2D(tDiffuse, vUv - uDir * 1.3846153).rgb) * 0.3162162;
    c += (texture2D(tDiffuse, vUv + uDir * 3.2307692).rgb
        + texture2D(tDiffuse, vUv - uDir * 3.2307692).rgb) * 0.0702702;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// highp обязателен: фаза точечного бега считается от uv.x * (число ТВ-пикселей
// в строке) и доходит до восьмисот. В mediump (fp16) шаг у таких чисел — треть
// единицы, и вместо тонкой сетки поднесущей получается рваная грязь.
const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;   // сцена: ЛИНЕЙНАЯ, значения могут быть > 1
  uniform sampler2D tPrev;      // сцена ПРЕДЫДУЩЕГО кадра (поля и послесвечение)
  uniform sampler2D tBloom;
  uniform float uTime;
  uniform float uField;         // 0/1 — чётность поля, меняется каждый кадр
  uniform vec2  uTexel;         // пиксель буфера сцены в UV
  uniform float uAspect;        // ширина/высота кадра: ТВ-пиксель квадратный
  uniform float uScanRes;       // сколько строк рисует «кинескоп» (НЕ высота рендера)
  uniform float uGrainRes;      // крупность зерна (тоже своя, не от разрешения)
  uniform float uCurvature;     // кривизна кинескопа
  uniform float uOverscan;      // насколько растр выходит за видимую часть стекла
  uniform float uExposure;      // экспозиция ПЕРЕД тонмаппингом
  uniform float uGamma;         // гамма кинескопа (sRGB ≈ 2.2, ТВ 90-х чуть выше)
  uniform float uChroma;        // ширина размытия цветности, ТВ-пиксели
  uniform float uChromaLag;     // отставание цветности от яркости, ТВ-пиксели
  uniform float uDetail;        // подчёркивание яркостных краёв (детализация камеры)
  uniform float uDotCrawl;      // точечный бег на цветных краях
  uniform float uPersist;       // послесвечение люминофора (доля прошлого кадра)
  uniform float uInterlace;     // сила чересстрочной «гребёнки»
  uniform float uHistory;       // 0 на кадре ПОСЛЕ СКЛЕЙКИ: старый план не тянется
  uniform float uScanline;      // сила полос развёртки
  uniform float uNoise;         // зерно
  uniform float uSaturation;
  uniform float uBrightness;
  uniform vec3  uTint;          // цветовой оттенок «канала»
  uniform float uVignette;
  uniform float uJitter;        // VHS-дрожание строк
  uniform float uBloom;         // сила halation
  uniform float uContrast;      // S-контраст вокруг средних тонов
  uniform float uLift;          // подъём чёрного: стекло кинескопа не бывает чёрным
  uniform float uToe;           // подъём ТЁМНЫХ УЧАСТКОВ (тени мягче, не «дыры»)
  uniform float uWarmth;        // раздел тонов: света теплее, тени холоднее
  uniform float uMatte;         // матовая рамка эфирной записи (доля высоты)
  uniform float uGain;          // живая ручка «яркость» на корпусе ТВ
  uniform float uContrastKnob;  // живая ручка «контраст»
  uniform float uColorKnob;     // живая ручка «цвет»
  varying vec2 vUv;

  // Веса яркости — Rec.601: это те самые коэффициенты, по которым аналоговое
  // ТВ разбирало цвет на яркость и цветность. Брать Rec.709 тут не за что.
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  // Тонмаппинг Khronos PBR Neutral (он же NeutralToneMapping в three.js).
  // Выбран сознательно: ACES обесцвечивает света и превращает тёплый свет
  // мачт в белое пятно, а этот сжимает только верхушку и оставляет лампам,
  // файерам и жёлтой форме их цвет.
  vec3 tonemapNeutral(vec3 c) {
    const float START = 0.76;      // 0.8 - 0.04
    const float DESAT = 0.15;
    float x = min(c.r, min(c.g, c.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    c -= offset;
    float peak = max(c.r, max(c.g, c.b));
    if (peak < START) return c;
    float d = 1.0 - START;
    float newPeak = 1.0 - d * d / (peak + d - START);
    c *= newPeak / peak;
    float g = 1.0 - 1.0 / (DESAT * (peak - newPeak) + 1.0);
    return mix(c, vec3(newPeak), g);
  }

  void main() {
    // Кривизна: выпуклый экран кинескопа.
    // ОВЕРСКАН обязателен: без него выпуклость оставляет чёрные поля внутри
    // рамки корпуса, и картинка читается как «экран меньше стекла». Настоящий
    // кинескоп работал наоборот — растр был ЧУТЬ БОЛЬШЕ видимой части, и
    // самые края кадра просто не показывались.
    vec2 cc = vUv * 2.0 - 1.0;
    cc /= 1.0 + uCurvature * uOverscan;
    cc *= 1.0 + uCurvature * dot(cc, cc);
    vec2 uv = cc * 0.5 + 0.5;

    // За пределами «стекла» — чёрная рамка
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // VHS: редкие горизонтальные срывы строк
    float lineId = floor(uv.y * uScanRes);
    float glitch = step(1.0 - uJitter * 0.006, rand(vec2(lineId, floor(uTime * 13.0))));
    uv.x += glitch * (rand(vec2(lineId, uTime)) - 0.5) * 0.08;

    // ================= ЛИНЕЙНОЕ ПРОСТРАНСТВО =================

    // «Телевизионный пиксель» — квадратный и не зависит от разрешения рендера,
    // ровно как строчность. Ниже пикселя буфера опускаться незачем: на 240p
    // размывать нечего.
    float tvPx = max(1.0 / (uScanRes * uAspect), uTexel.x);

    // Композитный сигнал: ЯРКОСТЬ широкополосная, ЦВЕТНОСТЬ — нет. У NTSC
    // яркость идёт до 4.2 МГц, а цветоразностные — 1.3 и 0.4 МГц, то есть
    // цвет размазан по строке в три-десять раз сильнее. Плюс цветность
    // физически ЗАПАЗДЫВАЕТ (линия задержки), и цвет уезжает вправо от своего
    // предмета — это тот самый красный шлейф от футболок в записи 90-х.
    //
    // Ради этого и затевалось: размытая цветность съедает ступеньки на
    // цветных краях низкополигональных фигур, а резкая яркость оставляет
    // разметку и блики острыми. Ровно так работала телекамера.
    //
    // Семь выборок по строке дают сразу три вещи: резкую яркость (центральная
    // выборка), размытую и сдвинутую цветность (несимметричное окно) и
    // симметрично размытую яркость для подчёркивания краёв.
    float chroW = max(uChroma, 0.6);
    float tapStep = max(1.0, chroW / 3.0);   // шаг выборок в ТВ-пикселях
    vec3 cur0 = vec3(0.0);
    vec3 chAcc = vec3(0.0);
    float yAcc = 0.0;
    float wcSum = 0.0;
    float wySum = 0.0;
    for (int i = -3; i <= 3; i++) {
      float pos = float(i) * tapStep;        // смещение в ТВ-пикселях
      vec3 s = texture2D(tDiffuse, vec2(uv.x + pos * tvPx, uv.y)).rgb;
      if (i == 0) cur0 = s;
      // ЗНАК ЗДЕСЬ ПРОВЕРЕН ЗАМЕРОМ, а не выведен рассуждением. Чтобы цвет
      // УЕХАЛ ВПРАВО (композитная линия задержки), пиксель обязан брать
      // цветность СЛЕВА от себя, то есть окно весов смещается в минус.
      // С «интуитивным» плюсом получалось наоборот: при lag +8 корреляция
      // яркостных и цветовых перепадов давала цветность на 18 пикселей
      // ЛЕВЕЕ яркости — цвет забегал вперёд предмета, чего в природе нет.
      float wc = max(0.0, 1.0 - abs(pos + uChromaLag) / chroW);
      float wy = max(0.0, 1.0 - abs(pos) / (tapStep * 1.7));
      chAcc += s * wc;
      wcSum += wc;
      yAcc += dot(s, LUMA) * wy;
      wySum += wy;
    }
    chAcc /= max(wcSum, 1e-4);
    yAcc /= max(wySum, 1e-4);

    // Послесвечение люминофора и ЧЕРЕССТРОЧНОСТЬ. В кадре эфира живут два
    // поля, снятые в разные моменты; на движении это даёт мягкую «гребёнку»,
    // на статике не меняет ничего. Мешается только ЯРКОСТЬ (её структуру глаз
    // и отслеживает) — цветность остаётся от текущего кадра, иначе размытие
    // по строке наполовину вернулось бы к резкому.
    // Побочный и главный подарок: временнóе смешение гасит дрожь ступенек на
    // разметке и мелкий шаг анимации — то самое «маскирует несовершенство».
    // uHistory обнуляет всё это на кадре после СКЛЕЙКИ (смена ракурса повтора,
    // старт празднования, смена разрешения). Без него старый план тянулся бы
    // через новый несколько кадров, и резкий монтажный стык эфира превращался
    // бы в наплыв — приём из другой эпохи и из другого жанра.
    vec3 prev = texture2D(tPrev, uv).rgb;
    float odd = mod(lineId + uField, 2.0);
    float mixPrev = clamp((uPersist + uInterlace * odd) * uHistory, 0.0, 0.9);
    vec3 c0 = mix(cur0, prev, mixPrev);

    // Собираем сигнал обратно: цветность размытая, яркость своя.
    float y0 = dot(c0, LUMA);
    // Детализация телекамеры (aperture correction): вещательные камеры
    // подчёркивали яркостные перепады, отсюда узкая светлая кайма у разметки.
    // Нам это нужно вдвойне — размытие цветности иначе съело бы и чёткость.
    float y = y0 + uDetail * (y0 - yAcc);
    vec3 col = max(chAcc + (y - dot(chAcc, LUMA)), vec3(0.0));

    // Точечный бег: яркость и цветность делили один провод, и на цветных
    // краях поднесущая пролезала в яркость мелкой шахматкой, ползущей вбок.
    // Знак меняется по строке и по полю — иначе это статичная сетка.
    float chromaMag = length(chAcc - vec3(dot(chAcc, LUMA)));
    float phase = uv.x * uScanRes * uAspect * 0.5 + lineId * 0.5 + uField * 0.5;
    col = max(col + uDotCrawl * chromaMag * cos(6.2831853 * phase), vec3(0.0));

    // Halation: свет от ярких мест растекается в стекле экрана. Ореол чуть
    // теплее источника — так ведёт себя люминофор. Считается ДО тонмаппинга:
    // после него лампе уже нечем светиться, она сжата в единицу.
    col += texture2D(tBloom, uv).rgb * uBloom * vec3(1.06, 1.0, 0.92);

    // Экспозиция и сведение HDR в диапазон экрана.
    col = tonemapNeutral(col * uExposure);

    // ================= ДИСПЛЕЙНОЕ ПРОСТРАНСТВО =================
    // С этой строки 0.5 — это настоящий средний серый, и весь грейдинг ниже
    // наконец означает то, что написано в его названии.
    col = pow(max(col, vec3(0.0)), vec3(1.0 / uGamma));

    // Насыщенность и оттенок канала. Ручки корпуса (uGain/uColorKnob) —
    // множители ПОВЕРХ пресета: пресет задаёт характер канала, ручка правит
    // его под свою комнату, ровно как на настоящем телевизоре.
    float luma = dot(col, LUMA);
    col = mix(vec3(luma), col, uSaturation * uColorKnob) * uTint * uBrightness * uGain;

    // Контраст вокруг средних тонов: главный рычаг «сочности»
    col = (col - 0.5) * uContrast * uContrastKnob + 0.5;

    // Подъём ТЁМНЫХ УЧАСТКОВ. uLift поднимает весь кадр (свечение стекла),
    // а это — только тени: полутени игроков и дальние углы перестают быть
    // чёрными дырами, света при этом не трогаются вовсе.
    float dk = 1.0 - smoothstep(0.0, 0.44, dot(col, LUMA));
    col += uToe * dk * vec3(0.84, 0.92, 1.12);   // и уводит их в стадионную синеву

    // Разделение тонов: света уходят в тёплый, тени — в синеву стадионной ночи
    float l2 = clamp(dot(col, LUMA), 0.0, 1.0);
    float hi = smoothstep(0.28, 0.92, l2);
    vec3 warm = vec3(1.0 + uWarmth * 0.5, 1.0, 1.0 - uWarmth * 0.42);
    vec3 cool = vec3(1.0 - uWarmth * 0.30, 1.0 - uWarmth * 0.08, 1.0 + uWarmth * 0.44);
    col *= mix(cool, warm, hi);

    // Полосы развёртки — структура самого экрана, поэтому ПОСЛЕ грейдинга
    float s = sin(uv.y * uScanRes * 3.14159);
    col *= 1.0 - uScanline * s * s;

    // Зерно
    col += (rand(uv * uGrainRes + vec2(uTime * 60.0)) - 0.5) * uNoise;

    // Виньетка по углам
    float vig = 1.0 - uVignette * dot(cc, cc) * 0.7;
    col *= vig;

    // Подъём чёрного: стекло кинескопа всегда чуть светится и отражает комнату
    col = max(col, vec3(0.0)) * (1.0 - uLift) + vec3(uLift * 0.85, uLift * 0.88, uLift);

    // Матовая рамка: у переписанного с эфира куска всегда есть чёрное поле по
    // краям — оно и есть первый признак «это запись, а не игра». Толщина
    // задана в долях ВЫСОТЫ, по горизонтали делится на аспект, иначе рамка
    // выходит разной толщины сверху и сбоку.
    if (uMatte > 0.0) {
      vec2 d = min(vUv, 1.0 - vUv) - vec2(uMatte / uAspect, uMatte);
      col *= smoothstep(0.0, 0.0025, min(d.x, d.y));
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

// Общая заготовка микропрохода: полноэкранный треугольник-квад + материал
function makeQuad(material) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return scene;
}

export class CRTPipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.height = CONFIG.render.targetHeight;
    this.size = new THREE.Vector2(320, 240);

    // HDR-буфер сцены. Половинная точность даёт две вещи, без которых ТВ-режим
    // не может не портить картинку:
    //   1) яркости ВЫШЕ единицы — лампам, файерам и бликам есть куда светить,
    //      и тонмаппинг сводит их мягко, а не срезает в плоское белое;
    //   2) тени без бандинга — в 8 битах ЛИНЕЙНОЙ шкалы соседние коды 1/255
    //      расходятся в дисплейном пространстве на 6%, и дымка над газоном
    //      расслаивалась кольцами.
    // Если железо не тянет — падаем на прежний байтовый буфер, всё остальное
    // продолжает работать.
    const gl = renderer.getContext();
    const canHDR = CONFIG.render.hdr !== false && !!(
      gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float')
    );
    this.hdr = canHDR;
    const sceneOpts = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      type: canHDR ? THREE.HalfFloatType : THREE.UnsignedByteType,
    };

    // Пинг-понг: сцена пишется по очереди в два буфера, и второй в этот
    // момент держит ПРЕДЫДУЩИЙ кадр. Так послесвечение и чересстрочность
    // достаются нам без единого лишнего полноэкранного прохода — только
    // одна лишняя выборка в главном шейдере.
    this.targets = [
      new THREE.WebGLRenderTarget(320, 240, sceneOpts),
      new THREE.WebGLRenderTarget(320, 240, { ...sceneOpts }),
    ];
    this.ping = 0;
    this.target = this.targets[0];   // текущий буфер сцены (для отладки и замеров)

    // Буферы halation: живут на 1/downscale от главного. Фильтр линейный —
    // размытие обязано «размазывать», а не тиражировать пиксели.
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      type: canHDR ? THREE.HalfFloatType : THREE.UnsignedByteType,
    };
    this.bloomA = new THREE.WebGLRenderTarget(80, 60, rtOpts);
    this.bloomB = new THREE.WebGLRenderTarget(80, 60, { ...rtOpts });
    // Значение по умолчанию под стартовые 80×60: render() до первого resize()
    // не должен падать на undefined (отладочные стенды рендерят без ресайза).
    this._bloomTexel = new THREE.Vector2(1 / 80, 1 / 60);

    const B = CONFIG.render.bloom;
    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BRIGHT_FRAG,
      uniforms: {
        tDiffuse: { value: this.targets[0].texture },
        uTexel: { value: new THREE.Vector2(1 / 320, 1 / 240) },
        uThreshold: { value: B.threshold },
        uKnee: { value: B.knee },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uDir: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });

    const R = CONFIG.render;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tDiffuse: { value: this.targets[0].texture },
        tPrev: { value: this.targets[1].texture },
        tBloom: { value: this.bloomA.texture },
        uTime: { value: 0 },
        uField: { value: 0 },
        uTexel: { value: new THREE.Vector2(1 / 320, 1 / 240) },
        uAspect: { value: 16 / 9 },
        uScanRes: { value: R.scanLines },
        uGrainRes: { value: R.grainRes },
        uCurvature: { value: 0.1 },
        uOverscan: { value: R.overscan },
        uExposure: { value: R.exposure },
        uGamma: { value: R.gamma },
        uChroma: { value: 2.6 },
        uChromaLag: { value: 1.1 },
        uDetail: { value: 0.3 },
        uDotCrawl: { value: 0.03 },
        uPersist: { value: 0.2 },
        uInterlace: { value: 0.12 },
        uHistory: { value: 0 },
        uScanline: { value: 0.3 },
        uNoise: { value: 0.05 },
        uSaturation: { value: 1.0 },
        uBrightness: { value: 1.0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uVignette: { value: 0.35 },
        uJitter: { value: 0 },
        uBloom: { value: B.enabled ? B.strength : 0 },
        uContrast: { value: 1.0 },
        uLift: { value: 0.0 },
        uToe: { value: 0.0 },
        uWarmth: { value: 0.0 },
        uMatte: { value: 0.0 },
        // Ручки корпуса ТВ: нейтраль = 1.0, пресет их не трогает
        uGain: { value: 1.0 },
        uContrastKnob: { value: 1.0 },
        uColorKnob: { value: 1.0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.brightScene = makeQuad(this.brightMat);
    this.blurScene = makeQuad(this.blurMat);
    this.quadScene = makeQuad(this.material);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._winW = 1;
    this._winH = 1;
    this._preset = null;
    // Сколько ближайших кадров рисовать БЕЗ буфера истории. Два, а не один:
    // после склейки истории нет ни у текущего кадра, ни у следующего, который
    // прочитает буфер, заполненный ещё старым планом.
    this._cut = 2;
  }

  // Склейка: следующий кадр рисуется без послесвечения. Зовётся на смене
  // ракурса повтора, старте празднования и любом прыжке камеры (main.js ловит
  // их сам по смещению) — иначе старый план тянется через новый наплывом.
  // Смена разрешения тоже склейка: setSize уничтожает буферы, и в них до
  // первой отрисовки лежит мусор.
  cut() { this._cut = 2; }

  // Пересчитать размер внутреннего рендера под аспект окна
  resize(width, height) {
    this._winW = width || this._winW;
    this._winH = height || this._winH;
    const aspect = Math.min(this._winW / this._winH, CONFIG.render.maxAspect);
    const h = this.height;
    const w = Math.round(h * aspect);
    this.size.set(w, h);

    // Ступеньки PS1 держим только на низких разрешениях. На 720p+ NEAREST
    // при апскейле в некратное разрешение даёт рваные строки, и полосы
    // развёртки начинают «дышать» при движении камеры.
    // Менять фильтр можно ТОЛЬКО сразу после setSize: он уже уничтожил старый
    // буфер, и текстура создастся заново с новыми параметрами. Ставить
    // needsUpdate на текстуру рендер-таргета нельзя — three попробует залить
    // её как обычную картинку и порвёт привязку к фреймбуферу.
    const filter = h > 480 ? THREE.LinearFilter : THREE.NearestFilter;
    for (const t of this.targets) {
      t.setSize(w, h);
      t.texture.magFilter = filter;
      t.texture.minFilter = filter;
    }

    const u = this.material.uniforms;
    u.uTexel.value.set(1 / w, 1 / h);
    u.uAspect.value = w / h;
    this.brightMat.uniforms.uTexel.value.set(1 / w, 1 / h);

    const k = Math.max(2, CONFIG.render.bloom.downscale);
    const bw = Math.max(8, Math.round(w / k));
    const bh = Math.max(8, Math.round(h / k));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    this._bloomTexel = new THREE.Vector2(1 / bw, 1 / bh);
    this.cut();   // setSize уничтожил буферы: в истории сейчас мусор
  }

  // Сменить высоту внутреннего рендера (селектор «Чёткость» в настройках)
  setHeight(h) {
    this.height = Math.max(120, Math.round(h) || CONFIG.render.targetHeight);
    CONFIG.render.targetHeight = this.height;
    this.resize();
  }

  // Применить ТВ-пресет (объект из data/tv-presets.json).
  // Все поля необязательные: пресет без нового поля берёт значение по
  // умолчанию из CONFIG.render и выглядит как раньше.
  setPreset(p) {
    this._preset = p;
    const u = this.material.uniforms;
    const B = CONFIG.render.bloom;
    const R = CONFIG.render;
    u.uCurvature.value = p.curvature ?? 0;
    u.uScanline.value = p.scanline ?? 0;
    u.uNoise.value = p.noise ?? 0;
    u.uSaturation.value = p.saturation ?? 1;
    u.uBrightness.value = p.brightness ?? 1;
    u.uVignette.value = p.vignette ?? 0;
    u.uJitter.value = p.jitter ?? 0;
    const t = p.tint || [1, 1, 1];
    u.uTint.value.set(t[0], t[1], t[2]);
    u.uBloom.value = B.enabled ? (p.bloom ?? B.strength) : 0;
    u.uContrast.value = p.contrast ?? 1.0;
    u.uLift.value = p.lift ?? 0.0;
    u.uToe.value = p.toe ?? 0.0;
    u.uWarmth.value = p.warmth ?? 0.0;
    // Экспозиция канала — множитель к общей: «канал» может быть посветлее
    // или потемнее, но общая точка съёмки задана один раз в CONFIG.
    u.uExposure.value = R.exposure * (p.exposure ?? 1.0);
    u.uGamma.value = p.gamma ?? R.gamma;
    u.uChroma.value = p.chroma ?? R.chroma;
    u.uChromaLag.value = p.chromaLag ?? R.chromaLag;
    u.uDetail.value = p.detail ?? R.detail;
    u.uDotCrawl.value = p.dotCrawl ?? 0.0;
    u.uPersist.value = p.persist ?? R.persist;
    u.uInterlace.value = p.interlace ?? R.interlace;
    u.uMatte.value = p.matte ?? 0.0;
  }

  // Живые ручки корпуса телевизора. Множители ПОВЕРХ пресета: смена канала
  // их не сбрасывает, как и на настоящем ТВ.
  setKnobs({ gain, contrast, color } = {}) {
    const u = this.material.uniforms;
    if (gain !== undefined) u.uGain.value = gain;
    if (contrast !== undefined) u.uContrastKnob.value = contrast;
    if (color !== undefined) u.uColorKnob.value = color;
  }

  // Три микропрохода на 1/downscale: яркая часть → размытие по X → по Y.
  // Результат остаётся в bloomA, откуда его читает главный проход.
  _renderBloom() {
    const B = CONFIG.render.bloom;
    if (!B.enabled || this.material.uniforms.uBloom.value <= 0) return;
    const r = this.renderer;
    const t = this._bloomTexel;

    r.setRenderTarget(this.bloomA);
    r.render(this.brightScene, this.quadCam);

    this.blurMat.uniforms.tDiffuse.value = this.bloomA.texture;
    this.blurMat.uniforms.uDir.value.set(t.x * B.radius, 0);
    r.setRenderTarget(this.bloomB);
    r.render(this.blurScene, this.quadCam);

    this.blurMat.uniforms.tDiffuse.value = this.bloomB.texture;
    this.blurMat.uniforms.uDir.value.set(0, t.y * B.radius);
    r.setRenderTarget(this.bloomA);
    r.render(this.blurScene, this.quadCam);
  }

  render(scene, camera, time) {
    const cur = this.targets[this.ping];
    const prev = this.targets[1 - this.ping];
    this.target = cur;

    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uField.value = this.ping;      // чётность поля меняется каждый кадр
    u.tDiffuse.value = cur.texture;
    u.tPrev.value = prev.texture;
    u.uHistory.value = this._cut > 0 ? 0 : 1;
    if (this._cut > 0) this._cut--;
    this.brightMat.uniforms.tDiffuse.value = cur.texture;

    this.renderer.setRenderTarget(cur);
    this.renderer.render(scene, camera);
    this._renderBloom();
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);

    this.ping ^= 1;
  }
}
