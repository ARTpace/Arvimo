"""给 .blend / .usd* 生成封面用的 Blender 脚本（无界面、Cycles CPU、512px 透明底）。

由 server/blender-thumb.mjs 调用，命令行固定形态：

    blender -b --factory-startup --python-exit-code 1 -P blender-thumb.py -- \
        --input <模型或工程文件> --out <png> [--size 512]

几条必须遵守的约束（都是踩过的坑）：
  · 不用文件里自带的相机 —— 工程文件的相机常常对着空处，甚至指向背后。
  · 打开 .blend 时 use_scripts=False —— 否则文件里的自动运行脚本会被执行。
  · 打开后先切 object 模式 —— 存在 edit/sculpt/pose 模式的工程会让 select_all 之类的算子失败。
  · 用 Cycles CPU —— 后台模式下的 EEVEE 需要可用的 GPU 离屏上下文，换台机器就可能渲染不出来。
"""
import json
import math
import sys

import bpy
from mathutils import Vector

FOV_DEGREES = 38.0
VIEW_DIRECTION = (1.15, 0.95, 1.45)  # 3/4 视角：右前上方
MARGIN = 1.06


def fail(message):
    print(json.dumps({"ok": False, "error": str(message)}))
    sys.exit(1)


def parse_args():
    argv = sys.argv
    if "--" not in argv:
        fail("缺少 -- 之后的参数")
    rest = argv[argv.index("--") + 1:]
    args = {"input": "", "out": "", "size": 512}
    i = 0
    while i < len(rest):
        key = rest[i]
        value = rest[i + 1] if i + 1 < len(rest) else ""
        if key == "--input":
            args["input"] = value
            i += 2
        elif key == "--out":
            args["out"] = value
            i += 2
        elif key == "--size":
            try:
                args["size"] = max(64, min(1024, int(value)))
            except ValueError:
                args["size"] = 512
            i += 2
        else:
            i += 1
    return args


def clear_scene():
    if bpy.ops.object.mode_set.poll():
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except RuntimeError:
            pass
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def import_file(path):
    lower = path.lower()
    if lower.endswith(".blend"):
        # 不加载界面、不执行文件内脚本，然后清掉别人工程里的相机与灯，统一用自己的布光。
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)
        for ob in list(bpy.context.scene.objects):
            if ob.type in {"CAMERA", "LIGHT"}:
                bpy.data.objects.remove(ob, do_unlink=True)
        return

    clear_scene()
    if lower.endswith((".glb", ".gltf")):
        bpy.ops.import_scene.gltf(filepath=path)
    elif lower.endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=path)
    elif lower.endswith(".usd") or lower.endswith(".usda") or lower.endswith(".usdc") or lower.endswith(".usdz"):
        if not hasattr(bpy.ops.wm, "usd_import"):
            fail("这个 Blender 构建没有 USD 导入器")
        bpy.ops.wm.usd_import(filepath=path)
    elif lower.endswith(".obj"):
        bpy.ops.wm.obj_import(filepath=path)
    elif lower.endswith(".stl"):
        bpy.ops.wm.stl_import(filepath=path)
    elif lower.endswith(".ply"):
        bpy.ops.wm.ply_import(filepath=path)
    else:
        fail(f"这个格式没有可用的导入器：{path.rsplit('.', 1)[-1]}")


def mesh_objects():
    return [ob for ob in bpy.context.scene.objects if ob.type == "MESH" and not ob.hide_render]


def ensure_object_mode():
    try:
        if bpy.context.object and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
    except RuntimeError:
        pass


def ensure_material(meshes):
    """没有材质的网格（STL / PLY / 部分 USD）渲出来是纯黑，补一个中性灰。"""
    grey = None
    for ob in meshes:
        if ob.material_slots and any(slot.material for slot in ob.material_slots):
            continue
        if grey is None:
            grey = bpy.data.materials.new("AV_Cover_Grey")
            grey.use_nodes = True
            shader = grey.node_tree.nodes.get("Principled BSDF")
            if shader:
                shader.inputs["Base Color"].default_value = (0.72, 0.72, 0.74, 1.0)
                shader.inputs["Roughness"].default_value = 0.55
        ob.data.materials.append(grey)


def world_corners(meshes):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for ob in meshes:
        evaluated = ob.evaluated_get(depsgraph)
        matrix = evaluated.matrix_world
        for corner in evaluated.bound_box:
            points.append(matrix @ Vector(corner))
    return points


def bounds(points):
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi, (lo + hi) * 0.5


def frame_camera(center, points):
    view = Vector(VIEW_DIRECTION).normalized()
    world_up = Vector((0.0, 0.0, 1.0))
    right = world_up.cross(view).normalized()
    up = view.cross(right).normalized()
    tan = math.tan(math.radians(FOV_DEGREES * 0.5))
    distance = 0.0
    for point in points:
        offset = point - center
        depth = offset.dot(view)
        distance = max(
            distance,
            depth + abs(offset.dot(right)) / tan,
            depth + abs(offset.dot(up)) / tan,
        )
    distance = max(distance * MARGIN, 1e-4)

    camera_data = bpy.data.cameras.new("AV_Cover_Camera")
    camera_data.angle = math.radians(FOV_DEGREES)
    camera_data.lens_unit = "FOV"
    camera_data.clip_start = max(distance * 0.001, 1e-4)
    camera_data.clip_end = distance * 20.0
    camera = bpy.data.objects.new("AV_Cover_Camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = center + view * distance
    camera.rotation_euler = view.to_track_quat("Z", "Y").to_euler()
    bpy.context.scene.camera = camera
    return camera, distance


def add_lights(center, distance):
    """两个方向光当主光 + 补光：强度与模型尺度无关，换大小模型都不用重调。"""
    specs = [
        ("AV_Cover_Key", 3.6, (0.9, 0.6, 1.0)),
        ("AV_Cover_Fill", 1.3, (-1.0, -0.7, 0.35)),
        ("AV_Cover_Rim", 1.1, (-0.2, -0.9, 0.9)),
    ]
    for name, energy, direction in specs:
        light_data = bpy.data.lights.new(name, type="SUN")
        light_data.energy = energy
        light_data.angle = math.radians(12.0)
        light = bpy.data.objects.new(name, light_data)
        bpy.context.scene.collection.objects.link(light)
        pointing = Vector(direction).normalized()
        light.location = center + pointing * distance
        light.rotation_euler = pointing.to_track_quat("Z", "Y").to_euler()

    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("AV_Cover_World")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    if background:
        background.inputs["Color"].default_value = (0.16, 0.17, 0.19, 1.0)
        background.inputs["Strength"].default_value = 0.7


def configure_render(size, out_path):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 40
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.02
    try:
        scene.cycles.use_denoising = True
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
    except (AttributeError, TypeError):
        pass
    scene.render.film_transparent = True
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 20
    # 透明度保持线性，别让 AgX 把白模压成灰。
    try:
        scene.view_settings.view_transform = "Standard"
    except (AttributeError, TypeError):
        pass
    scene.render.filepath = out_path


def main():
    args = parse_args()
    if not args["input"] or not args["out"]:
        fail("必须给 --input 与 --out")

    import_file(args["input"])
    ensure_object_mode()
    meshes = mesh_objects()
    if not meshes:
        fail("文件里没有可渲染的网格")

    ensure_material(meshes)
    points = world_corners(meshes)
    lo, hi, center = bounds(points)
    camera, distance = frame_camera(center, points)
    add_lights(center, distance)
    configure_render(args["size"], args["out"])

    bpy.ops.render.render(write_still=True)
    print(json.dumps({
        "ok": True,
        "objects": len(meshes),
        "size": [args["size"], args["size"]],
        "bounds": [round(v, 4) for v in (hi - lo)],
        "distance": round(distance, 4),
        "camera": [round(v, 4) for v in camera.location],
    }))


try:
    main()
except SystemExit:
    raise
except Exception as error:  # noqa: BLE001 —— 把任何异常都变成可解析的一行 JSON
    fail(f"{type(error).__name__}: {error}")
