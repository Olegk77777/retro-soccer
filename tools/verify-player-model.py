# -*- coding: utf-8 -*-
# Сверка двух версий models/player.glb: АНИМАЦИИ обязаны совпасть, меняется
# только сетка.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
#     --python tools/verify-player-model.py -- <старый.glb> <новый.glb>
#
# Зачем. По риггу вымерено полтора десятка игровых констант (кадры контакта
# aerial.sync, tackle.clipStart, throwin.releaseClip, темпы ступеней бега).
# Пересборка glb легко сдвигает клипы на кадр — например если импорт переключил
# fps сцены, — и тогда удар головой начнёт промахиваться, а найти причину будет
# уже негде. Поэтому: длительности всех клипов и кривая контрольной кости
# сверяются ЧИСЛАМИ, а не на глаз.
import bpy
import sys
import json

argv = sys.argv[sys.argv.index('--') + 1:]
OLD, NEW = argv[0], argv[1]

CTRL_BONE = 'mixamorig:RightFoot'   # контрольная кость: у неё двигается всё
SAMPLES = 12                        # точек на клип


def probe(path):
    bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
    bpy.ops.import_scene.gltf(filepath=path)
    scene = bpy.context.scene
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    ad = arm.animation_data
    fps = scene.render.fps
    out = {'fps': fps, 'clips': {}, 'meshes': {}, 'bones': [b.name for b in arm.data.bones]}
    for t in ad.nla_tracks:
        t.mute = True
    for t in ad.nla_tracks:
        st = t.strips[0]
        f0, f1 = st.frame_start, st.frame_end
        dur = (f1 - f0) / fps
        t.mute = False
        curve = []
        for i in range(SAMPLES):
            scene.frame_set(int(round(f0 + (f1 - f0) * i / (SAMPLES - 1))))
            bpy.context.view_layer.update()
            pb = arm.pose.bones.get(CTRL_BONE)
            p = (arm.matrix_world @ pb.head) if pb else None
            curve.append([round(x, 5) for x in p] if p else None)
        t.mute = True
        out['clips'][t.name] = {'dur': round(dur, 5), 'f0': f0, 'f1': f1, 'curve': curve}
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        me = o.data
        out['meshes'][o.name] = {
            'verts': len(me.vertices),
            'tris': sum(len(p.vertices) - 2 for p in me.polygons),
            'uv': [l.name for l in me.uv_layers],
            'colors': [a.name for a in me.color_attributes],
            'materials': [m.name if m else None for m in me.materials],
        }
    return out


a = probe(OLD)
b = probe(NEW)

print('=' * 70)
print(f'СТАРЫЙ  fps={a["fps"]}  клипов={len(a["clips"])}  сетки={a["meshes"]}')
print(f'НОВЫЙ   fps={b["fps"]}  клипов={len(b["clips"])}  сетки={b["meshes"]}')

problems = 0

lost = set(a['clips']) - set(b['clips'])
gained = set(b['clips']) - set(a['clips'])
if lost:
    print('ПОТЕРЯНЫ КЛИПЫ:', sorted(lost))
    problems += len(lost)
if gained:
    print('ДОБАВЛЕНЫ КЛИПЫ:', sorted(gained))

if a['bones'] != b['bones']:
    print('!!! СКЕЛЕТ ИЗМЕНИЛСЯ — вымеренные по риггу константы игры поедут')
    problems += 1
else:
    print(f'СКЕЛЕТ: совпал, {len(a["bones"])} костей')

worst = []
for name in sorted(set(a['clips']) & set(b['clips'])):
    ca, cb = a['clips'][name], b['clips'][name]
    ddur = abs(ca['dur'] - cb['dur'])
    dmax = 0.0
    for pa, pb in zip(ca['curve'], cb['curve']):
        if pa and pb:
            dmax = max(dmax, max(abs(x - y) for x, y in zip(pa, pb)))
    worst.append((dmax, ddur, name))
    if ddur > 1e-4 or dmax > 1e-3:
        print(f'  РАСХОЖДЕНИЕ {name}: длительность {ca["dur"]} → {cb["dur"]} '
              f'(Δ{ddur:.5f}), кость Δ{dmax * 100:.3f} см')
        problems += 1
worst.sort(reverse=True)
print(f'КЛИПЫ: сверено {len(worst)}; худшее расхождение кости '
      f'{worst[0][0] * 100:.4f} см ({worst[0][2]})' if worst else 'КЛИПЫ: нет')

# Второй слой UV и цвет вершин — данные для шейдера ткани; молча потерять их
# легко, а увидеть потерю можно только по неподвижной футболке.
for name, m in b['meshes'].items():
    print(f'СЕТКА {name}: {m["verts"]} вершин, {m["tris"]} тр., '
          f'UV={m["uv"]}, цвета={m["colors"]}, материалы={m["materials"]}')

print('=' * 70)
print('ИТОГ:', 'РАСХОЖДЕНИЙ НЕТ' if problems == 0 else f'ПРОБЛЕМ: {problems}')
