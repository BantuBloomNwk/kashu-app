# Kashu windows, rendered real: a painted, bevelled frame set into a wall, glazing bars, glass, a stone
# sill and a small room behind (lamp on or off); and the shutters, four patterns, left and right.
# One orthographic camera for every layer, so the layers line up pixel for pixel in CSS.
# Run: blender -b -P windows.py -- <outdir>
import bpy, bmesh, math, sys, os
from mathutils import Vector
OUT = sys.argv[sys.argv.index('--') + 1]
os.makedirs(OUT, exist_ok=True)

def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def hexlin(h):
    h = h.lstrip('#'); c = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c) + (1,)

def mat(name, col, rough=0.5, metal=0.0, emit=None, estr=0.0, coat=0.0, bump=0.0, scale=40, transmit=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = hexlin(col); b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Transmission Weight'].default_value = transmit
    if transmit: b.inputs['IOR'].default_value = 1.45
    if emit:
        b.inputs['Emission Color'].default_value = hexlin(emit); b.inputs['Emission Strength'].default_value = estr
    if bump:
        n = nt.nodes.new('ShaderNodeTexNoise'); n.inputs['Scale'].default_value = scale; n.inputs['Detail'].default_value = 8
        bp = nt.nodes.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = bump; bp.inputs['Distance'].default_value = 0.02
        nt.links.new(n.outputs['Fac'], bp.inputs['Height']); nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
    return m

def box(name, sx, sy, sz, loc, m, bevel=0.0, seg=3):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object; o.name = name; o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        bv = o.modifiers.new('bv', 'BEVEL'); bv.width = bevel; bv.segments = seg; bv.limit_method = 'ANGLE'
    o.data.materials.append(m)
    return o

def cut(target, cutter, op='DIFFERENCE'):
    md = target.modifiers.new('b', 'BOOLEAN'); md.operation = op; md.object = cutter; md.solver = 'EXACT'
    bpy.context.view_layer.objects.active = target
    # booleans first, bevel after
    target.modifiers.move(len(target.modifiers) - 1, 0)
    bpy.ops.object.modifier_apply(modifier='b')
    bpy.data.objects.remove(cutter)

def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        for md in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join(); objs[0].name = name
    return objs[0]

# geometry, in Blender units (x across, z up, camera looks along +y from y<0)
OW, OH = 4.0, 5.0            # frame outside
IW, IH = 3.3, 4.3            # opening
FD = 0.34                    # frame depth, front face at y = -FD/2
BAR_Z = IH / 2 - IH * 0.46   # horizontal glazing bar, 46% down the opening
VIEW = (-2.5, 2.5, -3.05, 2.55)   # x0 x1 z0 z1 of the picture
PX = 100                     # pixels per unit

def scene_base(lit):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 160; sc.cycles.use_denoising = True
    sc.cycles.device = 'CPU'; sc.render.threads_mode = 'FIXED'; sc.render.threads = 2
    sc.render.film_transparent = True
    sc.render.resolution_x = int((VIEW[1] - VIEW[0]) * PX); sc.render.resolution_y = int((VIEW[3] - VIEW[2]) * PX)
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
    sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = hexlin('#C9D6E6' if not lit else '#E9E2D2'); bg.inputs['Strength'].default_value = 0.55
    # a perspective camera square on, so the reveal and the room have depth; every layer shares it
    cam = bpy.data.cameras.new('cam'); cam.lens = 50; cam.sensor_fit = 'VERTICAL'; cam.sensor_height = 36
    co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    cx, cz = (VIEW[0] + VIEW[1]) / 2, (VIEW[2] + VIEW[3]) / 2
    D = (VIEW[3] - VIEW[2]) * 50 / 36
    co.location = (cx, -D, cz); co.rotation_euler = (math.radians(90), 0, 0)
    # raking sun from the top left and a little in front, as on a wall in the late afternoon
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 3.2; sun.angle = math.radians(3)
    so = bpy.data.objects.new('sun', sun); sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(58), math.radians(-28), math.radians(-22))
    # a big soft sky panel up front for the glass to reflect
    bpy.ops.mesh.primitive_plane_add(size=1, location=(-3, -9, 7)); sky = bpy.context.object
    sky.scale = (14, 6, 1); sky.rotation_euler = (math.radians(-60), 0, 0)
    sky.data.materials.append(mat('sky', '#FFFFFF', emit='#EEF4FF', estr=1.6))
    sky.visible_camera = False
    return sc

def build_wall():
    # the wall is a shadow catcher: invisible, but it keeps the frame's and sill's shadows
    w = box('wall', 12, 0.2, 12, (0, FD / 2 + 0.1, 0), mat('wallm', '#EEE8DA'))
    hole = box('hole', IW, 1, IH, (0, FD / 2 + 0.1, 0), mat('h', '#000000'))
    cut(w, hole); w.is_shadow_catcher = True
    return w

def build_frame(paint):
    f = box('frame', OW, FD, OH, (0, 0, 0), paint, bevel=0.05, seg=4)
    hole = box('hole', IW, 2, IH, (0, 0, 0), paint)
    cut(f, hole)
    # a raised moulding around the opening
    m = box('moulding', IW + 0.24, FD + 0.08, IH + 0.24, (0, -0.02, 0), paint, bevel=0.06, seg=4)
    h2 = box('h2', IW, 2, IH, (0, 0, 0), paint); cut(m, h2)
    # glazing bars, set back behind the shutters
    y = 0.03
    v = box('vbar', 0.09, 0.12, IH, (0, y, 0), paint, bevel=0.025)
    hb = box('hbar', IW, 0.12, 0.09, (0, y, BAR_Z), paint, bevel=0.025)
    return [f, m, v, hb]

def build_sill():
    stone = mat('stone', '#E4DFD2', rough=0.72, bump=0.25, scale=60)
    s = box('sill', OW + 0.5, 0.75, 0.24, (0, -0.2, -OH / 2 - 0.12), stone, bevel=0.04, seg=3)
    lip = box('lip', OW + 0.56, 0.12, 0.08, (0, -0.55, -OH / 2 - 0.27), stone, bevel=0.02)
    return [s, lip]

def build_room(lit):
    # a small room behind the glass, all of it behind the wall plane (y > 0.38) so the wall hides its edges
    plaster = mat('roomwall', '#EBD9B4' if lit else '#25344A', rough=0.92, bump=0.08, scale=30)
    Y0, Y1, X, Z0, Z1 = 0.4, 3.4, 2.7, -2.35, 3.2
    mid = (Y0 + Y1) / 2; depth = Y1 - Y0
    box('back', 2 * X, 0.1, Z1 - Z0, (0, Y1, (Z0 + Z1) / 2), plaster)
    box('lw', 0.1, depth, Z1 - Z0, (-X, mid, (Z0 + Z1) / 2), plaster); box('rw', 0.1, depth, Z1 - Z0, (X, mid, (Z0 + Z1) / 2), plaster)
    box('ceil', 2 * X, depth, 0.1, (0, mid, Z1), plaster)
    box('floor', 2 * X, depth, 0.1, (0, mid, Z0), mat('floor', '#7A4A2A' if lit else '#1A2233', rough=0.5, bump=0.1, scale=8))
    # a framed picture on the back wall
    box('pframe', 1.0, 0.06, 0.8, (-1.0, Y1 - 0.06, 0.9), mat('pf', '#2B2118', rough=0.4), bevel=0.02)
    box('print', 0.82, 0.02, 0.62, (-1.0, Y1 - 0.1, 0.9), mat('pr', '#C9824A' if lit else '#33405A', rough=0.7))
    # a side table with a plant
    wood = mat('wood', '#5A3A22' if lit else '#1C2230', rough=0.5)
    box('top', 1.3, 0.7, 0.07, (1.3, Y1 - 0.55, -1.2), wood, bevel=0.02)
    for dx in (-0.55, 0.55):
        box('leg', 0.07, 0.07, 1.1, (1.3 + dx, Y1 - 0.55, -1.8), wood)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.2, depth=0.36, location=(1.3, Y1 - 0.55, -0.98)); pot = bpy.context.object
    pot.data.materials.append(mat('pot', '#B85F3A' if lit else '#2A2C36', rough=0.8))
    leaf = mat('leaf', '#3E8E5E' if lit else '#1A3328', rough=0.55)
    import random; random.seed(4)
    for i in range(9):
        a = random.uniform(0, 6.28); r = random.uniform(0.05, 0.3)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=random.uniform(0.13, 0.22), location=(1.3 + math.cos(a) * r, Y1 - 0.55 + math.sin(a) * r * 0.4, -0.62 + random.uniform(0, 0.45)))
        o = bpy.context.object; o.scale = (1, 0.6, 1.4); o.rotation_euler = (0, random.uniform(-0.6, 0.6), 0); o.data.materials.append(leaf)
    # a pendant lamp
    bpy.ops.mesh.primitive_cone_add(radius1=0.42, radius2=0.12, depth=0.34, location=(0.35, 1.9, 1.45)); shade = bpy.context.object
    shade.data.materials.append(mat('shade', '#0D5A3B', rough=0.45))
    box('cord', 0.02, 0.02, 1.6, (0.35, 1.9, 2.4), mat('cord', '#222222'))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, location=(0.35, 1.9, 1.23)); bulb = bpy.context.object
    bulb.data.materials.append(mat('bulb', '#FFE9B0', emit='#FFD27A', estr=60 if lit else 0.0))
    if lit:
        pl = bpy.data.lights.new('lamp', 'POINT'); pl.energy = 520; pl.color = (1.0, 0.78, 0.45); pl.shadow_soft_size = 0.25
        po = bpy.data.objects.new('lamp', pl); bpy.context.scene.collection.objects.link(po); po.location = (0.35, 1.85, 1.12)
        fill = bpy.data.lights.new('fill', 'AREA'); fill.energy = 120; fill.color = (1.0, 0.8, 0.55); fill.size = 3
        fo = bpy.data.objects.new('fill', fill); bpy.context.scene.collection.objects.link(fo); fo.location = (0, 1.2, 2.9)
    else:
        moon = bpy.data.lights.new('moon', 'AREA'); moon.energy = 40; moon.color = (0.6, 0.72, 1.0); moon.size = 2
        mo = bpy.data.objects.new('moon', moon); bpy.context.scene.collection.objects.link(mo); mo.location = (-1.8, 1.0, 2.9)
    box('glass', IW, 0.02, IH, (0, 0.1, 0), mat('glass', '#FFFFFF', rough=0.03, transmit=1.0))

def shutter(pattern, side, paint, metal):
    # one leaf, closed, filling its half of the opening
    gap = 0.012
    w, h = IW / 2 - gap, IH - 0.02
    cx = (-IW / 4 - gap / 2) if side == 'l' else (IW / 4 + gap / 2)
    y0 = -FD / 2 + 0.07       # sits inside the reveal, just behind the frame's front
    t = 0.07; st = 0.16       # leaf thickness, stile width
    parts = []
    outer = box('leaf', w, t, h, (cx, y0, 0), paint, bevel=0.018)
    inner = box('in', w - 2 * st, 1, h - 2 * st, (cx, y0, 0), paint)
    cut(outer, inner); parts.append(outer)
    iw, ih = w - 2 * st, h - 2 * st
    if pattern == 'louvre':
        n = int(ih / 0.15)
        for i in range(n):
            z = -ih / 2 + (i + 0.5) * ih / n
            s = box('slat', iw + 0.02, 0.025, 0.2, (cx, y0 + 0.005, z), paint, bevel=0.007, seg=2)
            s.rotation_euler = (math.radians(-34), 0, 0); parts.append(s)
        parts.append(box('mid', iw, t, 0.1, (cx, y0, 0), paint, bevel=0.015))
    elif pattern == 'panel':
        back = box('back', iw + 0.02, 0.03, ih + 0.02, (cx, y0 + 0.02, 0), paint); parts.append(back)
        rail = box('rail', iw, t, 0.16, (cx, y0, -0.25), paint, bevel=0.015); parts.append(rail)
        for zc, hh in ((ih / 4 + 0.0, ih / 2 - 0.36), (-ih / 4 - 0.25, ih / 2 - 0.1 - 0.4)):
            p = box('raised', iw - 0.16, 0.05, hh, (cx, y0 - 0.005, zc + 0.0), paint, bevel=0.035, seg=4); parts.append(p)
    elif pattern == 'lattice':
        back = box('back', iw + 0.02, 0.02, ih + 0.02, (cx, y0 + 0.03, 0), mat('dark', '#0E2A1F', rough=0.8)); parts.append(back)
        strips = []
        for k in range(-10, 11):
            for ang in (45, -45):
                s = box('st', 0.05, 0.035, 7.5, (cx + k * 0.28, y0, 0), paint, bevel=0.008, seg=2)
                s.rotation_euler = (0, math.radians(ang), 0)
                strips.append(s)
        lat = join(strips, 'lattice')
        clip = box('clip', iw, 1, ih, (cx, y0, 0), paint)
        md = lat.modifiers.new('b', 'BOOLEAN'); md.operation = 'INTERSECT'; md.object = clip; md.solver = 'FAST'
        bpy.context.view_layer.objects.active = lat; bpy.ops.object.modifier_apply(modifier='b'); bpy.data.objects.remove(clip)
        parts.append(lat)
    elif pattern == 'grid':
        back = box('back', iw + 0.02, 0.02, ih + 0.02, (cx, y0 + 0.03, 0), mat('glassd', '#16283C', rough=0.15)); parts.append(back)
        nx, nz = 3, 6
        for i in range(1, nx):
            parts.append(box('gv', 0.05, 0.05, ih, (cx - iw / 2 + i * iw / nx, y0, 0), paint, bevel=0.012))
        for j in range(1, nz):
            parts.append(box('gh', iw, 0.05, 0.05, (cx, y0, -ih / 2 + j * ih / nz), paint, bevel=0.012))
    # hinge knuckles on the outer edge, and a small knob near the meeting edge
    hx = cx - w / 2 - 0.02 if side == 'l' else cx + w / 2 + 0.02
    for z in (h / 2 - 0.55, -h / 2 + 0.55):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.04, depth=0.34, location=(hx, y0 - 0.02, z)); k = bpy.context.object
        k.data.materials.append(metal); parts.append(k)
    kx = cx + w / 2 - 0.12 if side == 'l' else cx - w / 2 + 0.12
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.045, location=(kx, y0 - 0.06, -0.05)); kn = bpy.context.object
    kn.data.materials.append(metal); parts.append(kn)
    return parts

def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

GREEN = '#0D5A3B'
ONLY = os.environ.get('ONLY')
for lit in ((False, True) if not ONLY else ()):
    clear(); scene_base(lit)
    paint = mat('paint', GREEN, rough=0.38, coat=0.25, bump=0.05, scale=90)
    build_wall(); build_frame(paint); build_sill(); build_room(lit)
    render(os.path.join(OUT, f'frame-{"lit" if lit else "dark"}.png'))

for pattern in ([ONLY] if ONLY else ('louvre', 'panel', 'lattice', 'grid')):
    for side in ('l', 'r'):
        clear(); scene_base(False)
        paint = mat('paint', GREEN, rough=0.38, coat=0.25, bump=0.05, scale=90)
        sp = mat('spaint', '#DCE6D8', rough=0.45, coat=0.15, bump=0.06, scale=120)
        metal = mat('brass', '#B8955A', rough=0.3, metal=1.0)
        # the frame and sill stay in the scene for shadows and light, but are cut out of the picture
        for o in build_frame(paint) + build_sill():
            o.is_holdout = True
        shutter(pattern, side, sp, metal)
        render(os.path.join(OUT, f'shutter-{pattern}-{side}.png'))
print('DONE')
