// Ветер в футболке: смещение вершин ПОСЛЕ скиннинга, без симуляции ткани.
//
// Идея. Скелет уже поставил вершину на место (chunk skinning_vertex). Мы берём
// готовую точку и толкаем её по воздуху: назад по ходу бега (ткань отдувается)
// плюс мелкая рябь. Стоит это один sin на вершину и ноль байт на игрока —
// геометрия у всех 22 клонов ОДНА (SkeletonUtils.clone делит её по ссылке).
//
// Порядок chunk'ов в meshlambert_vert (three.js r185, vendor/three.module.js:545):
//   beginnormal -> skinbase -> skinnormal -> defaultnormal -> normal_vertex ->
//   begin_vertex -> morphtarget -> SKINNING_VERTEX -> displacementmap ->
//   project_vertex -> logdepthbuf -> clipping -> worldpos_vertex
// Нам нужно ПОСЛЕ skinning_vertex и ДО project_vertex.
//
// ГЛАВНАЯ ГРАБЛЯ (измерено на models/player.glb, а не вычитано).
// После skinning_vertex `transformed` живёт НЕ в метрах и НЕ в осях мира.
// В нашем glb узел Armature несёт поворот X +90° и масштаб 0.01 (обычный
// экспорт Blender/Mixamo), а увеличение ×100 сидит в матрицах КОСТЕЙ. Скиннинг
// проходит через кости и потому попадает в метры сам; наша прибавка идёт уже
// ПОСЛЕ костей и ловит только 0.01. Замер: `transformed += vec3(1,0,0)` двигает
// фигуру в мире на 0.008 м, а `+= vec3(0,0,1)` — на 0.016 м ВНИЗ (мировое «вверх»
// это локальное −Z). То есть наивные «5 сантиметров» превращаются в полмиллиметра
// и уезжают не в ту сторону.
// Поэтому всё считается в МИРОВЫХ метрах, а в локальные оси переводится одной
// матрицей uClothBasis = inverse(mat3(mesh.matrixWorld)) — она разом снимает и
// масштаб Armature, и поворот, и рост/сложение игрока, и разворот группы.
import * as THREE from 'three';
import { injectRim } from './rimlight.js';

// ОДИН объект времени на весь матч. Все материалы кладут себе ССЫЛКУ на него,
// поэтому обновление — одно присваивание, а не 22. Программа у всех общая,
// значит и кэш юниформов общий: gl.uniform1f реально уйдёт один раз за кадр.
export const clothTime = { value: 0 };

// --- Ручки. Всё в МЕТРАХ и ГЕРЦАХ, чтобы числа можно было представить. ---
export const CLOTH = {
  // ЗАПАСНАЯ маска по высоте — на случай модели без второго слоя UV.
  // Боевая маска печётся в Blender (tools/build-player-mesh.py) и приезжает
  // атрибутом uv1: там подол, рукав и шорты различаются ПО ПОСТРОЕНИЮ, а не
  // по совпадению высот.
  yPin: 1.36,        // линия плеч: выше неё ткань пришита к телу
  yHem: 1.04,        // подол футболки: тут свобода максимальна
  shortsLo: 0.89,
  shortsHi: 0.93,
  shortsFree: 0.30,  // шорты плотнее футболки — качаются слабее
  sleeveX: 0.16,
  sleeveFree: 0.35,

  // Амплитуды подобраны на плане повтора (7 м, фигура 470 px). На рабочей
  // ТВ-камере это 2 пикселя — и так и должно быть: развевающаяся футболка
  // живёт в повторе и празднованиях, а не в общем плане. Крутить её по
  // эфирному кадру нельзя, там доведёшь до флага.
  trail: 0.075,      // м: насколько подол уезжает НАЗАД на полном ходу
  billow: 0.032,     // м: «дыхание» ткани поперёк полотна (по нормали)
  sway: 0.026,       // м: боковое колыхание
  stride: 0.016,     // м: подскок подола в такт шагу
  breeze: 0.10,      // доля от billow, которая работает даже в покое

  qHalf: 4.0,        // м/с: скорость, на которой эффект набирает половину силы
  freqBase: 1.5,     // Гц: частота ряби в покое
  freqPerMs: 0.55,   // Гц на каждый м/с (7 м/с -> 5.4 Гц — трикотаж, не флаг)
  lambda: 0.38,      // м: длина волны ряби вдоль потока
};

// Один и тот же ТЕКСТ функции у всех материалов => один cacheKey => одна
// программа на все 22 фигуры (проверено: r.info.programs.length === 2,
// usedTimes 22 у формы и 44 у кожи/головы).
// ВНИМАНИЕ: подставлять в GLSL значения КОНКРЕТНОГО игрока нельзя — cacheKey
// их не видит, и все 22 молча получат шейдер первого. Личное — только юниформы.
const VERT_PARS = /* glsl */`
  attribute vec2 aCloth;       // x: 0 пришито к телу … 1 свободный подол; y: сдвиг фазы
  uniform float uClothTime;    // общие секунды матча
  uniform vec3  uClothAir;     // поток воздуха в МИРОВЫХ осях, м/с
  uniform mat3  uClothBasis;   // мир -> локаль после скиннинга
  uniform vec2  uClothPhase;   // x — личный сдвиг фазы, y — фаза шага (0..1)
`;

const VERT_BODY = /* glsl */`
  if ( aCloth.x > 0.0 ) {
    vec3 wPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    vec3 wNrm = normalize( mat3( modelMatrix ) * objectNormal );

    float q = length( uClothAir );
    // Насыщение: спринт не должен срывать футболку в флаг
    float sat = q / ( q + ${CLOTH.qHalf.toFixed(2)} );
    vec3 flow = q > 0.05 ? uClothAir / q : vec3( 0.0, 0.0, -1.0 );
    vec3 side = normalize( cross( flow, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4, 0.0, 0.0 ) );

    // Бегущая вдоль потока волна: фаза зависит и от того, как глубоко вершина
    // стоит по течению, и от её собственного сдвига (запечён в Blender по месту
    // на полотне). Без сдвига кольцо из двенадцати вершин колышется целиком,
    // как жёсткий обод, а не рябит тканью.
    float freq = ${CLOTH.freqBase.toFixed(2)} + ${CLOTH.freqPerMs.toFixed(2)} * q;
    float phase = 6.2831853 * freq * uClothTime
                - ( 6.2831853 / ${CLOTH.lambda.toFixed(2)} ) * dot( wPos, flow )
                + uClothPhase.x + 6.2831853 * aCloth.y;

    float w = aCloth.x;
    vec3 disp = flow * ( ${CLOTH.trail.toFixed(4)} * sat * w );
    disp += wNrm * ( ${CLOTH.billow.toFixed(4)} * ( sat + ${CLOTH.breeze.toFixed(3)} ) * w * sin( phase ) );
    disp += side * ( ${CLOTH.sway.toFixed(4)} * sat * w * sin( phase * 0.5 + 1.7 ) );
    disp.y += ${CLOTH.stride.toFixed(4)} * w * sat * sin( 6.2831853 * uClothPhase.y );

    transformed += uClothBasis * disp;   // метры мира -> локальные единицы
  }
`;

// three.js зовёт onBeforeCompile МЕТОДОМ (three.module.js:18210 —
// `material.onBeforeCompile( parameters, _this )`), поэтому внутри доступен
// `this` = материал, и личные юниформы достаются из его userData. Так у всех
// совпадает и ссылка на функцию, и cacheKey.
function patchCloth( shader ) {
  shader.vertexShader = shader.vertexShader
    .replace( '#include <common>', '#include <common>\n' + VERT_PARS )
    .replace( '#include <skinning_vertex>', '#include <skinning_vertex>\n' + VERT_BODY );
  const c = this.userData.cloth;
  shader.uniforms.uClothTime = clothTime;     // ОБЩИЙ объект на все 22
  shader.uniforms.uClothAir = c.air;          // личные
  shader.uniforms.uClothBasis = c.basis;
  shader.uniforms.uClothPhase = c.phase;
  // Контровой свет живёт ЗДЕСЬ, а не отдельным onBeforeCompile: слот у
  // материала ровно один, и второе присваивание молча выключило бы ветер —
  // без единой ошибки в консоли. Правило общее: в проекте есть занятые слоты
  // (форма — тут, трибуны — patchWaveShader в atmosphere.js), и новый эффект
  // ДОПИСЫВАЕТСЯ в цепочку, а не вешает свою функцию.
  injectRim( shader, this.userData.rimScale ?? 1 );
}

/** Вешает ветер на материал формы. Возвращает юниформы игрока для updateCloth. */
export function makeClothMaterial( mat ) {
  mat.userData.cloth = {
    air: { value: new THREE.Vector3( 0, 0, 0 ) },
    basis: { value: new THREE.Matrix3() },
    phase: { value: new THREE.Vector2( Math.random() * 6.283, 0 ) },
  };
  mat.onBeforeCompile = patchCloth;           // ССЫЛКА, не новая функция
  return mat.userData.cloth;
}

/**
 * Печёт маску свободной ткани в атрибут aCloth. Геометрия у клонов ОБЩАЯ
 * (SkeletonUtils.clone делает `this.geometry = source.geometry`), поэтому
 * зовём ОДИН раз на исходном gltf — все 22 фигуры получат её даром.
 */
export function bakeClothMask( geometry ) {
  if ( geometry.getAttribute( 'aCloth' ) ) return geometry.getAttribute( 'aCloth' );

  // Маска приходит ГОТОВОЙ из второго слоя UV. Он не развёртка, а данные:
  // в Blender (tools/build-player-mesh.py) каждой вершине формы записаны
  // свобода ткани и сдвиг фазы. Это лучше любой эвристики по координатам:
  // подол футболки (y ≈ 1.00) и пояс шорт (y ≈ 1.03) стоят почти на одной
  // высоте, и разделить их «по игреку» нельзя в принципе.
  const uv1 = geometry.getAttribute( 'uv1' );
  if ( uv1 ) {
    geometry.setAttribute( 'aCloth', uv1 );
    return uv1;
  }

  // Запасной вариант для старой модели без второго слоя UV: грубая прикидка
  // по высоте. Ткань хотя бы шевельнётся, а в консоли будет видно почему.
  console.warn( 'В модели нет слоя uv1 — маска ткани считается по координатам' );
  const pos = geometry.getAttribute( 'position' );
  const out = new Float32Array( pos.count * 2 );
  const span = CLOTH.yPin - CLOTH.yHem;
  for ( let i = 0; i < pos.count; i++ ) {
    const x = pos.getX( i ), y = pos.getY( i ), z = pos.getZ( i );
    let w = 0;
    if ( y >= CLOTH.yHem - 0.02 && y <= CLOTH.yPin ) {
      const t = Math.min( 1, ( CLOTH.yPin - y ) / span );
      w = t * t;
    } else if ( y > CLOTH.shortsLo && y < CLOTH.shortsHi ) {
      w = CLOTH.shortsFree;
    }
    if ( y > CLOTH.yPin && Math.abs( x ) > CLOTH.sleeveX ) {
      const k = Math.min( 1, ( Math.abs( x ) - CLOTH.sleeveX ) / 0.19 );
      w = Math.max( w, CLOTH.sleeveFree * k );
    }
    out[ i * 2 ] = w;
    out[ i * 2 + 1 ] = ( Math.atan2( z, x ) / 6.2831853 + 1 ) % 1;
  }
  const attr = new THREE.BufferAttribute( out, 2 );
  geometry.setAttribute( 'aCloth', attr );
  return attr;
}

const _m3 = new THREE.Matrix3();

/**
 * Раз в кадр на игрока.
 * @param cloth   — то, что вернул makeClothMaterial
 * @param mesh    — SkinnedMesh формы (нужна его matrixWorld)
 * @param vel     — мировая скорость игрока (this.vel)
 * @param loco    — фаза шага 0..1 (this.locoPhase)
 * @param windX/Z — ветер стадиона, м/с (можно 0)
 */
export function updateCloth( cloth, mesh, vel, loco, windX = 0, windZ = 0 ) {
  // Воздух, который чувствует тело = ветер минус собственная скорость.
  // На бегу вперёд это поток НАЗАД — ткань отдувается сама, без спецкода.
  cloth.air.value.set( windX - vel.x, 0, windZ - vel.z );
  // Одна матрица снимает всё сразу: масштаб Armature 0.01, поворот X +90°,
  // рост/сложение из состава и разворот игрока по полю.
  _m3.setFromMatrix4( mesh.matrixWorld );
  cloth.basis.value.copy( _m3 ).invert();
  cloth.phase.value.y = loco || 0;
}
