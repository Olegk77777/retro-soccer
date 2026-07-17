Материала достаточно. Собираю итоговый отчёт.

# Ретро-футбол: PS1-лук и CRT в Three.js — отчёт (июль 2026)

## TL;DR — рекомендуемый пайплайн
Рендерить сцену в низкоразрешённый render target (~320×240–480×270, `NearestFilter`), PS1-эффекты делать в материалах (vertex snapping + affine UV через `onBeforeCompile`), а весь CRT — **одним** объединённым проходом постобработки через библиотеку [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) (актуальная версия **v6.39.2 от 28.06.2026**, zlib, peer-dep `three`, есть сборки для CDN/importmap — совместимо с паттерном «HTML+JS без сборщика»). Газон — текстура с полосами покоса + лёгкий шейдер, без инстансинга травинок.

---

## (а) PS1-эффекты: готовые реализации для Three.js

- **Базовый разбор с кодом:** [«PS1 style graphics in Three.js» — Roman Liutikov, 11.03.2023](https://romanliutikov.com/blog/ps1-style-graphics-in-threejs). Лучшая единая статья: low-poly, 15-битный цвет, текстуры 128×128, **готовый GLSL 8×8 Bayer-дизеринга + постеризации** (код прямо в статье), вершинный снаппинг. Формула снаппинга (проверена в статье и на [форуме three.js, тред про affine mapping](https://discourse.threejs.org/t/affine-texture-mapping-in-shader-ps1-style-graphics/5945)):
  ```glsl
  vec4 pos = projectionMatrix * mvPosition;
  pos.xyz /= pos.w;
  pos.xy = floor(vec2(320.,240.) * pos.xy) / vec2(320.,240.);
  pos.xyz *= pos.w;
  ```
  Там же — affine mapping: в vertex умножить UV на «аффинный фактор» (дистанцию), во fragment разделить обратно.
- **Готовый jitter-шейдер (репозиторий):** [oguzhantufenk/ps1-jitter-shader](https://github.com/oguzhantufenk/ps1-jitter-shader) (~30★) + туториал [Codrops, 03.09.2024](https://tympanus.net/codrops/2024/09/03/how-to-create-a-ps1-inspired-jitter-shader-with-react-three-fiber/). Написан под R3F, но суть — патч `MeshStandardMaterial.onBeforeCompile`, переносится в ванильный Three.js почти дословно.
- **Готовый PSX-pass на ванильном JS:** [wboodon/threejs-ps1](https://github.com/wboodon/threejs-ps1) — маленький (1★), но содержит `RenderPsxPass.js` — цельный проход «PS1-лук в браузере», удобен как референс под стек без сборщика.
- **Низкое разрешение + пикселизация из коробки:** официальный аддон three.js [`RenderPixelatedPass`](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/postprocessing/RenderPixelatedPass.js) (`three/addons/postprocessing/RenderPixelatedPass.js`, живой пример `webgl_postprocessing_pixel` на threejs.org) — рендерит сцену в маленький target с NearestFilter.
- **Палитра + дизеринг одним проходом:** [@mesmotronic/three-retropass](https://github.com/mesmotronic/three-retropass) — npm **v1.3.0 от 19.03.2026**, BSD-2-Clause, `three >= 0.128`. Пример из README: `new RetroPass({ resolution: new THREE.Vector2(320, 200), colorCount: 16, dithering: true })` — низкое разрешение, квантование до N цветов (2–4096) и дизеринг сразу. [Живое демо](https://mesmotronic.github.io/three-retropass/).
- **Отдельные dither-репозитории:** [samwhitford/threejs-ordered-dithering-effect](https://github.com/samwhitford/threejs-ordered-dithering-effect) (Bayer 2/4/8), [Chajac/OrderedDither](https://github.com/Chajac/OrderedDither) (R3F, ограничение палитры). Теория с интерактивными примерами: [Maxime Heckel — «The Art of Dithering and Retro Shading»](https://blog.maximeheckel.com/posts/the-art-of-dithering-and-retro-shading-web/).

Известные Unity-шейдеры ([dsoft20/psx_retroshader](https://github.com/dsoft20/psx_retroshader)) — только как справка по формулам, не тянуть.

## (б) CRT-постобработка

- **Основной путь — pmndrs/postprocessing:** содержит готовые `ScanlineEffect`, `VignetteEffect`, `LensDistortionEffect` (кривизна), `ChromaticAberrationEffect`, `NoiseEffect`, `GridEffect`, `PixelationEffect` ([список в README](https://github.com/pmndrs/postprocessing), [доки](https://pmndrs.github.io/postprocessing/public/docs/)). Ключевое для планшета: `EffectPass` **автоматически сшивает набор эффектов в один шейдер-проход** — 4–5 CRT-эффектов стоят как один fullscreen-pass.
- **Фосфорная маска / полный CRT одним шейдером:** канонический шейдер **crt-mattias** — [libretro/glsl-shaders/crt/shaders/crt-mattias.glsl](https://github.com/libretro/glsl-shaders/blob/master/crt/shaders/crt-mattias.glsl) (кривизна, scanlines, RGB-маска, мерцание; оригинал — Shadertoy). Портирование Shadertoy→ShaderPass тривиально (замена iResolution/iTime): [гайд-гист](https://gist.github.com/scummtomte/523f2e4c403c083d6983f8865ca24bc7), [тред форума](https://discourse.threejs.org/t/help-me-to-port-a-shadertoy-shader-to-three-js/35505).
- **VHS/помехи для меню и повторов:** [felixturner/bad-tv-shader](https://github.com/felixturner/bad-tv-shader) (520★, MIT, классика; репозиторий 2019 г. — шейдеры рабочие, но обёртку под текущий EffectComposer надо обновить; есть форк [bad-tv-shader-mod](https://github.com/g-l-i-t-c-h-o-r-s-e/bad-tv-shader-mod)).
- Демо целиком «CRT-монитор в Three.js»: [daenavan/crt-threejs](https://daenavan.github.io/crt-threejs/), [unframework/threejs-crt-shader](https://github.com/unframework/threejs-crt-shader) (канвас на 3D-модели монитора — другой кейс, для игры не нужен).

## (в) Газон стадиона

Для вида «камера сверху/сбоку, 90-е»:
- **Рекомендация: текстура + шейдер, НЕ травинки.** Полосы покоса — это просто чередование двух оттенков зелёного по `floor(uv.y * N)` (или `mod`) в фрагментном шейдере плоскости, плюс шумовая текстура вытоптанности и разметка. Один draw call, ~0 нагрузки. На низком разрешении PS1-таргета инстансная трава всё равно превратится в кашу — аутентично 90-м как раз плоское поле (ISS Pro Evolution так и выглядел).
- Если захочется 3D-травы у кромки поля — проверенные примеры инстансинга: [James-Smyth/three-grass-demo](https://github.com/James-Smyth/three-grass-demo) (93★, GLSL-ветер, [туториал автора](https://smythdesign.com/blog/stylized-grass-webgl/)), [al-ro: 100 000 лезвий через `InstancedBufferGeometry`](https://al-ro.github.io/projects/grass/) с анимацией в vertex-шейдере, [simondevyoutube/Quick_Grass](https://github.com/simondevyoutube/Quick_Grass) (224★). Самый производительный пример: [thebenezer/FluffyGrass](https://github.com/thebenezer/FluffyGrass) ([Codrops, 04.02.2025](https://tympanus.net/codrops/2025/02/04/how-to-make-the-fluffiest-grass-with-three-js/)) — чанки 16×16 + frustum culling + 3 уровня LOD, «до 1 млн инстансов», автор заявляет работу на мобильных при сниженных настройках.

## Производительность на планшетах (iPad/Android)

1. **Низкоразрешённый PS1-таргет — главный «чит»:** фрагментная нагрузка падает в ~9–16 раз (320×240 против retina-фуллскрина), CRT-шейдер потом растягивает картинку. Ретро-стиль сам по себе спасает FPS.
2. **Один проход вместо цепочки:** каждый дополнительный pass на тайловых мобильных GPU — лишний resolve рендер-таргета; форум three.js подтверждает заметные просадки от самой цепочки EffectComposer ([раз](https://discourse.threejs.org/t/way-to-fix-performance-lag-using-effectcomposer/20256), [два](https://discourse.threejs.org/t/postprocessing-performance/35776)). Отсюда выбор pmndrs (мерж эффектов) либо одного самописного «PSX+CRT» ShaderPass.
3. `renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))`, отключить antialias (он не нужен — наоборот), избегать `HalfFloatType`-буферов на мобильных.
4. Дизеринг/палитра — считать в том же финальном проходе (как делает RetroPass), а не отдельным.

**Все версии и даты проверены на 17.07.2026.**
