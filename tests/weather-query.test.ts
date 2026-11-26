import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupWeatherForecast, parseWeatherQuery } from '../apps/desktop/src/main/weather-query';

test('weather query recognizes a Chinese city and requested forecast length', () => {
  assert.deepEqual(parseWeatherQuery('你好，这7天佛山的天气怎么样'), { location: '佛山', days: 7 });
  assert.deepEqual(parseWeatherQuery('深圳未来3天天气'), { location: '深圳', days: 3 });
  assert.deepEqual(parseWeatherQuery('天气怎么样'), { days: 7 });
  assert.equal(parseWeatherQuery('帮我看一下设备过站'), undefined);
});

test('weather lookup requests a geocoded seven-day forecast and formats daily rows', async () => {
  const requestedUrls: URL[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    if (url.hostname === 'nominatim.openstreetmap.org') {
      return new Response(JSON.stringify([{ lat: '23.02', lon: '113.11', name: '佛山市', address: { state: '广东省' } }]), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ daily: {
      time: ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'],
      weather_code: [0, 1, 2, 3, 45, 61, 95],
      temperature_2m_max: [21, 22, 23, 24, 20, 19, 18],
      temperature_2m_min: [14, 15, 16, 17, 13, 12, 11],
      precipitation_probability_max: [0, 5, 10, 20, 30, 40, 50],
      wind_speed_10m_max: [5, 6, 7, 8, 9, 10, 11],
    } }), { headers: { 'content-type': 'application/json' } });
  };

  const output = await lookupWeatherForecast({ query: { location: '佛山测试', days: 7 }, signal: new AbortController().signal, fetcher });

  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].searchParams.get('q'), '佛山测试');
  assert.equal(requestedUrls[1].searchParams.get('forecast_days'), '7');
  assert.match(output, /佛山测试未来7天天气预报/);
  assert.match(output, /晴/);
  assert.match(output, /雷暴/);
  assert.equal(output.split('\n').filter(line => line.startsWith('| ') && line.includes('°C')).length, 7);
});

test('weather lookup asks for a city without making network requests when location is absent', async () => {
  let requested = false;
  const fetcher: typeof fetch = async () => {
    requested = true;
    return new Response('{}');
  };
  const output = await lookupWeatherForecast({ query: { days: 7 }, signal: new AbortController().signal, fetcher });
  assert.equal(output, '请告诉我需要查询天气的城市。');
  assert.equal(requested, false);
});
