const { clockContext, webIntent, eventCountdown } = require('./calendar.cjs');
const { NAVI_DESTINATIONS, DESKTOP_ACTIONS, NAVI_LORE, MAX_TIMER_SECONDS } = require('./commands.cjs');
const { MEDIA_ACTIONS, MEDIA_TARGETS, validMediaAction } = require('./media-commands.cjs');

const actionFields = {
  open_app: { app: { type: 'string' } },
  close_app: { app: { type: 'string' } },
  start_timer: { seconds: { type: 'integer' } },
  move_navi: { destination: { type: 'string', enum: NAVI_DESTINATIONS } },
  follow_cursor: { enabled: { type: 'boolean' } },
  control_media: { action: { type: 'string', enum: Object.keys(MEDIA_ACTIONS) }, target: { type: 'string', enum: MEDIA_TARGETS } }
};

const instructions = [
  NAVI_LORE + ' En preguntas sobre ti, responde en personaje y sin enlaces. Habla de tecnología solo si te preguntan por ella.',
  'Sé breve y usa español de España. Escribe texto corrido para leer en voz alta, sin emojis, Markdown, etiquetas ni acotaciones de gestos o efectos. Si te piden un beso, responde con palabras naturales. Usa el reloj del PC para fechas relativas y la web para datos actuales.',
  'Atiende la petición del último mensaje. Las órdenes y confirmaciones anteriores ya se atendieron. Una mención, cita, negación o pregunta de cómo hacer algo no autoriza actuar.',
  'Nunca afirmes que ejecutaste una acción del escritorio. El programa comunica por separado los resultados de las acciones que ejecuta.'
].join(' ');
const unverified = 'No he podido verificar ese dato con una fuente actual.';

async function request(key, endpoint, body, json = true) {
  const response = await fetch('https://api.openai.com/v1/' + endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      ...(json ? { 'Content-Type': 'application/json' } : {})
    },
    body: json ? JSON.stringify(body) : body,
    redirect: 'error',
    signal: AbortSignal.timeout(endpoint === 'responses' ? 35000 : 20000)
  });
  if (!response.ok) {
    const reasons = {
      401: 'La clave de OpenAI no es válida. Revisa la configuración de IA.',
      403: 'El proyecto de OpenAI no tiene permiso para esa operación.',
      404: 'El modelo de OpenAI no está disponible para esa clave.',
      429: 'La API de OpenAI alcanzó su límite. Revisa la cuota o la facturación.'
    };
    throw new Error(reasons[response.status] || 'OpenAI devolvió un error (' + response.status + ').');
  }
  return response.json();
}

async function interpretDesktop(key, text, intents, placement, followingCursor = false) {
  const allowed = DESKTOP_ACTIONS.filter(name => intents.includes(name));
  if (!allowed.length) return null;
  const tool = {
    type: 'function', name: 'desktop_plan', strict: true,
    description: 'Traduce la petición actual a acciones del escritorio en el orden solicitado.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['actions', 'missing', 'confirm'],
      properties: {
        missing: { type: 'string', enum: ['none', ...allowed] },
        confirm: { type: 'boolean' },
        actions: {
          type: 'array', items: { anyOf: allowed.map(name => ({
            type: 'object', additionalProperties: false, required: ['name', ...Object.keys(actionFields[name])],
            properties: { name: { type: 'string', enum: [name] }, ...actionFields[name] }
          })) }
        }
      }
    }
  };
  const response = await request(key, 'responses', {
    model: process.env.NAVI_OPENAI_MODEL || 'gpt-6-luna', reasoning: { effort: 'none' },
    instructions: [
      'Interpreta solo el pedido actual dirigido a Navi en el escritorio de Windows. Devuelve un plan ordenado si hay una petición de actuar, incluso si viene con contexto, es indirecta o está formulada como pregunta cortés.',
      'Una mención, cita, relato, petición de instrucciones, negación o acción condicional con una condición sin verificar no autoriza actuar. Si no se pide actuar, devuelve actions vacío, missing none y confirm false. Si falta un dato imprescindible y no se puede inferir, devuelve actions vacío, la acción correspondiente en missing y confirm false. No inventes datos ni añadas acciones ajenas al pedido.',
      'Usa confirm false para órdenes claras y para preguntas corteses que piden actuar («¿puedes abrir Steam?»). Si hay una interpretación concreta pero dudas de si el usuario realmente te pide esa acción, devuelve solo esa propuesta con missing none y confirm true. Por ejemplo, «igual me vendría bien un recordatorio en un minuto» permite proponer start_timer con 60 segundos y pedir un sí o no.',
      'open_app y close_app llevan solo el nombre de la aplicación mencionada, sin rutas, enlaces, argumentos ni explicaciones. start_timer lleva la duración en segundos. Si se piden dos aplicaciones o dos temporizadores, usa un elemento por acción.',
      'move_navi con other-display cambia de monitor. «Me molestas en esta pantalla, cámbiate a la otra» y «¿Te podrías ir al monitor de al lado?» significan other-display. Las demás posiciones son top, center o bottom más left o right. Resuelve las posiciones relativas de una secuencia usando el resultado del paso anterior. Posición actual: ' + placement + '.',
      allowed.includes('follow_cursor') && ('follow_cursor mueve a Navi con el puntero (enabled true) o deja de seguirlo (enabled false). Interpreta errores pequeños de dictado en el verbo. «Engánchate al cursor», «pégate a mi ratón» y «ven conmigo mientras muevo el puntero» activan el modo. «Ya puedes soltarlo» y «ya no sigas el ratón» lo desactivan. Si se pide actuar pero el sentido del verbo es ambiguo, usa missing follow_cursor. Estado actual: ' + (followingCursor ? 'siguiendo el cursor.' : 'sin seguir el cursor.')),
      allowed.includes('control_media') && 'control_media actúa sobre lo que ya está reproduciéndose o pausado: pause, play, next, previous o restart. Para «¿qué estoy escuchando?» o preguntar el título o el artista de lo que suena, usa status, que solo consulta. Si dice «vuelve hacia atrás» sin indicar tiempo, previous. «Desde el principio» o «repite este vídeo» es restart, nunca previous. Usa el target explícito spotify, youtube, chrome, edge, firefox o browser; si no indica reproductor, usa current. No abras ni cierres la app para controlar su reproducción. No busques contenido en internet ni trates «pon [título]» como reanudar: este control solo maneja el contenido ya abierto.',
      'Mantén el orden. Por ejemplo, «cierra Epic Games y abre Steam» es close_app Epic Games, luego open_app Steam.'
    ].filter(Boolean).join('\n'),
    input: [{ role: 'user', content: text }], tools: [tool],
    tool_choice: { type: 'function', name: tool.name }, parallel_tool_calls: false,
    max_output_tokens: 450, store: false
  });
  const calls = (response.output || []).filter(item => item.type === 'function_call');
  if (response.status === 'incomplete' || calls.length !== 1 || calls[0].name !== tool.name) return null;
  let plan;
  try {
    plan = JSON.parse(calls[0].arguments);
  } catch {
    return null;
  }
  if (!Array.isArray(plan?.actions) || (plan.confirm !== undefined && typeof plan.confirm !== 'boolean')) return null;
  if (allowed.includes(plan.missing) && !plan.actions.length && !plan.confirm) return { missing: plan.missing };
  if (plan.missing !== 'none') return null;
  const actions = [];
  for (const action of plan.actions) {
    if (!allowed.includes(action?.name)) return null;
    const { name, ...args } = action;
    if (Object.keys(args).length !== Object.keys(actionFields[name]).length) return null;
    if (name === 'control_media' && !validMediaAction(args)) return null;
    if (name === 'move_navi' && !NAVI_DESTINATIONS.includes(args.destination)) return null;
    if (name === 'follow_cursor' && typeof args.enabled !== 'boolean') return null;
    if (name === 'start_timer' && (!Number.isSafeInteger(args.seconds) || args.seconds < 1 || args.seconds > MAX_TIMER_SECONDS)) return { missing: name };
    if (['open_app', 'close_app'].includes(name) && (typeof args.app !== 'string' || !args.app.trim() || args.app.length > 120
      || /[\\/<>|;&%\p{Cc}]/u.test(args.app))) return null;
    actions.push({ name, args });
  }
  return plan.confirm && actions.length ? { actions, confirm: true } : { actions };
}

async function ask(key, history, text, now = new Date(), { allowSearch = true } = {}) {
  const intent = allowSearch ? webIntent(text) : 'auto';
  const webOnly = intent !== 'auto';
  const countdown = intent === 'countdown';
  const search = { type: 'web_search', search_context_size: webOnly ? 'medium' : 'low',
    user_location: { type: 'approximate', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
  const dateInstructions = countdown
    ? 'Busca la fecha exacta anunciada del evento y la plataforma si aplica. Si es inequívoca, escribe FECHA: AAAA-MM-DD en la primera línea y después especifica el evento o plataformas y cita la fuente, sin repetir fecha ni calcular el tiempo. Si falta una fecha exacta o hay varias posibles, explícalo sin la línea FECHA.'
    : 'Distingue una fecha anunciada de un hecho que ya ocurrió.';
  const response = await request(key, 'responses', {
    model: process.env.NAVI_OPENAI_MODEL || 'gpt-6-luna',
    reasoning: { effort: 'none' },
    instructions: [clockContext(now), instructions, dateInstructions].join('\n'),
    input: [...history, { role: 'user', content: text }],
    ...(allowSearch ? {
      tools: [search], tool_choice: webOnly ? 'required' : 'auto', include: ['web_search_call.action.sources']
    } : {}),
    parallel_tool_calls: false,
    max_output_tokens: webOnly ? 300 : 180,
    store: false
  });
  const searches = allowSearch ? (response.output || []).filter(item => item.type === 'web_search_call' && item.status === 'completed') : [];
  const searched = searches.length > 0;
  const parts = (response.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text' || item.type === 'refusal');
  const sources = new Map();
  for (const part of parts) {
    for (const annotation of allowSearch ? part.annotations || [] : []) {
      if (annotation.type !== 'url_citation' || !isWebSource(annotation.url)) continue;
      sources.set(annotation.url, { url: annotation.url, title: annotation.title || new URL(annotation.url).hostname });
    }
  }
  if (!sources.size) {
    for (const item of searches) {
      for (const source of item.action?.sources || []) {
        if (!isWebSource(source.url)) continue;
        sources.set(source.url, { url: source.url, title: new URL(source.url).hostname });
      }
    }
  }
  if ((webOnly || searched) && (!searched || !sources.size)) return { text: unverified };
  let answer = parts.map(item => item.text || item.refusal).join('\n').trim()
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/gu, '$1');
  if (countdown) {
    const date = /^FECHA:\s*(\d{4}-\d{2}-\d{2})[ \t]*\r?\n?/iu.exec(answer);
    if (date) {
      const calculated = eventCountdown(now, date[1]);
      if (!calculated) return { text: unverified };
      answer = [calculated, answer.slice(date[0].length).trim()].filter(Boolean).join(' ');
    } else if (/\b(?:faltan?|quedan?|hace)\s+(?:\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:d[ií]a|semana|mes|año)/iu.test(answer)) {
      return { text: unverified, sources: [...sources.values()].slice(0, 4) };
    }
  }
  return {
    text: answer || 'No me llegó una respuesta completa. Prueba con una pregunta más corta.',
    ...(sources.size ? { sources: [...sources.values()].slice(0, 4) } : {})
  };
}

function isWebSource(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function transcribe(key, audio, format) {
  const form = new FormData();
  form.set('file', new Blob([audio], { type: 'audio/' + format }), 'peticion.' + format);
  form.set('model', 'gpt-transcribe');
  form.set('prompt', 'Transcribe literalmente lo que se oye en español. Navi es un nombre propio. Omite el ruido y no completes frases que no se oyen.');
  const result = await request(key, 'audio/transcriptions', form, false);
  return typeof result.text === 'string' ? result.text.trim() : '';
}

module.exports = { ask, interpretDesktop, transcribe, isWebSource };
