# ПОЛНАЯ пересборка анимаций models/player.glb из исходников models/mixamo/*.fbx.
#
# ЗАЧЕМ ЭТО ПОНАДОБИЛОСЬ (замер 28.07.2026). Клипы в боевой модели оказались
# испорчены ДВАЖДЫ, и обе порчи — от одной причины: давняя пересборка применила
# пересчёт 30 → 24 fps ДВА раза (0.8 × 0.8 = 0.64, то есть 1/1.5625).
#
#  1. ТЕМП. 21 клип из 28 играет в 1.56–1.75 раза быстрее, чем снят. Проверено не
#     по длине, а ПО ФОРМЕ: нормированные по времени траектории таза, обоих
#     носков, обеих кистей и головы сошлись с исходниками с расхождением
#     0.006–0.069 м. Разделение идеально двумодальное: 21 клип имеет отношение
#     1.56–1.75, а семь добавленных ПОЗЖЕ (tackle, kick_r, gk_step_*, gk_dive_r,
#     gk_block, gk_miss) — ровно 1.00. То есть грабля была найдена в 2026 году и
#     записана в tools/add-mixamo-clips.py, но СТАРЫЕ клипы никто не перебрал.
#
#  2. КАДРЫ. Хуже темпа: ключи сжали по времени, а экспорт сэмплировал по целым
#     кадрам — и треть кадров схлопнулась. `run` 17 кадров вместо 25, `trip` 29
#     вместо 46, `header` 37 вместо 57, `kick` 11 вместо 17, `idle` 201 вместо
#     317. Именно поэтому «все анимации, кроме бега, очень дёрганные»: у них
#     физически не хватает кадров, и никакой блендинг этого не лечит.
#
# Бег дефекта не показывал ровно потому, что его чинили вслепую: ступени
# лестницы (src/anim.js) растягивают клип ручкой `stretch`, и она — 1.95 у
# ходьбы, 1.32 у бега — фактически компенсировала ускорение. Компенсировала
# темп, но не выброшенные кадры.
#
# ПОЭТОМУ ИСТОЧНИК ПРАВДЫ ЗДЕСЬ — FBX, А НЕ GLB. Прежний tools/add-mixamo-clips.py
# брал базой сам player.glb и потому консервировал ошибку в каждой пересборке.
#
# Запуск:
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
#     --python tools/rebuild-player-clips.py -- <корень проекта> /tmp/player-new.glb
# Приёмка — tools/verify-player-clips.py, и только после неё файл кладётся в
# models/player.glb.
#
# Сетка, скелет и веса берутся из БОЕВОГО glb и не трогаются: их собирает
# tools/build-player-mesh.py, и переделывать их тут нечего.
import bpy, sys, os

argv = sys.argv[sys.argv.index('--') + 1:]
ROOT, OUT = argv[0], argv[1]
SRC = argv[2] if len(argv) > 2 else os.path.join(ROOT, 'models/player.glb')

BASE_FPS = 30          # тайм-код всего пака Mixamo; ни одного пересчёта больше
DRIFT_LIMIT = 20.0     # см чистого сноса за клип — выше этого ось детрендим

# Соответствие «клип в игре → файл пака». Установлено ЗАМЕРОМ ФОРМЫ, а не по
# именам: имена файлов в паке врут (goalkeeper sidestep идёт ВЛЕВО,
# kick soccerball бьёт ЛЕВОЙ — документированная грабля проекта).
CLIPS = [
    # --- то, что уже было в модели (пересобирается в честном темпе) ---
    ('idle',        'offensive idle.fbx'),
    ('run',         'jog forward.fbx'),
    ('run_back',    'jog backward.fbx'),
    ('strafe_l',    'jog strafe left.fbx'),
    ('strafe_r',    'jog strafe right.fbx'),
    ('kick',        'kick soccerball.fbx'),
    ('kick_r',      'kick soccerball (2).fbx'),
    ('kick_run',    'strike foward jog.fbx'),
    ('penalty',     'soccer penalty kick.fbx'),
    ('header',      'header soccerball.fbx'),
    ('tackle',      'soccer tackle (2).fbx'),
    ('trip',        'soccer trip.fbx'),
    ('fallen',      'fallen idle.fbx'),
    ('getup',       'standing up.fbx'),
    ('throwin',     'throw in.fbx'),
    ('receive',     'receive soccerball.fbx'),
    ('gk_idle',     'goalkeeper idle.fbx'),
    ('gk_catch',    'goalkeeper catch.fbx'),
    ('gk_dive',     'goalkeeper diving save.fbx'),
    ('gk_dive_r',   'goalkeeper diving save (2).fbx'),
    ('gk_block',    'goalkeeper body block.fbx'),
    ('gk_miss',     'goalkeeper miss.fbx'),
    ('gk_step_l',   'goalkeeper sidestep.fbx'),
    ('gk_step_r',   'goalkeeper sidestep (2).fbx'),
    ('gk_throw',    'goalkeeper overhand throw.fbx'),
    ('gk_scoop',    'goalkeeper scoop.fbx'),
    ('gk_dropkick', 'goalkeeper drop kick.fbx'),
    ('gk_pass',     'goalkeeper pass.fbx'),

    # --- новое: закрывает дыры, найденные разбором 28.07.2026 ---
    # Удар через себя — «король повтора». Замер: таз 0.95 → 0.13 → 0.92 м
    # (игрок правда ложится в воздухе), пик скорости правого носка 14.3 м/с.
    ('bicycle',     'scissor kick.fbx'),
    # Волей коленом и бедром. Раньше удар с лёта играл НАЗЕМНЫЙ клип `kick`,
    # у которого в вымеренном кадре контакта нога уже стоит на месте.
    ('knee_l',      'kneeing soccerball.fbx'),
    ('knee_r',      'kneeing soccerball (2).fbx'),
    # Подкат с прыжка. Начинается и кончается в ОДНОЙ позе (таз 0.950, голова
    # 1.434) — то есть стыкуется сам с собой и доводит фигуру до стойки, чего
    # действующий `tackle` не делает: он кончается в полуприседе на 0.909.
    ('tackle2',     'soccer tackle (3).fbx'),
    # Второй вариант игры головой — чтобы два верховых подряд не были копией
    ('header2',     'header soccerball (2).fbx'),
    # Ловля В ПРЫЖКЕ: выходы на подачу вратарь играл ловлей СТОЯ
    ('gk_catch_hi', 'goalkeeper catch (3).fbx'),
]


def fcurves(act):
    try:
        return act.layers[0].strips[0].channelbag(act.slots[0]).fcurves
    except Exception:
        return []


def up_axis(arm):
    """Какая компонента дорожки положения таза — ВЕРТИКАЛЬ.

    Не угадываем: у костей Mixamo оси повёрнуты (проект уже наступал на это в
    src/cloth.js и в lockRootXZ). Сдвигаем таз по каждой оси и смотрим, какая
    поднимает кость в мире.
    """
    pb = arm.pose.bones['mixamorig:Hips']
    base = (arm.matrix_world @ pb.matrix).translation.z
    best, bk = 1, 0.0
    for i in range(3):
        old = pb.location[i]
        pb.location[i] = old + 10.0
        bpy.context.view_layer.update()
        k = abs((arm.matrix_world @ pb.matrix).translation.z - base)
        pb.location[i] = old
        bpy.context.view_layer.update()
        if k > bk:
            best, bk = i, k
    return best


def strip_root_motion(act, up):
    """Снять ЛИНЕЙНЫЙ снос таза ПО ГОРИЗОНТАЛИ: перемещение считает физика игры.

    ВЕРТИКАЛЬ НЕ ТРОГАЕМ, и это не мелочь. Первый заход снимал снос по всем трём
    осям — и вместе с root motion выбросил САМИ ДВИЖЕНИЯ: у `trip` пропало
    падение (таз оставался на 1.04 м вместо 0.24), у `getup` — вставание (0.23 →
    0.23 вместо 0.23 → 0.95). Клип «подъём с газона» переставал поднимать.
    Опускание и подъём тела — это и есть анимация, а не снос, который надо
    отдать физике.
    """
    out = []
    for c in fcurves(act):
        if 'Hips' not in c.data_path or 'location' not in c.data_path:
            continue
        if c.array_index == up:
            continue
        kp = c.keyframe_points
        if len(kp) < 2:
            continue
        v0, v1 = kp[0].co[1], kp[-1].co[1]
        if abs(v1 - v0) < DRIFT_LIMIT:
            continue
        t0, t1 = kp[0].co[0], kp[-1].co[0]
        span = (t1 - t0) or 1.0
        for k in kp:
            f = (k.co[0] - t0) / span
            shift = (v1 - v0) * f
            k.co[1] -= shift
            k.handle_left[1] -= shift
            k.handle_right[1] -= shift
        c.update()
        out.append((c.array_index, round(v1 - v0, 1)))
    return out


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
assert len(arms) == 1, 'В базовой модели должна быть ровно одна арматура: %r' % arms
arm = arms[0]
print('БАЗА: костей %d, клипов пришло %d (все будут заменены)'
      % (len(arm.data.bones), len(bpy.data.actions)))

# Старые клипы выбрасываем ЦЕЛИКОМ — они и есть источник порчи. Заодно это
# страховка от тихого «пропуск: уже есть», из-за которого прежний скрипт
# оставлял испорченный клип на месте.
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a, do_unlink=True)
if arm.animation_data:
    arm.animation_data_clear()

bpy.context.scene.render.fps = BASE_FPS
UP = up_axis(arm)
print('ВЕРТИКАЛЬ таза — компонента %d (замер, а не догадка); её детренд запрещён' % UP)

for clip, fname in CLIPS:
    path = os.path.join(ROOT, 'models/mixamo', fname)
    assert os.path.exists(path), 'Нет исходника: %s' % path
    before = {a.name for a in bpy.data.actions}
    objs_before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    fbx_fps = bpy.context.scene.render.fps
    assert fbx_fps == BASE_FPS, ('%s снят на %d fps, а не 30 — пересчёт запрещён, '
                                 'именно он всё и сломал' % (fname, fbx_fps))
    new_acts = [a for a in bpy.data.actions if a.name not in before]
    assert len(new_acts) == 1, (fname, [a.name for a in new_acts])
    act = new_acts[0]
    cleaned = strip_root_motion(act, UP)
    dur = (act.frame_range[1] - act.frame_range[0]) / BASE_FPS
    act.name = clip
    act.use_fake_user = True
    for o in set(bpy.data.objects) - objs_before:
        bpy.data.objects.remove(o, do_unlink=True)
    print('КЛИП %-12s ← %-32s %.4f с (%d кадров)  снос: %s'
          % (clip, fname, dur, round((act.frame_range[1] - act.frame_range[0])) + 1,
             cleaned or 'не требовался'))

assert bpy.context.scene.render.fps == BASE_FPS
# Ключи обязаны лежать на целых кадрах: дробные означают, что где-то всё-таки
# случился пересчёт, и экспортёр опять срежет хвосты и выбросит кадры
frac = []
for a in bpy.data.actions:
    for c in fcurves(a):
        if any(abs(k.co[0] - round(k.co[0])) > 1e-4 for k in c.keyframe_points):
            frac.append(a.name)
            break
    if frac and frac[-1] == a.name:
        continue
print('ДРОБНЫХ КАДРОВ:', sorted(set(frac)) or 'нет')
assert not frac, 'Найдены дробные кадры — пересборка невалидна'

ad = arm.animation_data_create()
for a in sorted(bpy.data.actions, key=lambda x: x.name):
    tr = ad.nla_tracks.new()
    tr.name = a.name
    tr.strips.new(a.name, int(a.frame_range[0]), a)
ad.action = None

bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB',
    export_vertex_color='ACTIVE',
    export_animation_mode='NLA_TRACKS',
    export_animations=True, export_skins=True, export_morph=False,
    export_apply=False, export_yup=True,
    export_image_format='AUTO',
    export_cameras=False, export_lights=False,
    export_optimize_animation_size=True,
)
print('ЭКСПОРТ:', os.path.getsize(OUT), 'байт, клипов', len(bpy.data.actions),
      ', fps сцены', bpy.context.scene.render.fps)
