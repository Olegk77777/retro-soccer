# -*- coding: utf-8 -*-
# Параметрическая сборка сетки игрока вокруг ГОТОВОГО рига Mixamo.
#
# Запуск (пути абсолютные):
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
#     "models/blender/player-base.blend" --python tools/build-player-mesh.py \
#     -- <корень проекта> /tmp/player-geo.glb
#
# ЗАЧЕМ. Прежняя сетка (260 вершин, 234 квада) собрана из колец по ЧЕТЫРЕ
# вершины: у рук, ног и шеи сечение — КВАДРАТ. Отсюда «игрок из прямоугольников».
# Кистей рук не было вообще (рука сходила на конус), лица не было, бутса — клин.
# Здесь сетка строится заново кольцами по 8–12 вершин, с кистями, бутсами,
# рукавами, воротником и головой под текстуру лица.
#
# ЧЕГО ЭТОТ СКРИПТ НЕ ТРОГАЕТ — СКЕЛЕТ И АНИМАЦИИ. Все вымеренные по риггу
# константы игры (CONFIG.player.aerial.sync, tackle.clipStart, точки удара по
# костям головы и стопы, посадка причёски на mixamorigHead) завязаны на КОСТИ,
# а не на меш. Кости и клипы остаются те же, поэтому геймплейные замеры не едут.
#
# ЧЕТЫРЕ ГРАБЛИ, НА КОТОРЫХ ЛЕГКО ПОТЕРЯТЬ ДЕНЬ.
#  1. Веса. Новая вершина без весов остаётся в рест-позе и тянется за фигурой
#     резиновой нитью. База — ПЕРЕНОС со старой сетки (data_transfer): у неё
#     веса Mixamo, проверенные 25 клипами. Но кисти и носок бутсы торчат ЗА
#     пределы старой сетки, и ближайшая грань там врёт — этим частям веса
#     ставим руками, аналитически, ПОСЛЕ переноса.
#  2. glTF держит максимум ЧЕТЫРЕ кости на вершину. После переноса обязательны
#     vertex_group_limit_total(4) и нормализация, иначе экспортёр молча
#     выбросит лишние влияния и деформация поедет.
#  3. Развёртка — не «как получится», а жёсткая схема зон атласа формы
#     (textures/kits/README.md). Восемь PNG уже нарисованы под неё: грудная
#     полоса Франции живёт на y=46..52, воротники на y=60..64, манжеты на
#     x=12..16, отворот гетр на y=13..16. Сдвинешь развёртку — поедут все формы.
#  4. Импорт FBX/glTF переключает fps сцены. Здесь исходник — .blend, он уже
#     на 30 fps; проверяем это утверждением, а не надеждой.
#
# Второй слой UV (`flutter`) — не развёртка, а ДАННЫЕ для вершинного шейдера:
# U — насколько ткань в этой вершине свободна (подол, рукав, шорты),
# V — сдвиг фазы волны. Экспортёр Blender выносит его в TEXCOORD_1, а GLTFLoader
# кладёт в атрибут `uv1` — проверено в браузере на боевой сборке.
import bpy
import bmesh
import sys
import os
import math
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc

argv = sys.argv[sys.argv.index('--') + 1:]
ROOT, OUT = argv[0], argv[1]

TAU = math.pi * 2

# --- Оси мира (Blender, Z вверх) --------------------------------------------
# +X — ЛЕВАЯ сторона игрока (mixamorig:LeftUpLeg стоит на x = +0.085)
# -Y — ВПЕРЁД (носок бутсы уходит в y = -0.26)
# +Z — вверх. При экспорте с export_yup три.js получит: вперёд = +Z, вверх = +Y.

FLAT_SHADING = True   # гранёное затенение — примета эпохи; сглаженное = пластик

# ============================================================================
#  ЗОНЫ АТЛАСА ФОРМЫ 64×64 (textures/kits/README.md). (0,0) — низ слева.
#  Числа держим ИМЕННО эти: восемь PNG уже нарисованы под них.
# ============================================================================
def zone(x0, y0, x1, y1):
    return (x0 / 64.0, y0 / 64.0, x1 / 64.0, y1 / 64.0)


Z_FRONT = zone(0, 32, 32, 64)    # перед футболки
Z_BACK = zone(32, 32, 64, 64)    # спина футболки (сюда пойдёт номер)
Z_SLEEVE = zone(0, 16, 16, 32)   # рукав вдоль руки, правый край — манжета
Z_SIDE = zone(16, 16, 32, 32)    # бока торса, однотонная заливка
Z_SHORTS = zone(32, 16, 64, 32)  # шорты, верх зоны — пояс
Z_SOCK = zone(0, 0, 16, 16)      # гетры по кругу ноги, верх — отворот
Z_BOOT = zone(16, 0, 32, 16)     # бутса вдоль стопы

# Отступ от края зоны: NearestFilter иначе цепляет соседнюю зону на самой
# кромке грани, и на подоле проступает полоса от шорт.
UV_MARGIN = 0.35 / 64.0


def uv_in(z, fx, fy):
    """Точка (fx, fy) в долях 0..1 внутри зоны → координата UV атласа."""
    x0, y0, x1, y1 = z
    fx = min(1.0, max(0.0, fx))
    fy = min(1.0, max(0.0, fy))
    m = UV_MARGIN
    return (x0 + m + (x1 - x0 - 2 * m) * fx,
            y0 + m + (y1 - y0 - 2 * m) * fy)


# Высота футболки на атласе: подол z=1.000 → низ зоны, воротник z=1.556 → верх.
# Ровно так лежала старая развёртка (замер: z=1.415 → v=0.874), поэтому грудная
# полоса Франции (y=46..52) остаётся на груди, а не уезжает на живот.
SHIRT_Z0, SHIRT_Z1 = 1.000, 1.556
SHORTS_Z0, SHORTS_Z1 = 0.792, 1.035   # низ/верх зоны шорт
SOCK_Z0, SOCK_Z1 = 0.092, 0.512       # щиколотка / верх отворота гетры
SLEEVE_X0, SLEEVE_X1 = 0.160, 0.305   # начало зоны рукава / манжета


def shirt_v(z):
    return (z - SHIRT_Z0) / (SHIRT_Z1 - SHIRT_Z0)


# ============================================================================
#  ПРОПОРЦИИ. Метры, фигура ростом 1.80 м, поза T.
#  Высоты сверены с костями рига: колено 0.529, таз 0.970, плечо 1.492,
#  основание шеи 1.509, локоть 0.512 по X, запястье 0.836, макушка 1.800.
# ============================================================================

# Торс: (z, полуширина по X, полуглубина по Y). Сечение — суперэллипс:
# у человека грудь и спина ПЛОСКИЕ, а бока круглые; чистый эллипс даёт бочку.
TORSO = [
    (1.000, 0.184, 0.120),   # подол футболки — висит ниже пояса и НАКРЫВАЕТ шорты
    (1.062, 0.178, 0.115),   # талия, самое узкое место
    (1.135, 0.185, 0.118),
    (1.222, 0.197, 0.124),
    (1.310, 0.208, 0.129),
    (1.392, 0.216, 0.130),   # грудь
    (1.452, 0.216, 0.124),
    (1.500, 0.204, 0.112),   # под плечами
    (1.534, 0.172, 0.097),   # линия плеч / трапеция
    (1.556, 0.104, 0.074),   # основание воротника
]
TORSO_N = 12
TORSO_POWER = 2.5   # суперэллипс: 2 — бочка, больше — плоские грудь и спина

# Воротник: короткий отворот поверх основания шеи. Примета формы 90-х —
# у Бразилии-98 и Франции-98 воротники были, и на общем плане они дают тёмную
# полоску под подбородком, которая читается как «одет», а не «голый торс».
COLLAR = [
    (1.556, 0.104, 0.074),
    (1.578, 0.084, 0.063),
    (1.596, 0.075, 0.057),
]
COLLAR_N = 12

# Рукав: короткий, кончается выше локтя. (|x|, радиус, центр по Z)
SLEEVE = [
    (0.080, 0.103, 1.493),
    (0.150, 0.097, 1.484),
    (0.225, 0.086, 1.474),
    (0.292, 0.076, 1.466),   # манжета
    (0.305, 0.071, 1.464),   # подворот манжеты внутрь
]
SLEEVE_N = 8

# Рука: от края рукава до запястья. Кость Arm 0.217→0.512, ForeArm →0.836.
# Толщина — не косметика: тонкая труба той же длины читается ЗАМЕТНО длиннее.
# Живые размеры для фигуры 1.80: плечо у дельты ≈ 11 см в поперечнике,
# брюшко предплечья ≈ 10, запястье ≈ 6.
ARM = [
    (0.240, 0.058, 1.471),
    (0.380, 0.052, 1.464),
    (0.470, 0.047, 1.459),
    (0.512, 0.045, 1.458),   # локоть
    (0.575, 0.049, 1.455),   # брюшко предплечья
    (0.700, 0.041, 1.451),
    (0.836, 0.032, 1.446),   # запястье
]
ARM_N = 8

# Кисть: «варежка». Отдельные пальцы на такой фигуре не нужны и не видны, но
# БЕЗ кисти рука сходит на конус — первое, что выдаёт заглушку.
# (|x|, полуглубина по Y, полувысота по Z, смещение центра по Y)
# Кисть КОРОТКАЯ, и это осознанно. Кость Hand в риге Mixamo кончается на
# x = 1.159, то есть размах рук по риггу и так процентов на десять больше
# роста. Довести сетку до конца кости — получить «безумно длинные руки»
# (фидбек Олега 27.07.2026). Рисуем 12 см кисти вместо 16: размах выходит
# 1.92 при росте 1.80, и рука наконец читается рукой.
HAND = [
    (0.836, 0.036, 0.030, 0.000),
    (0.874, 0.050, 0.034, -0.005),   # ладонь шире запястья
    (0.912, 0.050, 0.033, -0.007),
    (0.940, 0.043, 0.028, -0.009),
    (0.958, 0.026, 0.017, -0.010),   # кончики пальцев
]
HAND_N = 8
# Большой палец: короткий прилив на передней стороне ладони.
THUMB = dict(x0=0.852, x1=0.890, dy=-0.048, dz=-0.004, r0=0.018, r1=0.013, n=6)

NECK = [
    (1.498, 0.068, 0.062),
    (1.545, 0.061, 0.055),
    (1.590, 0.057, 0.052),
    (1.614, 0.056, 0.051),
]
NECK_N = 8

# Голова: (z, полуширина X, полуглубина Y, сдвиг центра по Y).
# Яйцом: скулы шире лба, затылок глубже лица, подбородок сужается.
HEAD = [
    (1.584, 0.038, 0.057, -0.011),   # подбородок: узкий и вынесен вперёд
    (1.610, 0.056, 0.079, -0.009),   # угол челюсти
    (1.641, 0.069, 0.091, -0.006),   # скулы, линия рта
    (1.676, 0.074, 0.096, -0.004),   # глаза, бровь — самое широкое место
    (1.714, 0.072, 0.093, 0.000),    # лоб
    (1.752, 0.066, 0.083, 0.004),
    (1.784, 0.047, 0.058, 0.006),
    (1.800, 0.022, 0.027, 0.006),    # макушка
]
HEAD_N = 12
# Нос не отдельная геометрия, а ВЫДАВЛИВАНИЕ фронтальных вершин: на такой
# сетке коробка носа (как было) читается клювом, а сдвиг двух колец вперёд
# даёт профиль бесплатно. Ключ — индекс кольца HEAD, значение — вынос в метрах.
NOSE = {2: 0.012, 3: 0.019}
BROW = {3: 0.007}        # надбровная дуга чуть вперёд
# Уши: маленькие прилипшие пластины, нужны только силуэту в профиль.
EAR = dict(z0=1.646, z1=1.692, y0=0.006, y1=-0.024, out=0.012)

# Шорты: свободные, расширяются книзу; низ подворачивается внутрь и
# закрывается — открытая труба показывала бы изнанку с нижней камеры.
# Шорты 90-х свободные, но не юбка: 38 см в поперечнике по самому широкому
# месту. Прежние 40 вместе с широким подолом футболки давали сплошной
# расширяющийся книзу силуэт.
SHORTS = [
    (1.035, 0.172, 0.112),   # пояс
    (0.968, 0.187, 0.130),
    (0.888, 0.194, 0.139),
    (0.806, 0.190, 0.135),   # подол
    (0.838, 0.152, 0.106),   # подворот внутрь
]
SHORTS_N = 12

# Бедро (кожа) — от паха до отворота гетры.
# Бедро футболиста в обхвате около 58 см, то есть примерно 19 см в поперечнике
# сверху. Прежние 17 читались «очень худыми ногами» (фидбек Олега 27.07.2026).
THIGH = [
    (0.972, 0.098, 0.094),
    (0.880, 0.090, 0.086),
    (0.760, 0.080, 0.077),
    (0.640, 0.068, 0.066),
    (0.560, 0.060, 0.059),
    (0.529, 0.057, 0.057),   # колено
    (0.502, 0.060, 0.060),
]
THIGH_N = 8

# Гетра: сверху отворот валиком (в 90-х заворачивали именно так).
SOCK = [
    (0.512, 0.070, 0.070),   # верх отворота
    (0.478, 0.065, 0.065),
    (0.430, 0.067, 0.068),
    (0.360, 0.065, 0.066),   # икра: у футболиста она заметная
    (0.260, 0.051, 0.053),
    (0.170, 0.040, 0.042),
    (0.092, 0.038, 0.040),   # щиколотка — уходит ВНУТРЬ бутсы
]
SOCK_N = 8

# ============================ БУТСА ==========================================
# Считается в СИСТЕМЕ СТОПЫ: начало — щиколотка (кость Foot), ось «вперёд» — на
# носок (кость Toe_End). t — метры вдоль этой оси.
#
# Прежняя «бутса» была клином длиной 32 см — на фигуре это читалось ластами
# (фидбек Олега 27.07.2026). Настоящая бутса 44-го размера — 28–29 см, и у неё
# есть форма: плоская подошва, ВЫСОКИЙ задник, самое широкое место на подушечке
# под пальцами, покатый подъём и ПРИПОДНЯТЫЙ носок. Носок, лежащий на газоне
# всей плоскостью, — главный признак тапка вместо бутсы.
#
# Поперечное сечение (поперёк колодки −1…1, высота 0…1). Обход начинается с
# ЦЕНТРА ПОДОШВЫ, идёт наружу, вверх по борту, через верх и вниз по другому.
# Низ плоский — на нём стоит фигура; борт расширяется книзу, как у колодки.
BOOT_SECTION = [
    (0.00, 0.00),
    (0.66, 0.00),
    (1.00, 0.11),
    (1.00, 0.44),
    (0.72, 0.83),
    (0.00, 1.00),
    (-0.72, 0.83),
    (-1.00, 0.44),
    (-1.00, 0.11),
    (-0.66, 0.00),
]
BOOT_N = len(BOOT_SECTION)

# (t вдоль стопы, полуширина, низ по Z, верх по Z)
#
# Концы НЕ сводятся в точку. Первый заход сужал носок до 1.7 см и пятку до
# 3 см, крышка садилась почти на вершину — и в профиль бутса читалась дротиком.
# У настоящей колодки и носок, и пятка ЗАКРУГЛЕНЫ: торцевая крышка остаётся
# заметной площадкой в 5 см шириной.
#
# Верх у щиколотки поднят до 10.5 см и ПЕРЕКРЫВАЕТ низ гетры (9.2 см). Без
# нахлёста между ними остаётся полуторасантиметровый зазор — на общем плане
# не видно, а на повторе нога висит в воздухе.
BOOT = [
    (-0.052, 0.028, 0.019, 0.050),   # задняя кромка подошвы, скруглена вверх
    (-0.038, 0.035, 0.009, 0.078),   # задник
    (-0.014, 0.041, 0.004, 0.100),   # верх задника
    (0.014, 0.044, 0.003, 0.105),    # щиколотка: сюда входит гетра
    (0.064, 0.047, 0.003, 0.072),    # подъём
    (0.118, 0.048, 0.003, 0.054),    # подушечка — самое широкое место
    (0.172, 0.045, 0.004, 0.042),
    (0.212, 0.038, 0.006, 0.033),    # носок пошёл вверх
    (0.238, 0.024, 0.012, 0.026),    # скруглённый кончик, приподнят над газоном
]

# --- Свобода ткани для вершинного шейдера -----------------------------------
BACK_BILLOW = 1.30    # спина отдувается сильнее груди


def flutter_torso(z, ny):
    """0..1: насколько свободна футболка. Грудь пришита к телу, подол гуляет."""
    t = max(0.0, min(1.0, (1.150 - z) / 0.150)) ** 1.35
    return min(1.0, t * (BACK_BILLOW if ny > 0 else 1.0))


SHORTS_STIFF = 0.55   # шорты плотнее трикотажа футболки и качаются слабее


def flutter_shorts(z):
    return SHORTS_STIFF * max(0.0, min(1.0, (0.908 - z) / 0.102)) ** 1.2


def flutter_sleeve(x):
    return max(0.0, min(1.0, (abs(x) - 0.115) / 0.19)) ** 1.1


# ============================================================================
#  Примитивы построения
# ============================================================================
class Build:
    """Копилка геометрии: вершины и грани с материалом, UV и маской ткани."""

    def __init__(self):
        self.verts = []
        self.faces = []    # ([индексы], материал, [(u,v)…], [(flut, phase)…])

    def ring(self, pts):
        i0 = len(self.verts)
        for p in pts:
            self.verts.append(Vector(p))
        return list(range(i0, i0 + len(pts)))

    def face(self, idx, mat, uvs, flut):
        assert len(idx) == len(uvs) == len(flut), (len(idx), len(uvs), len(flut))
        self.faces.append((list(idx), mat, list(uvs), list(flut)))

    def bridge(self, a, b, mat, uvf, flutf, closed=True):
        """Соединить два кольца равной длины поясом четырёхугольников.

        uvf(ring, seg) → (u, v); ring — 0 для кольца a, 1 для b.
        seg пробегает 0..n, то есть на единицу БОЛЬШЕ числа вершин: развёртке
        нужен «шов», где последняя грань берёт u конца, а не u начала.
        """
        n = len(a)
        assert n == len(b)
        last = n if closed else n - 1
        for k in range(last):
            k1 = (k + 1) % n
            self.face(
                [a[k], a[k1], b[k1], b[k]], mat,
                [uvf(0, k), uvf(0, k + 1), uvf(1, k + 1), uvf(1, k)],
                [flutf(0, k), flutf(0, k + 1), flutf(1, k + 1), flutf(1, k)],
            )

    def cap(self, ring, mat, uv, flut):
        """Крышка трубы. Ориентацию не задаём — все нормали пересчитываются
        скопом в конце (bmesh recalc), иначе на два десятка труб приходится
        два десятка шансов вывернуть грань наизнанку."""
        self.face(list(ring), mat, [uv] * len(ring), [flut] * len(ring))


def ring_xy(z, rx, ry, n, y0=0.0, power=2.0):
    """Горизонтальное кольцо. Угол 0 = ВПЕРЁД (-Y), дальше по кругу к +X (влево).

    power — показатель суперэллипса: 2 даёт эллипс (бочку), больше — плоские
    грудь и спину при круглых боках, то есть силуэт человека, а не бочонок.
    """
    out = []
    for k in range(n):
        a = TAU * k / n
        c, s = math.cos(a), math.sin(a)
        kk = (abs(c) ** power + abs(s) ** power) ** (-1.0 / power)
        out.append((rx * s * kk, y0 - ry * c * kk, z))
    return out


def ring_yz(x, ry, rz, n, y0=0.0, z0=0.0):
    """Кольцо в плоскости YZ — для руки и кисти вдоль оси X.
    Угол 0 = вперёд (-Y), дальше вверх (+Z)."""
    out = []
    for k in range(n):
        a = TAU * k / n
        out.append((x, y0 - ry * math.cos(a), z0 + rz * math.sin(a)))
    return out


def ang(k, n):
    """Угол сегмента в радианах, 0 = вперёд."""
    return TAU * (k % n if k < n else k) / n


def wrap_frac(k, n):
    """Доля обхода кольца 0..1 для сегмента k (k может равняться n — это шов)."""
    return k / float(n)


# ============================================================================
#  Сборка частей
# ============================================================================
def build_torso(b):
    """Футболка. Перед/спина/бока ложатся в СВОИ зоны атласа."""
    n = TORSO_N
    rings = [b.ring(ring_xy(z, rx, ry, n, power=TORSO_POWER)) for z, rx, ry in TORSO]
    zs = [t[0] for t in TORSO]

    # Разбиение кольца из 12 сегментов по зонам:
    #   грани 10,11,0,1 — перед (углы −60°…+60°)
    #   грани 2,3       — левый бок      грани 8,9 — правый бок
    #   грани 4..7      — спина (120°…240°)
    def zone_of(k):
        k %= n
        if k in (10, 11, 0, 1):
            return 'front'
        if k in (2, 3):
            return 'sideL'
        if k in (8, 9):
            return 'sideR'
        return 'back'

    for i in range(len(rings) - 1):
        a, bb = rings[i], rings[i + 1]
        za, zb = zs[i], zs[i + 1]
        for k in range(n):
            k1 = (k + 1) % n
            zn = zone_of(k)
            corners = [(a[k], za, k), (a[k1], za, k + 1),
                       (bb[k1], zb, k + 1), (bb[k], zb, k)]
            uvs, fl = [], []
            for vi, z, seg in corners:
                deg = 360.0 * seg / n
                if deg > 180:
                    deg -= 360.0
                fy = shirt_v(z)
                if zn == 'front':
                    # смотрим спереди: лево кадра = правая сторона игрока
                    fx = (deg + 60.0) / 120.0
                    uvs.append(uv_in(Z_FRONT, fx, fy))
                elif zn == 'back':
                    d = deg if deg > 0 else deg + 360.0
                    fx = (d - 120.0) / 120.0
                    uvs.append(uv_in(Z_BACK, fx, fy))
                elif zn == 'sideL':
                    uvs.append(uv_in(Z_SIDE, (deg - 60.0) / 60.0, fy))
                else:
                    d = deg if deg > 0 else deg + 360.0
                    fx = (d - 240.0) / 60.0
                    uvs.append(uv_in(Z_SIDE, fx, fy))
                ny = b.verts[vi].y
                fl.append((flutter_torso(z, ny), (seg / float(n) + z * 1.7) % 1.0))
            b.face([c[0] for c in corners], 'kit', uvs, fl)

    # Низ подола закрываем плоским n-угольником: снизу в кадр он не попадает,
    # но без него из-под футболки видно изнанку при низкой камере повтора.
    b.cap(rings[0], 'kit', uv_in(Z_SIDE, 0.5, 0.02), (1.0, 0.0))
    return rings[-1]


def build_collar(b, top_ring):
    n = COLLAR_N
    rings = [top_ring] + [b.ring(ring_xy(z, rx, ry, n, power=TORSO_POWER))
                          for z, rx, ry in COLLAR[1:]]
    zs = [c[0] for c in COLLAR]
    for i in range(len(rings) - 1):
        a, bb = rings[i], rings[i + 1]
        za, zb = zs[i], zs[i + 1]
        for k in range(n):
            k1 = (k + 1) % n
            deg0 = 360.0 * k / n
            back = 90.0 < deg0 < 270.0
            zn = Z_BACK if back else Z_FRONT
            # воротник рисуют в верхних 4 рядах зоны — берём их же
            fy0 = 0.94 + 0.06 * (za - COLLAR[0][0]) / 0.05
            fy1 = 0.94 + 0.06 * (zb - COLLAR[0][0]) / 0.05
            uvs = [uv_in(zn, 0.42, min(1.0, fy0)), uv_in(zn, 0.58, min(1.0, fy0)),
                   uv_in(zn, 0.58, min(1.0, fy1)), uv_in(zn, 0.42, min(1.0, fy1))]
            b.face([a[k], a[k1], bb[k1], bb[k]], 'kit', uvs, [(0.0, 0.0)] * 4)
    # Верх воротника закрываем: он внутри шеи и не виден, но открытая труба
    # оставляет пересчёту нормалей неоднозначность.
    b.cap(rings[-1], 'kit', uv_in(Z_FRONT, 0.5, 0.99), (0.0, 0.0))
    return rings[-1]


def build_sleeve(b, sign):
    n = SLEEVE_N
    rings = []
    for x, r, z in SLEEVE:
        rings.append(b.ring(ring_yz(sign * x, r, r, n, z0=z)))

    def uvf(i0, i1):
        def f(r, k):
            x = SLEEVE[i0 if r == 0 else i1][0]
            fx = (x - SLEEVE_X0) / (SLEEVE_X1 - SLEEVE_X0)
            return uv_in(Z_SLEEVE, fx, wrap_frac(k, n))
        return f

    for i in range(len(rings) - 1):
        a, bb = (rings[i], rings[i + 1]) if sign > 0 else (rings[i + 1], rings[i])
        x0, x1 = SLEEVE[i][0], SLEEVE[i + 1][0]
        fl0 = flutter_sleeve(x0)
        fl1 = flutter_sleeve(x1)
        if sign < 0:
            fl0, fl1 = fl1, fl0
        b.bridge(a, bb, 'kit', uvf(i, i + 1) if sign > 0 else uvf(i + 1, i),
                 lambda r, k, f0=fl0, f1=fl1: ((f0 if r == 0 else f1),
                                               (k / float(n) * 0.5 + 0.25) % 1.0))
    b.cap(rings[0], 'kit', uv_in(Z_SLEEVE, 0.02, 0.5), (0.0, 0.0))
    b.cap(rings[-1], 'kit', uv_in(Z_SLEEVE, 0.98, 0.5), (0.0, 0.0))
    return rings


def build_arm(b, sign):
    n = ARM_N
    rings = [b.ring(ring_yz(sign * x, r, r, n, z0=z)) for x, r, z in ARM]
    uv = (0.5, 0.5)
    for i in range(len(rings) - 1):
        a, bb = (rings[i], rings[i + 1]) if sign > 0 else (rings[i + 1], rings[i])
        b.bridge(a, bb, 'skin', lambda r, k: uv, lambda r, k: (0.0, 0.0))
    b.cap(rings[0], 'skin', uv, (0.0, 0.0))
    b.cap(rings[-1], 'skin', uv, (0.0, 0.0))
    return rings


def build_hand(b, sign):
    n = HAND_N
    rings = [b.ring(ring_yz(sign * x, ry, rz, n, y0=dy, z0=1.446))
             for x, ry, rz, dy in HAND]
    uv = (0.5, 0.5)
    for i in range(len(rings) - 1):
        a, bb = (rings[i], rings[i + 1]) if sign > 0 else (rings[i + 1], rings[i])
        b.bridge(a, bb, 'skin', lambda r, k: uv, lambda r, k: (0.0, 0.0))
    b.cap(rings[-1], 'skin', uv, (0.0, 0.0))
    b.cap(rings[0], 'skin', uv, (0.0, 0.0))

    # Большой палец — короткий прилив на передней стороне ладони
    t = THUMB
    tn = t['n']
    r0 = b.ring(ring_yz(sign * t['x0'], t['r0'], t['r0'], tn,
                        y0=t['dy'], z0=1.446 + t['dz']))
    r1 = b.ring(ring_yz(sign * t['x1'], t['r1'], t['r1'], tn,
                        y0=t['dy'] - 0.012, z0=1.446 + t['dz']))
    a, bb = (r0, r1) if sign > 0 else (r1, r0)
    b.bridge(a, bb, 'skin', lambda r, k: uv, lambda r, k: (0.0, 0.0))
    b.cap(r1, 'skin', uv, (0.0, 0.0))
    b.cap(r0, 'skin', uv, (0.0, 0.0))
    return rings


def build_neck(b):
    n = NECK_N
    rings = [b.ring(ring_xy(z, rx, ry, n)) for z, rx, ry in NECK]
    uv = (0.5, 0.5)
    for i in range(len(rings) - 1):
        b.bridge(rings[i], rings[i + 1], 'skin', lambda r, k: uv,
                 lambda r, k: (0.0, 0.0))
    b.cap(rings[0], 'skin', uv, (0.0, 0.0))
    b.cap(rings[-1], 'skin', uv, (0.0, 0.0))
    return rings


def build_head(b):
    """Голова с ЦИЛИНДРИЧЕСКОЙ развёрткой под текстуру лица.

    u = 0.5 в самой середине лица, растёт по кругу; текстура лица рисуется
    кодом под ровно эту схему (см. src/face.js). Затылок оказывается на краях
    развёртки — там просто тон кожи, и шов не виден.
    """
    n = HEAD_N
    rings = []
    for ri, (z, rx, ry, y0) in enumerate(HEAD):
        pts = list(ring_xy(z, rx, ry, n, y0=y0))
        push = NOSE.get(ri, 0.0)
        brow = BROW.get(ri, 0.0)
        if push or brow:
            for k in range(n):
                a = TAU * k / n
                # вес выноса: максимум строго вперёд, к вискам гаснет
                w = max(0.0, math.cos(a)) ** 3
                if w > 0.001:
                    x, y, zz = pts[k]
                    pts[k] = (x, y - (push + brow) * w, zz)
        rings.append(b.ring(pts))

    for i in range(len(rings) - 1):
        a, bb = rings[i], rings[i + 1]
        z0, z1 = HEAD[i][0], HEAD[i + 1][0]
        fy0 = (z0 - HEAD[0][0]) / (HEAD[-1][0] - HEAD[0][0])
        fy1 = (z1 - HEAD[0][0]) / (HEAD[-1][0] - HEAD[0][0])
        for k in range(n):
            k1 = (k + 1) % n
            # U идёт НЕПРЕРЫВНО 0.5 → 1.5, а шов закрывает RepeatWrapping
            # текстуры. Если вместо этого заворачивать u вручную в 0..1, у
            # грани на затылке получится диапазон 1.0 → 0.083, и она размажет
            # по себе ВСЮ текстуру лица задом наперёд.
            u0 = 0.5 + k / float(n)
            u1 = 0.5 + (k + 1) / float(n)
            b.face([a[k], a[k1], bb[k1], bb[k]], 'head',
                   [(u0, fy0), (u1, fy0), (u1, fy1), (u0, fy1)],
                   [(0.0, 0.0)] * 4)
    b.cap(rings[-1], 'head', (0.5, 1.0), (0.0, 0.0))
    b.cap(rings[0], 'head', (0.5, 0.0), (0.0, 0.0))

    # Уши: две пластины по бокам. Дают силуэт в профиль, стоят 4 грани.
    e = EAR
    # Ушам нужен участок ЧИСТОГО ТОНА КОЖИ, иначе они покрасятся тем, что
    # окажется в этой точке текстуры лица. (0.5, 0.5) — это переносица, то есть
    # уши получили бы пиксель брови. Берём затылок на середине высоты: u = 1.0
    # ровно за головой (угол 180°), там по построению ровная кожа.
    uv = (1.0, 0.55)
    for sign in (1, -1):
        xin, xout = 0.066 * sign, (0.066 + e['out']) * sign
        inner = b.ring([(xin, e['y0'], e['z0']), (xin, e['y1'], e['z0']),
                        (xin, e['y1'], e['z1']), (xin, e['y0'], e['z1'])])
        outer = b.ring([(xout, e['y0'] - 0.004, e['z0'] + 0.006),
                        (xout, e['y1'] + 0.006, e['z0'] + 0.006),
                        (xout, e['y1'] + 0.006, e['z1'] - 0.006),
                        (xout, e['y0'] - 0.004, e['z1'] - 0.006)])
        for k in range(4):
            k1 = (k + 1) % 4
            b.face([inner[k], inner[k1], outer[k1], outer[k]], 'head',
                   [uv] * 4, [(0.0, 0.0)] * 4)
        b.cap(outer, 'head', uv, (0.0, 0.0))
        b.cap(inner, 'head', uv, (0.0, 0.0))
    return rings


def build_shorts(b):
    n = SHORTS_N
    rings = [b.ring(ring_xy(z, rx, ry, n, power=2.2)) for z, rx, ry in SHORTS]
    zs = [s[0] for s in SHORTS]

    def fy_of(z):
        return (z - SHORTS_Z0) / (SHORTS_Z1 - SHORTS_Z0)

    # Обход: перед 0.5→1.0 по u, спина обратно. Тогда боковой кант (x=32..34 и
    # 62..64 в атласе) ложится на ВНЕШНИЕ бока шорт, как на настоящих.
    def fx_of(k):
        w = wrap_frac(k, n)
        return 2.0 * w if w <= 0.5 else 2.0 * (1.0 - w)

    for i in range(len(rings) - 1):
        a, bb = rings[i], rings[i + 1]
        za, zb = zs[i], zs[i + 1]
        inner = i == len(rings) - 2      # подворот внутрь: нормали наружу
        for k in range(n):
            k1 = (k + 1) % n
            uvs = [uv_in(Z_SHORTS, fx_of(k), fy_of(za)),
                   uv_in(Z_SHORTS, fx_of(k + 1), fy_of(za)),
                   uv_in(Z_SHORTS, fx_of(k + 1), fy_of(zb)),
                   uv_in(Z_SHORTS, fx_of(k), fy_of(zb))]
            fl = [(flutter_shorts(za), (k / float(n) + 0.31) % 1.0),
                  (flutter_shorts(za), ((k + 1) / float(n) + 0.31) % 1.0),
                  (flutter_shorts(zb), ((k + 1) / float(n) + 0.31) % 1.0),
                  (flutter_shorts(zb), (k / float(n) + 0.31) % 1.0)]
            quad = [a[k], a[k1], bb[k1], bb[k]]
            if inner:
                quad = list(reversed(quad))
                uvs = list(reversed(uvs))
                fl = list(reversed(fl))
            b.face(quad, 'kit', uvs, fl)
    b.cap(rings[-1], 'kit', uv_in(Z_SHORTS, 0.5, 0.5), (0.0, 0.0))
    b.cap(rings[0], 'kit', uv_in(Z_SHORTS, 0.5, 0.98), (0.0, 0.0))
    return rings


def build_leg(b, sign):
    """Бедро (кожа) + гетра (кит) + бутса (кит) одной ногой."""
    hip_x = 0.0885 * sign
    n = THIGH_N
    skin_uv = (0.5, 0.5)

    thigh = [b.ring(ring_xy(z, rx, ry, n, y0=0.004)) for z, rx, ry in THIGH]
    for idx in thigh:
        for i in idx:
            v = b.verts[i]
            b.verts[i] = Vector((v.x + hip_x, v.y, v.z))
    for i in range(len(thigh) - 1):
        a, bb = (thigh[i + 1], thigh[i]) if sign > 0 else (thigh[i], thigh[i + 1])
        b.bridge(a, bb, 'skin', lambda r, k: skin_uv, lambda r, k: (0.0, 0.0))
    b.cap(thigh[0], 'skin', skin_uv, (0.0, 0.0))
    b.cap(thigh[-1], 'skin', skin_uv, (0.0, 0.0))

    sn = SOCK_N
    sock = [b.ring(ring_xy(z, rx, ry, sn, y0=0.006)) for z, rx, ry in SOCK]
    for idx in sock:
        for i in idx:
            v = b.verts[i]
            b.verts[i] = Vector((v.x + hip_x + 0.004 * sign, v.y, v.z))

    def sock_fy(z):
        return (z - SOCK_Z0) / (SOCK_Z1 - SOCK_Z0)

    for i in range(len(sock) - 1):
        za, zb = SOCK[i][0], SOCK[i + 1][0]
        a, bb = sock[i], sock[i + 1]
        for k in range(sn):
            k1 = (k + 1) % sn
            w0, w1 = wrap_frac(k, sn), wrap_frac(k + 1, sn)
            fx0 = 2.0 * w0 if w0 <= 0.5 else 2.0 * (1.0 - w0)
            fx1 = 2.0 * w1 if w1 <= 0.5 else 2.0 * (1.0 - w1)
            uvs = [uv_in(Z_SOCK, fx0, sock_fy(za)), uv_in(Z_SOCK, fx1, sock_fy(za)),
                   uv_in(Z_SOCK, fx1, sock_fy(zb)), uv_in(Z_SOCK, fx0, sock_fy(zb))]
            quad = [a[k], a[k1], bb[k1], bb[k]]
            if sign > 0:
                quad = [a[k1], a[k], bb[k], bb[k1]]
                uvs = [uvs[1], uvs[0], uvs[3], uvs[2]]
            b.face(quad, 'kit', uvs, [(0.0, 0.0)] * 4)
    b.cap(sock[0], 'kit', uv_in(Z_SOCK, 0.5, 0.98), (0.0, 0.0))
    b.cap(sock[-1], 'kit', uv_in(Z_SOCK, 0.5, 0.02), (0.0, 0.0))

    # --- Бутса: система координат стопы ---
    # Щиколотка (кость Foot) и носок (Toe_End) взяты из рига; ось «вперёд»
    # почти в -Y, но с небольшим разворотом наружу — берём её из костей.
    ank = Vector((0.0926 * sign, 0.0137 if sign > 0 else 0.0115, 0.0854))
    toe = Vector((0.1587 * sign, -0.2643, 0.0015))
    fwd = Vector((toe.x - ank.x, toe.y - ank.y, 0.0)).normalized()
    right = Vector((fwd.y, -fwd.x, 0.0))

    def boot_ring(t, hw, zbot, ztop):
        base = ank + fwd * t
        pts = []
        for u, v in BOOT_SECTION:
            pts.append((base.x + right.x * hw * u,
                        base.y + right.y * hw * u,
                        zbot + (ztop - zbot) * v))
        return pts

    boot = [b.ring(boot_ring(t, hw, zb_, zt)) for t, hw, zb_, zt in BOOT]

    # Развёртка бутсы: u вдоль колодки (пятка справа, как было у старой сетки),
    # v — ВЫСОТА сечения. Значит подошва всегда ложится на нижние ряды зоны
    # атласа, и туда можно нарисовать светлый кант подошвы — примету бутсы 90-х.
    t0, t1 = BOOT[0][0], BOOT[-1][0]
    for i in range(len(boot) - 1):
        fx0 = 1.0 - (BOOT[i][0] - t0) / (t1 - t0)
        fx1 = 1.0 - (BOOT[i + 1][0] - t0) / (t1 - t0)
        a, bb = boot[i], boot[i + 1]
        for k in range(BOOT_N):
            k1 = (k + 1) % BOOT_N
            v0, v1 = BOOT_SECTION[k][1], BOOT_SECTION[k1][1]
            uvs = [uv_in(Z_BOOT, fx0, v0), uv_in(Z_BOOT, fx0, v1),
                   uv_in(Z_BOOT, fx1, v1), uv_in(Z_BOOT, fx1, v0)]
            b.face([a[k], a[k1], bb[k1], bb[k]], 'kit', uvs, [(0.0, 0.0)] * 4)
    b.cap(boot[0], 'kit', uv_in(Z_BOOT, 0.98, 0.45), (0.0, 0.0))
    b.cap(boot[-1], 'kit', uv_in(Z_BOOT, 0.02, 0.45), (0.0, 0.0))
    return thigh, sock, boot


# ============================================================================
#  Сцена
# ============================================================================
def fcurves(act):
    try:
        return act.layers[0].strips[0].channelbag(act.slots[0]).fcurves
    except Exception:
        return []


def retime(act, k):
    """Перевести кадры клипа в другой тайм-код (реальная длительность та же).

    После умножения кадры ПРИЩЁЛКИВАЕМ к целым. Причина арифметическая: 6.7 с
    при 24 fps дают 160.79999 кадра, умножение на 1.25 — 200.99999, и int()
    при создании полосы NLA отрезает это до 200. Клип `idle` терял ровно один
    кадр. Щёлкаем только те ключи, что уже стоят у целого ближе тысячной, —
    настоящую дробную анимацию (её тут быть не должно) это не тронет.
    """
    for c in fcurves(act):
        for p in c.keyframe_points:
            t = p.co[0] * k
            snapped = round(t)
            d = (snapped - t) if abs(snapped - t) < 1e-3 else 0.0
            p.co[0] = t + d
            p.handle_left[0] = p.handle_left[0] * k + d
            p.handle_right[0] = p.handle_right[0] * k + d
        c.update()


def load_source(scene):
    """Импорт боевой модели и перевод сцены в тайм-код 30 fps.

    ПОЧЕМУ ИСТОЧНИК — models/player.glb, А НЕ models/blender/player-base.blend.
    Казалось бы, .blend удобнее: там четырёхугольная сетка и родные действия.
    Но замер показал, что клипы в нём в 1.5625 раза ДЛИННЕЕ боевых (`run`
    0.833 с против 0.533 с) — .blend остался в более раннем состоянии, чем
    отгруженная модель. Собери мы из него, и вся анимация замедлилась бы
    в полтора раза, а вымеренные кадры контакта (aerial.sync) промахнулись бы
    мимо мяча. Анимации берём ТОЛЬКО из боевого файла и не трогаем совсем.

    Тайм-код. glTF хранит время в СЕКУНДАХ, а импорт кладёт сцену на 24 fps —
    концы клипов попадают на дробные кадры (0.533 с × 24 = 12.8), и экспортёр,
    сэмплирующий по целым кадрам, срезает у каждого клипа хвост. Переводим на
    30 fps: там все номера кадров целые, а секунды не меняются.
    """
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'models/player.glb'))
    got = scene.render.fps
    base = 30
    if got != base:
        for a in list(bpy.data.actions):
            retime(a, base / got)
        scene.render.fps = base
    frac = [(a.name, round(k.co[0], 3)) for a in bpy.data.actions
            for c in fcurves(a) for k in c.keyframe_points
            if abs(k.co[0] - round(k.co[0])) > 1e-4]
    keys = sum(len(c.keyframe_points) for a in bpy.data.actions for c in fcurves(a))
    print(f'ИСХОДНИК: fps импорта {got} → {base}, клипов {len(bpy.data.actions)}, '
          f'ключей {keys}, дробных кадров {len(frac)}')
    # «Дробных нет» при НУЛЕ ключей — не проверка, а тишина: если обход f-кривых
    # сломается (в Blender 4.4+ они лежат в слоях действия), ретайм молча не
    # применится, а утверждение всё равно пройдёт.
    assert keys > 1000, f'Похоже, f-кривые не читаются: ключей всего {keys}'
    assert not frac, frac[:5]

    # ПОЛОСЫ NLA ПЕРЕСОБИРАЕМ ЗАНОВО. Ретайм двигает ключи ВНУТРИ действия, но
    # границы полосы остаются прежними — полоса продолжает кончаться на кадре
    # 12.8, обрезая уже растянутое до 16 кадров действие. Экспортёр пишет
    # анимации именно по полосам, и в игру уезжают клипы на четверть короче:
    # замер показал `run` 0.4 с вместо 0.533, то есть весь бег быстрее на 25 %,
    # а вымеренные кадры контакта (aerial.sync) промахиваются мимо мяча.
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    if arm.animation_data:
        arm.animation_data_clear()
    ad = arm.animation_data_create()
    for a in sorted(bpy.data.actions, key=lambda x: x.name):
        tr = ad.nla_tracks.new()
        tr.name = a.name
        tr.strips.new(a.name, int(a.frame_range[0]), a)
    ad.action = None


def main():
    scene = bpy.context.scene
    load_source(scene)

    arm_obj = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    old = next(o for o in bpy.data.objects
               if o.type == 'MESH' and o.vertex_groups and len(o.data.materials) == 3)
    old.name = 'WeightDonor'
    old.data.name = 'WeightDonor'

    b = Build()
    top = build_torso(b)
    build_collar(b, top)
    for s in (1, -1):
        build_sleeve(b, s)
        build_arm(b, s)
        build_hand(b, s)
        build_leg(b, s)
    build_neck(b)
    build_head(b)
    build_shorts(b)

    # --- в bmesh ---
    bm = bmesh.new()
    bverts = [bm.verts.new(v) for v in b.verts]
    bm.verts.index_update()
    uv_lay = bm.loops.layers.uv.new('UVMap')
    fl_lay = bm.loops.layers.uv.new('flutter')

    mats = ['kit', 'skin', 'head']
    made = 0
    skipped = 0
    for idx, mat, uvs, flut in b.faces:
        try:
            f = bm.faces.new([bverts[i] for i in idx])
        except ValueError:
            skipped += 1
            continue
        f.material_index = mats.index(mat)
        f.smooth = not FLAT_SHADING
        for li, loop in enumerate(f.loops):
            loop[uv_lay].uv = uvs[li]
            loop[fl_lay].uv = flut[li]
        made += 1
    print(f'ГРАНЕЙ: создано {made}, пропущено дублей {skipped}')

    # Нормали пересчитываем СКОПОМ, а не следим за порядком обхода в каждой из
    # двух десятков труб. Именно поэтому все объёмы закрыты крышками: у открытой
    # трубы «наружу» определяется неоднозначно, и часть фигуры вывернулась бы
    # наизнанку — на Lambert с отсечением задних граней это дыра в игроке.
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    me = bpy.data.meshes.new('PlayerBase')
    bm.to_mesh(me)
    bm.free()
    # Материалы берём ИЗ ДОНОРА, а не по имени из bpy.data: после импорта glb
    # имена могут получить суффикс (kit.001), и поиск по строке молча свалится.
    by_name = {m.name.split('.')[0]: m for m in old.data.materials}
    for name in mats:
        me.materials.append(by_name[name])

    obj = bpy.data.objects.new('PlayerBase', me)
    scene.collection.objects.link(obj)
    # Посадка. Наши координаты — МЕТРЫ мировой системы (фигура 1.8 м у нуля),
    # а у донора после импорта glb локальные координаты в САНТИМЕТРАХ и Y-вверх:
    # v0 = [-16.5, 86.0, 10.5] превращается в [-0.165, -0.105, 0.86] только
    # матрицей арматуры (масштаб 0.01 плюс разворот осей). Поэтому мировую
    # матрицу нашей сетки держим ЕДИНИЧНОЙ, а масштаб родителя гасим обратной
    # матрицей. Иначе фигура станет ростом 1.8 сантиметра, а все проверки
    # расстояний «вершина — кость» пройдут ложно: они тоже сожмутся в сто раз.
    obj.parent = arm_obj
    obj.matrix_parent_inverse = arm_obj.matrix_world.inverted()
    assert (obj.matrix_world - Matrix.Identity(4)).median_scale < 1e-6, obj.matrix_world

    # --- веса ---
    for bone in arm_obj.data.bones:
        obj.vertex_groups.new(name=bone.name)

    transfer_weights(obj, old)
    verify_weights(obj, arm_obj)

    analytic_weights(obj)
    clamp_weights(obj)
    verify_weights(obj, arm_obj)

    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm_obj

    bpy.data.objects.remove(old, do_unlink=True)

    # В боевом glb висит осиротевшая Icosphere радиусом 2 м — след старой
    # работы. Игра её не инстанцирует (она вне сцены glTF), но в файле она
    # лежит. Заодно выносим всё, что не арматура и не наша сетка.
    for o in list(bpy.data.objects):
        if o not in (arm_obj, obj):
            print('УБРАН ИЗ ЭКСПОРТА:', o.name, o.type)
            bpy.data.objects.remove(o, do_unlink=True)

    stats(obj)
    export(scene, arm_obj)


def transfer_weights(dst, src):
    """Перенос весов со старой сетки по БЛИЖАЙШЕЙ ТОЧКЕ ПОВЕРХНОСТИ.

    Почему не оператором `bpy.ops.object.data_transfer`. Он зависит от контекста
    и в фоновом Blender (-b) молча отработал мимо: замер после него показал, что
    581 вершина из 980 оказалась дальше 28 см от своей главной кости, а кончик
    кисти на x = 1.0 получил веса ТАЗА. В T-позе это не видно вовсе — фигура
    стоит ровно, — и вылезает только в движении длинными шипами из бутс.
    Здесь то же самое считается руками и проверяемо: BVH-дерево по старой сетке,
    для каждой новой вершины ищем ближайшую точку, берём грань, на которую она
    попала, и смешиваем веса её вершин барицентрически.
    """
    smesh = src.data
    SM = src.matrix_world
    DM = dst.matrix_world
    sverts = [SM @ v.co for v in smesh.vertices]
    spolys = [tuple(p.vertices) for p in smesh.polygons]
    tree = BVHTree.FromPolygons(sverts, spolys, all_triangles=False)

    snames = [g.name for g in src.vertex_groups]
    sweights = [{snames[g.group]: g.weight for g in v.groups} for v in smesh.vertices]
    dgroups = {g.name: g for g in dst.vertex_groups}

    far = 0
    for v in dst.data.vertices:
        p = DM @ v.co
        loc, _nor, idx, dist = tree.find_nearest(p)
        if loc is None:
            continue
        if dist > 0.12:
            far += 1
        poly = spolys[idx]
        bary = poly_3d_calc([sverts[i] for i in poly], loc)
        acc = {}
        for w, vi in zip(bary, poly):
            for name, sw in sweights[vi].items():
                acc[name] = acc.get(name, 0.0) + sw * w
        total = sum(acc.values())
        if total <= 0:
            continue
        for name, w in acc.items():
            if w > 1e-4:
                dgroups[name].add([v.index], w / total, 'REPLACE')
    print(f'ВЕСА: перенесены со старой сетки; дальше 12 см от донора — {far} вершин')


def verify_weights(obj, arm_obj, limit=12):
    """Проверка «вершина рядом со своей костью».

    Сломанные веса не видно в T-позе: фигура стоит ровно, а рассыпается только
    в движении. Дешёвый и надёжный признак — РАССТОЯНИЕ от вершины до отрезка
    её главной кости. Вершина шорт, у которой главная кость RightFoot, лежит от
    неё в полуметре, и это ловится арифметикой, а не глазами.
    """
    M = obj.matrix_world
    A = arm_obj.matrix_world
    seg = {}
    for bn in arm_obj.data.bones:
        seg[bn.name] = (A @ bn.head_local, A @ bn.tail_local)
    names = [g.name for g in obj.vertex_groups]

    def dist_to_bone(p, name):
        h, t = seg[name]
        d = t - h
        L2 = d.dot(d)
        u = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, (p - h).dot(d) / L2))
        return (p - (h + d * u)).length

    bad = []
    for v in obj.data.vertices:
        p = M @ v.co
        gs = sorted(((names[g.group], g.weight) for g in v.groups), key=lambda t: -t[1])
        if not gs:
            continue
        d = dist_to_bone(p, gs[0][0])
        bad.append((d, v.index, [round(x, 3) for x in p], gs[0][0].replace('mixamorig:', ''),
                    round(gs[0][1], 2)))
    bad.sort(reverse=True)
    worst = bad[:limit]
    print('ПРОВЕРКА ВЕСОВ: худшие расстояния до главной кости')
    for d, i, p, bn, w in worst:
        print(f'   {d * 100:6.1f} см  верш {i:4}  {p}  → {bn} {w}')
    over = [x for x in bad if x[0] > 0.28]
    print(f'  вершин дальше 28 см от своей кости: {len(over)} из {len(bad)}')
    return len(over)


def clamp_weights(obj):
    """Не больше ЧЕТЫРЁХ костей на вершину и сумма ровно 1.

    Делаем руками, а не операторами vertex_group_limit_total/normalize_all:
    операторы зависят от контекста (режим, активный объект, область), и в
    фоновом Blender молча ничего не делают — а обнаружится это только тем,
    что экспортёр обрежет пятое влияние и деформация поедет в игре.
    """
    me = obj.data
    groups = obj.vertex_groups
    dropped = 0
    for v in me.vertices:
        # Забираем ВСЕ принадлежности, включая нулевые: вершина с нулевым весом
        # всё равно числится в группе и съедает один из четырёх слотов glTF.
        ws = sorted(((g.group, g.weight) for g in v.groups), key=lambda t: -t[1])
        keep = [(gi, w) for gi, w in ws if w > 1e-4][:4]
        total = sum(w for _, w in keep)
        if total <= 0:
            continue
        if len(ws) > len(keep):
            dropped += 1
        for gi, _ in ws:
            groups[gi].remove([v.index])
        for gi, w in keep:
            groups[gi].add([v.index], w / total, 'REPLACE')
    print(f'ВЕСА: нормализованы; у {dropped} вершин было больше 4 костей')


def analytic_weights(obj):
    """Кисти, большой палец и носок бутсы торчат ЗА старую сетку — перенос там
    врёт (ближайшей гранью оказывается что попало). Ставим руками."""
    me = obj.data
    M = obj.matrix_world
    groups = {g.name: g for g in obj.vertex_groups}

    def setw(vi, pairs):
        for g in obj.vertex_groups:
            try:
                g.remove([vi])
            except RuntimeError:
                pass
        for name, w in pairs:
            if w > 0.0005:
                groups['mixamorig:' + name].add([vi], w, 'REPLACE')

    fixed_hand = fixed_foot = 0
    for v in me.vertices:
        p = M @ v.co
        side = 'Left' if p.x >= 0 else 'Right'
        ax = abs(p.x)
        # кисть: всё дальше запястья (0.836) принадлежит кости Hand целиком,
        # с коротким переходом от предплечья, чтобы запястье не ломалось углом
        if ax > 0.80 and p.z > 1.30:
            t = min(1.0, max(0.0, (ax - 0.800) / 0.055))
            setw(v.index, [(side + 'Hand', t), (side + 'ForeArm', 1.0 - t)])
            fixed_hand += 1
            continue
        # носок бутсы: старая стопа кончалась на y = -0.20, наша — на -0.26
        if p.y < -0.185 and p.z < 0.13:
            t = min(1.0, max(0.0, (-p.y - 0.150) / 0.055))
            setw(v.index, [(side + 'ToeBase', t), (side + 'Foot', 1.0 - t)])
            fixed_foot += 1
    print(f'ВЕСА ВРУЧНУЮ: кисть {fixed_hand} вершин, носок бутсы {fixed_foot}')


def stats(obj):
    me = obj.data
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    per_mat = {}
    for p in me.polygons:
        n = me.materials[p.material_index].name
        per_mat[n] = per_mat.get(n, 0) + len(p.vertices) - 2
    unweighted = [v.index for v in me.vertices if not v.groups]
    over4 = sum(1 for v in me.vertices if len(v.groups) > 4)
    print(f'СЕТКА: {len(me.vertices)} вершин, {len(me.polygons)} граней, {tris} треугольников')
    print(f'  по материалам (тр.): {per_mat}')
    print(f'  без весов: {len(unweighted)}  |  больше 4 костей: {over4}')
    assert not unweighted, f'Вершины без весов: {unweighted[:20]}'
    assert not over4, 'Есть вершины с более чем 4 костями — glTF их обрежет'


def export(scene, arm_obj):
    assert scene.render.fps == 30, scene.render.fps
    bpy.ops.export_scene.gltf(
        filepath=OUT, export_format='GLB',
        export_animation_mode='NLA_TRACKS',
        export_animations=True, export_skins=True, export_morph=False,
        export_apply=False, export_yup=True,
        export_image_format='AUTO',
        export_cameras=False, export_lights=False,
        export_optimize_animation_size=True,
        export_vertex_color='NONE',
        use_selection=False,
    )
    print('ЭКСПОРТ:', os.path.getsize(OUT), 'байт, fps сцены', scene.render.fps)


main()
