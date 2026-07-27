# -*- coding: utf-8 -*-
# Контрольный лист модели игрока: несколько ракурсов и несколько ПОЗ из клипов.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
#     --python tools/render-player-sheet.py -- <путь к .glb> <папка для PNG> [префикс]
#
# Зачем позы. Сетку легко сделать красивой в T-позе и сломать в движении:
# веса проверяются только тем, что фигура нормально гнётся. Поэтому лист
# обязательно включает кадры бега, удара, подката и броска вратаря.
#
# ВАЖНО. В glb все клипы лежат NLA-треками, и при импорте они складываются
# ВСЕ СРАЗУ — фигура превращается в кашу. Треки надо глушить и включать по
# одному, иначе «сломанные веса» окажутся артефактом просмотра, а не правдой.
import bpy
import sys
import os
import math
import mathutils

argv = sys.argv[sys.argv.index('--') + 1:]
GLB, OUTDIR = argv[0], argv[1]
PREFIX = argv[2] if len(argv) > 2 else 'p'
os.makedirs(OUTDIR, exist_ok=True)

# (имя клипа, доля длительности) — где встать в клипе
POSES = [
    (None, 0.0),          # рест-поза
    ('run', 0.30),
    ('run', 0.62),
    ('kick_r', 0.55),
    ('header', 0.55),
    ('tackle', 0.45),
    ('gk_dive', 0.55),
    ('throwin', 0.55),
]

bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
bpy.ops.import_scene.gltf(filepath=GLB)

scene = bpy.context.scene
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm]
if not meshes:
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']

ad = arm.animation_data
for t in ad.nla_tracks:
    t.mute = True
ad.action = None

# Workbench в режиме MATERIAL берёт цвет из viewport display, а после импорта
# glTF он у всех серый — фигура выходит гипсовой, и судить о ней невозможно.
# Красим по именам материалов, как это делает игра из JSON состава.
PREVIEW = {
    'kit': (0.09, 0.23, 0.56, 1.0),    # синий комплект Франции-98
    'skin': (0.76, 0.60, 0.47, 1.0),
    'head': (0.76, 0.60, 0.47, 1.0),
}
for m in bpy.data.materials:
    if m.name in PREVIEW:
        m.diffuse_color = PREVIEW[m.name]

scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'Standard'
sh = scene.display.shading
sh.light = 'STUDIO'
sh.color_type = 'MATERIAL'
sh.show_cavity = True
sh.show_object_outline = False

cam_data = bpy.data.cameras.new('C')
cam_data.sensor_fit = 'VERTICAL'
cam = bpy.data.objects.new('C', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam


def shoot(name, loc, target, res=(640, 980), lens=34):
    cam.data.lens = lens
    cam.location = mathutils.Vector(loc)
    cam.rotation_euler = (mathutils.Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = os.path.join(OUTDIR, f'{PREFIX}-{name}.png')
    bpy.ops.render.render(write_still=True)


def set_pose(clip, frac):
    arm.data.pose_position = 'REST' if clip is None else 'POSE'
    for t in ad.nla_tracks:
        t.mute = (t.name != clip)
    if clip is None:
        bpy.context.view_layer.update()
        return True
    tr = next((t for t in ad.nla_tracks if t.name == clip), None)
    if tr is None:
        print('НЕТ КЛИПА:', clip)
        return False
    st = tr.strips[0]
    scene.frame_set(int(st.frame_start + (st.frame_end - st.frame_start) * frac))
    bpy.context.view_layer.update()
    return True


# T-поза: три четверти, анфас, профиль, голова крупно
set_pose(None, 0)
shoot('rest-34', (1.75, -2.85, 1.55), (0, 0, 0.90))
shoot('rest-front', (0.0, -3.3, 0.90), (0, 0, 0.90))
shoot('rest-side', (-3.3, 0.0, 0.90), (0, 0, 0.90))
shoot('rest-back', (0.0, 3.3, 0.90), (0, 0, 0.90))
shoot('rest-head', (0.24, -0.50, 1.76), (0, -0.02, 1.70), res=(620, 620), lens=45)
shoot('rest-face', (0.0, -0.55, 1.70), (0, 0, 1.70), res=(620, 620), lens=45)
shoot('rest-hand', (0.90, -0.30, 1.56), (0.90, -0.01, 1.45), res=(620, 620), lens=80)
shoot('rest-boot', (0.52, -0.34, 0.22), (0.12, -0.10, 0.045), res=(720, 500), lens=52)
shoot('rest-boot-side', (0.62, -0.10, 0.10), (0.12, -0.10, 0.045), res=(720, 500), lens=52)

def posed_bounds(margin=0.16):
    """Габариты фигуры В ТЕКУЩЕЙ ПОЗЕ. Подкат и бросок вратаря уводят тело
    далеко от начала координат, и фиксированная камера показывает пустоту —
    а «пустой кадр» легко принять за сломанную модель.

    Тонкость: depsgraph надо ЯВНО обновить (dg.update()). Смена mute у NLA-трека
    не помечает его грязным, и evaluated_get() отдаёт сетку в ПРЕДЫДУЩЕЙ позе —
    камера уезжает мимо, кадр выходит пустым, и это легко принять за сломанную
    модель. Сам рендер при этом рисует правильную позу, что и путает.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    mn = mathutils.Vector((9e9,) * 3)
    mx = mathutils.Vector((-9e9,) * 3)
    for o in meshes:
        ev = o.evaluated_get(dg)
        m = ev.to_mesh()
        for v in m.vertices:
            c = o.matrix_world @ v.co
            for i in range(3):
                mn[i] = min(mn[i], c[i])
                mx[i] = max(mx[i], c[i])
        ev.to_mesh_clear()
    return (mn - mathutils.Vector((margin,) * 3),
            mx + mathutils.Vector((margin,) * 3))


# Позы из клипов — камера подстраивается под габариты позы
for clip, frac in POSES[1:]:
    if set_pose(clip, frac):
        tag = f'{clip}-{int(frac * 100)}'
        posed_bounds()          # первый замер после смены позы ещё отстаёт на кадр
        mn, mx = posed_bounds()
        print('ПОЗА', tag, 'габариты', [round(x, 2) for x in mn], [round(x, 2) for x in mx])
        c = (mn + mx) / 2
        span = max((mx - mn).length, 1.2)
        d = span * 1.35
        shoot(tag, (c.x + d * 0.55, c.y - d * 0.82, c.z + d * 0.30), (c.x, c.y, c.z))

print('ЛИСТ ГОТОВ:', OUTDIR)
