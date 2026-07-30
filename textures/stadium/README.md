# Texture pack «France 98»

Сгенерировано 18–26 июля 2026 встроенным генератором изображений Codex. Исходники сохранены в каталоге генератора; игровые версии уменьшены до разумного размера, чтобы не тратить память iPad и не заставлять детали мерцать в рендере 320×240.

## Файлы в игре

- `grass-98.png` — 512×512, ухоженный край шкалы 0 % и бесшовная трава за пределами поля.
- `pitch-balanced-98.png` — 1024×663, умеренный износ 50 %; золотая середина и значение по умолчанию.
- `pitch-worn-98.png` — 1024×663, сильно вытоптанный край шкалы 100 %.
- `crowd-night-98.png` — 1024×128, прежняя крупная толпа (сохранена как исходник).
- `crowd-night-98-fine.png` — 2048×256, рабочая мелкая плотная толпа; в игре
  масштабируется в метрах одинаково на прямых и угловых секторах чаши.
- `ads-france-98.png` — 1024×128, реальные печатные щиты; полный атлас повторяется раз примерно в 48 м.
- `../ball/tricolore-98.png` — 256×128, цветовая карта мяча France 98.

Ползунок в настройках плавно смешивает 0→50→100 % на canvas; выбор хранится в `f98.pitchWear`. Яркость трёх источников калибруется отдельно, поэтому меняется степень износа, а не экспозиция поля. Рисунок покоса выбирается независимо: `classic` — прежние 14 прямых полос и значение по умолчанию, `wide-98` — 10 широких прямых полос, `arcs-80` — вложенные полукруги вокруг центра поля по референсу старой телетрансляции; выбор хранится в `f98.pitchPattern`. Разметка, три рисунка покоса, пятна прожекторов и CRT не запечены в PNG — их добавляет игра, чтобы линии оставались точными, износ смешивался независимо, а фильтры переключались без новых текстур.

## Финальные промпты

### Умеренный газон — золотая середина

```text
Use case: precise-object-edit
Asset type: balanced-wear full-field diffuse/albedo texture for a low-resolution Three.js football pitch
Input images: Image 1 is the edit target and defines the exact full-pitch composition, orthographic viewpoint, scale, broad color distribution and localized wear map. Image 2 is a supporting reference for healthier dense grass texture and deeper late-1990s broadcast green; do not copy its square framing or repeated details.
Primary request: create the golden-middle version between these two surfaces. Reduce the visible wear of Image 1 by roughly half while keeping the same natural locations: both goalmouth traffic zones near the left and right center edges, the midfield corridor and kickoff area. Replace much of the pale flattened grass with healthy grass matching Image 2, but retain subtle uneven density, faint reseeded patches, a few soft scuffs and restrained signs of match use. It must clearly be less worn than Image 1, yet clearly less pristine and uniform than Image 2.
Style/medium: realistic flat diffuse/albedo texture for a 1996–98 TV-broadcast / PS1-era football game; broad calm variation that survives 320×240 rendering, not a cinematic photograph.
Composition/framing: preserve Image 1 exactly — strict 90-degree orthographic bird's-eye view, full wide 105×68 m pitch surface filling the frame, goals conceptually at left and right center edges, no perspective.
Color palette: preserve restrained olive broadcast greens; slightly deepen the healthy grass toward Image 2 without making it dark, neon or modern.
Constraints: change only the intensity and density of grass wear; preserve the full-field layout and natural irregularity. Flat even albedo illumination. No painted field lines, center circle, penalty-box markings, goalposts, players, ball, stadium, shadows, spotlight gradients, objects, text, logos or watermark. No bilateral mirror symmetry.
Avoid: pristine modern carpet, obvious checkerboard mowing, huge mud patches, bare soil, repeated tile motifs, macro blades, modern saturated FIFA look, sepia, grain overlay, scratches, vignette or dramatic lighting.
```

### Сильно вытоптанный газон

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
