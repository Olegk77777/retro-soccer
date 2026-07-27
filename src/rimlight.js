// Контровой свет от мачт: светящаяся кайма по плечам, макушке и краю бедра
// у фигуры, между которой и камерой оказалась дальняя лампа.
//
// ЗАЧЕМ. Модели у нас гранёные и небогатые, и объём им даёт не детализация, а
// свет. Контровик отрывает фигуру от тёмной трибуны и рисует её границу —
// ровно тот приём, на котором держится читаемость персонажей в RDR 2 (разбор:
// База-знаний/Исследования/18-Свет-и-атмосфера.md §1.2, §3.2).
//
// СВЕТ, А НЕ ОБВОДКА — главное различие, которое нельзя терять.
// Мультяшный контур получается, когда яркость зависит ТОЛЬКО от угла между
// нормалью и камерой: тогда светится весь силуэт по кругу и всегда. У нас в
// формулу входит ещё и лампа, причём дважды: грань должна быть повёрнута К
// НЕЙ (ndl), и сама лампа должна стоять ЗА объектом относительно камеры (back).
// Поэтому кайма живёт на одной-двух сторонах, переезжает при развороте игрока
// и гаснет, когда он бежит лицом к камере под ближней мачтой. Френель здесь не
// самостоятельное слагаемое, а ВЕС при вкладе реального источника — приём из
// доклада Valve про шейдинг в Source: выключил лампу, и кайма исчезла.
//
// ЗАМЕР, НА КОТОРОМ ВСЁ ДЕРЖИТСЯ (наша геометрия, игрок в центре поля).
// Мачты в (±68.5, 28.5, ±50), рабочая ТВ-камера в (0, 27, 55). Множитель
// «лампа за спиной» -dot(L,V): у ОБЕИХ дальних мачт 0.379, у обеих ближних 0.
// Отсюда два следствия, оба обязательные:
//   1) веса мачт РАЗНЫЕ (CONFIG.atmosphere.light.weights) — при равных кайма
//      симметрична на обоих плечах, то есть является обводкой ПО ПОСТРОЕНИЮ;
//   2) степень при back не выше 1.5 — 0.379² = 0.144, эффект просто пропадёт.
//
// ГДЕ СЧИТАЕМ. В пространстве ВИДА, потому что там же считает весь Lambert:
// позиция фрагмента равна -vViewPosition, значит вектор на лампу берётся
// сложением, и ни одного нового varying не нужно. Мачты переводит в это
// пространство процессор — четыре умножения вектора на матрицу за кадр на всю
// сцену, а не на игрока.
//
// ВРЕЗКА — сразу после <lights_fragment_end>: там уже посчитаны normal,
// vViewPosition и diffuseColor, но ещё не собран outgoingLight и НЕ ПРИМЕНЁН
// ТУМАН. Последнее важно: кайма обязана добавляться ДО тумана, тогда дальний
// игрок теряет её в дымке сам собой. Вставка после <fog_fragment> дала бы
// игроков, светящихся сквозь дымку, — видно только на дальней бровке, в
// отладке пропускается легко.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mastPositions } from './atmosphere.js';

// ОДИН объект юниформов на все материалы сцены — как clothTime в cloth.js.
// Личных чисел в контровике нет вообще: сила, резкость и цвет общие, а разница
// между формой, кожей и железом задаётся одним множителем uRimScale, который
// живёт в userData материала. Благодаря этому текст патча у всех совпадает,
// и число шейдерных программ не растёт.
export const rimRig = {
  uRimMast: { value: [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ] },
  uRimW: { value: [1, 1, 1, 1] },
  uRimColor: { value: new THREE.Color(0xfff2d0) },
  // x — сила, y — степень френеля, z — степень «лампа за спиной», w — доля альбедо
  uRim: { value: new THREE.Vector4(0.9, 2.8, 1.2, 0.35) },
  uRimMax: { value: 1.0 },
};

const _masts = [];

/** Читает CONFIG в юниформы. Зовётся один раз при сборке сцены. */
export function initRim() {
  const R = CONFIG.atmosphere.rim;
  const L = CONFIG.atmosphere.light;
  rimRig.uRim.value.set(R.enabled ? R.strength : 0, R.power, R.back, R.tint);
  rimRig.uRimMax.value = R.max;
  rimRig.uRimColor.value.set(R.color ?? L.mastColor);
  const w = L.weights;
  for (let i = 0; i < 4; i++) rimRig.uRimW.value[i] = w[i] ?? 1;
  _masts.length = 0;
  for (const m of mastPositions()) _masts.push(new THREE.Vector3(m.x, m.y, m.z));
}

/**
 * Раз в кадр, ПОСЛЕ camera.lookAt: переводим мачты в пространство вида.
 * Четыре вектора на всю сцену — не на игрока.
 */
export function updateRim(camera) {
  if (!_masts.length) return;
  const inv = camera.matrixWorldInverse;
  for (let i = 0; i < 4; i++) rimRig.uRimMast.value[i].copy(_masts[i]).applyMatrix4(inv);
}

const RIM_PARS = /* glsl */`
  uniform vec3  uRimMast[ 4 ];   // мачты в пространстве вида
  uniform float uRimW[ 4 ];      // веса мачт (ОБЩИЕ со светом и с тенями)
  uniform vec3  uRimColor;
  uniform vec4  uRim;            // сила, степень френеля, степень back, доля альбедо
  uniform float uRimMax;
  uniform float uRimScale;       // множитель материала: форма 1, кожа 0.7, железо 0.6
`;

// Считаем ПОСЛЕ <lights_fragment_end> и пользуемся тем, что там уже готово:
// geometryNormal (= normal) и geometryViewDir (= normalize(vViewPosition), с
// корректной веткой для ортокамеры) объявлены в <lights_fragment_begin>. Своя
// нормализация была бы лишней работой на каждый фрагмент.
// Прибавляем в reflectedLight.directDiffuse, а НЕ в outgoingLight: последняя
// собирается ниже по тексту и в этой точке ещё не существует. Заодно это и
// правильнее по смыслу — контровик прямой свет, а <aomap_fragment> трогает
// только НЕПРЯМОЙ (правило «затенение окружающим светом не умножает прямой»).
const RIM_BODY = /* glsl */`
  if ( uRim.x * uRimScale > 0.0 ) {
    // Френель: чем сильнее грань отвернулась от камеры, тем ближе она к силуэту.
    // Здесь он только ВЕС, самостоятельного свечения не даёт.
    float rimEdge = pow( 1.0 - clamp( dot( geometryNormal, geometryViewDir ), 0.0, 1.0 ), uRim.y );
    float rimSum = 0.0;
    for ( int i = 0; i < 4; i ++ ) {
      // Позиция фрагмента в пространстве вида = -vViewPosition, поэтому
      // вектор «фрагмент -> лампа» это сложение, без единого varying.
      vec3  rimL = normalize( uRimMast[ i ] + vViewPosition );
      float rimN = max( dot( geometryNormal, rimL ), 0.0 );        // грань повёрнута К лампе
      float rimB = clamp( -dot( rimL, geometryViewDir ), 0.0, 1.0 ); // лампа ЗА объектом
      rimSum += uRimW[ i ] * rimN * pow( rimB, uRim.z );
    }
    rimSum = min( rimSum * rimEdge * uRim.x * uRimScale, uRimMax );
    // Кайма НЕ белая: цвет лампы плюс доля собственного цвета ткани. Чистый
    // белый на тёмной форме читается неоном, а двадцать две белые обводки
    // превращают кадр в комикс.
    reflectedLight.directDiffuse += rimSum * uRimColor * mix( vec3( 1.0 ), diffuseColor.rgb, uRim.w );
  }
`;

/**
 * Дописывает контровик в уже разобранный шейдер. Зовётся ИЗНУТРИ функции
 * onBeforeCompile — своей у материала может быть только одна (см. addRim).
 */
export function injectRim(shader, scale) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + RIM_PARS)
    .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + RIM_BODY);
  Object.assign(shader.uniforms, rimRig);
  shader.uniforms.uRimScale = { value: scale };
}

// Одна ССЫЛКА на все материалы без других патчей. Отдельная стрелочная функция
// на каждый материал дала бы разный текст, а значит и разные программы.
function patchRimOnly(shader) {
  injectRim(shader, this.userData.rimScale ?? 1);
}

/**
 * Вешает контровик на материал.
 *
 * ГЛАВНАЯ ГРАБЛЯ. onBeforeCompile у материала РОВНО ОДИН, и у формы он уже
 * занят ветром ткани (src/cloth.js). Второе присваивание молча выключит
 * первое — без ошибки в консоли. Поэтому материалы с уже занятым слотом
 * дописывают вызов injectRim ВНУТРЬ своей функции, а сюда не приходят.
 *
 * Ключ кэша программ у three.js по умолчанию — ТЕКСТ функции onBeforeCompile
 * (Material.customProgramCacheKey в vendor/three.core.js). Здесь ссылка одна на
 * всех, поэтому ключ совпадает и число программ не растёт. Проверка приёмки:
 * renderer.info.programs.length до и после правки одинаков.
 *
 * @param mat   материал (MeshLambertMaterial — Basic контровик не поддерживает,
 *              у него нет ни нормали, ни vViewPosition)
 * @param scale множитель силы для этого вида поверхности
 */
export function addRim(mat, scale = 1) {
  if (!mat || !mat.isMeshLambertMaterial) return mat;
  mat.userData.rimScale = scale;
  mat.onBeforeCompile = patchRimOnly;
  return mat;
}
