import importlib.util
import json
import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('dcc_receiver', Path(__file__).resolve().parents[1] / 'server' / 'dcc-receiver.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='assetvault-receiver-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.receiver = module.Receiver('maya', self.temp.name)

    def request(self, **changes):
        request = dict(id=str(uuid.uuid4()), target='maya', session=os.getpid(),
                       file='asset.fbx', name='Asset', expiresAt=time.time() * 1000 + 5000)
        request.update(changes)
        path = self.directory / (request['id'] + '.request.json')
        path.write_text(json.dumps(request), encoding='utf-8')
        return path

    def test_only_matching_session_imports_and_acknowledges(self):
        ignored = self.request(session=-1)
        wanted = self.request()
        with patch.object(module, 'import_model', return_value='new_scene_object') as importer:
            self.receiver.tick()
        importer.assert_called_once_with('maya', 'asset.fbx', 'Asset')
        result = json.loads(wanted.with_name(wanted.name.replace('.request.', '.response.')).read_text(encoding='utf-8'))
        self.assertTrue(result['ok'])
        self.assertEqual(result['detail'], 'new_scene_object')
        self.assertTrue(ignored.exists())
        self.assertFalse(wanted.exists())

    def test_expired_tasks_never_import_later(self):
        expired = self.request(expiresAt=0)
        with patch.object(module, 'import_model') as importer:
            self.receiver.tick()
        importer.assert_not_called()
        self.assertFalse(expired.exists())

    def test_native_import_failure_is_returned_and_original_trace_is_logged(self):
        task = self.request()
        with patch.object(module, 'import_model', side_effect=RuntimeError('native importer rejected file')):
            self.receiver.tick()
        result = json.loads(task.with_name(task.name.replace('.request.', '.response.')).read_text(encoding='utf-8'))
        self.assertFalse(result['ok'])
        self.assertIn('native importer rejected file', result['error'])
        self.assertIn('RuntimeError', (self.directory / 'receiver.log').read_text(encoding='utf-8'))
        self.assertFalse(list(self.directory.glob('*.processing')))

    def test_import_rejects_non_model_files_before_calling_any_host_api(self):
        script = self.directory / 'untrusted.py'
        script.write_text('raise Exception("must never run")', encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'FBX 或 OBJ'):
            module.import_model('maya', str(script), 'Not a model')


if __name__ == '__main__':
    unittest.main()
