const forecastSource = { url: 'https://open-meteo.com/', title: 'Pronóstico de Open-Meteo' };

function normalize(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function parseWeather(text) {
  const plain = normalize(text);
  const forecast = /\b(?:que tiempo(?: (?:hace|hara|va a hacer|habra|tenemos|se espera|hay)|(?=[\s?!.]*$))|tiempo (?:en|hoy|manana|para)|(?:pronostico|prevision)(?: del tiempo| meteorologic[oa])?|meteorologia|(?:va a|podria|puede) llover|llovera|llueve|(?:que|cuanta|cual es la) temperatura|cuantos grados)\b/u.test(plain);
  const small = /\b(?:cuanto tiempo|el tiempo que tarda|buscar en (?:internet|la web)|alerta|avisos?|fin de semana|proximos dias|ayer|semana que viene)\b/u.test(plain);
  if (!forecast || small) return null;

  const offset = /\bpasado manana\b/u.test(plain) ? 2 : /\bmanana\b/u.test(plain) ? 1 : 0;
  const day = offset === 2 ? 'pasado mañana' : offset === 1 ? 'mañana' : 'hoy';
  const city = /\b(?:en|para)\s+([\p{L}\d][\p{L}\d ,.'’-]{1,74})/iu.exec(text)?.[1]
    ?.replace(/\s+(?:(?:hoy|pasado mañana|mañana|ahora(?: mismo)?)(?:\s.*)?|por favor)$/iu, '')
    .replace(/[ ,.]+$/u, '').trim();
  return { city: city && !/^(?:casa|mi (?:ciudad|zona)|mi localidad|mi pueblo|la (?:manana|tarde|noche)|que ciudad)$/u.test(normalize(city)) ? city : null,
    offset, day, current: offset === 0 && /\b(?:ahora|actual|hace|llueve|tenemos)\b/u.test(plain) };
}

function cityReply(text) {
  const city = text.replace(/^[¿¡\s]+|[?.!\s]+$/gu, '')
    .replace(/^(?:en|para)\s+/iu, '').replace(/,?\s+por favor$/iu, '').trim();
  if (!/^[\p{L}\d][\p{L}\d ,.'’-]{1,64}$/u.test(city) || city.split(/\s+/u).length > 6
    || /\b(?:abre|dime|busca|como|cuando|cuanto|hora|nunca|gracias|cancelar|que|hola)\b/u.test(normalize(city))) return null;
  return city;
}

function parseWeatherFollowUp(text) {
  const phrase = text.replace(/^[¿¡\s]+|[?.!\s]+$/gu, '').trim();
  const match = /^(?:y\s+)?(?:para\s+)?(hoy|mañana|pasado mañana)(?:\s+en\s+(.+))?$/iu.exec(phrase);
  if (!match) return null;
  const day = match[1].toLowerCase();
  const city = match[2] ? cityReply(match[2]) : null;
  if (match[2] && !city) return null;
  return { city, offset: ['hoy', 'mañana', 'pasado mañana'].indexOf(day), day, current: false };
}

function conditions(code) {
  if (code === 0) return 'cielo despejado';
  if (code === 1 || code === 2) return 'algunas nubes';
  if (code === 3) return 'cielo cubierto';
  if (code === 45 || code === 48) return 'niebla';
  if (code >= 95) return 'tormentas';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'nieve';
  if (code >= 51 && code <= 82) return 'lluvia';
  return '';
}

async function readJson(endpoint, options) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams(options).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(6500) });
  if (!response.ok) throw new Error('Open-Meteo ' + response.status);
  return response.json();
}

async function getForecast(query, city) {
  const { results } = await readJson('https://geocoding-api.open-meteo.com/v1/search',
    { name: city, count: '5', language: 'es', format: 'json' });
  const places = (results || []).filter(place =>
    Number.isFinite(place.latitude) && Number.isFinite(place.longitude));
  if (!places.length) return { text: 'No encuentro «' + city + '». Dime la ciudad y, si hace falta, el país.', retryCity: true };
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const place = places.find(item => item.timezone === localZone && normalize(item.name) === normalize(city)) || places[0];
  const label = [place.name, place.country].filter(Boolean).join(', ');
  const data = await readJson('https://api.open-meteo.com/v1/forecast', {
    latitude: place.latitude, longitude: place.longitude, timezone: 'auto', forecast_days: '3',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    current: 'temperature_2m,weather_code'
  });
  const { daily, current } = data;
  const index = query.offset;
  if (!daily || !Number.isFinite(daily.temperature_2m_max?.[index]) ||
    !Number.isFinite(daily.temperature_2m_min?.[index])) throw new Error('Pronóstico incompleto');
  const degrees = value => Math.round(value) + ' grados';
  const high = degrees(daily.temperature_2m_max[index]);
  const low = degrees(daily.temperature_2m_min[index]);
  const rain = daily.precipitation_probability_max?.[index];
  const sky = conditions(query.current ? current?.weather_code : daily.weather_code?.[index]);
  const temperatures = 'máxima de ' + high + ' y mínima de ' + low + '.';
  const lead = query.current && Number.isFinite(current?.temperature_2m)
    ? 'Ahora en ' + label + ' hay ' + degrees(current.temperature_2m) + (sky ? ' y ' + sky : '') + '. Hoy, '
    : query.day[0].toUpperCase() + query.day.slice(1) + ' en ' + label + (sky ? ' se espera ' + sky + ', con ' : ', ');
  return { text: lead + temperatures + (Number.isFinite(rain) ? ' La probabilidad de precipitación llega al ' + rain + ' %.' : ''),
    sources: [forecastSource], city: [place.name, place.country].filter(Boolean).join(', ') };
}

module.exports = { parseWeather, parseWeatherFollowUp, cityReply, getForecast };
