import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'verify_delivery.py'
spec = importlib.util.spec_from_file_location('verify_delivery', SCRIPT)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='yuanshu-delivery-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_missing_video_decoder_is_not_a_pass(self):
        file = self.root / 'fake.mp4'
        file.write_bytes(b'not a video')
        with patch.object(verify, 'HAS_CV2', False):
            result = verify.verify_video(str(file))
        self.assertFalse(result['valid'])
        self.assertEqual(result['status'], 'unverified')

    @unittest.skipUnless(verify.HAS_PIL, 'Pillow required')
    def test_truncated_pixels_fail_even_when_header_opens(self):
        file = self.root / 'broken.bmp'
        verify.Image.new('RGB', (100, 100), 'red').save(file)
        file.write_bytes(file.read_bytes()[:100])
        self.assertFalse(verify.verify_image(str(file))['valid'])

    @unittest.skipUnless(verify.HAS_PIL, 'Pillow required')
    def test_real_image_and_expected_dimensions(self):
        file = self.root / 'image.png'
        verify.Image.new('RGB', (40, 60), 'red').save(file)
        self.assertTrue(verify.verify_image(str(file))['valid'])
        result = verify.verify_image(str(file), expected_width=60, expected_height=40)
        self.assertFalse(result['valid'])

    def test_html_static_check_is_not_browser_acceptance(self):
        file = self.root / 'index.html'
        file.write_text('<!DOCTYPE html><html><head><title>T</title></head><body><picture><img src="missing.png"></picture></body></html>')
        result = verify.verify_html(str(file))
        self.assertFalse(result['valid'])
        self.assertIn('missing.png', str(result))

    def test_complete_static_html_is_still_unverified(self):
        file = self.root / 'index.html'
        file.write_text('<!DOCTYPE html><html><head><title>T</title></head><body>OK</body></html>')
        result = verify.verify_html(str(file))
        self.assertEqual(result['status'], 'unverified')
        self.assertFalse(result['valid'])

    @unittest.skipUnless(verify.HAS_PIL, 'Pillow required')
    def test_image_cli_validates_ratio(self):
        file = self.root / 'portrait.png'
        verify.Image.new('RGB', (40, 60), 'red').save(file)
        for ratio, exit_code in [('0.666667', 0), ('1', 1)]:
            proc = subprocess.run([sys.executable, str(SCRIPT), str(file), '--json', '--ratio', ratio], capture_output=True, text=True)
            self.assertEqual(proc.returncode, exit_code, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)[0]['valid'], exit_code == 0)

    def test_cli_empty_directory_or_invalid_file_exit_nonzero(self):
        for target in [self.root, self.root / 'absent.png']:
            proc = subprocess.run([sys.executable, str(SCRIPT), str(target), '--json'], capture_output=True, text=True)
            self.assertNotEqual(proc.returncode, 0)
            json.loads(proc.stdout)

if __name__ == '__main__':
    unittest.main()
