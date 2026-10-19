"""
AssetVault Blender Bridge

Drop this file into Blender's scripts/startup directory (AssetVault does this
best-effort automatically). It starts a localhost-only TCP listener so the
AssetVault desktop library can import downloaded GLB/glTF/FBX files into the
currently open Blender scene without launching a second Blender instance, and
can build a Principled BSDF material out of a downloaded PBR texture set.
"""
import json
import os
import queue
import socket
import sys
import threading
import traceback

HOST = "127.0.0.1"
PORT = int(os.environ.get("SFX_BLENDER_BRIDGE_PORT", "47752"))
MAX_LINE = 1024 * 1024

_tasks = queue.Queue()
_health_ticks = 0

# 状态必须挂在 sys 上，不能放在模块全局：
#  1) 幂等标记放 bpy.app 上会直接抛 AttributeError（C 扩展对象没有 __dict__）；
#  2) 模块全局会在 Blender 执行 Reload Scripts（importlib.reload 会重新执行本文件）
#     时被重新初始化，socket 引用一旦丢失就会被 GC 关掉，端口随即消失。
_listener_flag = "_assetvault_bridge_listener"
_timer_flag = "_assetvault_bridge_timer"


def _current_listener():
    """返回仍然可用的监听 socket；没有则返回 None。"""
    sock = getattr(sys, _listener_flag, None)
    if sock is None:
        return None
    try:
        if sock.fileno() < 0:
            return None
    except Exception:
        return None
    return sock


def _send(conn, payload):
    """发送一行 JSON 后关闭连接。绝不向外抛异常。

    Blender 会把「抛出未捕获异常的 timer 函数」自动注销掉，所以这里一旦漏出
    异常（比如客户端提前断开导致 sendall 失败），整个桥接就会永久失效。
    """
    try:
        conn.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        return True
    except Exception:
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _read_line(conn):
    chunks = []
    total = 0
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if b"\n" in chunk:
            break
        if total > MAX_LINE:
            raise RuntimeError("Request too large")
    raw = b"".join(chunks).split(b"\n", 1)[0]
    if not raw:
        raise RuntimeError("Empty request")
    return json.loads(raw.decode("utf-8"))


def _import_asset(filepath, frame=True):
    import bpy

    filepath = os.path.abspath(filepath)
    if not os.path.exists(filepath):
        raise RuntimeError("Model file not found: " + filepath)
    ext = os.path.splitext(filepath)[1].lower()
    before = set(bpy.data.objects)
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=filepath)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=filepath)
    else:
        raise RuntimeError("Unsupported model format: " + ext)

    imported = [obj for obj in bpy.data.objects if obj not in before]
    for obj in bpy.context.scene.objects:
        obj.select_set(False)
    for obj in imported:
        obj.select_set(True)
    if imported:
        bpy.context.view_layer.objects.active = imported[0]
    if frame:
        _frame_selected()
    return {"ok": True, "file": filepath, "imported": len(imported)}


# ── 材质导入 ──────────────────────────────────────────────────────────────
# 服务端已经把贴图按 map 名解析成绝对路径发过来，这里只管按 PBR 惯例接进
# Principled BSDF。两处最容易出错的地方都写死在下面：
#   1) 非颜色贴图（roughness/normal/displacement…）必须设 Non-Color，
#      否则 Blender 按 sRGB 解读，粗糙度和法线全是错的；
#   2) NormalDX 是 DirectX 约定，与 Blender 的 OpenGL 约定绿通道相反，
#      直接接会让凹凸反凹，所以走一条 Separate/Flip/Combine 的翻转链。
_SLOT_SOCKETS = {
    "baseColor": ("Base Color",),
    "roughness": ("Roughness",),
    "metalness": ("Metallic",),
    "alpha": ("Alpha",),
    "emission": ("Emission Color", "Emission"),
}

# 贴图节点按顺序纵向错开，全叠在 (-700, 300) 会糊成一坨没法看线。
_TEXTURE_ROW = {"cursor": 0}


def _next_texture_slot():
    row = _TEXTURE_ROW["cursor"]
    _TEXTURE_ROW["cursor"] = row + 1
    return row


def _principled(mat):
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    node = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    output = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if output:
        mat.node_tree.links.new(node.outputs[0], output.inputs["Surface"])
    return node


def _image(filepath, non_color):
    import bpy

    image = bpy.data.images.load(filepath, check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    return image


def _texture_node(mat, filepath, non_color=True, location=None):
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = _image(filepath, non_color)
    if location is None:
        row = _next_texture_slot()
        location = (-760, 460 - row * 300)
    node.location = location
    node.width = 240
    return node


def _set_input(bsdf, slot, value):
    for name in _SLOT_SOCKETS.get(slot, ()):
        socket = bsdf.inputs.get(name)
        if socket is not None:
            socket.default_value = value
            return True
    return False


def _plug(mat, node, bsdf, slot):
    socket = None
    for name in _SLOT_SOCKETS.get(slot, ()):
        socket = bsdf.inputs.get(name)
        if socket is not None:
            break
    if socket is None:
        return False
    mat.node_tree.links.new(node.outputs["Color"], socket)
    return True


def _connect_normal(mat, filepath, bsdf, directx):
    """法线贴图接进 Normal Map 节点；DirectX 需要翻转绿通道。"""
    tex = _texture_node(mat, filepath, non_color=True)
    tex.location = (-1080, 460 - _next_texture_slot() * 300)
    normal_map = mat.node_tree.nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-560, tex.location.y)
    source = tex.outputs["Color"]
    if directx:
        separate = mat.node_tree.nodes.new("ShaderNodeSeparateColor")
        separate.location = (tex.location.x + 210, tex.location.y)
        invert = mat.node_tree.nodes.new("ShaderNodeInvert")
        invert.location = (tex.location.x + 390, tex.location.y - 120)
        combine = mat.node_tree.nodes.new("ShaderNodeCombineColor")
        combine.location = (tex.location.x + 550, tex.location.y)
        links = mat.node_tree.links
        links.new(source, separate.inputs[0])
        links.new(separate.outputs["Green"], invert.inputs[0])
        links.new(separate.outputs["Red"], combine.inputs["Red"])
        links.new(invert.outputs[0], combine.inputs["Green"])
        links.new(separate.outputs["Blue"], combine.inputs["Blue"])
        source = combine.outputs[0]
    mat.node_tree.links.new(source, normal_map.inputs["Color"])
    socket = bsdf.inputs.get("Normal")
    if socket is None:
        return False
    mat.node_tree.links.new(normal_map.outputs["Normal"], socket)
    return True


def _multiply_ao(mat, bsdf, ao_node):
    """AO 在 Blender 里没有独立输入槽，按惯例乘进 Base Color。

    Base Color 往往已经被颜色贴图占用，而 links.new 对单输入接口是「顶掉旧
    连接」而不是「追加」。所以必须先把原来源改接到 Color1，否则颜色贴图会被
    静默踢下线，基础色只剩 AO 乘白 —— 表现为颜色贴图「接上了又好像没接」。
    """
    base = bsdf.inputs.get("Base Color")
    if base is None:
        return False
    mix = mat.node_tree.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MULTIPLY"
    mix.inputs["Fac"].default_value = 1.0
    mix.location = (-360, 420)
    existing = base.links[0].from_socket if base.is_linked else None
    if existing is not None:
        mat.node_tree.links.new(existing, mix.inputs["Color1"])
    else:
        mix.inputs["Color1"].default_value = base.default_value
    mat.node_tree.links.new(ao_node.outputs["Color"], mix.inputs["Color2"])
    mat.node_tree.links.new(mix.outputs["Color"], base)
    return True


def _connect_displacement(mat, filepath, bsdf):
    """高度图接进置换。

    Blender 4.1 起 Principled BSDF 上的 Displacement 输入被移除，改成由
    Material Output 的 Displacement 接口驱动，配 mat.displacement_method 开关；
    4.0 及更早仍是 BSDF 上的输入口。两边都试一遍，否则贴图节点会被建出来
    却悬在半空（就是「高度贴图没接上」的成因）。
    """
    tex = _texture_node(mat, filepath, non_color=True)
    socket = bsdf.inputs.get("Displacement")
    if socket is not None:
        mat.node_tree.links.new(tex.outputs["Color"], socket)
    else:
        output = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
        socket = output.inputs.get("Displacement") if output else None
        if socket is None:
            return False
        mat.node_tree.links.new(tex.outputs["Color"], socket)
        output.location = (320, -220)
    # BUMP 只需法线、不动顶点，不细分网格也能立刻看到高度带来的明暗。
    for method in ("BUMP", "DISPLACEMENT", "BOTH"):
        try:
            mat.displacement_method = method
            break
        except TypeError:
            continue
    return True


def _preview_ball(mat):
    """没有选中物体就丢一个预览球进去：有材质没物体等于什么都看不见。"""
    import bpy

    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=1.0, location=(0, 0, 0))
    ball = bpy.context.active_object
    ball.name = mat.name + " 预览球"
    ball.data.materials.clear()
    ball.data.materials.append(mat)
    for poly in ball.data.polygons:
        poly.use_smooth = True
    return ball


def _import_material(request):
    import bpy

    maps = request.get("maps") or {}
    name = str(request.get("name") or "PBR 材质").strip()[:120]
    missing = [slot for slot, path in maps.items() if not path or not os.path.exists(str(path))]
    maps = {slot: str(path) for slot, path in maps.items() if path and os.path.exists(str(path))}
    if not maps:
        raise RuntimeError("没有可用的贴图：服务端发来的路径全部不存在")

    existing = bpy.data.materials.get(name)
    if existing is not None:
        mat = existing
        mat.use_nodes = True
        mat.node_tree.nodes.clear()
        # 复用同名材质时不能留旧节点，但输出节点必须重建，否则材质渲染不出来。
        output = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
        output.location = (260, 0)
        bsdf = _principled(mat)
    else:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = _principled(mat)

    connected = []
    _TEXTURE_ROW["cursor"] = 0
    if "baseColor" in maps and _plug(mat, _texture_node(mat, maps["baseColor"], non_color=False), bsdf, "baseColor"):
        connected.append("baseColor")
    for slot, source in (("roughness", "roughness"), ("metalness", "metalness")):
        if source in maps and _plug(mat, _texture_node(mat, maps[source]), bsdf, slot):
            connected.append(slot)
    if "opacity" in maps:
        tex = _texture_node(mat, maps["opacity"], non_color=False)
        if _plug(mat, tex, bsdf, "alpha"):
            try:
                mat.blend_method = "BLEND"
            except (AttributeError, TypeError):
                pass
            connected.append("alpha")
    if "displacement" in maps and _connect_displacement(mat, maps["displacement"], bsdf):
        connected.append("displacement")
    if "emission" in maps and _plug(mat, _texture_node(mat, maps["emission"]), bsdf, "emission"):
        connected.append("emission")
    # 法线：优先 OpenGL 约定，DirectX 只在缺 GL 时才用。
    normal_slot = "normal" if "normal" in maps else ("normalDX" if "normalDX" in maps else None)
    if normal_slot and _connect_normal(mat, maps[normal_slot], bsdf, directx=normal_slot == "normalDX"):
        connected.append("normal" + ("DX" if normal_slot == "normalDX" else ""))
    # AO 必须最后做：它会重写 Base Color 的上游链接。
    if "ao" in maps and _multiply_ao(mat, bsdf, _texture_node(mat, maps["ao"])):
        connected.append("ao")

    applied = None
    if request.get("assignSelection"):
        targets = [obj for obj in bpy.context.selected_objects if obj.type == "MESH"]
        if targets:
            for obj in targets:
                obj.data.materials.clear()
                obj.data.materials.append(mat)
            applied = "selection"
        else:
            ball = _preview_ball(mat)
            bpy.context.view_layer.objects.active = ball
            applied = "preview"
    if applied == "preview":
        _frame_selected()
    return {"ok": True, "material": mat.name, "maps": connected, "applied": applied}


def _import_environment(filepath):
    """把 HDRI 设为当前场景的世界环境（World → Environment Texture）。

    Poly Haven 的 HDRI 交付物是单个 .hdr/.exr，没有网格可导。Blender 的
    世界节点默认可能没启用节点树，这里直接重建一张最小节点图：
    Environment Texture → Background → World Output，强度保持 1.0。
    """
    import bpy

    filepath = os.path.abspath(filepath)
    if not os.path.exists(filepath):
        raise RuntimeError("HDRI file not found: " + filepath)
    ext = os.path.splitext(filepath)[1].lower()
    if ext not in (".hdr", ".exr", ".png", ".jpg", ".jpeg"):
        raise RuntimeError("Unsupported environment format: " + ext)
    image = bpy.data.images.load(filepath, check_existing=True)
    # .hdr/.exr 是线性数据，Blender 载入时自动用 Linear 色彩空间，不要碰 colorspace；
    # 但 PNG/JPG 是 LDR 图像，必须显式设成 sRGB，否则天空盒会明显偏暗/偏色。
    if ext in (".png", ".jpg", ".jpeg"):
        try:
            image.colorspace_settings.name = "sRGB"
        except Exception:
            pass

    world = bpy.context.scene.world
    if world is None:
        world = bpy.data.worlds.new("AssetVault HDRI")
        bpy.context.scene.world = world
    world.use_nodes = True
    tree = world.node_tree
    tree.nodes.clear()
    tex = tree.nodes.new("ShaderNodeTexEnvironment")
    tex.location = (-420, 0)
    tex.image = image
    bg = tree.nodes.new("ShaderNodeBackground")
    bg.location = (-140, 0)
    bg.inputs["Strength"].default_value = 1.0
    out = tree.nodes.new("ShaderNodeOutputWorld")
    out.location = (120, 0)
    tree.links.new(tex.outputs["Color"], bg.inputs["Color"])
    tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return {"ok": True, "file": filepath, "world": world.name, "image": image.name}


def _frame_selected():
    import bpy

    screen = bpy.context.screen
    if screen is None or not bpy.context.selected_objects:
        return
    for area in screen.areas:
        if area.type != "VIEW_3D":
            continue
        region = next((r for r in area.regions if r.type == "WINDOW"), None)
        space = next((s for s in area.spaces if s.type == "VIEW_3D"), None)
        if not region or not space:
            continue
        override = {
            "window": bpy.context.window,
            "screen": bpy.context.screen,
            "area": area,
            "region": region,
            "space_data": space,
        }
        try:
            with bpy.context.temp_override(**override):
                bpy.ops.view3d.view_selected(use_all_regions=False)
        except Exception:
            pass


def _process_tasks():
    """bpy 只能在主线程操作，所以由 Blender 的 timer 回调驱动。

    这个函数绝不能向外抛异常：Blender 会注销出错的 timer，一次意外就永久失去桥接。
    """
    global _health_ticks

    # 周期性体检：Blender 执行 Reload Scripts 或插件重置时可能把监听 socket
    # 连对象一起销毁，端口就悄悄没了。这里发现丢失就自动重建，无需用户干预。
    _health_ticks += 1
    if _health_ticks >= 25:  # 约 5 秒（本回调每次返回 0.2 秒）
        _health_ticks = 0
        if _current_listener() is None:
            print("AssetVault Blender Bridge: listener lost, rebinding on %s:%s" % (HOST, PORT))
            start_bridge()

    while True:
        try:
            conn, req = _tasks.get_nowait()
        except queue.Empty:
            break
        except Exception:
            traceback.print_exc()
            break
        try:
            op = req.get("op")
            if op == "ping":
                _send(conn, {"ok": True, "app": "blender", "bridge": "assetvault", "version": 1})
            elif op == "import":
                _send(conn, _import_asset(req.get("file", ""), bool(req.get("frame", True))))
            elif op == "material":
                _send(conn, _import_material(req))
            elif op == "environment":
                _send(conn, _import_environment(req.get("file", "")))
            else:
                raise RuntimeError("Unsupported operation: " + str(op))
        except Exception as exc:
            traceback.print_exc()
            _send(conn, {"ok": False, "error": str(exc)})
    return 0.2


def _server_thread(sock):
    """只用一个后台线程串行处理连接。

    不要为每个连接再新建线程：某些 Blender 插件（例如 BlenderGIS）会
    monkey-patch threading.Thread，嵌套创建线程会和它们冲突（实测会让
    Blender 抛出 RecursionError 并直接崩溃）。桥接只服务于 AssetVault 的
    单次导入请求，串行处理完全够用。
    """
    while True:
        try:
            conn, addr = sock.accept()
        except OSError:
            break
        except Exception:
            traceback.print_exc()
            continue
        if addr[0] not in ("127.0.0.1", "::1"):
            try:
                conn.close()
            except Exception:
                pass
            continue
        try:
            # 客户端连上却不发数据时不能把线程卡死。
            conn.settimeout(5.0)
            req = _read_line(conn)
            _tasks.put((conn, req))
        except Exception as exc:
            _send(conn, {"ok": False, "error": str(exc)})


def start_bridge():
    # 已经有一个活着的监听就什么都不做；否则（首次加载，或模块被 reload 导致
    # socket 丢失）重新绑定，让桥接能自愈。
    if _current_listener() is not None:
        return
    setattr(sys, _listener_flag, None)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((HOST, PORT))
        sock.listen(8)
    except OSError as exc:
        # 端口被占用时不保留状态，这样下一次加载还有机会重试。
        print("AssetVault Blender Bridge: could not listen on %s:%s: %s" % (HOST, PORT, exc))
        try:
            sock.close()
        except Exception:
            pass
        return

    setattr(sys, _listener_flag, sock)
    threading.Thread(target=_server_thread, args=(sock,), daemon=True).start()

    try:
        import bpy

        # reload 后模块被重新执行，这会得到一个新的函数对象；旧的 timer 还指着
        # 旧函数（队列已失效），所以要先注销再注册，避免留下空转的 timer。
        previous = getattr(sys, _timer_flag, None)
        if previous is not None:
            try:
                if bpy.app.timers.is_registered(previous):
                    bpy.app.timers.unregister(previous)
            except Exception:
                pass
        bpy.app.timers.register(_process_tasks, persistent=True)
        setattr(sys, _timer_flag, _process_tasks)
    except Exception:
        traceback.print_exc()

    print("AssetVault Blender Bridge listening on %s:%s" % (HOST, PORT))


def register():
    """Blender 会把 scripts/startup 下的脚本也当作可注册脚本扫描，
    补上 register/unregister 可以消掉那条 "has no register function" 警告。"""
    start_bridge()


def unregister():
    """刻意留空。

    桥接的生命周期应当绑定 Blender 进程本身，而不是 addon 的启用状态。
    Blender 执行 Reload Scripts 时会对每个脚本走一遍 unregister/register，
    如果在这里关闭监听 socket，刚 reload 完桥接就会掉线（端口消失）。
    addon_utils 只要求这个函数存在，并不要求它做清理。
    """
    return


start_bridge()
