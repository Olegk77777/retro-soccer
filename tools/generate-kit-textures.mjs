// Генератор пиксельных атласов форм 64×64.
// Координаты совпадают со схемой textures/kits/README.md: (0, 0) — снизу слева.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 64;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'textures/kits');

const C = {
  empty: '#48494c',
  seam: '#1a1a1c',
  boot: '#171719',
  white: '#eee9da',
  brazilYellow: '#f6cf19',
  brazilYellowShade: '#dfb915',
  brazilGreen: '#167342',
  brazilBlue: '#24469a',
  franceBlue: '#173b8f',
  franceBlueShade: '#123274',
  franceRed: '#d92736',
  keeperGreen: '#155c38',
  keeperGreenShade: '#10472c',
  keeperBlack: '#17191c',
  keeperBlackShade: '#0d0f11',
};

function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function atlas(fill = C.empty) {
  const image = new Uint8Array(SIZE * SIZE * 3);
  const color = rgb(fill);
  for (let i = 0; i < image.length; i += 3) image.set(color, i);
  return image;
}

function px(image, x, y, color) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const rowFromTop = SIZE - 1 - y;
  image.set(rgb(color), (rowFromTop * SIZE + x) * 3);
}

function rect(image, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) px(image, x, y, color);
  }
}

function line(image, x0, y0, x1, y1, color) {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    px(image, x, y, color);
    if (x === x1 && y === y1) break;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function baseOutfield(image, shirt, shirtShade, shorts, socks) {
  rect(image, 0, 32, 32, 64, shirt);
  rect(image, 32, 32, 64, 64, shirt);
  rect(image, 0, 16, 16, 32, shirt);
  rect(image, 16, 16, 32, 32, shirtShade);
  rect(image, 32, 16, 64, 32, shorts);
  rect(image, 0, 0, 16, 16, socks);
  rect(image, 16, 0, 32, 16, C.boot);
  // Пиксельные швы зон помогают форме не сливаться после CRT.
  rect(image, 0, 32, 32, 33, shirtShade);
  rect(image, 32, 32, 64, 33, shirtShade);
  rect(image, 32, 16, 64, 17, C.seam);
}

function brazilHome() {
  const image = atlas();
  baseOutfield(image, C.brazilYellow, C.brazilYellowShade, C.brazilBlue, C.white);

  // Круглый зелёный ворот, тонкий кант на плечах и манжетах Nike 1998.
  rect(image, 12, 61, 20, 64, C.brazilGreen);
  rect(image, 44, 61, 52, 64, C.brazilGreen);
  line(image, 2, 62, 11, 59, C.brazilGreen);
  line(image, 21, 59, 30, 62, C.brazilGreen);
  line(image, 34, 62, 43, 59, C.brazilGreen);
  line(image, 53, 59, 62, 62, C.brazilGreen);
  rect(image, 13, 16, 16, 32, C.brazilGreen);

  // Значок CBF и маленький зелёный swoosh читаются как 90-е, не как фото-принт.
  rect(image, 7, 50, 11, 55, C.brazilGreen);
  rect(image, 8, 51, 10, 54, C.brazilBlue);
  px(image, 9, 53, C.white);
  line(image, 22, 51, 27, 51, C.brazilGreen);
  line(image, 26, 51, 28, 53, C.brazilGreen);

  // Синие шорты с белым боковым кантом, белые гетры с зелёно-синим отворотом.
  rect(image, 32, 16, 34, 32, C.white);
  rect(image, 62, 16, 64, 32, C.white);
  rect(image, 0, 13, 16, 16, C.brazilGreen);
  rect(image, 0, 12, 16, 13, C.brazilBlue);
  return image;
}

function brazilKeeper() {
  const image = atlas();
  baseOutfield(
    image,
    C.keeperGreen,
    C.keeperGreenShade,
    C.keeperGreenShade,
    C.keeperGreen,
  );
  rect(image, 12, 61, 20, 64, C.brazilYellow);
  rect(image, 44, 61, 52, 64, C.brazilYellow);
  line(image, 2, 62, 11, 59, C.brazilYellow);
  line(image, 21, 59, 30, 62, C.brazilYellow);
  line(image, 34, 62, 43, 59, C.brazilYellow);
  line(image, 53, 59, 62, 62, C.brazilYellow);
  rect(image, 13, 16, 16, 32, C.brazilYellow);
  rect(image, 32, 16, 34, 32, C.brazilYellow);
  rect(image, 62, 16, 64, 32, C.brazilYellow);
  rect(image, 0, 13, 16, 16, C.brazilYellow);
  return image;
}

function franceHome() {
  const image = atlas();
  baseOutfield(image, C.franceBlue, C.franceBlueShade, C.white, C.franceRed);

  // Белый отложной ворот с триколором и знаменитая грудная полоса Vitesse.
  rect(image, 11, 60, 21, 64, C.white);
  rect(image, 43, 60, 53, 64, C.white);
  rect(image, 11, 60, 14, 61, C.franceRed);
  rect(image, 18, 60, 21, 61, C.franceBlue);
  rect(image, 0, 46, 32, 47, C.white);
  rect(image, 0, 47, 32, 51, C.franceRed);
  rect(image, 0, 51, 32, 52, C.white);

  // Три полосы adidas по плечам: синяя часть остаётся фоном, видны белая и красная.
  line(image, 2, 62, 10, 58, C.franceRed);
  line(image, 3, 63, 11, 59, C.white);
  line(image, 22, 59, 30, 63, C.white);
  line(image, 23, 58, 31, 62, C.franceRed);
  line(image, 34, 62, 42, 58, C.franceRed);
  line(image, 35, 63, 43, 59, C.white);
  line(image, 53, 59, 61, 63, C.white);
  line(image, 54, 58, 62, 62, C.franceRed);

  // Бело-красно-синие манжеты, белые шорты и красные гетры.
  rect(image, 12, 16, 14, 32, C.white);
  rect(image, 14, 16, 15, 32, C.franceRed);
  rect(image, 15, 16, 16, 32, C.franceBlue);
  rect(image, 32, 16, 34, 32, C.franceBlue);
  rect(image, 34, 16, 35, 32, C.white);
  rect(image, 35, 16, 36, 32, C.franceRed);
  rect(image, 60, 16, 61, 32, C.franceRed);
  rect(image, 61, 16, 62, 32, C.white);
  rect(image, 62, 16, 64, 32, C.franceBlue);
  rect(image, 0, 14, 16, 16, C.franceBlue);
  rect(image, 0, 13, 16, 14, C.white);

  // Петух FFF и adidas — по несколько контрастных пикселей, как на PS1.
  rect(image, 7, 53, 10, 56, C.white);
  px(image, 8, 56, C.franceRed);
  line(image, 23, 53, 27, 53, C.white);
  line(image, 24, 54, 26, 54, C.white);
  return image;
}

function franceKeeper() {
  const image = atlas();
  baseOutfield(
    image,
    C.keeperBlack,
    C.keeperBlackShade,
    C.keeperBlack,
    C.keeperBlack,
  );
  // Чёрная форма Barthez: белый ворот/манжеты и тонкая белая вертикальная полоска.
  rect(image, 11, 60, 21, 64, C.white);
  rect(image, 43, 60, 53, 64, C.white);
  for (const x of [4, 9, 14, 19, 24, 29, 36, 41, 46, 51, 56, 61]) {
    rect(image, x, 34, x + 1, 59, '#55585e');
  }
  rect(image, 13, 16, 16, 32, C.white);
  rect(image, 32, 16, 34, 32, C.white);
  rect(image, 62, 16, 64, 32, C.white);
  rect(image, 0, 13, 16, 16, C.white);
  return image;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function png(image) {
  const scanlines = Buffer.alloc((SIZE * 3 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const dst = y * (SIZE * 3 + 1);
    scanlines[dst] = 0;
    Buffer.from(image.buffer, image.byteOffset + y * SIZE * 3, SIZE * 3)
      .copy(scanlines, dst + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, image] of Object.entries({
  'brazil-1998-home.png': brazilHome(),
  'brazil-1998-gk.png': brazilKeeper(),
  'france-1998-home.png': franceHome(),
  'france-1998-gk.png': franceKeeper(),
})) {
  writeFileSync(resolve(OUT, name), png(image));
}

console.log('Готово: 4 атласа форм записаны в textures/kits/');
