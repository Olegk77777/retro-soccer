# Пересборка models/player.glb: добавляем недостающие клипы из models/mixamo/.
#
# Запуск (пути абсолютные, второй — куда писать новый glb):
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
#     --python tools/add-mixamo-clips.py -- <корень проекта> /tmp/player-new.glb
# Готовый файл кладём в models/player.glb только ПОСЛЕ сверки (см. ниже).
#
# Три грабли, на которых тут легко потерять день:
#  1. Импорт FBX ПЕРЕКЛЮЧАЕТ fps сцены (Mixamo — 30, glTF-импорт ставит 24).
#     Кадры уже импортированных клипов при этом не двигаются, и все старые
#     анимации молча ускоряются на четверть. Работаем в тайм-коде 30 fps:
#     там все номера кадров ЦЕЛЫЕ (12.8 → 16, 43.2 → 54), а экспортёр
#     сэмплирует по целым кадрам и иначе срезает у каждого клипа хвост — как
#     раз там, где живут вымеренные константы (aerial.sync, tackle.clipStart,
#     throwin.releaseClip).
#  2. Сырой клип Mixamo несёт root motion — модель уезжает от группы, и тень,
#     курсор и физика рассинхронятся (грабля 21.07.2026).
#  3. Имя файла в паке НЕ говорит ни про направление, ни про бьющую ногу:
#     goalkeeper sidestep.fbx идёт влево, kick soccerball.fbx бьёт левой.
#     Меряем по риггу, а не читаем из имени.
#
# Сверка после экспорта обязательна: длительности всех СТАРЫХ клипов должны
# совпасть со старым файлом, а кривая контрольной кости — сойтись бит-в-бит.
import bpy, sys, os

argv = sys.argv[sys.argv.index('--')+1:]
ROOT, OUT = argv[0], argv[1]
# Третий аргумент — откуда брать базовый glb. По умолчанию это боевая модель,
# но при пересборке ГЕОМЕТРИИ (tools/build-player-mesh.py) сюда приходит
# промежуточный файл: сетка уже новая, а трёх клипов в ней ещё нет.
SRC = argv[2] if len(argv) > 2 else os.path.join(ROOT, 'models/player.glb')

NEW = [
    ('kick soccerball (2).fbx',     'kick_r'),
    # Направление замерено по опорной стопе, а не по имени файла: в игре
    # «вправо» при взгляде в +Z — это движение в -X (right = forward × up).
    # sidestep.fbx уводит тело в +X, то есть ВЛЕВО, а (2) — вправо.
    ('goalkeeper sidestep.fbx',     'gk_step_l'),
    ('goalkeeper sidestep (2).fbx', 'gk_step_r'),
]
DRIFT_LIMIT = 20.0   # см чистого сноса за клип — выше этого ось детрендим

def fcurves(act):
    try:
        return act.layers[0].strips[0].channelbag(act.slots[0]).fcurves
    except Exception:
        return []

def strip_root_motion(act):
    out = []
    for c in fcurves(act):
        if 'Hips' not in c.data_path or 'location' not in c.data_path:
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

def retime(act, k):
    """Перевести кадры клипа в другой тайм-код (реальная длительность та же)."""
    for c in fcurves(act):
        for p in c.keyframe_points:
            p.co[0] *= k
            p.handle_left[0] *= k
            p.handle_right[0] *= k
        c.update()

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
# Клипы были сняты на 30 fps, а glTF-импорт кладёт сцену на 24 — из-за этого
# концы клипов попадают на ДРОБНЫЕ кадры (12.8, 28.8, 43.2), и экспортёр,
# сэмплирующий по целым кадрам, срезает у каждого хвост до кадра. На вымеренных
# константах (aerial.sync, tackle.clipStart, throwin.releaseClip) это заметно.
# Переводим сцену обратно в 30 fps: все номера кадров становятся целыми.
GLTF_FPS = bpy.context.scene.render.fps
BASE_FPS = 30
arm = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
print('ИСХОДНО: fps импорта=%d, костей %d, клипов %d' % (GLTF_FPS, len(arm.data.bones), len(bpy.data.actions)))
if GLTF_FPS != BASE_FPS:
    for a in list(bpy.data.actions):
        retime(a, BASE_FPS / GLTF_FPS)
bpy.context.scene.render.fps = BASE_FPS

for fname, clip in NEW:
    if clip in bpy.data.actions:
        print('ПРОПУСК (уже есть):', clip); continue
    before = {a.name for a in bpy.data.actions}
    objs_before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, 'models/mixamo', fname))
    fbx_fps = bpy.context.scene.render.fps
    new_acts = [a for a in bpy.data.actions if a.name not in before]
    assert len(new_acts) == 1, (fname, [a.name for a in new_acts])
    act = new_acts[0]
    cleaned = strip_root_motion(act)
    dur = (act.frame_range[1] - act.frame_range[0]) / fbx_fps
    if fbx_fps != BASE_FPS:
        retime(act, BASE_FPS / fbx_fps)
    bpy.context.scene.render.fps = BASE_FPS
    act.name = clip
    act.use_fake_user = True
    for o in set(bpy.data.objects) - objs_before:
        bpy.data.objects.remove(o, do_unlink=True)
    print('ДОБАВЛЕН %-10s из %-30s %.3f с (fbx %d fps)  снос: %s'
          % (clip, fname, dur, fbx_fps, cleaned or 'не требовался'))

assert bpy.context.scene.render.fps == BASE_FPS, bpy.context.scene.render.fps
# Проверка: после перевода все ключи обязаны лежать на целых кадрах
frac = []
for a in bpy.data.actions:
    for c in fcurves(a):
        for k in c.keyframe_points:
            if abs(k.co[0] - round(k.co[0])) > 1e-4:
                frac.append((a.name, round(k.co[0], 3)))
                break
        if frac and frac[-1][0] == a.name:
            break
print('ДРОБНЫХ КАДРОВ:', frac[:5] if frac else 'нет')

if arm.animation_data:
    arm.animation_data_clear()
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
print('ЭКСПОРТ:', os.path.getsize(OUT), 'байт, fps сцены', bpy.context.scene.render.fps)
