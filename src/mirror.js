// Зеркальный клип: та же хореография ДРУГОЙ ногой.
//
// ЗАЧЕМ. В паке Mixamo (56 файлов, перебраны все) нет ни одного левоногого
// силового удара: `kick_run` бьёт правой, `penalty` правой, найденный внутри
// `gk_dropkick` удар с лёта — тоже правой. Левой ноге доставался только тычок
// `kick`, у которого замаха нет по построению (замер: носок не заходит за таз,
// пик скорости 7.4 м/с против 18.0 у kick_run). То есть у левоногого игрока
// удара по воротам анимационно не существовало — он «пихал мяч ногой».
//
// ПОЧЕМУ НЕ ПЕРЕСБОРКА glb. Скачать нужный клип неоткуда (вход в аккаунт
// Mixamo), а пересборка модели — это headless-Blender с пятью известными
// граблями и обязательной сверкой всех 25 клипов. Зеркало же считается из того,
// что уже загружено, за миллисекунды и проверяется тем же стендом.
//
// ПОЧЕМУ ЧЕРЕЗ МИРОВЫЕ МАТРИЦЫ, А НЕ ФОРМУЛОЙ ПО ЛОКАЛЬНЫМ КВАТЕРНИОНАМ.
// Ходовой приём «поменять местами дорожки Left/Right и обратить компоненты
// (x, −y, −z, w)» верен ТОЛЬКО если у зеркальной пары костей зеркальны и
// ориентации в позе покоя. У Mixamo оси костей повёрнуты, и в этом проекте на
// этом уже спотыкались трижды (cloth.js, hair.js, гашение root motion). Здесь
// вопрос снят по существу: мы задаём зеркальную МИРОВУЮ ориентацию каждой
// кости и пересчитываем её в локальную через родителя. Как ориентированы оси —
// не важно вовсе.
//
// Отражение поворота по плоскости X = 0: R' = S·R·S при S = diag(−1, 1, 1).
// Определитель сохраняется (−1 · 1 · −1 = 1), то есть R' — честный поворот, а
// не отражение. В кватернионах это (x, −y, −z, w).
import * as THREE from 'three';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _sc = new THREE.Vector3();
// Отражение по плоскости X = 0. Считать надо МАТРИЦАМИ, а не парой
// «кватернион + позиция»: у арматуры Mixamo масштаб 0.01, и при разборе на
// компоненты он теряется. Первая редакция так и попалась — таз записался в
// МЕТРАХ (0.97) вместо локальных единиц родителя (96.8), и фигура схлопывалась
// в точку у газона: оба носка стояли ровно в (0, 0, 0).
const _S = new THREE.Matrix4().makeScale(-1, 1, 1);

// Имя зеркальной кости. Кости без стороны (таз, позвоночник, голова)
// зеркальны сами себе — их ориентация всё равно отражается.
export function twinName(name) {
  if (name.includes('Left')) return name.replace('Left', 'Right');
  if (name.includes('Right')) return name.replace('Right', 'Left');
  return name;
}

// Матрица кости ОТНОСИТЕЛЬНО КОРНЯ рига. Через мировые матрицы сцены считать
// нельзя: клон скелета стоит там, где его поставили, а плоскость зеркала
// обязана проходить через самого игрока.
function relative(root, bone, out) {
  return out.copy(root.matrixWorld).invert().multiply(bone.matrixWorld);
}

// Зеркальная копия клипа. rig — клон скелета (не боевой, его поза портится),
// mixer — микшер на этом клоне.
export function mirrorClip(rig, mixer, src, name, fps = 60) {
  const bones = [];
  rig.traverse((o) => { if (o.isBone) bones.push(o); });   // родители раньше детей
  if (!bones.length) return null;

  // Зеркалим только те кости, чья ПАРА анимирована в исходнике: собственных
  // движений автор им не задавал, и выдумывать их за него мы не станем.
  const animated = new Set();
  for (const t of src.tracks) animated.add(t.name.slice(0, t.name.lastIndexOf('.')));
  const list = bones.filter((b) => animated.has(twinName(b.name)));
  if (!list.length) return null;
  // Позицию анимируем только там, где её анимировал автор (у Mixamo это таз):
  // у остальных костей позиция — длина кости, и трогать её нельзя.
  const movable = list.filter((b) => src.tracks.some(
    (t) => t.name === `${twinName(b.name)}.position`));

  const steps = Math.max(4, Math.round(src.duration * fps));
  const dt = src.duration / steps;
  const times = new Float32Array(steps + 1);
  const rot = new Map(list.map((b) => [b.name, new Float32Array((steps + 1) * 4)]));
  const pos = new Map(movable.map((b) => [b.name, new Float32Array((steps + 1) * 3)]));
  const anim = new Set(list.map((b) => b.name));
  const moves = new Set(movable.map((b) => b.name));
  // Матрицы кадра относительно корня: сперва снимаем исходные, потом строим
  // целевые СВЕРХУ ВНИЗ. Строить их надо ровно из того, что мы запишем в трек:
  // у кости без дорожки позиции при воспроизведении останется её собственная
  // (длина кости — своя, а не зеркальная), и цепочку надо считать по ней,
  // иначе дети уедут от родителя.
  const world = new Map();
  const target = new Map();
  const _mm = new THREE.Matrix4();
  const _inv = new THREE.Matrix4();
  const _loc = new THREE.Matrix4();
  const _qw = new THREE.Quaternion();
  const _pw = new THREE.Vector3();

  const action = mixer.clipAction(src);
  mixer.stopAllAction();
  action.reset();
  action.enabled = true;
  action.setEffectiveWeight(1);
  action.timeScale = 1;
  action.play();
  // Прогрев: первый update после reset не даёт устоявшейся позы (та же грабля,
  // что в sampleClip и в стендах)
  action.time = 0;
  mixer.update(0);
  rig.updateMatrixWorld(true);
  action.time = 0;
  mixer.update(0);

  for (let i = 0; i <= steps; i++) {
    rig.updateMatrixWorld(true);
    times[i] = i * dt;
    world.clear();
    for (const b of bones) world.set(b.name, relative(rig, b, new THREE.Matrix4()));
    target.clear();
    for (const b of bones) {
      const par = b.parent;
      const parT = par ? target.get(par.name) : null;
      // Родитель вне скелета (узел арматуры) не анимируется — его матрица
      // остаётся исходной, и зеркалить её нельзя
      const base = parT || (par ? relative(rig, par, new THREE.Matrix4()) : new THREE.Matrix4());
      if (!anim.has(b.name)) {
        // Кость без дорожки играет свою обычную локальную матрицу
        target.set(b.name, base.clone().multiply(b.matrix));
        continue;
      }
      // Зеркальная мировая матрица: S · M(пара) · S. Определитель сохраняется
      // (−1 · 1 · −1 = 1), то есть это честный поворот, а не отражение, и
      // масштаб арматуры едет вместе с ней.
      _mm.copy(_S).multiply(world.get(twinName(b.name)) || world.get(b.name)).multiply(_S);
      _inv.copy(base).invert();
      _loc.copy(_inv).multiply(_mm);
      _loc.decompose(_v, _q, _sc);
      _q.normalize();
      const r = rot.get(b.name);
      r[i * 4] = _q.x; r[i * 4 + 1] = _q.y; r[i * 4 + 2] = _q.z; r[i * 4 + 3] = _q.w;
      const pt = pos.get(b.name);
      if (pt) {
        pt[i * 3] = _v.x; pt[i * 3 + 1] = _v.y; pt[i * 3 + 2] = _v.z;
      } else {
        // Дорожки позиции у этой кости не будет — значит в игре сыграет её
        // СОБСТВЕННАЯ (длина кости своя, а не зеркальная), и цепочку для
        // детей надо считать по ней, иначе они уедут от родителя
        _v.setFromMatrixPosition(b.matrix);
        _sc.setFromMatrixScale(b.matrix);
      }
      _loc.compose(_v, _q, _sc);
      target.set(b.name, base.clone().multiply(_loc));
    }
    if (i < steps) mixer.update(dt);
  }
  mixer.stopAllAction();
  mixer.uncacheAction(src);

  const tracks = [];
  for (const b of list) {
    tracks.push(new THREE.QuaternionKeyframeTrack(
      `${b.name}.quaternion`, Array.from(times), Array.from(rot.get(b.name))));
    const pt = pos.get(b.name);
    if (pt) {
      tracks.push(new THREE.VectorKeyframeTrack(
        `${b.name}.position`, Array.from(times), Array.from(pt)));
    }
  }
  return new THREE.AnimationClip(name, src.duration, tracks, src.blendMode);
}
