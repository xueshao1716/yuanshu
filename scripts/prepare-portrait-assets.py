"""Prepare this version's generated assets without modifying source images."""
from pathlib import Path
import json
from PIL import Image

root = Path(__file__).resolve().parents[1]
source = root / 'output/imagegen'
target = root / 'frontend/public/portraits'
target.mkdir(parents=True, exist_ok=True)
portrait = Image.open(source / 'yuanshu-staircase-source.png')
portrait.load()
cutout = Image.open(source / 'yuanshu-cutout-green.png')
cutout.load()
# This provider returned real alpha despite the requested green background.
# Preserve it: chroma-keying transparent black would erase the black outfit.
assert cutout.mode == 'RGBA', 'Expected provider-supplied alpha; inspect before converting'
alpha = cutout.getchannel('A')
assert alpha.getextrema() == (0, 255)
transparent = alpha.histogram()[0] / (cutout.width * cutout.height)
assert 0.15 < transparent < 0.95, 'Unexpected alpha coverage'
bounds = alpha.getbbox()
assert bounds
left, top, right, bottom = bounds
margin = 24
crop = (max(0, left-margin), max(0, top-margin), min(cutout.width, right+margin), min(cutout.height, bottom+margin))
cutout = cutout.crop(crop)
cutout.thumbnail((512, 768), Image.Resampling.LANCZOS)
portrait.save(target / 'yuanshu-staircase-v1.webp', quality=88, method=6)
cutout.save(target / 'yuanshu-cutout-v1.webp', quality=90, method=6)
facts = {
    'date': '2026-09-26', 'provider': 'aieyra-image',
    'requestedModel': 'gpt-image-2.5-sunburst',
    'variant': 'Fully covered black outfit and flat shoes; not the original clothing specification.',
    'requestedSize': [1024, 1536], 'actualPortraitSize': list(portrait.size),
    'portraitProcessing': 'WebP compression only; original aspect ratio retained, not exact 9:16.',
    'alphaProcessing': 'Provider returned RGBA. Preserved original alpha; cropped empty margins and resized.',
    'cutoutSize': list(cutout.size), 'sourceTransparentFraction': transparent,
    'visualReview': 'Pending: current assistant image input tool unavailable. Automated checks are not visual approval.',
    'assets': {},
}
for name in ['yuanshu-staircase-v1.webp', 'yuanshu-cutout-v1.webp']:
    file = target / name
    with Image.open(file) as im:
        im.load()
        facts['assets'][name] = {'size': list(im.size), 'mode': im.mode, 'bytes': file.stat().st_size}
        if 'cutout' in name:
            assert im.mode == 'RGBA' and im.getchannel('A').getextrema() == (0, 255)
print(json.dumps(facts, ensure_ascii=False, indent=2))
