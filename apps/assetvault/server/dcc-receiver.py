# coding: utf-8
"""One-shot asset importer, loaded inside the target DCC, never in a standalone Python.

Design references and upstream notices: docs/dcc-import.md.
Only the host's main-thread callback modifies the scene. No live scene synchronization.
"""
import builtins
import json
import os
import re
import time
import traceback


def import_model(target, file, name):
    if not os.path.isfile(file) or os.path.splitext(file)[1].lower() not in ('.fbx', '.obj'):
        raise RuntimeError('找不到可导入的 FBX 或 OBJ 文件')
    if target == 'maya':
        import maya.cmds as cmds
        fbx = file.lower().endswith('.fbx')
        plugin = 'fbxmaya' if fbx else 'objExport'
        if not cmds.pluginInfo(plugin, query=True, loaded=True):
            cmds.loadPlugin(plugin)
        namespace = 'AssetVault_' + str(int(time.time() * 1000))
        nodes = cmds.file(file, i=True, type='FBX' if fbx else 'OBJ',
                          namespace=namespace, returnNewNodes=True)
        if not nodes:
            raise RuntimeError('导入器没有创建任何场景对象')
        return namespace
    if target == '3dsmax':
        from pymxs import runtime as rt
        before = set(int(rt.getHandleByAnim(obj)) for obj in rt.objects)
        rt.importFile(file, rt.Name('noPrompt'))
        imported = [obj for obj in rt.objects if int(rt.getHandleByAnim(obj)) not in before]
        if not imported:
            raise RuntimeError('导入器没有创建任何场景对象，请检查 FBX/OBJ 导入插件')
        rt.select(imported)
        rt.redrawViews()
        return str(len(imported)) + ' 个对象'
    if target == 'houdini':
        import hou
        if file.lower().endswith('.fbx'):
            result = hou.hipFile.importFBX(file, import_into_object_subnet=True)
            node = result[0]
            if node is None:
                raise RuntimeError('Houdini 没有创建 FBX 对象')
        else:
            node = hou.node('/obj').createNode('geo', 'AssetVault')
            reader = node.createNode('file', 'imported_asset')
            reader.parm('file').set(file.replace('\\', '/'))
            reader.setDisplayFlag(True)
            reader.setRenderFlag(True)
            reader.cook(force=True)
            if reader.errors():
                raise RuntimeError('；'.join(reader.errors()))
        node.moveToGoodPosition()
        node.setSelected(True, clear_all_selected=True)
        return node.path()
    if target == 'c4d':
        import c4d
        doc = c4d.documents.GetActiveDocument()
        # Same native merge route used by Megascans LiveLink for Cinema 4D.
        before = doc.GetObjects()
        flags = c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS
        if not c4d.documents.MergeDocument(doc, file, flags, None):
            raise RuntimeError('Cinema 4D 导入器无法读取该模型')
        imported = [obj for obj in doc.GetObjects() if obj not in before]
        if not imported:
            raise RuntimeError('导入器没有创建任何场景对象')
        c4d.EventAdd()
        return str(len(imported)) + ' 个对象'
    raise RuntimeError('不支持的目标软件')


class Receiver:
    def __init__(self, target, queue):
        self.target = target
        self.queue = queue
        self.last_heartbeat = 0
        self.busy = False
        os.makedirs(queue, exist_ok=True)

    def write(self, filename, payload):
        path = os.path.join(self.queue, filename)
        temporary = path + '.part'
        with open(temporary, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False)
        os.replace(temporary, path)

    def tick(self, *unused):
        if self.busy:
            return
        now = time.time() * 1000
        if now - self.last_heartbeat >= 2000:
            self.write('status-%s.json' % os.getpid(),
                       {'pid': os.getpid(), 'target': self.target, 'at': now})
            self.last_heartbeat = now
        for filename in sorted(os.listdir(self.queue)):
            if not re.match(r'^[0-9a-f-]{36}\.request\.json$', filename):
                continue
            path = os.path.join(self.queue, filename)
            try:
                with open(path, encoding='utf-8') as stream:
                    request = json.load(stream)
                if request.get('session') != os.getpid() or request.get('target') != self.target:
                    continue
                if request.get('expiresAt', 0) < now:
                    os.unlink(path)
                    continue
                claimed = path + '.processing'
                os.replace(path, claimed)
            except (OSError, ValueError):
                continue
            self.busy = True
            try:
                detail = import_model(self.target, request.get('file', ''), request.get('name', 'AssetVault'))
                result = {'ok': True, 'detail': detail}
            except Exception as error:
                with open(os.path.join(self.queue, 'receiver.log'), 'a', encoding='utf-8') as stream:
                    stream.write(traceback.format_exc() + '\n')
                result = {'ok': False, 'error': str(error)}
            finally:
                self.busy = False
                try:
                    os.unlink(claimed)
                except OSError:
                    pass
            self.write(filename.replace('.request.json', '.response.json'), result)
            break


def start(target, queue):
    key = '_assetvault_receiver_' + target
    if getattr(builtins, key, None):
        return
    receiver = Receiver(target, queue)
    if target == 'maya':
        import maya.utils
        import maya.cmds as cmds
        # Startup imports may run before Maya's UI is ready.
        maya.utils.executeDeferred(lambda: cmds.scriptJob(event=['idle', receiver.tick], protected=True))
    elif target == '3dsmax':
        try:
            from PySide6.QtCore import QTimer
        except ImportError:
            from PySide2.QtCore import QTimer
        timer = QTimer()
        timer.timeout.connect(receiver.tick)
        timer.start(250)
        receiver.timer = timer
    elif target == 'houdini':
        import hou
        if not hou.isUIAvailable():
            return
        hou.ui.addEventLoopCallback(receiver.tick)
    elif target == 'c4d':
        import c4d

        class ImportTimer(c4d.plugins.MessageData):
            def GetTimer(self):
                return 250

            def CoreMessage(self, message_id, data):
                if message_id == c4d.MSG_TIMER:
                    receiver.tick()
                return True

        # Local development ID; obtain a Maxon Plugin ID before distributing a packaged C4D plugin.
        plugin_id = int(os.environ.get('ASSETVAULT_C4D_PLUGIN_ID', '1000001'))
        if not c4d.plugins.RegisterMessagePlugin(plugin_id, 'AssetVault Import', 0, ImportTimer()):
            raise RuntimeError('AssetVault 插件编号被占用，请设置 ASSETVAULT_C4D_PLUGIN_ID')
    else:
        raise RuntimeError('不支持的目标软件')
    setattr(builtins, key, receiver)
    receiver.tick()


if 'ASSETVAULT_TARGET' in globals():
    start(ASSETVAULT_TARGET, ASSETVAULT_QUEUE)
