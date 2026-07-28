// Слой анимации: производные шаговые клипы и самокалибровка их длины шага.
//
// ЗАЧЕМ. В паке Mixamo ровно ОДИН клип бега вперёд — лёгкая трусца. Раньше он
// растягивался на весь диапазон скоростей одним `timeScale = speed / 4.0`,
// зажатым в 0.6…1.9. Три замера по риггу объясняют всю «роботоподобность»:
//
//  1. Настоящая скорость клипа не 4.0, а 4.57 м/с. На медленном ходу (1 м/с)
//     нижний зажим 0.6 держал ноги на 2.7 м/с — стопы ехали по газону ВТРОЕ
//     быстрее тела. Это и читалось как «полупарализованные».
//  2. Один делитель 4.0 стоял на четырёх разных клипах: strafe_l (5.34 м/с)
//     скользил на треть сильнее, чем strafe_r (3.99). Шаг влево и шаг вправо
//     ломались по-разному — глаз ловит такую асимметрию мгновенно.
//  3. Цикл в glb сжат по времени: шаг остался 2.44 м, а цикл сократился до
//     0.533 с — это 225 шагов в минуту на скорости трусцы (норма ~175).
//     Отсюда семенящий «завод игрушки».
//
// ЧТО ДЕЛАЕМ. Из одного клипа собираем ЛЕСТНИЦУ (ходьба → бег → спринт) двумя
// независимыми ручками:
//   amp     — размах движения, то есть ДЛИНА ШАГА;
//   stretch — растяжка по времени, то есть ЧАСТОТА ШАГА.
// Скорость ступени = длина шага / длительность цикла. Её мы НЕ задаём числом,
// а МЕРЯЕМ на риге после сборки: гоняем скелет-клон через микшер и смотрим,
// с какой скоростью едет назад опорная стопа. Тот же принцип, что у вымеренных
// кадров контакта (CONFIG.player.aerial.sync) — числа из рига, а не из головы.
//
// Размах масштабируется ВОКРУГ ПОЗЫ ПОКОЯ скелета. Побочный эффект приятный и
// бесплатный: у ходьбы корпус сам выпрямляется (наклон бега — тоже отклонение
// от покоя, и оно ужимается), а у спринта сам заваливается вперёд.
//
// Плюс замыкание цикла: у strafe_l и strafe_r последний кадр расходился с
// первым на 18–20° (замер по glb) — каждые 0.4 с фигура дёргалась. Разрыв
// размазывается по всему клипу, а не режется в одном кадре.

import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';
import { mirrorClip } from './mirror.js';

// Кость → группа, у каждой свой множитель размаха.
// Предплечье и кисть — ОТДЕЛЬНАЯ группа от плеча: у них разная роль. Плечо
// задаёт мах руки (его и масштабируем со скоростью), а локоть задаёт, насколько
// рука согнута — то есть длину видимого силуэта руки.
function boneGroup(name) {
  if (/UpLeg|Leg$|Foot|Toe/.test(name)) return 'leg';
  if (/ForeArm|Hand/.test(name)) return 'forearm';     // проверять ДО /Arm/
  if (/Shoulder|Arm/.test(name)) return 'arm';
  if (/Spine|Neck|Head/.test(name)) return 'spine';
  return 'root';                                       // Hips
}

const _qRest = new THREE.Quaternion();
const _qKey = new THREE.Quaternion();
const _qDelta = new THREE.Quaternion();
const _qOut = new THREE.Quaternion();
const _qGap = new THREE.Quaternion();
const _qFix = new THREE.Quaternion();
const _qId = new THREE.Quaternion();

// Группы, у которых размах масштабируется вокруг СРЕДНЕЙ позы дорожки, а не
// вокруг позы покоя (см. подробное объяснение в deriveClip)
const MEAN_PIVOT = new Set(['arm']);

// Разбор имени дорожки: 'mixamorigLeftLeg.quaternion' → кость и свойство
function splitTrack(name) {
  const dot = name.lastIndexOf('.');
  return { bone: name.slice(0, dot), prop: name.slice(dot + 1) };
}

// «Средняя поза» дорожки поворотов: усреднение кватернионов с приведением
// знака к первому кадру (иначе q и −q, задающие один поворот, гасят друг друга)
const _qAvg = new THREE.Quaternion();
function meanQuat(v) {
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  for (let i = 0; i < v.length; i += 4) {
    const s = (v[i] * v[0] + v[i + 1] * v[1] + v[i + 2] * v[2] + v[i + 3] * v[3]) < 0 ? -1 : 1;
    x += v[i] * s; y += v[i + 1] * s; z += v[i + 2] * s; w += v[i + 3] * s;
  }
  _qAvg.set(x, y, z, w);
  if (_qAvg.lengthSq() < 1e-8) return null;
  return _qAvg.normalize();
}

// Ось «отвести плечо от рёбер». Согнутый локоть поднимает кисти (без этого мах
// вырождается в маятник у бедра), но прижатое к корпусу предплечье прячется в
// силуэт — руки снова читаются культями. Разведение решает обе задачи разом.
// Оси костей Mixamo повёрнуты, поэтому ось НЕ угадываем: крутим плечо по каждой
// из трёх осей и смотрим, какая уводит локоть наружу от корпуса.
const _qProbe = new THREE.Quaternion();
const _vProbe = new THREE.Vector3();
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

// ВАЖНО: пробовать надо в БЕГОВОЙ позе, а не в позе покоя. В T-позе рука и так
// разведена до предела — там ни один поворот не уводит её дальше наружу, и
// проба возвращает шум (проверено: разведение уходило внутрь, кисть вбок падала
// с 0.27 до 0.21 м). Поэтому берём несколько кадров исходного клипа бега.
export function probeSpread(rig, clip) {
  const out = {};
  const hips = rig.getObjectByName('mixamorigHips');
  if (!hips || !clip) return out;
  const mixer = new THREE.AnimationMixer(rig);
  const action = mixer.clipAction(clip);
  action.enabled = true;
  action.setEffectiveWeight(1);
  action.timeScale = 0;
  action.play();
  const times = [0, 0.25, 0.5, 0.75].map((k) => k * clip.duration);

  for (const side of ['Left', 'Right']) {
    const arm = rig.getObjectByName(`mixamorig${side}Arm`);
    const hand = rig.getObjectByName(`mixamorig${side}Hand`);
    if (!arm || !hand) continue;
    const score = [0, 0, 0, 0, 0, 0];   // 3 оси × 2 знака
    for (const t of times) {
      action.time = t;
      mixer.update(0);
      rig.updateMatrixWorld(true);
      const hipX = _vProbe.setFromMatrixPosition(hips.matrixWorld).x;
      const pose = arm.quaternion.clone();
      const base = _vProbe.setFromMatrixPosition(hand.matrixWorld).x - hipX;
      const outward = Math.sign(base) || 1;   // в какую сторону от таза эта рука
      for (let a = 0; a < 3; a++) {
        for (let si = 0; si < 2; si++) {
          _qProbe.setFromAxisAngle(AXES[a], (si ? -1 : 1) * 0.35);
          arm.quaternion.copy(pose).multiply(_qProbe);
          rig.updateMatrixWorld(true);
          // Растёт ли ОТСТУП КИСТИ от корпуса — именно он вынимает предплечье
          // из силуэта; локоть для этого мерить бесполезно
          const gain = (_vProbe.setFromMatrixPosition(hand.matrixWorld).x - hipX - base) * outward;
          score[a * 2 + si] += gain;
        }
      }
      arm.quaternion.copy(pose);
    }
    let bi = 0;
    for (let i = 1; i < 6; i++) if (score[i] > score[bi]) bi = i;
    if (score[bi] > 0) out[`${side}Arm`] = { axis: bi >> 1, sign: (bi & 1) ? -1 : 1 };
  }
  mixer.stopAllAction();
  mixer.uncacheAction(clip);
  return out;
}

// Производный клип: та же хореография, но другой размах и другая частота шага.
export function deriveClip(src, rest, spec, name, spread = null) {
  const stretch = spec.stretch || 1;
  const tracks = [];
  for (const t of src.tracks) {
    const { bone, prop } = splitTrack(t.name);
    const f = spec[boneGroup(bone)];
    const times = stretch === 1 ? Array.from(t.times) : Array.from(t.times, (x) => x * stretch);
    const v = Float32Array.from(t.values);

    if (f != null && f !== 1) {
      if (prop === 'quaternion') {
        // Вокруг ЧЕГО масштабировать размах — вопрос не праздный.
        //
        // Для ног и корпуса опора — ПОЗА ПОКОЯ: тогда вместе с шагом
        // масштабируется и постоянный наклон, и ходьба сама выпрямляется, а
        // спринт сам заваливается вперёд. Это то, что нужно.
        //
        // Для ПЛЕЧА так делать НЕЛЬЗЯ. В покое рука прямая, а в беге локоть
        // постоянно согнут на ~67°, и это не размах, а поза. Масштабируя
        // «от покоя», мы умножали сам сгиб: замер по риггу дал 160° в спринте
        // (предплечье почти сложено на плечо) и расстояние плечо→кисть 0.39 м
        // против 0.59 м в оригинале — руки превращались в культи тираннозавра
        // (фидбек Олега 26.07.2026). Поэтому у плеча опора — СРЕДНЯЯ ПОЗА самой
        // дорожки: постоянный сгиб сохраняется, а масштабируется только мах.
        //
        // А вот у ЛОКТЯ опора снова поза покоя — и это осознанно. Исходная
        // трусца Mixamo держит локоть согнутым на 67° и прижимает кисти к
        // корпусу (0.27 м от оси против 0.42 м в стойке). Анатомически это
        // верно, но на низкополигональной фигуре с «варежками» предплечье
        // прячется в силуэт корпуса, и рука опять читается культёй (второй
        // фидбек Олега 26.07.2026). Множитель `forearm` меньше единицы
        // РАЗГИБАЕТ локоть к покою — рука снова видна целиком.
        //
        // Но разгибать локоть до конца тоже нельзя: прямая рука опускает кисти
        // на высоту таза, и мах вырождается в маятник у бедра — «руки просто
        // висят внизу» (третий фидбек Олега 26.07.2026; замер: кисть на
        // −0.16 м от таза, ровно как в стойке покоя, против +0.06 в оригинале).
        // Поэтому локоть держим согнутым (кисти высоко), а из силуэта корпуса
        // предплечье выводим ОТДЕЛЬНОЙ ручкой `spread` — разведением плеча.
        const useMean = MEAN_PIVOT.has(boneGroup(bone));
        const r = useMean ? meanQuat(v) : rest.get(bone);
        if (r) {
          _qRest.copy(r);
          for (let i = 0; i < v.length; i += 4) {
            _qKey.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
            _qDelta.copy(_qRest).invert().multiply(_qKey);
            _qOut.copy(_qId).slerp(_qDelta, f);
            _qOut.premultiply(_qRest).normalize();
            v[i] = _qOut.x; v[i + 1] = _qOut.y; v[i + 2] = _qOut.z; v[i + 3] = _qOut.w;
          }
        }
      } else if (prop === 'position') {
        // У позиции «покой» — это СРЕДНЯЯ точка самой дорожки, а не bind pose:
        // масштабируя вокруг bind, мы утопили бы таз в газон или подвесили его
        // в воздух. Ужимаем только колебание вокруг среднего.
        const n = v.length / 3;
        let mx = 0, my = 0, mz = 0;
        for (let i = 0; i < v.length; i += 3) { mx += v[i]; my += v[i + 1]; mz += v[i + 2]; }
        mx /= n; my /= n; mz /= n;
        for (let i = 0; i < v.length; i += 3) {
          v[i] = mx + (v[i] - mx) * f;
          v[i + 1] = my + (v[i + 1] - my) * f;
          v[i + 2] = mz + (v[i + 2] - mz) * f;
        }
      }
    }
    // Разведение плеча: постоянный доворот поверх кадра. Умножаем СПРАВА —
    // тогда поворот идёт в собственных осях плеча и «едет» вместе с махом,
    // то есть рука остаётся отведённой на всей амплитуде, а не только в покое.
    if (spread && spec.spread && prop === 'quaternion') {
      const s = spread[bone.replace('mixamorig', '')];
      if (s) {
        _qProbe.setFromAxisAngle(AXES[s.axis], s.sign * spec.spread);
        for (let i = 0; i < v.length; i += 4) {
          _qOut.set(v[i], v[i + 1], v[i + 2], v[i + 3]).multiply(_qProbe).normalize();
          v[i] = _qOut.x; v[i + 1] = _qOut.y; v[i + 2] = _qOut.z; v[i + 3] = _qOut.w;
        }
      }
    }
    const T = t.constructor;
    tracks.push(new T(t.name, times, Array.from(v)));
  }
  const clip = new THREE.AnimationClip(name, src.duration * stretch, tracks, src.blendMode);
  if (spec.loop !== false) closeLoop(clip);
  return clip;
}

// Замыкание цикла: последний кадр обязан совпасть с первым, иначе на стыке
// фигура дёргается. Разрыв не режем в одном кадре, а РАЗМАЗЫВАЕМ по всей
// длине — линейно нарастающей поправкой. Тогда ни рывка, ни «подволакивания».
export function closeLoop(clip) {
  const dur = clip.duration || 1;
  for (const t of clip.tracks) {
    const { prop } = splitTrack(t.name);
    const v = t.values;
    if (prop === 'quaternion') {
      const n = v.length / 4;
      if (n < 3) continue;
      _qKey.set(v[0], v[1], v[2], v[3]);                          // первый кадр
      _qOut.set(v[(n - 1) * 4], v[(n - 1) * 4 + 1], v[(n - 1) * 4 + 2], v[(n - 1) * 4 + 3]);
      if (Math.abs(_qKey.dot(_qOut)) > 0.99998) continue;         // уже замкнут
      _qGap.copy(_qOut).invert().multiply(_qKey);                 // сколько не хватает
      for (let i = 0; i < n; i++) {
        const u = Math.min(1, (t.times[i] || 0) / dur);
        _qFix.copy(_qId).slerp(_qGap, u);
        _qOut.set(v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]).multiply(_qFix).normalize();
        v[i * 4] = _qOut.x; v[i * 4 + 1] = _qOut.y;
        v[i * 4 + 2] = _qOut.z; v[i * 4 + 3] = _qOut.w;
      }
    } else if (prop === 'position') {
      const n = v.length / 3;
      if (n < 3) continue;
      for (let c = 0; c < 3; c++) {
        const gap = v[c] - v[(n - 1) * 3 + c];
        if (Math.abs(gap) < 1e-5) continue;
        for (let i = 0; i < n; i++) {
          v[i * 3 + c] += gap * Math.min(1, (t.times[i] || 0) / dur);
        }
      }
    }
  }
  return clip;
}

// Прогон клипа по скелету: где были обе стопы в каждом кадре цикла
function sampleClip(mixer, rig, clip, toes, samples) {
  const action = mixer.clipAction(clip);
  mixer.stopAllAction();
  action.reset();
  action.enabled = true;
  action.setEffectiveWeight(1);
  action.timeScale = 1;
  action.play();

  const dt = clip.duration / samples;
  const pts = [];
  action.time = 0;
  mixer.update(0);
  rig.updateMatrixWorld(true);   // прогрев: первая поза применена
  action.time = 0;
  mixer.update(0);
  for (let i = 0; i <= samples; i++) {
    rig.updateMatrixWorld(true);
    pts.push([
      new THREE.Vector3().setFromMatrixPosition(toes[0].matrixWorld),
      new THREE.Vector3().setFromMatrixPosition(toes[1].matrixWorld),
    ]);
    if (i < samples) mixer.update(dt);
  }
  mixer.stopAllAction();
  mixer.uncacheAction(clip);
  return { pts, dt };
}

// Разбор прогона: нижняя точка стопы за цикл и «длина шага в виде скорости».
//
// Порог опоры НЕ фиксированный: он свой у каждого клипа (нижняя точка + узкая
// полоса). Фиксированный порог врал именно на производных клипах — у них стопа
// висит выше или тонет, и в выборку попадали кадры быстрого маха, а не опоры.
function analyse(pts, dt, band) {
  let minY = Infinity;
  for (const [l, r] of pts) minY = Math.min(minY, l.y, r.y);
  const limit = minY + band;
  const sp = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const lo = pts[i][0].y <= pts[i][1].y ? 0 : 1;   // опорная — та, что ниже
    const a = pts[i][lo];
    if (a.y > limit) continue;                        // мах, а не опора
    const b = pts[i + 1][lo];
    sp.push(Math.hypot(b.x - a.x, b.z - a.z) / dt);
  }
  sp.sort((x, y) => x - y);
  return { minY, nat: sp.length ? sp[Math.floor(sp.length / 2)] : 0 };
}

// Дорожка положения таза — единственная, которой можно поднять/опустить фигуру
function hipsTrack(clip) {
  return clip.tracks.find((t) => /Hips\.position$/.test(t.name)) || null;
}

// Сдвиг таза по одной компоненте дорожки (в единицах рига Mixamo)
function shiftHips(clip, axis, delta) {
  const t = hipsTrack(clip);
  if (!t || !delta) return;
  for (let i = axis; i < t.values.length; i += 3) t.values[i] += delta;
}

// Какая компонента дорожки таза — «вверх», и сколько метров в её единице.
// Оси костей Mixamo повёрнуты, поэтому не угадываем, а пробуем: двигаем каждую
// компоненту и смотрим, что стало с высотой стоп. Замер один на весь риг.
function probeHipsAxis(mixer, rig, clip, toes, samples) {
  const s0 = sampleClip(mixer, rig, clip, toes, samples);
  const base = analyse(s0.pts, s0.dt, 0.05);
  let best = { axis: 1, k: 0 };
  const PROBE = 10;                                   // единиц рига
  for (let axis = 0; axis < 3; axis++) {
    shiftHips(clip, axis, PROBE);
    const s = sampleClip(mixer, rig, clip, toes, samples);
    const got = analyse(s.pts, s.dt, 0.05);
    shiftHips(clip, axis, -PROBE);
    const k = (got.minY - base.minY) / PROBE;         // метров мира на единицу
    if (Math.abs(k) > Math.abs(best.k)) best = { axis, k };
  }
  return best;
}

// Сборка производных клипов + калибровка. Вызывается ОДИН раз на общий gltf,
// до того как из него наклонируют игроков, — все клоны получают готовый набор.
export function buildDerivedClips(gltf) {
  if (gltf.userData.animReady) return gltf;
  const A = CONFIG.player.anim;

  // Поза покоя: сразу после загрузки кости стоят в bind pose, микшер их ещё
  // не трогал — можно брать как есть
  const rest = new Map();
  gltf.scene.traverse((o) => { if (o.isBone) rest.set(o.name, o.quaternion.clone()); });

  const byName = {};
  for (const c of gltf.animations) byName[c.name] = c;

  // Ось разведения плеча ищем ДО сборки клипов — на отдельном клоне в позе
  // покоя, чтобы ничего не испортить в общем gltf
  let spread = null;
  try {
    const probeRig = cloneSkeleton(gltf.scene);
    spread = probeSpread(probeRig, byName[(A.derive[0] && A.derive[0].from) || 'run']);
    probeRig.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  } catch (e) {
    console.error('Ось разведения плеча не найдена, руки останутся прижатыми:', e);
  }

  for (const spec of A.derive) {
    const src = byName[spec.from];
    if (!src) { console.warn(`Ф-98: нет исходного клипа ${spec.from} для ${spec.name}`); continue; }
    if (byName[spec.name]) continue;                 // уже есть в glb — не трогаем
    const clip = deriveClip(src, rest, spec, spec.name, spread);
    gltf.animations.push(clip);
    byName[spec.name] = clip;
  }

  // ЗЕРКАЛЬНЫЕ КЛИПЫ (src/mirror.js). Все силовые удары в паке Mixamo
  // правоногие, и левой ноге доставался один тычок `kick` — то есть у
  // левоногого игрока удара по воротам анимационно не существовало. Зеркало
  // считается из уже загруженного клипа; отдельный риг и микшер нужны потому,
  // что поза клона при замере портится, а общий gltf трогать нельзя.
  if (A.mirror && A.mirror.length) {
    let rig = null;
    let mx = null;
    try {
      rig = cloneSkeleton(gltf.scene);
      mx = new THREE.AnimationMixer(rig);
      for (const spec of A.mirror) {
        const src = byName[spec.from];
        if (!src) { console.warn(`Ф-98: нет клипа ${spec.from} для зеркала ${spec.name}`); continue; }
        if (byName[spec.name]) continue;
        const clip = mirrorClip(rig, mx, src, spec.name);
        if (!clip) { console.warn(`Ф-98: зеркало ${spec.name} не собралось`); continue; }
        gltf.animations.push(clip);
        byName[spec.name] = clip;
      }
    } catch (e) {
      console.error('Зеркальные клипы не собрались, левая нога останется с тычком:', e);
    } finally {
      if (mx) mx.uncacheRoot(rig);
      if (rig) rig.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    }
  }

  gltf.userData.locoSpeed = calibrate(gltf);
  gltf.userData.animReady = true;
  return gltf;
}

// Приземление и калибровка производных клипов.
//
// ЗАЧЕМ ПРИЗЕМЛЕНИЕ. Масштабирование размаха меняет не только длину шага, но и
// то, как далеко нога уходит ОТ ТАЗА по вертикали. Замер до правки: у бега
// стопа стоит ровно на нуле шесть кадров подряд (честная опора), а у
// производных ходьба ТОНУЛА в газон на 2 см, спринт ВИСЕЛ над ним на 4 см —
// опорной фазы не оставалось вовсе, и любая привязка темпа к длине шага теряла
// смысл. Поэтому после сборки каждый производный клип опускается/поднимается
// тазом так, чтобы нижняя точка стопы совпала с исходной.
function calibrate(gltf) {
  const out = {};
  const A = CONFIG.player.anim;
  let rig = null;
  try {
    rig = cloneSkeleton(gltf.scene);
    rig.scale.set(1, 1, 1);            // мерим «на единицу масштаба игрока»
    const toes = [
      rig.getObjectByName('mixamorigLeftToeBase'),
      rig.getObjectByName('mixamorigRightToeBase'),
    ];
    if (!toes[0] || !toes[1]) return out;
    const mixer = new THREE.AnimationMixer(rig);
    const byName = {};
    for (const c of gltf.animations) byName[c.name] = c;

    // Какая ось дорожки таза — «вверх». Ищем один раз на весь риг
    const probeSrc = byName[A.derive[0] && A.derive[0].from] || byName.run;
    const up = probeSrc ? probeHipsAxis(mixer, rig, probeSrc, toes, A.groundSamples) : null;

    for (const spec of A.derive) {
      const clip = byName[spec.name];
      const src = byName[spec.from];
      if (!clip) continue;
      // Целевая высота опоры — та же, что у исходного клипа
      let target = 0;
      if (src) {
        const s = sampleClip(mixer, rig, src, toes, A.groundSamples);
        target = analyse(s.pts, s.dt, A.groundBand).minY;
      }
      if (up && Math.abs(up.k) > 1e-6) {
        const s = sampleClip(mixer, rig, clip, toes, A.groundSamples);
        const got = analyse(s.pts, s.dt, A.groundBand).minY;
        shiftHips(clip, up.axis, (target - got) / up.k);
      }
      const s = sampleClip(mixer, rig, clip, toes, A.calibrateSamples);
      const res = analyse(s.pts, s.dt, A.groundBand);
      out[spec.name] = res.nat;
      if (A.logCalibration) out[`${spec.name}__minY`] = res.minY;
    }
    mixer.stopAllAction();
  } catch (e) {
    console.error('Калибровка шаговых клипов не удалась, темп ног будет грубым:', e);
  }
  if (rig) rig.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  if (A.logCalibration) {
    const pretty = {};
    for (const spec of A.derive) {
      const c = gltf.animations.find((x) => x.name === spec.name);
      if (!c || out[spec.name] == null) continue;
      pretty[spec.name] = `${out[spec.name].toFixed(2)} м/с · цикл ${c.duration.toFixed(2)} с`
        + ` · опора ${(out[`${spec.name}__minY`] || 0).toFixed(3)} м`;
      delete out[`${spec.name}__minY`];
    }
    console.log('Ф-98 · шаговые клипы (на единицу масштаба):', pretty);
  }
  for (const k in out) if (k.endsWith('__minY')) delete out[k];
  return out;
}
