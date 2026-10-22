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
import re
import socket
import shutil
import sys
import tempfile
import threading
import traceback
import zipfile

HOST = "127.0.0.1"
PORT = int(os.environ.get("SFX_BLENDER_BRIDGE_PORT", "47752"))
MAX_LINE = 1024 * 1024
BRIDGE_VERSION = 2          # 2 = 多了 HTTP 入口，浏览器（局域网访客）也能把资产送进来
MAX_UPLOAD = 512 * 1024 * 1024

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


def _read_head(conn):
    """读到首个换行为止，返回原始字节（可能已经带上 body 的开头）。

    两个入口共用这一段：JSON 行协议只取首行，HTTP 还要接着把请求头与 body 读满。
    """
    buf = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
        if b"\n" in buf:
            break
        if len(buf) > MAX_LINE:
            raise RuntimeError("Request too large")
    if not buf:
        raise RuntimeError("Empty request")
    return buf


# ---------------------------------------------------------------------------
# HTTP 入口
#
# 桌面版走上面的 JSON 行协议；局域网访客手上只有浏览器，浏览器只会说 HTTP，
# 所以同一个端口额外认一套极简 HTTP：GET /ping 探活、POST /import-upload 直接
# 接收资产 ZIP 并导入。两个协议靠首行区分，互不干扰。
# ---------------------------------------------------------------------------
# 只对私网/本机来源回 CORS：公网网页即使猜到端口也拿不到访问权。
_ORIGIN_RE = re.compile(r"^http://(\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::\d+)?$", re.I)


def _cors_origin(origin):
    origin = (origin or "").strip()
    match = _ORIGIN_RE.match(origin)
    if not match:
        return None
    host = match.group(1).lower()
    if host == "localhost":
        return origin
    try:
        octets = [int(part) for part in host.split(".")]
    except ValueError:
        return None
    if octets[0] in (10, 127):
        return origin
    if octets[0] == 192 and octets[1] == 168:
        return origin
    if octets[0] == 172 and 16 <= octets[1] <= 31:
        return origin
    return None


def _http_reply(conn, status, payload, origin=None):
    """回一个短 JSON 响应后关闭连接。绝不向外抛异常。"""
    try:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        reason = {200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden",
                  404: "Not Found", 405: "Method Not Allowed",
                  500: "Internal Server Error"}.get(status, "OK")
        headers = [
            "HTTP/1.1 %d %s" % (status, reason),
            "Content-Type: application/json; charset=utf-8",
            "Content-Length: %d" % len(body),
            "Connection: close",
            "Cache-Control: no-store",
            "Access-Control-Allow-Origin: " + (origin or "null"),
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: content-type",
            # Chrome 的 Private Network Access：局域网页面访问 127.0.0.1 时要这一条。
            "Access-Control-Allow-Private-Network: true",
        ]
        conn.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("latin-1") + body)
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _read_http(conn, buf):
    """补齐请求头与 body，返回 (method, path, headers, body)。"""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(65536)
        if not chunk:
            raise RuntimeError("连接在请求头结束前断开")
        buf += chunk
        if len(buf) > MAX_LINE:
            raise RuntimeError("请求头过大")
    head, _, body = buf.partition(b"\r\n\r\n")
    lines = head.decode("utf-8", "replace").splitlines()
    if not lines:
        raise RuntimeError("空请求")
    parts = lines[0].split()
    method = parts[0].upper()
    path = parts[1] if len(parts) > 1 else "/"
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length") or 0)
    if length > MAX_UPLOAD:
        raise RuntimeError("上传内容超过 %d MB" % (MAX_UPLOAD // (1024 * 1024)))
    conn.settimeout(120.0)
    while len(body) < length:
        chunk = conn.recv(65536)
        if not chunk:
            break
        body += chunk
    return method, path, headers, body[:length]


def _safe_member(folder, name):
    """把压缩包内的条目限制在解压目录里，挡住 ../ 穿越。"""
    target = os.path.abspath(os.path.join(folder, name))
    root = os.path.abspath(folder) + os.sep
    return target if target.startswith(root) else None


def _pick_model_file(folder):
    """挑压缩包里最该导入的那个：glb/gltf 优先，其次 fbx/obj，同格式取最大的。"""
    order = (".glb", ".gltf", ".fbx", ".obj")
    found = []
    for root, _dirs, files in os.walk(folder):
        for name in files:
            ext = os.path.splitext(name)[1].lower()
            if ext in order:
                full = os.path.join(root, name)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    size = 0
                found.append((order.index(ext), -size, full))
    if not found:
        raise RuntimeError("这个压缩包里没有可导入的模型文件（glb / gltf / fbx / obj）")
    found.sort()
    return found[0][2]


def _stage_upload(body, name):
    """把上传内容落成临时目录，返回主模型文件路径；目录由调用方负责清理。"""
    folder = tempfile.mkdtemp(prefix="assetvault-upload-")
    if body[:4] == b"PK\x03\x04":
        archive = os.path.join(folder, "upload.zip")
        with open(archive, "wb") as handle:
            handle.write(body)
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                if item.is_dir():
                    continue
                target = _safe_member(folder, item.filename)
                if not target:
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with bundle.open(item) as source, open(target, "wb") as dest:
                    shutil.copyfileobj(source, dest)
        try:
            os.remove(archive)
        except OSError:
            pass
    else:
        clean = os.path.basename(name or "upload.bin").replace(os.sep, "_")
        with open(os.path.join(folder, clean), "wb") as handle:
            handle.write(body)
    return folder, _pick_model_file(folder)


def _bridge_info():
    info = {"ok": True, "app": "blender", "bridge": "assetvault",
            "version": BRIDGE_VERSION, "upload": True}
    try:
        import bpy
        info["blender"] = bpy.app.version_string
    except Exception:
        pass
    return info


def _respond(conn, req, payload):
    """按入口协议回话：JSON 行协议还是 HTTP。"""
    if req.get("_http"):
        _http_reply(conn, 200 if payload.get("ok") else 500, payload, req.get("_origin"))
    else:
        _send(conn, payload)


def _handle_http(conn, buf):
    """在 socket 线程里处理 HTTP；需要动 bpy 的动作照样丢给 timer 线程。"""
    origin = None
    try:
        method, path, headers, body = _read_http(conn, buf)
        origin = _cors_origin(headers.get("origin"))
        route = path.split("?", 1)[0]
        if method == "OPTIONS":
            _http_reply(conn, 204, None, origin)
            return
        if method in ("GET", "HEAD") and route == "/ping":
            _http_reply(conn, 200, _bridge_info(), origin)
            return
        if route not in ("/import-upload", "/import"):
            _http_reply(conn, 404, {"ok": False, "error": "未知接口：" + route}, origin)
            return
        if method != "POST":
            _http_reply(conn, 405, {"ok": False, "error": "请使用 POST"}, origin)
            return
        # 没有可信来源的请求不落盘：只有页面才会带私网 Origin，其余一律拒掉。
        if not origin:
            _http_reply(conn, 403, {"ok": False, "error": "来源不受信任"}, None)
            return

        name = ""
        if "?" in path:
            for pair in path.split("?", 1)[1].split("&"):
                key, _, value = pair.partition("=")
                if key == "name":
                    name = value
        try:
            from urllib.parse import unquote
            name = unquote(name)
        except Exception:
            pass

        folder, model = _stage_upload(body, name)
        _tasks.put((conn, {"op": "import", "file": model, "frame": True,
                           "_http": True, "_origin": origin, "_temp": folder}))
    except Exception as exc:
        traceback.print_exc()
        _http_reply(conn, 400, {"ok": False, "error": str(exc)}, origin)


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
    elif ext == ".obj":
        if bpy.app.version >= (4, 0, 0):
            bpy.ops.wm.obj_import(filepath=filepath)
        else:
            bpy.ops.import_scene.obj(filepath=filepath)
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
    # check_existing 可能命中一个已经失效的空壳 datablock（源文件被删/被换过），
    # 此时贴图会静默变成 Blender 的「缺失贴图」洋红——视口里就是一片爆粉的紫。
    # 这里强制重读一次，读不出像素就直接报错，别把一个坏的世界环境留给用户。
    try:
        image.reload()
    except Exception:
        pass
    if not image.size[0] or not image.size[1]:
        raise RuntimeError("HDRI 读不出像素（文件缺失或已损坏）：" + filepath)
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
                _respond(conn, req, {"ok": True, "app": "blender", "bridge": "assetvault", "version": BRIDGE_VERSION})
            elif op == "import":
                _respond(conn, req, _import_asset(req.get("file", ""), bool(req.get("frame", True))))
            elif op == "material":
                _respond(conn, req, _import_material(req))
            elif op == "environment":
                _respond(conn, req, _import_environment(req.get("file", "")))
            else:
                raise RuntimeError("Unsupported operation: " + str(op))
        except Exception as exc:
            traceback.print_exc()
            _respond(conn, req, {"ok": False, "error": str(exc)})
        finally:
            # 浏览器上传的临时目录到此为止，别在用户盘上越攒越多。
            temp = req.get("_temp")
            if temp:
                try:
                    shutil.rmtree(temp, ignore_errors=True)
                except Exception:
                    pass
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
            head = _read_head(conn)
            first = head.split(b"\n", 1)[0].strip()
            if first.split(b" ", 1)[0] in (b"GET", b"POST", b"OPTIONS", b"HEAD", b"PUT", b"DELETE"):
                _handle_http(conn, head)
                continue
            if not first:
                raise RuntimeError("Empty request")
            _tasks.put((conn, json.loads(first.decode("utf-8"))))
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
