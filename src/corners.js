// Угловые флажки. Четыре штуки, ровно в точках пересечения боковой и лицевой
// линий. По правилам шест не ниже 1,5 м и обязательно с ТУПЫМ верхом — отсюда
// набалдашник, а не остриё.
//
// Флажок — единственный предмет на поле, который живёт САМ: он полощется на
// ветру стадиона (общий вектор CONFIG.atmosphere.wind — тот же, что несёт дым
// с трибун), гнётся, когда мимо проносится игрок, и качается обратно.
//
// МЯЧ ФЛАЖОК НЕ ТОРМОЗИТ И НЕ ОТСКАКИВАЕТ ОТ НЕГО, и это не упрощение, а
// осознанное решение: угловой ставится в 0.35 м от древка (restart.lineInset),
// то есть физический столбик в этой точке ломал бы КАЖДУЮ подачу с угла.
// Мяч флажок только гнёт — ровно так это и читается в трансляции.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { addRim } from './rimlight.js';

// Полотнище: два цвета клином от древка — так флажок читается даже когда
// занимает в кадре четыре пикселя, а на повторе виден рисунок.
function flagTexture() {
  const C = CONFIG.corners;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 48;
  const ctx = c.getContext('2d');
  ctx.fillStyle = C.flagColor;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = C.flagColorAlt;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(c.width * C.stripe, 0);
  ctx.lineTo(0, c.height);
  ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class CornerFlag {
  constructor(scene, x, z, shared) {
    const C = CONFIG.corners;
    this.x = x;
    this.z = z;
    // Наклон древка — две пружины (вокруг X и Z). Держим углы, а не матрицу:
    // так и толчок, и возврат считаются парой строк.
    this.bendX = 0;
    this.bendZ = 0;
    this.velX = 0;
    this.velZ = 0;
    this.phase = (x * 0.7 + z * 1.3) % (Math.PI * 2); // свой ритм у каждого угла

    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    // Пивот у земли: шест гнётся от основания, как воткнутый в газон прут.
    this.pole = new THREE.Mesh(shared.poleGeo, shared.poleMat);
    this.pole.position.y = C.poleHeight / 2;
    this.group.add(this.pole);
    const knob = new THREE.Mesh(shared.knobGeo, shared.poleMat);
    knob.position.y = C.poleHeight;
    this.group.add(knob);

    // Полотнище висит на древке своим ЛЕВЫМ краем: геометрию сдвигаем так,
    // чтобы x = 0 был у древка, тогда волна считается от него же.
    const geo = new THREE.PlaneGeometry(C.flagW, C.flagH, C.segments, 2);
    geo.translate(C.flagW / 2, 0, 0);
    this.flag = new THREE.Mesh(geo, shared.flagMat);
    this.flag.position.y = C.poleHeight - C.flagTop - C.flagH / 2;
    this.group.add(this.flag);
    this.base = geo.attributes.position.array.slice();
    scene.add(this.group);
  }

  // Толчок от пробегающего тела. Это СИЛА, а не готовая скорость: множитель
  // обязан идти через dt, иначе на 120-герцовом планшете флажок гнётся вдвое
  // сильнее, чем на 60 Гц (замер первой редакции: спринт клал шест в упор
  // предела на каждом пробегающем, и предел переставал что-либо значить).
  hit(px, pz, vx, vz, kick, dt) {
    const C = CONFIG.corners;
    const dx = this.x - px;
    const dz = this.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > C.hitRadius) return false;
    const speed = Math.hypot(vx, vz);
    if (speed < 0.2) return false;
    // Гнётся флажок ПО ходу задевшего: наклон вокруг Z — это ход по X.
    // Сила растёт КВАДРАТИЧНО со скоростью, и это не украшение: время в зоне
    // падает как 1/v, поэтому при линейной силе итоговый импульс не зависит от
    // скорости вовсе — замер первой редакции дал 11.9° у идущего шагом и 13.9°
    // у спринтера, то есть флажок отвечал одинаково на что угодно.
    const k = kick * speed * speed * (1 - d / C.hitRadius) * dt;
    this.velZ -= vx * k / speed;
    this.velX += vz * k / speed;
    return true;
  }

  update(dt, t, windX, windZ) {
    const C = CONFIG.corners;
    // Пружина возврата: ветер даёт постоянный наклон, толчки — рывки.
    const restZ = -windX * 0.03;
    const restX = windZ * 0.03;
    this.velZ += (restZ - this.bendZ) * C.bendSpring * dt - this.velZ * C.bendDamping * dt;
    this.velX += (restX - this.bendX) * C.bendSpring * dt - this.velX * C.bendDamping * dt;
    this.bendZ = THREE.MathUtils.clamp(this.bendZ + this.velZ * dt, -C.bendMax, C.bendMax);
    this.bendX = THREE.MathUtils.clamp(this.bendX + this.velX * dt, -C.bendMax, C.bendMax);
    this.group.rotation.set(this.bendX, 0, this.bendZ);

    // Полотнище относит ПО ВЕТРУ: угол берётся из общего вектора стадиона,
    // а не выдумывается на месте — иначе флаг и дым покажут разные стороны.
    // Знак проверяется подстановкой, а не рассуждением: локальная +X после
    // поворота на θ вокруг Y смотрит в (cos θ, 0, −sin θ), поэтому θ считается
    // от (−windZ, windX), а не от (windX, windZ).
    this.flag.rotation.y = Math.atan2(-windZ, windX);

    // Волна по полотнищу. Амплитуда растёт от древка к свободному краю:
    // у древка ткань прибита, там движения нет вовсе.
    const pos = this.flag.geometry.attributes.position;
    const arr = pos.array;
    const wind = Math.min(1.6, Math.hypot(windX, windZ) / 2.5);
    for (let i = 0; i < arr.length; i += 3) {
      const bx = this.base[i];
      const by = this.base[i + 1];
      const along = bx / C.flagW;
      const wave = Math.sin(t * C.wave + this.phase - along * 6.2) * C.waveAmp * wind;
      arr[i + 2] = wave * along * along;
      // Свободный край слегка провисает и подбирается к древку — без этого
      // флажок читается жестяной табличкой, а не тряпкой.
      arr[i] = bx - along * along * C.flagW * 0.12 * wind;
      arr[i + 1] = by - along * 0.02 * (1 - wind * 0.5);
    }
    pos.needsUpdate = true;
    // Нормали пересчитываем: без этого волна не ловит свет мачт и полотнище
    // читается жестью. Двадцать семь вершин на флажок — цена нулевая.
    this.flag.geometry.computeVertexNormals();
  }
}

export class CornerFlags {
  constructor(scene) {
    const C = CONFIG.corners;
    const F = CONFIG.field;
    // Геометрия и материалы общие на все четыре: четыре одинаковых материала
    // дали бы четыре шейдерные программы на ровном месте.
    const shared = {
      poleGeo: new THREE.CylinderGeometry(C.poleRadius, C.poleRadius * 1.15, C.poleHeight, 6),
      knobGeo: new THREE.SphereGeometry(C.knobRadius, 6, 4),
      // Белый прут на фоне тёмной трибуны без каймы не читается объёмом —
      // та же причина, по которой кайма есть у штанг ворот.
      poleMat: addRim(
        new THREE.MeshLambertMaterial({ color: C.poleColor, emissive: 0x4a4a4a }),
        CONFIG.atmosphere.rim.gearScale,
      ),
      flagMat: new THREE.MeshLambertMaterial({
        map: flagTexture(),
        emissive: 0x333333,
        side: THREE.DoubleSide,
      }),
    };
    this.flags = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.flags.push(new CornerFlag(scene, sx * F.length / 2, sz * F.width / 2, shared));
      }
    }
    this.t = 0;
  }

  update(dt, players = null, ball = null) {
    const C = CONFIG.corners;
    const W = CONFIG.atmosphere.wind;
    this.t += dt;
    for (const flag of this.flags) {
      if (players) {
        for (const p of players) {
          const pos = p.group.position;
          // Дешёвый отсев: у угла бывают двое-трое за матч, а игроков 22.
          if (Math.abs(pos.x - flag.x) > C.hitRadius || Math.abs(pos.z - flag.z) > C.hitRadius) continue;
          flag.hit(pos.x, pos.z, p.vel.x, p.vel.z, C.hitKick, dt);
        }
      }
      if (ball) {
        const bp = ball.mesh.position;
        if (bp.y < CONFIG.corners.poleHeight) {
          flag.hit(bp.x, bp.z, ball.vel.x, ball.vel.z, C.ballKick, dt);
        }
      }
      flag.update(dt, this.t, W.x, W.z);
    }
  }
}
