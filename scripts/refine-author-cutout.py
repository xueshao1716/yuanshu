from pathlib import Path
import cv2
import numpy as np
from PIL import Image

src = Path(r'D:\pi-web\output\imagegen\portrait-poses-diagnostic-20260927-author')
out = Path(r'D:\pi-web\output\imagegen\portrait-poses-diagnostic-20260927-author-grabcut')
out.mkdir(exist_ok=True)
for name in ['daydreaming', 'working', 'responding', 'listening', 'resting', 'reading']:
    im = cv2.imread(str(src / f'{name}.png'))
    if im is None:
        raise FileNotFoundError(name)
    h, w = im.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    rect = (int(w * .06), int(h * .015), int(w * .88), int(h * .97))
    cv2.grabCut(im, mask, rect, bgd, fgd, 8, cv2.GC_INIT_WITH_RECT)
    alpha = np.where((mask == 1) | (mask == 3), 255, 0).astype(np.uint8)
    kernel = np.ones((5, 5), np.uint8)
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_CLOSE, kernel, iterations=2)
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, kernel, iterations=1)
    rgba = cv2.cvtColor(im, cv2.COLOR_BGR2RGBA)
    rgba[:, :, 3] = alpha
    ys, xs = np.where(alpha > 0)
    if len(xs):
        pad = 18
        rgba = rgba[max(0, ys.min()-pad):min(h, ys.max()+pad+1), max(0, xs.min()-pad):min(w, xs.max()+pad+1)]
    height = 512
    width = max(1, int(rgba.shape[1] * height / rgba.shape[0]))
    Image.fromarray(rgba).resize((width, height), Image.Resampling.LANCZOS).save(out / f'{name}.png')
    print(name, 'coverage', round(float((alpha > 0).mean()), 3), 'size', width, height)
