# Kashu objects, rendered real: moon (NASA LRO colour map, public domain), sun, steel vault (door, dial
# and handle as separate layers on one camera), gold kernels, a glass jar of kernels, and two phone
# frames (iPhone-style and Seeker-style) with see-through screens. Run:
#   blender -b -P assets.py -- <outdir> [only]
import bpy, bmesh, math, sys, os, json, random
OUT = sys.argv[sys.argv.index('--') + 1]; ONLY = sys.argv[sys.argv.index('--') + 2:] if len(sys.argv) > sys.argv.index('--') + 2 else []
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src')
os.makedirs(OUT, exist_ok=True)
META = {}

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c) + (1,)

def fresh(res, view, samples=128, transform='AgX', look='AgX - Medium High Contrast'):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.samples = samples; sc.cycles.use_denoising = True
    sc.render.threads_mode = 'FIXED'; sc.render.threads = 2
    sc.render.film_transparent = True
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.view_settings.view_transform = transform
    if look: sc.view_settings.look = look
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
    cam = bpy.data.cameras.new('cam'); cam.type = 'ORTHO'; cam.ortho_scale = view
    co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    co.location = (0, 0, 30)
    return sc

def world(col, s):
    n = bpy.context.scene.world.node_tree.nodes['Background']; n.inputs['Color'].default_value = lin(col); n.inputs['Strength'].default_value = s

def light(kind, energy, loc, rot=(0, 0, 0), size=1.0, col='#FFFFFF'):
    l = bpy.data.lights.new(kind, kind); l.energy = energy; l.color = lin(col)[:3]
    if kind == 'AREA': l.size = size
    if kind == 'SUN': l.angle = math.radians(size)
    o = bpy.data.objects.new(kind, l); bpy.context.scene.collection.objects.link(o); o.location = loc; o.rotation_euler = rot
    return o

def mat(name, col='#FFFFFF', rough=0.5, metal=0.0, coat=0.0, transmit=0.0, aniso=0.0, emit=None, estr=0.0, ior=1.45):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = lin(col); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    b.inputs['Coat Weight'].default_value = coat; b.inputs['Transmission Weight'].default_value = transmit; b.inputs['IOR'].default_value = ior
    b.inputs['Anisotropic'].default_value = aniso
    if emit: b.inputs['Emission Color'].default_value = lin(emit); b.inputs['Emission Strength'].default_value = estr
    return m

def nodes(m):
    return m.node_tree.nodes, m.node_tree.links, m.node_tree.nodes['Principled BSDF']

def render(name):
    bpy.context.scene.render.filepath = os.path.join(OUT, name + '.png'); bpy.ops.render.render(write_still=True)

def want(k): return not ONLY or k in ONLY

def obj_apply(o):
    bpy.context.view_layer.objects.active = o
    for md in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=md.name)

def rrect(name, w, h, r, depth, z=0.0, seg=10):
    """Rounded-rectangle prism in XY, top face at z + depth/2."""
    bm = bmesh.new(); pts = []
    for cx, cy, a0 in ((w/2-r, h/2-r, 0), (-w/2+r, h/2-r, 90), (-w/2+r, -h/2+r, 180), (w/2-r, -h/2+r, 270)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg); pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    vs = [bm.verts.new((x, y, z - depth / 2)) for x, y in pts]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f]); top = [v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=top, vec=(0, 0, depth))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    return o

# ---------------------------------------------------------------- moon
if want('moon'):
    fresh((640, 640), 2.3, samples=96)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=128, ring_count=64); m = bpy.context.object
    bpy.ops.object.shade_smooth()
    mm = mat('moon', rough=0.95); n, L, b = nodes(mm)
    tc = n.new('ShaderNodeTexImage'); tc.image = bpy.data.images.load(os.path.join(SRC, 'moon-color.tif'))
    td = n.new('ShaderNodeTexImage'); td.image = bpy.data.images.load(os.path.join(SRC, 'moon-disp.tif')); td.image.colorspace_settings.name = 'Non-Color'
    bc = n.new('ShaderNodeBrightContrast'); bc.inputs['Bright'].default_value = 0.05; bc.inputs['Contrast'].default_value = 0.15
    tint = n.new('ShaderNodeMixRGB'); tint.blend_type = 'MULTIPLY'; tint.inputs['Fac'].default_value = 0.35; tint.inputs['Color2'].default_value = lin('#FFE9B8')
    L.new(tc.outputs['Color'], bc.inputs['Color']); L.new(bc.outputs['Color'], tint.inputs['Color1']); L.new(tint.outputs['Color'], b.inputs['Base Color'])
    bp = n.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = 0.6; L.new(td.outputs['Color'], bp.inputs['Height']); L.new(bp.outputs['Normal'], b.inputs['Normal'])
    m.data.materials.append(mm); m.rotation_euler = (math.radians(90), 0, math.radians(-30))
    # sunlight from the left and a little behind: a thick crescent, lit on the left like the brand's moon
    light('SUN', 9.0, (0, 0, 0), (math.radians(0), math.radians(-118), 0), size=0.6, col='#FFF6E8')
    world('#8EA3CC', 0.14)   # earthshine on the dark side
    render('moon')

# ---------------------------------------------------------------- sun
if want('sun'):
    fresh((640, 640), 2.3, samples=64, transform='Standard', look=None)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=96, ring_count=48); s = bpy.context.object; bpy.ops.object.shade_smooth()
    sm = bpy.data.materials.new('sun'); sm.use_nodes = True; n = sm.node_tree.nodes; L = sm.node_tree.links
    for x in list(n): n.remove(x)
    out = n.new('ShaderNodeOutputMaterial'); em = n.new('ShaderNodeEmission')
    noise = n.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value = 90; noise.inputs['Detail'].default_value = 12; noise.inputs['Roughness'].default_value = 0.65
    vor = n.new('ShaderNodeTexVoronoi'); vor.inputs['Scale'].default_value = 140
    lw = n.new('ShaderNodeLayerWeight'); lw.inputs['Blend'].default_value = 0.5
    ramp = n.new('ShaderNodeValToRGB'); r = ramp.color_ramp
    r.elements[0].position = 0.0; r.elements[0].color = lin('#FFE7A3'); r.elements[1].position = 1.0; r.elements[1].color = lin('#C2400F')
    e = r.elements.new(0.45); e.color = lin('#FFB238'); e2 = r.elements.new(0.75); e2.color = lin('#EE7A1E')
    mix = n.new('ShaderNodeMath'); mix.operation = 'ADD'
    gran = n.new('ShaderNodeMath'); gran.operation = 'MULTIPLY'; gran.inputs[1].default_value = 0.42
    g2 = n.new('ShaderNodeMath'); g2.operation = 'MULTIPLY'; g2.inputs[1].default_value = 0.22
    L.new(noise.outputs['Fac'], gran.inputs[0]); L.new(vor.outputs['Distance'], g2.inputs[0])
    facing = n.new('ShaderNodeMath'); facing.operation = 'POWER'; facing.inputs[1].default_value = 1.6
    L.new(lw.outputs['Facing'], facing.inputs[0])
    a1 = n.new('ShaderNodeMath'); a1.operation = 'ADD'; L.new(facing.outputs[0], a1.inputs[0]); L.new(gran.outputs[0], a1.inputs[1])
    a2 = n.new('ShaderNodeMath'); a2.operation = 'ADD'; L.new(a1.outputs[0], a2.inputs[0]); L.new(g2.outputs[0], a2.inputs[1])
    L.new(a2.outputs[0], ramp.inputs['Fac']); L.new(ramp.outputs['Color'], em.inputs['Color']); em.inputs['Strength'].default_value = 1.0
    L.new(em.outputs[0], out.inputs['Surface']); s.data.materials.append(sm)
    render('sun')

# ---------------------------------------------------------------- vault (door, dial, handle)
if want('vault'):
    def vault_scene():
        sc = fresh((800, 800), 4.6, samples=128)
        world('#C9D2CC', 0.6)
        light('AREA', 900, (-4, 4, 8), (math.radians(-30), math.radians(-28), 0), size=5, col='#FFF6EA')
        light('AREA', 260, (5, -3, 5), (math.radians(30), math.radians(40), 0), size=3, col='#DDE8FF')
        steel = mat('steel', '#B9BEC0', rough=0.32, metal=1.0, aniso=0.7)
        dark = mat('dark', '#2B3133', rough=0.45, metal=0.9)
        green = mat('paint', '#0D5A3B', rough=0.42, coat=0.4)
        brass = mat('brass', '#C9A253', rough=0.25, metal=1.0)
        # the housing: a green painted block with a round recess
        bpy.ops.mesh.primitive_cube_add(size=1); hs = bpy.context.object; hs.scale = (4.2, 4.2, 0.8); hs.location = (0, 0, -0.5)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bv = hs.modifiers.new('bv', 'BEVEL'); bv.width = 0.12; bv.segments = 5
        hs.data.materials.append(green)
        bpy.ops.mesh.primitive_cylinder_add(radius=1.78, depth=1.0, location=(0, 0, 0), vertices=128); cut = bpy.context.object
        bo = hs.modifiers.new('b', 'BOOLEAN'); bo.object = cut; bo.operation = 'DIFFERENCE'; bo.solver = 'EXACT'
        hs.modifiers.move(1, 0); bpy.context.view_layer.objects.active = hs; bpy.ops.object.modifier_apply(modifier='b'); bpy.data.objects.remove(cut)
        # the door
        bpy.ops.mesh.primitive_cylinder_add(radius=1.7, depth=0.4, location=(0, 0, -0.05), vertices=128); door = bpy.context.object
        dv = door.modifiers.new('bv', 'BEVEL'); dv.width = 0.06; dv.segments = 4; door.data.materials.append(steel); bpy.ops.object.shade_smooth()
        bpy.ops.mesh.primitive_torus_add(major_radius=1.45, minor_radius=0.045, location=(0, 0, 0.16), major_segments=128); ring = bpy.context.object; ring.data.materials.append(dark)
        for i in range(24):
            a = 2 * math.pi * i / 24
            bpy.ops.mesh.primitive_uv_sphere_add(radius=0.055, location=(1.58 * math.cos(a), 1.58 * math.sin(a), 0.15)); rv = bpy.context.object; rv.data.materials.append(steel); bpy.ops.object.shade_smooth()
        # hinge barrels on the left
        for y in (1.0, -1.0):
            bpy.ops.mesh.primitive_cylinder_add(radius=0.14, depth=0.7, location=(-1.85, y, 0.05), vertices=48); hb = bpy.context.object; hb.rotation_euler = (math.radians(90), 0, 0); hb.data.materials.append(steel); bpy.ops.object.shade_smooth()
        # dial, centred at (-0.35, 0.35)
        dial = []
        bpy.ops.mesh.primitive_cylinder_add(radius=0.52, depth=0.18, location=(-0.35, 0.35, 0.24), vertices=96); d0 = bpy.context.object
        d0.modifiers.new('bv', 'BEVEL').width = 0.03; d0.data.materials.append(dark); bpy.ops.object.shade_smooth(); dial.append(d0)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.36, depth=0.08, location=(-0.35, 0.35, 0.34), vertices=96); d1 = bpy.context.object; d1.data.materials.append(steel); bpy.ops.object.shade_smooth(); dial.append(d1)
        for i in range(40):
            a = 2 * math.pi * i / 40; L_ = 0.09 if i % 5 else 0.15
            bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.35 + 0.44 * math.cos(a), 0.35 + 0.44 * math.sin(a), 0.335)); t = bpy.context.object
            t.scale = (L_, 0.018, 0.02); t.rotation_euler = (0, 0, a); t.data.materials.append(brass); dial.append(t)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.12, depth=0.12, location=(-0.35, 0.35, 0.42), vertices=48); d2 = bpy.context.object; d2.data.materials.append(brass); bpy.ops.object.shade_smooth(); dial.append(d2)
        # handle: three spokes with knobs, centred at (0.55, -0.55)
        handle = []
        bpy.ops.mesh.primitive_cylinder_add(radius=0.17, depth=0.22, location=(0.55, -0.55, 0.26), vertices=48); h0 = bpy.context.object; h0.data.materials.append(steel); bpy.ops.object.shade_smooth(); handle.append(h0)
        for i in range(3):
            a = math.radians(90 + 120 * i)
            bpy.ops.mesh.primitive_cylinder_add(radius=0.045, depth=0.62, location=(0.55 + 0.31 * math.cos(a), -0.55 + 0.31 * math.sin(a), 0.32), vertices=24); sp = bpy.context.object
            sp.rotation_euler = (0, math.radians(90), a); sp.data.materials.append(steel); bpy.ops.object.shade_smooth(); handle.append(sp)
            bpy.ops.mesh.primitive_uv_sphere_add(radius=0.1, location=(0.55 + 0.62 * math.cos(a), -0.55 + 0.62 * math.sin(a), 0.32)); kb = bpy.context.object; kb.data.materials.append(brass); bpy.ops.object.shade_smooth(); handle.append(kb)
        return dial, handle
    dial, handle = vault_scene()
    for o in dial + handle: o.visible_camera = False
    for o in handle: o.visible_shadow = False
    render('vault-body')
    for layer, keep in (('vault-dial', 'dial'), ('vault-handle', 'handle')):
        dial, handle = vault_scene()
        for o in bpy.context.scene.objects:
            if o.type == 'MESH' and o not in (dial if keep == 'dial' else handle): o.is_holdout = True
    # centres in % of the picture, for CSS transform-origin
        render(layer)
    META['vault'] = {'dial': [50 + (-0.35 / 4.6) * 100, 50 - (0.35 / 4.6) * 100], 'handle': [50 + (0.55 / 4.6) * 100, 50 + (0.55 / 4.6) * 100]}

# ---------------------------------------------------------------- kernels
def kernel(loc=(0, 0, 0), rot=(0, 0, 0), scale=1.0, m=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=64, ring_count=32, location=loc); k = bpy.context.object
    k.scale = (1.0 * scale, 0.42 * scale, 0.36 * scale); bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bd = k.modifiers.new('bend', 'SIMPLE_DEFORM'); bd.deform_method = 'BEND'; bd.angle = math.radians(150); bd.deform_axis = 'Z'
    ta = k.modifiers.new('taper', 'SIMPLE_DEFORM'); ta.deform_method = 'TAPER'; ta.factor = 0.25; ta.deform_axis = 'X'
    obj_apply(k); bpy.ops.object.shade_smooth()
    k.rotation_euler = rot
    if m: k.data.materials.append(m)
    return k

def kernel_mat():
    m = mat('kernel', '#E9C27A', rough=0.48, coat=0.12)
    n, L, b = nodes(m)
    b.inputs['Subsurface Weight'].default_value = 0.25; b.inputs['Subsurface Radius'].default_value = (0.3, 0.2, 0.1)
    no = n.new('ShaderNodeTexNoise'); no.inputs['Scale'].default_value = 7; no.inputs['Detail'].default_value = 8
    cr = n.new('ShaderNodeValToRGB'); cr.color_ramp.elements[0].color = lin('#F1D49A'); cr.color_ramp.elements[1].color = lin('#C98E45')
    L.new(no.outputs['Fac'], cr.inputs['Fac']); L.new(cr.outputs['Color'], b.inputs['Base Color'])
    bp = n.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = 0.15; L.new(no.outputs['Fac'], bp.inputs['Height']); L.new(bp.outputs['Normal'], b.inputs['Normal'])
    return m

if want('kernel'):
    for name, rot in (('kernel-a', (math.radians(20), math.radians(-15), math.radians(-25))), ('kernel-b', (math.radians(-35), math.radians(30), math.radians(40)))):
        fresh((480, 480), 2.6, samples=128)
        world('#F3EEDF', 0.8)
        light('AREA', 500, (-3, 3, 5), (math.radians(-30), math.radians(-30), 0), size=3, col='#FFF3DC')
        light('AREA', 200, (3, -2, 2), (math.radians(40), math.radians(50), 0), size=2, col='#FFE2B0')
        kernel(rot=rot, m=kernel_mat())
        render(name)

# ---------------------------------------------------------------- jar of kernels
if want('jar'):
    fresh((640, 640), 3.3, samples=160)
    sc = bpy.context.scene; cam = sc.camera; cam.location = (0, -12, 1.35 + 12 * math.tan(math.radians(12))); cam.rotation_euler = (math.radians(78), 0, 0)
    world('#EFEADC', 0.9)
    light('AREA', 700, (-4, -4, 6), (math.radians(40), math.radians(-30), math.radians(-40)), size=4, col='#FFF4E0')
    light('AREA', 300, (4, 3, 4), (math.radians(-40), math.radians(40), 0), size=3, col='#E0ECFF')
    glass = mat('glass', '#FFFFFF', rough=0.02, transmit=1.0, ior=1.5)
    bpy.ops.mesh.primitive_cylinder_add(radius=1.0, depth=2.2, location=(0, 0, 1.1), vertices=96); jar = bpy.context.object
    bpy.ops.object.mode_set(mode='EDIT'); bm = bmesh.from_edit_mesh(jar.data)
    top = [f for f in bm.faces if f.normal.z > 0.9]; bmesh.ops.delete(bm, geom=top, context='FACES'); bmesh.update_edit_mesh(jar.data); bpy.ops.object.mode_set(mode='OBJECT')
    so = jar.modifiers.new('s', 'SOLIDIFY'); so.thickness = 0.05; jb = jar.modifiers.new('bv', 'BEVEL'); jb.width = 0.04; jb.segments = 4; jb.limit_method = 'ANGLE'
    jar.data.materials.append(glass); bpy.ops.object.shade_smooth()
    bpy.ops.mesh.primitive_cylinder_add(radius=1.02, depth=0.32, location=(0, 0, 2.34), vertices=96); lid = bpy.context.object
    lid.modifiers.new('bv', 'BEVEL').width = 0.05; lid.data.materials.append(mat('lid', '#0D5A3B', rough=0.35, coat=0.5)); bpy.ops.object.shade_smooth()
    km = kernel_mat(); random.seed(7)
    for i in range(40):
        layer = i // 8; a = random.uniform(0, 6.28); r = random.uniform(0, 0.66)
        kernel(loc=(r * math.cos(a), r * math.sin(a), 0.14 + layer * 0.17 + random.uniform(0, 0.05)),
               rot=(random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(0, 6.28)), scale=0.3, m=km)
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0)); fl = bpy.context.object; fl.is_shadow_catcher = True
    render('jar')

# ---------------------------------------------------------------- phone frames (screen is see-through)
def phone(name, W, H, R, bezel, body_col, rim_col, rim_metal, cutout):
    view = H + 0.6
    fresh((int((W + 0.6) / view * 1400), 1400), view, samples=96)
    bpy.context.scene.camera.data.sensor_fit = 'VERTICAL'
    world('#D9DEE6', 0.6)
    light('AREA', 900, (-5, 8, 10), (math.radians(-35), math.radians(-25), 0), size=6, col='#FFFFFF')
    light('AREA', 300, (6, -6, 6), (math.radians(40), math.radians(40), 0), size=4, col='#EAF0FF')
    rim = rrect('rim', W, H, R, 0.8, z=0.0, seg=16)
    bv = rim.modifiers.new('bv', 'BEVEL'); bv.width = 0.12; bv.segments = 8; bv.limit_method = 'ANGLE'
    rim.data.materials.append(mat('rim', rim_col, rough=0.28 if rim_metal else 0.55, metal=1.0 if rim_metal else 0.0, aniso=0.4 if rim_metal else 0))
    bpy.ops.object.shade_smooth()
    glassR = R - 0.06
    front = rrect('front', W - 0.12, H - 0.12, glassR, 0.05, z=0.42, seg=16)
    front.data.materials.append(mat('front', '#0A0B0D', rough=0.06, coat=1.0))
    sw, sh, sr = W - 2 * bezel, H - 2 * bezel, max(0.05, R - bezel)
    hole = rrect('screen', sw, sh, sr, 0.02, z=0.46, seg=16); hole.is_holdout = True
    if cutout == 'island':
        isl = rrect('island', 1.25, 0.37, 0.185, 0.02, z=0.48, seg=12); isl.location.y = sh / 2 - 0.45
        isl.data.materials.append(mat('isl', '#050505', rough=0.3))
    else:
        bpy.ops.mesh.primitive_cylinder_add(radius=0.17, depth=0.02, location=(0, sh / 2 - 0.38, 0.48), vertices=48); ph = bpy.context.object
        ph.data.materials.append(mat('cam', '#050505', rough=0.2))
    render(name)
    META[name] = {'w': W + 0.6, 'h': view, 'screen': {'left': (W + 0.6 - sw) / 2 / (W + 0.6) * 100, 'top': (view - sh) / 2 / view * 100,
                  'width': sw / (W + 0.6) * 100, 'height': sh / view * 100, 'radius_pct_w': sr / sw * 100}}

if want('phones'):
    phone('phone-iphone', 7.16, 14.76, 1.1, 0.24, '#111111', '#8E8B86', True, 'island')   # natural titanium rim
    phone('phone-seeker', 7.36, 15.9, 0.9, 0.3, '#111111', '#22252B', False, 'punch')     # matte, Seeker-style

json.dump(META, open(os.path.join(OUT, 'meta.json'), 'w'), indent=1)
print('DONE', META)
