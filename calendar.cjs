const weekdayFormat = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
});
const timeFormat = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const utcDateFormat = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
});
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayMs = 86_400_000;
const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const writtenDate = new RegExp('^(?:el )?(\\d{1,2}) de (' + months.join('|') + ')(?: de (\\d{4}))?$', 'u');

function localDateISO(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, i) => String(part).padStart(i ? 2 : 4, '0')).join('-');
}

function clockContext(now) {
  return `Reloj del PC: ${localDateISO(now)}, ${timeFormat.format(now)}, ${timeZone} (${weekdayFormat.format(now)}).`;
}

function normalized(text) {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[¿?¡!.,:;]/gu, ' ').replace(/\s+/gu, ' ').trim()
    .replace(/^(?:(?:oye|hey|ey|eh|hola)[ ]+)?(?:navi|navy)(?: una cosa)?\b */u, '')
    .replace(/^(?:dime |me dices |me puedes decir )/u, '').replace(/ por favor$/u, '');
}

function answerFromClock(text, now) {
  const question = normalized(text);
  if (/^(?:que hora(?: es| tenemos)?|a que hora estamos|hora actual|hora local)$/u.test(question)) {
    return 'Son las ' + timeFormat.format(now) + '.';
  }

  const dateOnly = /^(?:cuanto (?:tiempo )?(?:falta|queda)|cuantos? dias? (?:faltan?|quedan?)) (?:para|hasta) (.+)$/u.exec(question)?.[1];
  const target = dateOnly && writtenDate.exec(dateOnly);
  if (target) {
    const iso = (target[3] || now.getFullYear()) + '-' +
      String(months.indexOf(target[2]) + 1).padStart(2, '0') + '-' + target[1].padStart(2, '0');
    return eventCountdown(now, iso, 'Esa fecha') ?? 'Esa fecha no es válida.';
  }

  const dateQuestion = /^(?:(?:que (?:dia|fecha)(?: de la semana)?(?: es| estamos| estamos a| sera| fue)?|a que (?:dia|fecha) estamos|cual es la fecha)(?: (?:hoy|manana|ayer))?|fecha de hoy|fecha actual|dia de hoy|en que (?:dia|fecha|mes|ano) estamos)$/u;
  if (!dateQuestion.test(question)) return null;
  if (question === 'en que mes estamos') {
    return 'Estamos en ' + new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(now) + '.';
  }
  if (question === 'en que ano estamos') return 'Estamos en ' + now.getFullYear() + '.';

  const relative = question.match(/\b(manana|ayer)$/u)?.[1];
  const date = new Date(now);
  const lead = relative === 'manana' ? 'Mañana es ' : relative === 'ayer' ? 'Ayer fue ' : 'Hoy es ';
  if (relative) date.setDate(date.getDate() + (relative === 'manana' ? 1 : -1));
  return lead + weekdayFormat.format(date) + '.';
}

function webIntent(text) {
  const question = normalized(text);
  const countdown = /\b(?:cuanto (?:tiempo )?(?:falta|queda)|cuantos? (?:dias?|meses?|semanas?) (?:faltan?|quedan?|han pasado))\b/u.test(question);
  const calendarTarget = /\b(?:dentro de|hace) \d+ (?:dias?|semanas?|meses?|anos?)\b/u.test(question);
  const event = /\b(?:lanzamiento|estreno|publicacion|fecha de salida|fecha oficial|sale|saldra|salga|salio|se estrena|estrenara|se estrene|se lanza|lanzara|se lance|se publica|se publicara|empieza|empezara|empiece|se celebra|se abre|se cierra|comienza|comience|termina|termine|se acaba)\b/u.test(question);
  if (countdown && !calendarTarget && event) return 'countdown';
  if (countdown && !calendarTarget && /\b(?:para (?:que|el|la|los|las)|hasta)\b/u.test(question)) return 'countdown';
  if (event && /\b(?:cuando|fecha|que dia|ya|cuanto|cuantos)\b/u.test(question)) return 'always';
  if (/^(?:puedes )?(?:busca(?:me|r)?|investiga(?:me|r)?|consulta(?:me|r)?|verifica(?:r)?|comprueba|mirame)\b/u.test(question)
    || /\b(?:busca|buscame|buscar|consulta|verifica|comprueba|mira)\b.{0,82}\b(?:internet|web|oficial|ultimo|ultimas?)\b/u.test(question)
    || /\b(?:tiempo|pronostico|prevision|temperatura|llovera)\b.{0,42}\b(?:manana|hoy|esta semana)\b/u.test(question)
    || /\b(?:actualmente|en directo|en vivo|ultimas noticias|a dia de hoy)\b/u.test(question)
    || (/\b(?:hoy|ahora mismo|reciente|esta semana|ayer|este mes)\b/u.test(question)
      && /\b(?:tiempo|precio|cuesta|noticias|resultado|marcador|partido|cartelera|horario|cotiza|llueve)\b/u.test(question))) return 'always';
  return 'auto';
}

function eventCountdown(now, isoDate, label = 'La fecha anunciada') {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(isoDate)) return null;
  const target = Date.parse(isoDate + 'T00:00:00Z');
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== isoDate) return null;
  const today = Date.parse(localDateISO(now) + 'T00:00:00Z');
  const days = (target - today) / dayMs;
  const date = utcDateFormat.format(target);
  if (days === 0) return `${label} es hoy, ${date}.`;
  if (days === 1) return `Falta 1 día. ${label} es el ${date}.`;
  if (days > 1) return `Faltan ${days} días. ${label} es el ${date}.`;
  return `${label} fue el ${date}, hace ${-days} ${days === -1 ? 'día' : 'días'}.`;
}

module.exports = { answerFromClock, clockContext, webIntent, eventCountdown };
