from pathlib import Path
from PIL import Image

ROOT = Path(r"D:\pi-web")
SOURCE_DIRS = {
    "author": ROOT / "output/imagegen/portrait-poses-diagnostic-20260927-u2net",
    "uniform": ROOT / "output/imagegen/portrait-poses-diagnostic-20260927-u2net-uniform",
}
NAMES = ["working", "reading", "resting", "daydreaming", "listening", "responding"]
AUTHOR_FILES = {
    "working": "小语立绘-工作-20260927.webp",
    "reading": "小语立绘-阅读-20260927.webp",
    "resting": "小语立绘-休息-20260927.webp",
    "daydreaming": "小语立绘-发呆-20260927.webp",
    "listening": "小语立绘-倾听-20260927.webp",
    "responding": "小语立绘-回应-20260927.webp",
}
TARGETS = [
    ROOT / "frontend/public/assets/portraits",
    ROOT / "frontend/dist/assets/portraits",
    ROOT / "public/assets/portraits",
    ROOT / "app/dist/assets/portraits",
]

def normalize(src: Path, dst: Path) -> None:
    im = Image.open(src).convert("RGBA")
    alpha = im.getchannel("A")
    box = alpha.point(lambda x: 255 if x > 8 else 0).getbbox()
    if not box:
        raise RuntimeError(f"empty alpha: {src}")
    pad = 14
    x0 = max(0, box[0] - pad); y0 = max(0, box[1] - pad)
    x1 = min(im.width, box[2] + pad); y1 = min(im.height, box[3] + pad)
    im = im.crop((x0, y0, x1, y1))
    height = 512
    width = max(1, round(im.width * height / im.height))
    im = im.resize((width, height), Image.Resampling.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "WEBP", quality=96, method=6)

for group, src_dir in SOURCE_DIRS.items():
    suffix = "author-v2" if group == "author" else "v3"
    for name in NAMES:
        src = src_dir / (AUTHOR_FILES[name] if group == "author" else f"{name}.webp")
        if not src.exists():
            raise FileNotFoundError(src)
        for target in TARGETS:
            normalize(src, target / f"yuanshu-life-{name}-{suffix}.webp")
        print(group, name)
