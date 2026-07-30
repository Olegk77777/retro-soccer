#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Генератор звуков стадиона через ElevenLabs Sound Effects API.

Зачем отдельный скрипт, а не MCP-инструмент: обёртка MCP режет длину клипа
до 5 секунд, а нам нужна базовая петля на 30 — API это умеет, ограничение
живёт только в обёртке. Плюс скрипт даёт то, чего у MCP нет вовсе:
воспроизводимость. Все промпты лежат тут же, в CLIPS, поэтому банк звуков
можно перегенерировать целиком одной командой, а не вспоминать формулировки.

Ключ НЕ передаётся аргументом (иначе он осел бы в истории команд) —
скрипт берёт его из конфига Claude Code либо из переменной окружения.

Запуск:
    python3 tools/gen-crowd-audio.py --list          # что вообще есть
    python3 tools/gen-crowd-audio.py base            # один клип
    python3 tools/gen-crowd-audio.py --all           # весь банк
    python3 tools/gen-crowd-audio.py base --dry-run  # без трат, только план
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

API_URL = 'https://api.elevenlabs.io/v1/sound-generation'
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'audio', 'crowd')

# Банк звуков стадиона.
#   loop=True  — ElevenLabs сшивает конец с началом, клип годится в вечный фон.
#   loop=False — одноразовое событие, у него обязаны быть атака и спад.
#   influence  — насколько буквально модель следует тексту (0..1). Фону нужен
#                низкий (пусть звучит естественно), событию — высокий.
CLIPS = {
    'base': dict(
        text=('Distant ambient roar of a large football stadium crowd, tens of thousands of '
              'spectators murmuring and rumbling steadily, no distinct voices, no music, '
              'no commentary, no announcer, low continuous background hum heard from the '
              'pitch at night, seamless'),
        seconds=30, loop=True, influence=0.25,
        note='Базовый гул. Крутится всегда, поверх него идёт всё остальное.'),

    'murmur_high': dict(
        text=('Large football stadium crowd growing restless and louder, thousands of voices '
              'rising in anticipation, scattered shouting and clapping, no chanting, '
              'no commentary, continuous seamless background'),
        seconds=30, loop=True, influence=0.3,
        note='Тот же зал, но взвинченный. Подмешивается к базе на атаках.'),

    'goal_roar': dict(
        text=('Massive football stadium crowd explodes in a roar as a goal is scored, '
              'sudden huge cheer, thousands screaming and applauding, air horns blaring, '
              'roar slowly settling into excited celebration, no commentary'),
        seconds=22, loop=False, influence=0.45,
        note='Гол. Резкая атака, длинный хвост.'),

    'near_miss': dict(
        text=('Football stadium crowd gasps and groans as a shot narrowly misses the goal, '
              'sharp collective "ooooh" rising then fading into disappointed murmur, '
              'scattered applause, no commentary'),
        seconds=8, loop=False, influence=0.45,
        note='Опасный момент, мяч мимо: ах — и разочарованный гул.'),

    'applause': dict(
        text=('Football stadium crowd applauding warmly, thousands of hands clapping, '
              'appreciative but not ecstatic, fading out naturally, no cheering voices, '
              'no commentary'),
        seconds=10, loop=False, influence=0.4,
        note='Аплодисменты: выход команд, хорошая комбинация, замена.'),

    'whistles': dict(
        text=('Angry football crowd whistling and jeering in disapproval, thousands of sharp '
              'shrill whistles from the stands, booing, rising then fading, no commentary'),
        seconds=12, loop=False, influence=0.45,
        note='Свист трибун: грубый фол, тянут время, спорное решение.'),

    'horns': dict(
        text=('Football supporters section with plastic horns and vuvuzela-like blasts, '
              'trumpets and air horns over a crowd murmur, rhythmic and messy, '
              'no commentary, seamless'),
        seconds=25, loop=True, influence=0.35,
        note='Дудки фанатского сектора. Отдельным слоем, включается волнами.'),

    'drums_chant': dict(
        text=('Football ultras section chanting in unison with a steady bass drum beat, '
              'rhythmic crowd chant without intelligible words, echoing in a large stadium, '
              'seamless continuous loop'),
        seconds=30, loop=True, influence=0.4,
        note='Барабан и речёвка виража. Заводится в спокойные минуты.'),

    'kick_thump': dict(
        text=('Single hard football kick, boot striking a leather ball with a solid thump, '
              'close and dry, no crowd, no reverb tail'),
        seconds=1.5, loop=False, influence=0.6,
        note='Удар по мячу. Пригодится вместо синтеза, если дойдут руки.'),
}


def api_key():
    """Ключ: сперва окружение, потом конфиг Claude Code."""
    k = os.environ.get('ELEVENLABS_API_KEY')
    if k:
        return k
    cfg = os.path.expanduser('~/.claude.json')
    try:
        with open(cfg, encoding='utf-8') as f:
            env = json.load(f)['mcpServers']['elevenlabs']['env']
        k = env.get('ELEVENLABS_API_KEY')
    except (OSError, KeyError, ValueError) as e:
        raise SystemExit(f'Не нашёл ключ ElevenLabs: {e}\n'
                         f'Положи его в ELEVENLABS_API_KEY или в {cfg}')
    if not k:
        raise SystemExit('Ключ ElevenLabs в конфиге пустой')
    return k


def quota(key):
    """Остаток кредитов — чтобы видеть цену каждой генерации."""
    req = urllib.request.Request('https://api.elevenlabs.io/v1/user/subscription',
                                 headers={'xi-api-key': key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        return d['character_count'], d['character_limit']
    except Exception as e:                                    # квота не критична
        print(f'  (квоту прочитать не вышло: {e})')
        return None, None


def generate(name, spec, key, fmt):
    body = json.dumps({
        'text': spec['text'],
        'duration_seconds': spec['seconds'],
        'loop': spec['loop'],
        'prompt_influence': spec['influence'],
        'model_id': 'eleven_text_to_sound_v2',
        'output_format': fmt,
    }).encode('utf-8')

    req = urllib.request.Request(API_URL, data=body, headers={
        'xi-api-key': key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            audio = r.read()
    except urllib.error.HTTPError as e:
        raise SystemExit(f'[{name}] API ответил {e.code}: {e.read().decode("utf-8", "replace")[:400]}')
    except urllib.error.URLError as e:
        raise SystemExit(f'[{name}] сеть недоступна: {e.reason}')

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f'{name}.mp3')
    with open(path, 'wb') as f:
        f.write(audio)
    return path


def probe(path):
    """Реальная длительность файла: заказанные секунды и полученные расходятся."""
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', path],
            capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description='Генерация звуков стадиона (ElevenLabs)')
    ap.add_argument('names', nargs='*', help='какие клипы делать')
    ap.add_argument('--all', action='store_true', help='весь банк')
    ap.add_argument('--list', action='store_true', help='показать банк и выйти')
    ap.add_argument('--dry-run', action='store_true', help='без вызовов API')
    ap.add_argument('--format', default='mp3_44100_128', help='формат выдачи')
    a = ap.parse_args()

    if a.list:
        for n, s in CLIPS.items():
            print(f'{n:14} {s["seconds"]:>4} c  {"петля" if s["loop"] else "разовый":8} — {s["note"]}')
        return

    names = list(CLIPS) if a.all else a.names
    if not names:
        ap.error('назови клипы или добавь --all (список — --list)')
    unknown = [n for n in names if n not in CLIPS]
    if unknown:
        ap.error(f'нет таких клипов: {", ".join(unknown)}')

    if a.dry_run:
        for n in names:
            print(f'[план] {n}: {CLIPS[n]["seconds"]} c, петля={CLIPS[n]["loop"]}')
        return

    key = api_key()
    used0, limit = quota(key)
    if used0 is not None:
        print(f'Кредиты до: {used0} из {limit} (осталось {limit - used0})')

    for n in names:
        spec = CLIPS[n]
        print(f'[{n}] {spec["seconds"]} c, петля={spec["loop"]} ...', flush=True)
        path = generate(n, spec, key, a.format)
        dur = probe(path)
        size = os.path.getsize(path) / 1024
        print(f'  готово: {os.path.relpath(path)} — {size:.0f} КБ'
              + (f', {dur:.2f} c' if dur else ''))

    used1, _ = quota(key)
    if used0 is not None and used1 is not None:
        print(f'Кредиты после: {used1} (потрачено {used1 - used0})')


if __name__ == '__main__':
    main()
