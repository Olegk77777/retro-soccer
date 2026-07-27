// Номер и фамилия на спине — поверх атласа формы, кодом.
//
// Зачем. На трансляции 98-го номер на спине виден почти в каждом крупном плане
// и в каждом повторе. Без него фигура читается манекеном в цветной майке.
// Это дешевле любой другой детали: ноль треугольников, одна текстура.
//
// КАК ЭТО РАБОТАЕТ. Базовый атлас формы (64×64, textures/kits/*.png) увеличиваем
// БЕЗ СГЛАЖИВАНИЯ в четыре раза — каждый исходный пиксель становится квадратом
// 4×4, то есть форма остаётся ровно такой же грубой, как была. А вот номер
// рисуется уже по сетке 256 и потому выходит чётким. Это и есть картинка
// эфира: плоская майка и резко отпечатанный номер.
//
// Лицензионный слой не трогаем: и номер, и фамилия берутся из squad, значит
// пак retro-legends подменит надписи сам, без единой правки кода.
import * as THREE from 'three';

export const KITNUM = {
  scale: 4,            // во сколько раз крупнее атласа 64×64
  // Границы в координатах АТЛАСА (0,0 — низ слева, как в textures/kits/README.md).
  // Зона спины — (32,32)-(64,64).
  // Номер занимает середину спины: верх — под лопатками, низ — выше пояса.
  // Пересчёт в метры: y атласа 41…55 это высота 1.12…1.36 на фигуре ростом 1.8.
  numTop: 53,          // верх номера
  numBottom: 39,       // низ номера
  // Фамилия идёт НАД номером, но ниже линии плеч: выше её закрывают рукав и
  // воротник, и на модели остаётся только номер.
  nameTop: 58.5,
  nameBottom: 55.5,
  centerX: 48,         // середина зоны спины
};

// Базовые картинки формы грузятся один раз на путь, а не на игрока.
const imgCache = new Map();
function loadImage(path) {
  if (imgCache.has(path)) return imgCache.get(path);
  const p = new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`Форма не загрузилась: ${path}`));
    im.src = path;
  });
  imgCache.set(path, p);
  return p;
}

// Шрифт эфира тот же, что у телеграфики (Oswald, узкий гротеск с кириллицей).
// Ждать его ОБЯЗАТЕЛЬНО: без загруженного шрифта canvas посчитает ширину по
// запасному, и номер уедет из центра спины.
let fontsReady = null;
function whenFonts() {
  if (!fontsReady) {
    fontsReady = (document.fonts && document.fonts.ready)
      ? document.fonts.ready.catch(() => null)
      : Promise.resolve();
  }
  return fontsReady;
}

const texCache = new Map();

/** Цвет номера: белый на тёмной форме, тёмный на светлой. Берём пробу с самой
 *  зоны спины, а не с «основного цвета команды» — у вратаря он другой. */
function pickInkColor(ctx, S) {
  const s = KITNUM.scale;
  const d = ctx.getImageData(Math.round(40 * s), Math.round((64 - 50) * s),
                             Math.round(8 * s), Math.round(8 * s)).data;
  let lum = 0;
  for (let i = 0; i < d.length; i += 4) {
    lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  }
  lum /= d.length / 4;
  return lum > 128
    ? { ink: '#1b1d22', edge: 'rgba(255,255,255,0.55)' }
    : { ink: '#f2efe6', edge: 'rgba(0,0,0,0.45)' };
}

function draw(canvas, img, look) {
  const s = KITNUM.scale;
  const S = 64 * s;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;          // форма обязана остаться пиксельной
  g.clearRect(0, 0, S, S);
  g.drawImage(img, 0, 0, S, S);

  const num = look && look.number;
  if (num === undefined || num === null) return;

  // Атласная координата → пиксель холста. Строка 0 холста — это ВЕРХ атласа
  // (y = 64): PNG хранится сверху вниз, а текстура читается с flipY = false.
  const cy = (atlasY) => (64 - atlasY) * s;
  const cx = (atlasX) => atlasX * s;

  const { ink, edge } = pickInkColor(g, S);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  const numH = (KITNUM.numTop - KITNUM.numBottom) * s;
    // Начертание ровно то, что грузит index.html (400/500/700). Попроси 600 —
  // браузер подменит его синтетическим полужирным, и цифра поплывёт.
  g.font = `700 ${Math.round(numH)}px Oswald, "Arial Narrow", sans-serif`;
  const nx = cx(KITNUM.centerX);
  const ny = cy((KITNUM.numTop + KITNUM.numBottom) / 2);
  // Тонкая обводка: на пёстрой форме голая цифра теряется, а толстая читается
  // современной наклейкой. Полпикселя атласа — ровно как печатали в 90-х.
  g.lineWidth = Math.max(1, s * 0.5);
  g.strokeStyle = edge;
  g.strokeText(String(num), nx, ny);
  g.fillStyle = ink;
  g.fillText(String(num), nx, ny);

  const name = look.name;
  if (name) {
    const nameH = (KITNUM.nameTop - KITNUM.nameBottom) * s;
    g.font = `500 ${Math.round(nameH)}px Oswald, "Arial Narrow", sans-serif`;
    g.fillStyle = ink;
    // Фамилию сжимаем по ширине зоны: длинная («ДЖОРКАЕФФ») иначе вылезет
    // на бока футболки, где развёртка идёт уже другой зоной.
    const maxW = 26 * s;
    g.save();
    const w = g.measureText(name).width;
    if (w > maxW) {
      g.translate(nx, 0);
      g.scale(maxW / w, 1);
      g.translate(-nx, 0);
    }
    g.fillText(name, nx, cy((KITNUM.nameTop + KITNUM.nameBottom) / 2));
    g.restore();
  }
}

/**
 * Текстура формы с номером конкретного игрока.
 * Возвращается СРАЗУ, картинка дорисовывается по загрузке PNG и шрифта.
 * @param path — путь к атласу 64×64
 * @param look — запись из squad ({ number, name })
 */
export function kitTextureWithNumber(path, look) {
  const num = look && look.number;
  // КЛЮЧ ОБЯЗАН СОДЕРЖАТЬ НОМЕР. С ключом по одному только пути вся команда
  // молча получит текстуру того, кто загрузился первым, — то есть одиннадцать
  // игроков с одинаковой цифрой на спине.
  const key = `${path}#${num}#${(look && look.name) || ''}`;
  if (texCache.has(key)) return texCache.get(key);

  const S = 64 * KITNUM.scale;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;                       // как у исходного атласа
  tex.magFilter = THREE.NearestFilter;
  // А вот минификация — с мипами, в отличие от старого атласа 64×64. Причина
  // в номере: он мелкий и контрастный, и без мипов на общем плане начинает
  // мерцать на каждом шаге игрока. Сама форма от мипов не страдает: её
  // крупные заливки размываются только на дистанции, где их и так не видно.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, tex);

  Promise.all([loadImage(path), whenFonts()])
    .then(([img]) => {
      draw(canvas, img, look);
      tex.needsUpdate = true;
    })
    .catch((e) => console.error('Номер на форме не нарисовался:', e));

  return tex;
}
