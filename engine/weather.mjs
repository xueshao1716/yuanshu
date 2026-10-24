// engine/weather.mjs —— 天气预报（2026-10-24）
//
// 首页要"多元一点"，天气是最自然的日常信息。要求：不引第三方 key、失败不阻塞页面。
// 数据源 Open-Meteo（免 key、免费、无追踪），按经纬度取当前+当日高低温+降水概率，缓存 30 分钟。
import fs from 'node:fs';
import path from 'node:path';

const CACHE_FILE = '记忆/运行时/天气缓存.json';
const TTL_MS = 30 * 60 * 1000;
// 默认兰州（工作区里有"兰州格澜酒店"的项目，先按常驻地兜底）；可用位置文件覆盖
const DEFAULT_PLACE = { name: '兰州', latitude: 36.0611, longitude: 103.8343 };

const WMO = {
  0: ['晴', 'sun'], 1: ['晴间多云', 'sun-cloud'], 2: ['多云', 'cloud'], 3: ['阴', 'cloud'],
  45: ['雾', 'fog'], 48: ['雾凇', 'fog'],
  51: ['毛毛雨', 'drizzle'], 53: ['小雨', 'drizzle'], 55: ['中雨', 'rain'],
  56: ['冻雨', 'rain'], 57: ['冻雨', 'rain'],
  61: ['小雨', 'rain'], 63: ['中雨', 'rain'], 65: ['大雨', 'rain'],
  66: ['冻雨', 'rain'], 67: ['冻雨', 'rain'],
  71: ['小雪', 'snow'], 73: ['中雪', 'snow'], 75: ['大雪', 'snow'], 77: ['雪粒', 'snow'],
  80: ['阵雨', 'rain'], 81: ['强阵雨', 'rain'], 82: ['暴雨', 'rain'],
  85: ['阵雪', 'snow'], 86: ['强阵雪', 'snow'],
  95: ['雷阵雨', 'storm'], 96: ['雷阵雨伴冰雹', 'storm'], 99: ['强雷暴', 'storm'],
};

function readPlace(wsRoot) {
  try {
    const f = path.join(wsRoot, '记忆', '运行时', '位置.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Number.isFinite(j.latitude) && Number.isFinite(j.longitude)) {
      return { name: String(j.name || '当前地点'), latitude: j.latitude, longitude: j.longitude };
    }
  } catch {}
  return DEFAULT_PLACE;
}

function readCache(wsRoot) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(wsRoot, CACHE_FILE), 'utf8'));
    if (j?.at && Date.now() - j.at < TTL_MS && j.data) return j;
  } catch {}
  return null;
}

function writeCache(wsRoot, data) {
  try {
    const file = path.join(wsRoot, CACHE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), data }, null, 2), 'utf8');
  } catch {}
}

export async function readWeather(wsRoot, { force = false, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const place = readPlace(wsRoot);
  if (!force) {
    const hit = readCache(wsRoot);
    // 缓存按地点匹配，换城市后不会返回旧城市
    if (hit && Math.abs(hit.data?.latitude - place.latitude) < 0.01 && Math.abs(hit.data?.longitude - place.longitude) < 0.01) return hit.data;
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
    `&timezone=Asia%2FShanghai&forecast_days=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'yuanshu/weather (+local)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const cur = j.current || {};
    const day = (j.daily || {});
    const [text, icon] = WMO[Number(cur.weather_code)] || ['—', 'cloud'];
    const high = Number(day.temperature_2m_max?.[0]);
    const low = Number(day.temperature_2m_min?.[0]);
    const rain = Number(day.precipitation_probability_max?.[0]);
    const data = {
      place: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
      at: new Date().toISOString(),
      temp: Math.round(Number(cur.temperature_2m)),
      feels: Math.round(Number(cur.apparent_temperature)),
      text,
      icon,
      high: Number.isFinite(high) ? Math.round(high) : null,
      low: Number.isFinite(low) ? Math.round(low) : null,
      rain: Number.isFinite(rain) ? rain : null,
      wind: Math.round(Number(cur.wind_speed_10m) || 0),
      humidity: Math.round(Number(cur.relative_humidity_2m) || 0),
      sunrise: day.sunrise?.[0] || null,
      sunset: day.sunset?.[0] || null,
      hint: (() => {
        if (Number.isFinite(rain) && rain >= 60) return '大概率下雨，出门带伞';
        if (Number.isFinite(low) && low <= 3) return '早晚偏冷，加件外套';
        if (Number.isFinite(high) && high >= 33) return '午后偏热，注意补水';
        if (Number.isFinite(rain) && rain >= 30) return '可能有阵雨';
        return '';
      })(),
    };
    writeCache(wsRoot, data);
    return data;
  } catch (e) {
    // 失败不抛给页面：返回 null，前端就不显示天气块（本地生活信息，失败不该挡住工作）
    return { error: String(e?.message || e).slice(0, 120), place: place.name };
  } finally {
    clearTimeout(timer);
  }
}
