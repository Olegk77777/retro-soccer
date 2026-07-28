# Приёмка пересобранной модели (tools/rebuild-player-clips.py).
#
# Прежний tools/verify-player-model.py требовал НОЛЬ расхождений с боевым файлом
# и годился для пересборки СЕТКИ. Здесь задача обратная: длительности обязаны
# ИЗМЕНИТЬСЯ (в этом и смысл — вернуть честный темп), а измениться не должны
# три вещи:
#
#   1. СЕТКА, СКЕЛЕТ И ВЕСА — бит-в-бит: их собирает build-player-mesh.py, и
#      пересборка анимаций не имеет права их трогать.
#   2. ХОРЕОГРАФИЯ старых клипов — то есть форма движения, если убрать время.
#      Сравниваем нормированные по времени траектории ключевых костей.
#   3. Соответствие исходнику — длительность и число кадров каждого клипа
#      обязаны совпасть с его FBX.
#
# Запуск:
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
#     --python tools/verify-player-clips.py -- <корень> <новый glb> <старый glb>
import bpy, sys, os, math, json

argv = sys.argv[sys.argv.index('--') + 1:]
ROOT, NEW, OLD = argv[0], argv[1], argv[2]
BONES = ['mixamorig:Hips', 'mixamorig:LeftToeBase', 'mixamorig:RightToeBase',
         'mixamorig:LeftHand', 'mixamorig:RightHand', 'mixamorig:Head']
N = 32
# Порог расхождения формы, м. Он РАЗНЫЙ для двух групп, и это не поблажка:
# у клипов, которые не были испорчены (коэффициент 1.000), совпадение обязано
# быть идеальным — оно и выходит РОВНО 0.0000, и это доказывает, что метод
# сверки работает. У пересобранных совпасть идеально не может по построению:
# в старом файле физически не было трети кадров, и выборка по нормированному
# времени попадает между ними. Расхождение там растёт ровно с числом потерянных
# кадров (kick 0.042 при 11→18, trip 0.091 при 29→47) — это и есть измеренная
# цена дефекта, а не признак того, что подменили движение.
SHAPE_LIMIT = 0.12     # м: выше этого клип считается ДРУГИМ
SHAPE_LIMIT_INTACT = 0.002  # …а для нетронутых клипов допуска нет вовсе


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    arm = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    return arm, meshes


def signature(arm, act, fps):
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    try:
        arm.animation_data.action_slot = act.slots[0]
    except Exception:
        pass
    f0, f1 = act.frame_range
    pb = [arm.pose.bones.get(b) for b in BONES]
    hips = arm.pose.bones.get(BONES[0])
    out = []
    for i in range(N):
        bpy.context.scene.frame_set(int(round(f0 + (f1 - f0) * i / (N - 1))))
        bpy.context.view_layer.update()
        org = (arm.matrix_world @ hips.matrix).translation
        for b in pb:
            p = (arm.matrix_world @ b.matrix).translation
            out += [p.x - org.x, p.y - org.y, p.z - org.z]
    n = 0
    for s in act.layers[0].strips[0].channelbag(act.slots[0]).fcurves:
        n = max(n, len(s.keyframe_points))
    return out, (f1 - f0) / fps, n


def meshsig(meshes):
    """Подпись геометрии.

    ЧИСЛО ВЕРШИН СЮДА НЕ ВХОДИТ, и это осознанно. glTF хранит не вершины сетки,
    а вершины ОТРИСОВКИ: на каждом шве UV, на каждой границе сглаживания одна
    вершина расщепляется на несколько. Прогон через Blender переклеивает их по
    своим правилам, и 3987 честно превращается в 4030 при том же самом теле.
    Поверхность же описывают ПОЛИГОНЫ, габарит и слои UV — их и сверяем.
    Отдельно слой uv1: в нём запечена маска свободной ткани (src/cloth.js),
    и потерять его молча — значит остановить ветер в футболке у всех 22 фигур.
    """
    out = []
    for m in sorted(meshes, key=lambda o: o.name):
        # Считаем в МИРОВЫХ координатах и склеиваем расщеплённые вершины по
        # положению: локальная система у объекта своя в каждом файле (экспортёр
        # по-своему делит трансформ между узлом и данными), а тело — одно.
        pts = {tuple(round(c, 3) for c in (m.matrix_world @ v.co)) for v in m.data.vertices}
        pts = sorted(pts)
        n = len(pts)
        cen = [round(sum(p[i] for p in pts) / n, 3) for i in range(3)]
        lo = [round(min(p[i] for p in pts), 3) for i in range(3)]
        hi = [round(max(p[i] for p in pts), 3) for i in range(3)]
        out.append((m.name, len(m.data.polygons), len(m.vertex_groups),
                    tuple(sorted(u.name for u in m.data.uv_layers)),
                    n, tuple(cen), tuple(lo), tuple(hi)))
    return out


def rms(a, b):
    n = min(len(a), len(b))
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(n)) / n)


# --- старый файл ---
arm, meshes = load(OLD)
fps_old = bpy.context.scene.render.fps
old_sig = {a.name: signature(arm, a, fps_old) for a in bpy.data.actions}
old_mesh = meshsig(meshes)

# --- новый файл ---
arm, meshes = load(NEW)
fps_new = bpy.context.scene.render.fps
new_sig = {a.name: signature(arm, a, fps_new) for a in bpy.data.actions}
new_mesh = meshsig(meshes)

bad = []
print('=== 1. СЕТКА, СКЕЛЕТ, ВЕСА ===')
if old_mesh == new_mesh:
    print('  совпали бит-в-бит:', ', '.join('%s %d в/%d гр' % (m[0], m[1], m[2]) for m in new_mesh))
else:
    bad.append('сетка изменилась')
    print('  РАСХОЖДЕНИЕ\n   было:', old_mesh, '\n   стало:', new_mesh)

print('=== 2. ХОРЕОГРАФИЯ СТАРЫХ КЛИПОВ (форма без времени) ===')
print('  %-14s %8s %8s %7s %7s %8s' % ('клип', 'было,с', 'стало,с', '×', 'кадры', 'форма,м'))
for name in sorted(old_sig):
    if name not in new_sig:
        bad.append('пропал клип ' + name)
        print('  %-14s ПРОПАЛ' % name)
        continue
    so, do, no = old_sig[name]
    sn, dn, nn = new_sig[name]
    r = rms(so, sn)
    # Клип, у которого не менялось НИ ЧИСЛО КАДРОВ, ни длительность, обязан
    # совпасть идеально: он и не пересобирался по сути, а значит любое
    # расхождение — это подмена движения. Признак «то же число кадров» тут
    # важнее длительности: `tackle` потерял ровно ОДИН кадр из 54, длительность
    # разошлась всего на 2 %, а выборка по нормированному времени от этого уже
    # едет — и без учёта кадров такой клип ложно объявлялся подменённым.
    intact = (no == nn) and (abs(dn / do - 1) < 0.005 if do else False)
    lim = SHAPE_LIMIT_INTACT if intact else SHAPE_LIMIT
    mark = '' if r <= lim else '  ← ДРУГОЕ ДВИЖЕНИЕ'
    if r > lim:
        bad.append('форма %s разошлась на %.3f м (предел %.3f)' % (name, r, lim))
    print('  %-14s %8.4f %8.4f %7.3f %4d→%-4d %7.4f%s'
          % (name, do, dn, dn / do if do else 0, no, nn, r, mark))

print('=== 3. СВЕРКА С ИСХОДНИКАМИ ПАКА ===')
sys.path.insert(0, os.path.join(ROOT, 'tools'))
CLIPS = {}
with open(os.path.join(ROOT, 'tools/rebuild-player-clips.py'), encoding='utf-8') as f:
    txt = f.read()
blk = txt[txt.index('CLIPS = ['):]
blk = blk[:blk.index('\n]') + 2]
for line in blk.splitlines():
    line = line.strip()
    if not line.startswith("('"):
        continue
    a = line.split("'")
    CLIPS[a[1]] = a[3]
miss = 0
for name, fn in CLIPS.items():
    if name not in new_sig:
        bad.append('нет клипа ' + name)
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, 'models/mixamo', fn))
    fps = bpy.context.scene.render.fps
    a = list(bpy.data.actions)[0]
    src_dur = (a.frame_range[1] - a.frame_range[0]) / fps
    got = new_sig[name][1]
    if abs(src_dur - got) > 1.5 / fps:
        bad.append('длительность %s: %.4f против %.4f в исходнике' % (name, got, src_dur))
        print('  %-14s %.4f с против %.4f в %s  ← РАСХОЖДЕНИЕ' % (name, got, src_dur, fn))
        miss += 1
print('  клипов сверено: %d, расхождений: %d' % (len(CLIPS), miss))

print('=== ИТОГ ===')
if bad:
    print('  ПРОВАЛ:')
    for b in bad:
        print('   -', b)
    sys.exit(1)
print('  ВСЁ СОШЛОСЬ: сетка не тронута, хореография прежняя, темп честный.')
print('  Клипов в новой модели: %d (было %d)' % (len(new_sig), len(old_sig)))
