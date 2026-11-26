export interface WeatherQuery {
  location?: string;
  days: number;
}

interface WeatherLookupRequest {
  query: WeatherQuery;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}

interface LocationResult {
  latitude: number;
  longitude: number;
  name: string;
  region?: string;
}

const GEOCODING_URL = 'https://nominatim.openstreetmap.org/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const GEOCODING_CACHE_MS = 24 * 60 * 60 * 1000;
const GEOCODING_INTERVAL_MS = 1000;
const geocodingCache = new Map<string, { expiresAt: number; location: LocationResult }>();
let nextGeocodingRequestAt = 0;

export function parseWeatherQuery(prompt: string): WeatherQuery | undefined {
  if (!/(?:天气|气象|气温|预报|\bweather\b|\bforecast\b)/i.test(prompt)) return undefined;

  const requestedDays = prompt.match(/(?:未来|接下来|这)?\s*(\d{1,2})\s*天/);
  const requestedWeek = /(?:未来|接下来|这)?\s*(?:一|1)\s*周/.test(prompt);
  const days = requestedWeek ? 7 : requestedDays ? Math.min(Math.max(Number(requestedDays[1]), 1), 7) : 7;
  const marker = /天气|气象|气温|预报|\bweather\b|\bforecast\b/i.exec(prompt);
  if (!marker) return { days };

  const beforeMarker = prompt.slice(0, marker.index);
  const afterMarker = prompt.slice(marker.index + marker[0].length);
  const cleanedBefore = cleanLocationText(beforeMarker);
  const chineseLocation = cleanedBefore.match(/[\p{Script=Han}]{2,12}$/u)?.[0];
  if (chineseLocation) return { location: chineseLocation, days };

  const englishLocation = /\b(?:in|for|at)\s+([A-Za-z][A-Za-z -]{1,40})$/i.exec(beforeMarker)?.[1]
    ?? /^\s*([A-Za-z][A-Za-z -]{1,40})\b/.exec(afterMarker)?.[1];
  return { ...(englishLocation ? { location: englishLocation.trim() } : {}), days };
}

function cleanLocationText(text: string): string {
  return text
    .replace(/你好|您好|请问|麻烦|帮我|我想知道|告诉我|查询|查一下|查查|看一下|看看|获取|请/g, ' ')
    .replace(/(?:未来|接下来|最近|这|本周|这一周|下周|今天|明天|后天)?\s*(?:\d+|[一二三四五六七八九十几]+)?\s*(?:天|周|星期)(?:内|的)?/g, ' ')
    .replace(/的|在/g, ' ')
    .replace(/[，,。?？!！\s]+/g, ' ')
    .trim();
}

export async function lookupWeatherForecast(request: WeatherLookupRequest): Promise<string> {
  const locationName = request.query.location?.trim();
  if (!locationName) return '请告诉我需要查询天气的城市。';

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(request.signal.reason);
  const timeout = setTimeout(() => controller.abort(new Error('天气查询超时')), REQUEST_TIMEOUT_MS);
  request.signal.addEventListener('abort', abortFromCaller, { once: true });
  if (request.signal.aborted) abortFromCaller();

  try {
    const fetcher = request.fetcher ?? fetch;
    const location = await resolveLocation(locationName, fetcher, controller.signal);
    const forecast = await loadForecast(location, request.query.days, fetcher, controller.signal);
    return formatForecast(locationName, forecast, request.query.days);
  } catch (error) {
    if (request.signal.aborted) throw abortedError();
    if (controller.signal.aborted) throw new Error('天气查询超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abortFromCaller);
  }
}

async function resolveLocation(name: string, fetcher: typeof fetch, signal: AbortSignal): Promise<LocationResult> {
  const key = name.toLocaleLowerCase();
  const cached = geocodingCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.location;

  const delay = nextGeocodingRequestAt - Date.now();
  if (delay > 0) await wait(delay, signal);
  nextGeocodingRequestAt = Date.now() + GEOCODING_INTERVAL_MS;

  const url = new URL(GEOCODING_URL);
  url.searchParams.set('q', name);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('accept-language', 'zh-CN');
  const response = await fetcher(url, { signal, redirect: 'error', headers: { 'User-Agent': 'JinggongAgent/0.9.9' } });
  if (!response.ok) throw new Error(`城市定位服务请求失败（HTTP ${response.status}）`);

  const results = await readJson(response, signal);
  if (!Array.isArray(results)) throw new Error('城市定位服务返回数据无效');
  const candidate = results.find(isLocationResult);
  if (!candidate) throw new Error(`没有找到“${name}”对应的城市，请补充省份或国家名称`);

  const location: LocationResult = {
    latitude: Number(candidate.lat),
    longitude: Number(candidate.lon),
    name: candidate.name,
    ...(typeof candidate.address?.state === 'string' ? { region: candidate.address.state } : {}),
  };
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) throw new Error('城市定位服务返回了无效坐标');
  geocodingCache.set(key, { expiresAt: Date.now() + GEOCODING_CACHE_MS, location });
  return location;
}

function isLocationResult(value: unknown): value is { lat: string; lon: string; name: string; address?: { state?: unknown } } {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.lat === 'string' && Number.isFinite(Number(result.lat))
    && typeof result.lon === 'string' && Number.isFinite(Number(result.lon))
    && typeof result.name === 'string';
}

async function loadForecast(location: LocationResult, days: number, fetcher: typeof fetch, signal: AbortSignal): Promise<Record<string, unknown>> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(days));
  const response = await fetcher(url, { signal, redirect: 'error' });
  if (!response.ok) throw new Error(`天气预报服务请求失败（HTTP ${response.status}）`);
  const result = await readJson(response, signal);
  if (!result || typeof result !== 'object' || !('daily' in result)) throw new Error('天气预报服务返回数据无效');
  return result as Record<string, unknown>;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('天气服务返回空响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw abortedError();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('天气服务响应超过大小限制');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (signal.aborted) throw abortedError();
    if (error instanceof SyntaxError) throw new Error('天气服务返回了无效 JSON');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function formatForecast(location: string, response: Record<string, unknown>, days: number): string {
  const daily = response.daily as Record<string, unknown>;
  const dates = daily.time;
  const codes = daily.weather_code;
  const highs = daily.temperature_2m_max;
  const lows = daily.temperature_2m_min;
  const precipitation = daily.precipitation_probability_max;
  const wind = daily.wind_speed_10m_max;
  if (![dates, codes, highs, lows, precipitation, wind].every(Array.isArray)
    || (dates as unknown[]).length < days
    || [codes, highs, lows, precipitation, wind].some(items => (items as unknown[]).length < days)) {
    throw new Error('天气预报服务未返回完整的逐日数据');
  }

  const rows = Array.from({ length: days }, (_, index) => {
    const date = (dates as unknown[])[index];
    const code = (codes as unknown[])[index];
    const high = (highs as unknown[])[index];
    const low = (lows as unknown[])[index];
    const rain = (precipitation as unknown[])[index];
    const windSpeed = (wind as unknown[])[index];
    if (typeof date !== 'string' || typeof code !== 'number') throw new Error('天气预报服务返回了无效逐日数据');
    return `| ${formatDate(date)} | ${weatherDescription(code)} | ${formatNumber(high)} / ${formatNumber(low)} °C | ${formatNumber(rain)}% | ${formatNumber(windSpeed)} km/h |`;
  });
  return `## ${location}未来${days}天天气预报\n\n| 日期 | 天气 | 最高 / 最低 | 降雨概率 | 最大风速 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n天气数据来自 Open-Meteo，城市定位来自 OpenStreetMap contributors。`;
}

function weatherDescription(code: number): string {
  if (code === 0) return '晴';
  if (code === 1) return '大致晴朗';
  if (code === 2) return '局部多云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code >= 51 && code <= 57) return '毛毛雨';
  if (code === 61) return '小雨';
  if (code === 63) return '中雨';
  if (code === 65) return '大雨';
  if (code === 66 || code === 67) return '冻雨';
  if (code === 71 || code === 73 || code === 75 || code === 77) return '降雪';
  if (code === 80) return '小阵雨';
  if (code === 81) return '中阵雨';
  if (code === 82) return '强阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code === 95 || code === 96 || code === 99) return '雷暴';
  return '天气情况未知';
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('天气预报服务返回了无效日期');
  const label = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'numeric', day: 'numeric', weekday: 'short' }).format(date);
  return `${label.replace('星期', '周')}`;
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '--';
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortedError();
  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(abortedError());
    };
    timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function abortedError(): Error {
  const error = new Error('天气查询已停止');
  error.name = 'AbortError';
  return error;
}
