# Texture pack «France 98»

Сгенерировано 18 июля 2026 встроенным генератором изображений Codex. Исходники сохранены в каталоге генератора; в игру положены уменьшенные степени двойки, чтобы не тратить память iPad и не заставлять детали мерцать в рендере 320×240.

## Файлы в игре

- `grass-98.png` — 512×512, бесшовная база тёмной травы за пределами поля.
- `pitch-worn-98.png` — 1024×663, полноразмерная карта поля с естественным износом у ворот и в центре.
- `crowd-night-98.png` — 1024×128, дальняя толпа с флагами сборных эпохи.
- `ads-france-98.png` — 1024×128, реальные печатные щиты; полный атлас повторяется раз примерно в 48 м.
- `../ball/tricolore-98.png` — 256×128, цветовая карта мяча France 98.

Разметка поля, слабые неровные полосы покоса, пятна прожекторов и CRT не запечены в PNG. Их добавляет игра: так линии остаются точными, фильтры переключаются, а текстуры можно заменить без изменения физики. Пространственный износ теперь хранится в отдельной карте всего поля: одинаковая 18-метровая плитка физически не могла правдоподобно отличать вратарские от центра.

## Финальные промпты

### Полноразмерный газон с износом

```text
Use case: stylized-concept
Asset type: full-field diffuse/albedo game texture for a low-resolution Three.js football pitch
Primary request: create one authentic late-1990s European stadium football grass surface with believable imperfections and localized wear, designed for a 1996–98 television-broadcast / PS1-era football game
Scene/backdrop: only the grass surface, filling the entire frame edge to edge
Style/medium: realistic top-down diffuse texture, restrained enough to survive 320×240 rendering and CRT filtering; natural analog-broadcast colors, not a cinematic photograph
Composition/framing: strict orthographic bird's-eye view at exactly 90 degrees; wide 3:2 landscape rectangle representing the whole 105×68 m pitch, with the goals conceptually at the exact left and right center edges; no perspective, no horizon
Color palette: muted medium broadcast greens with olive and slightly yellow-green variation, no neon and no brown vintage wash
Materials/textures: short late-summer stadium grass, slightly uneven density and mowing, subtle broad cloudy color variation; gently flattened and pale worn grass in both goalmouth traffic zones near the left and right center edges, modest wear through the central midfield corridor and around the unseen kickoff area, a few faint irregular scuffs and reseeded patches; damage is restrained and mostly grass-colored, with only tiny hints of dry soil; wear must look accumulated by football play, not decorative grunge
Constraints: flat even albedo illumination; no painted field lines, no center circle, no penalty-box markings, no goalposts, no players, no ball, no stadium, no shadows, no spotlight gradients, no 3D relief, no objects, no text, no logos, no watermark; keep all important wear inside the image rather than cut off; natural irregularity, not bilateral mirror symmetry
Avoid: pristine modern striped carpet, repeated tile motifs, checkerboard mowing, huge mud patches, bare dirt goalmouths, close-up macro blades, long grass, modern saturated FIFA-game look, sepia, fake film grain, scratches, vignette, dramatic lighting
```

### Бесшовная основа травы для отбивки

```text
Use case: stylized-concept
Asset type: seamless tileable game texture for a low-resolution Three.js football pitch
Primary request: authentic late-1990s European stadium football grass, seen perfectly top-down at 90 degrees
Style/medium: realistic diffuse/albedo texture deliberately suitable for PS1-era low-resolution rendering and an analog CRT broadcast
Color palette: restrained medium and dark broadcast greens, slightly olive, not neon
Materials/textures: very short freshly mown blades, subtle uneven density, tiny pale dry tips, restrained worn and flattened patches, faint soil only in a few tiny areas
Composition/framing: the entire square is one continuous grass surface, uniform scale, no perspective
Constraints: perfectly seamless on all four edges; flat even illumination; no painted field lines; no mowing stripes; no shadows; no gradient; no objects; no text; no logos; no watermark
Avoid: close-up macro grass, long blades, modern hyper-saturated FIFA look, large dirt patches, obvious repeated motifs
```

### Толпа

```text
Use case: historical-scene
Asset type: horizontally tileable stadium crowd texture for a low-resolution Three.js game
Primary request: dense football spectators in a European stadium in 1998, viewed straight-on from a distant television camera
Subject: thousands of tiny spectators packed edge-to-edge, late-1990s jackets, scarves and caps, a few small French, Brazilian, Italian, German, English, Dutch, Argentine and Croatian flags dispersed naturally
Style/medium: realistic but intentionally coarse diffuse/albedo texture that will be downsampled and seen through a 320x240 CRT broadcast
Lighting/mood: evening floodlight ambience, dark recesses between people, warm skin and muted clothing
Composition/framing: flat straight-on facade, crowd fills every edge, no foreground figures, no dominant person
Constraints: horizontally seamless; no perspective; no aisles; no empty seats; no stadium architecture; no readable banners; no modern smartphones; no modern LED lights; no watermarks
Avoid: close-up faces, repeated cloned people, carnival colors, glossy modern sports-game crowd
```

### Рекламные щиты

```text
Use case: historical-scene
Asset type: wide advertising hoarding texture strip for a 1998 football stadium in a low-resolution game
Primary request: six adjacent printed pitch-side advertising panels exactly in the visual language of the 1998 World Cup era
Subject: authentic period brand panels for "Coca-Cola", "adidas", "Canon", "FUJIFILM", "PHILIPS", and "McDonald's", one brand per equal-width panel, each rendered exactly once and spelled correctly
Style/medium: straight-on flat diffuse/albedo texture of printed vinyl and painted boards, slightly faded, scuffed lower edges, analog broadcast color
Composition/framing: one long horizontal row, equal panel heights, hard vertical seams, no perspective, no surrounding stadium
Text (verbatim): "Coca-Cola", "adidas", "Canon", "FUJIFILM", "PHILIPS", "McDonald's"
Constraints: exact readable brand names; period-appropriate 1998 colors and wordmark styling; no extra text; no people; no shadows; no 3D mockup; no watermark
Avoid: LED boards, modern glossy gradients, invented brands, misspelled text, duplicated panels
```

### Мяч

```text
Use case: stylized-concept
Asset type: equirectangular diffuse UV texture for a low-poly football mesh
Primary request: the authentic Adidas Tricolore match-ball graphic used at the 1998 FIFA World Cup, laid out as a flat rectangular surface texture
Subject: white leather base with the recognizable blue, red and gold Tricolore rooster/flame motifs and small authentic adidas wordmark details
Style/medium: clean but lightly match-worn diffuse/albedo texture, designed to remain recognizable on a 10x8-segment low-poly sphere at 320x240 resolution
Composition/framing: flat edge-to-edge 2:1 equirectangular UV-style layout, repeated motifs distributed evenly, horizontally seamless
Constraints: texture map only; no rendered ball; no sphere; no perspective; no lighting; no shadows; no background scene; no watermark
Avoid: black-and-white pentagon ball, Brazuca/Telstar/Jabulani patterns, modern glossy product photography
```
