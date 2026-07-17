# Раздача браузерной игры друзьям на тестирование — отчёт (июль 2026)

## TL;DR
Для проекта «HTML+JS+Three.js через CDN, без сборщика» оптимум — **GitHub Pages, режим «Deploy from a branch»**: `git push` → сайт сам обновился, ноль конфигурации CI. Запасной/дополнительный вариант — **itch.io в режиме Draft** (секретная ссылка, заливка одной командой `butler push`). Netlify/Vercel — избыточны для этой задачи, у обоих в 2025–26 ужесточились бесплатные лимиты.

---

## (а) GitHub Pages

- **Бесплатно только для public-репозиториев** на тарифе Free; Pages из private-репозитория требует платный GitHub Pro/Team/Enterprise ([docs: Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [обсуждение](https://github.com/orgs/community/discussions/22817)). Важно: сайт Pages **всегда публичен по URL**, даже если репо private — «скрыть от чужих» ссылку можно только неочевидностью URL.
- **Лимиты:** сайт ≤ 1 ГБ, «мягкие» 100 ГБ трафика/мес и 10 билдов/час — для друзей-тестеров с запасом ([docs](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)).
- **Включение:** репозиторий → **Settings → Pages** → источник публикации. Два режима ([docs: configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)):
  1. **Deploy from a branch** — выбрать ветку (`main`) и папку (`/` или `/docs`). Каждый push в ветку автоматически публикует сайт. Для проекта без сборки — это всё, GitHub Actions писать не нужно (Pages сам запускает служебный workflow).
  2. **GitHub Actions (custom workflow)** — нужен, только если есть шаг сборки. Не наш случай.
- URL будет `https://<username>.github.io/<repo>/`. Нюанс: пути к ассетам должны быть относительными (`./textures/...`), а не от корня (`/textures/...`), иначе на подпути `/repo/` всё сломается.

## (б) itch.io

Режимы видимости ([docs: Access control](https://itch.io/docs/creators/access-control)):
- **Draft** — страница видна только владельцу и тем, у кого есть **секретный URL**. Работает для HTML5-игр; самый простой способ «дать поиграть друзьям» ([форум](https://itch.io/t/471212/how-to-distribute-restricted-links-to-an-html5-game)).
- **Restricted** — доступ только одобренным (через download keys) **или по паролю**; пароль можно зашить в ссылку `?password=XXX` ([docs](https://itch.io/docs/creators/access-control)).
- **Public + «Unlisted in search & browse»** — игра опубликована, но не видна в поиске/каталоге, доступ по прямой ссылке.
- Для HTML5: тип проекта — «HTML», загружается zip с `index.html` в корне, itch сам хостит и встраивает в iframe.

**Автоматизация — [butler](https://itch.io/docs/butler/)** (официальный CLI itch.io): `butler push папка_с_index user/game:html5` заливает новую версию без zip и без веб-интерфейса; авторизация один раз (`butler login`) или через `BUTLER_API_KEY` ([github.com/itchio/butler](https://github.com/itchio/butler), [гайд](https://remarkablegames.org/posts/itchio-butler-github-actions/)). Claude Code легко вызывает это из Bash.

## (в) Netlify / Vercel (free tier)

- **Netlify Free** перешёл на кредитную модель: **300 кредитов/мес**, где production-деплой стоит 15 кредитов (≈20 деплоев/мес), трафик — 20 кредитов/ГБ (≈15 ГБ); при исчерпании сайт встаёт на паузу до следующего месяца ([netlify.com/pricing](https://www.netlify.com/pricing/), [docs: credit-based plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/), [обзор](https://temps.sh/compare/vs-netlify)). Для частых итераций «пуш каждые полчаса» — лимит деплоев реально мешает.
- **Vercel Hobby**: 100 ГБ трафика, 100 build-минут/мес, **только некоммерческое использование**; при превышении — пауза до конца месяца, счетов не выставляют ([vercel.com/docs/plans/hobby](https://vercel.com/docs/plans/hobby), [обзор](https://costbench.com/software/developer-tools/vercel/free-plan/)).
- Оба умеют авто-деплой по `git push` из привязанного GitHub-репозитория и дают private-репо + публичный сайт. Но для статики без сборки преимуществ перед Pages нет, а лимиты жёстче.

## Что проще автоматизировать из Claude Code

1. **GitHub Pages (deploy from branch)** — победитель: `git add && git commit && git push` — единственный шаг, через 30–60 сек сайт обновлён. Никаких токенов кроме уже настроенного git.
2. **itch.io + butler** — одна команда `butler push`, хорошо как «витрина для тестеров» с паролем/секретной ссылкой.
3. **Netlify/Vercel** — тоже «push → деплой», но требуют аккаунт, привязку репо и следят за кредитами.

## .gitignore и Git LFS

Для проекта без сборщика `.gitignore` минимален:

```gitignore
.DS_Store            # мусор macOS
Thumbs.db
node_modules/        # если вдруг появится npm
*.log
.claude/settings.local.json
# исходники ассетов, не нужные игре:
*.blend, *.blend1, *.psd, *.aseprite
```

**Git LFS** (хранение больших бинарников вне git): обычный лимит GitHub — файл ≤ 100 МБ (предупреждение с 50 МБ). С 2025 бесплатная квота LFS — **10 ГБ хранилища и 10 ГБ трафика/мес** ([docs: LFS billing](https://docs.github.com/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage)). **Критичный подвох: GitHub Pages не отдаёт LFS-файлы** — вместо текстуры браузер получит 134-байтовый pointer-файл ([issue](https://github.com/git-lfs/git-lfs/issues/1342), [обсуждение](https://github.com/orgs/community/discussions/50337)). Практический вывод для low-poly PS1-стиля: ассеты и так мелкие — **LFS не нужен**, просто держать текстуры/модели < 50 МБ каждая и не тащить в репо исходники (.blend, .psd). LFS понадобится, только если появятся большие видео/аудио — и тогда для Pages придётся деплоить через Actions с распаковкой LFS.

## На будущее: порталы HTML5-игр (один абзац)

**CrazyGames**: суммарный размер ≤ 250 МБ и ≤ 1500 файлов, начальная загрузка ≤ 50 МБ (≤ 20 МБ для мобильной главной), SDK (HTML5 v2) желателен, для полной интеграции с рекламой — обязателен ([docs.crazygames.com/requirements/technical](https://docs.crazygames.com/requirements/technical/)). **Poki**: целевая начальная загрузка < 8 МБ, обязательные события SDK (gameplayStart по первому вводу, gameplayStop на паузах), скипаемые заставки, реклама через commercialBreak/rewardedBreak с автомьютом ([sdk.poki.com/requirements](https://sdk.poki.com/requirements)). **Яндекс Игры**: архив ≤ 100 МБ в распакованном виде, подключение Yandex Games SDK обязательно для модерации, реклама и платежи — только через SDK, локализация минимум на один язык (для RU-домена рекомендован русский — тут у Олега преимущество) ([yandex.com/dev/games/...requirements](https://yandex.com/dev/games/doc/en/concepts/requirements)). Общий вывод: уже сейчас стоит следить за весом ассетов и закладывать «шину» для будущей вставки SDK (единая точка init/pause/resume в коде).

---

**Рекомендация для «Ретро-футбола»:** public-репо на GitHub → Settings → Pages → «Deploy from a branch» (`main`, `/`) → ссылку `https://<user>.github.io/retro-soccer/` друзьям. Когда захочется красивую страницу с паролем и обложкой — добавить itch.io Draft/Restricted и заливать через butler. Единственное «но» публичного репо: реальные составы 1996–99 и код будут видны всем — для тестов с друзьями это не проблема.
