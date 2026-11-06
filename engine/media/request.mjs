// 尺寸属于请求参数，不是提示词魔法。此表是默认请求尺寸，并非上游能力声明。
const SIZES = { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024',
  '3:4': '960x1280', '4:3': '1280x960', '4:5': '1024x1280', '5:4': '1280x1024',
  '16:9': '1472x832', '9:16': '832x1472', '21:9': '1792x768' };
const gcd = (a, b) => b ? gcd(b, a % b) : a;
function ratioKey(value) {
  const match = String(value).trim().match(/^(\d{1,3})\s*[:：/]\s*(\d{1,3})$/);
  if (!match || !+match[1] || !+match[2]) throw new Error('aspect_ratio 无效，须为正整数比例，如 2:3');
  const w = +match[1], h = +match[2], divisor = gcd(w, h);
  return `${w / divisor}:${h / divisor}`;
}

export function resolveImageRequest(args = {}, prompt = '') {
  const rawSize = args.size;
  let size;
  if (rawSize != null && rawSize !== '') {
    const m = String(rawSize).trim().match(/^(\d{2,5})\s*[xX×*]\s*(\d{2,5})$/);
    if (!m || +m[1] < 64 || +m[2] < 64 || +m[1] > 8192 || +m[2] > 8192) {
      throw new Error('size 无效，须为 64–8192 像素的 宽x高，如 1024x1536');
    }
    size = `${+m[1]}x${+m[2]}`;
  }
  const rawRatio = args.aspect_ratio ?? args.aspectRatio;
  let ratio = rawRatio != null ? ratioKey(rawRatio) : undefined;
  if (!size && !ratio) {
    const pixels = String(prompt).match(/\b(\d{2,4})\s*[xX×*]\s*(\d{2,4})\s*(?:pixels?\b|px\b|像素)/i);
    if (pixels && +pixels[1] >= 64 && +pixels[2] >= 64 && +pixels[1] <= 8192 && +pixels[2] <= 8192) {
      return { size: `${+pixels[1]}x${+pixels[2]}` };
    }
    const explicit = String(prompt).match(/\b(\d{1,2})\s*[:：]\s*(\d{1,2})\b/);
    if (explicit && +explicit[1] && +explicit[2] && SIZES[ratioKey(explicit[0])]) ratio = ratioKey(explicit[0]);
    else if (/横版|横屏|宽屏|宽幅|landscape/i.test(prompt)) ratio = '16:9';
    else if (/竖版|竖屏|纵版|长图|vertical|portrait/i.test(prompt)) ratio = '9:16';
  }
  if (ratio && !size && !SIZES[ratio]) throw new Error(`暂未配置比例 ${ratio} 的默认尺寸，请明确传 size（宽x高）`);
  if (size && ratio) {
    const [w, h] = size.split('x').map(Number), [rw, rh] = ratio.split(':').map(Number);
    if (Math.abs(w / h / (rw / rh) - 1) > 0.01) throw new Error(`size ${size} 与 aspect_ratio ${ratio} 冲突`);
  }
  return { ...(size || ratio ? { size: size || SIZES[ratio] } : {}), ...(ratio ? { aspectRatio: ratio } : {}) };
}
