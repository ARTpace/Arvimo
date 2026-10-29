"""Run with Houdini's hython. Uses an isolated headless scene, never the user's open scene."""
import importlib.util
import os
import tempfile
import hou

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('assetvault_receiver', os.path.join(root, 'server', 'dcc-receiver.py'))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
with tempfile.TemporaryDirectory(prefix='assetvault-houdini-') as directory:
    obj = os.path.join(directory, 'triangle.obj')
    with open(obj, 'w') as stream:
        stream.write('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
    imported = receiver.import_model('houdini', obj, 'Triangle')
    node = hou.node(imported)
    assert len(node.displayNode().geometry().prims()) == 1
    assert len(node.displayNode().geometry().points()) == 3
    print('PASS: native Houdini OBJ import created real geometry:', imported)
