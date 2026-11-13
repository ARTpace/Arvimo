import os
import sys
import traceback


def _args_after_dash():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []



def _import_asset(filepath):
    import bpy
    ext = os.path.splitext(filepath)[1].lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=filepath)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=filepath)
    elif ext == '.obj':
        if bpy.app.version >= (4, 0, 0):
            bpy.ops.wm.obj_import(filepath=filepath)
        else:
            bpy.ops.import_scene.obj(filepath=filepath)
    else:
        raise RuntimeError('Unsupported model format: ' + ext)


def _frame_scene():
    import bpy
    for obj in bpy.context.scene.objects:
        obj.select_set(obj.type in {'MESH', 'ARMATURE', 'EMPTY'})
    view_layer = bpy.context.view_layer
    if bpy.context.selected_objects:
        view_layer.objects.active = bpy.context.selected_objects[0]
    screen = bpy.context.screen
    if screen is None:
        return
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            region = next((r for r in area.regions if r.type == 'WINDOW'), None)
            space = next((s for s in area.spaces if s.type == 'VIEW_3D'), None)
            if region and space:
                override = {'window': bpy.context.window, 'screen': bpy.context.screen, 'area': area, 'region': region, 'space_data': space}
                try:
                    with bpy.context.temp_override(**override):
                        bpy.ops.view3d.view_selected(use_all_regions=False)
                except Exception:
                    pass


def main():
    args = _args_after_dash()
    if not args:
        raise RuntimeError('Missing model path')
    filepath = os.path.abspath(args[0])
    if not os.path.exists(filepath):
        raise RuntimeError('Model file not found: ' + filepath)
    _import_asset(filepath)
    _frame_scene()


try:
    main()
except Exception:
    traceback.print_exc()
    raise
