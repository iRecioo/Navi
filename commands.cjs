const { asksAboutMedia, classifyMedia } = require('./media-commands.cjs');

const WORDS = [
  'cero', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete',
  'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidos', 'veintitres',
  'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho',
  'veintinueve'
];
const NUMBERS = new Map(WORDS.map((word, index) => [word, index]));
NUMBERS.set('uno', 1);
NUMBERS.set('una', 1);
NUMBERS.set('veintiun', 21);
NUMBERS.set('veintiuna', 21);
NUMBERS.set('media', 0.5);
NUMBERS.set('medio', 0.5);
for (const [base, value] of [['treinta', 30], ['cuarenta', 40], ['cincuenta', 50], ['sesenta', 60]]) {
  NUMBERS.set(base, value);
  for (let unit = 1; unit <= 9; unit += 1) {
    NUMBERS.set(base + ' y ' + WORDS[unit], value + unit);
  }
}

const MAX_TIMER_SECONDS = 7 * 24 * 60 * 60;
const NAVI_DESTINATIONS = ['top-left', 'top-right', 'center-left', 'center-right', 'bottom-left', 'bottom-right', 'other-display'];
const DESKTOP_ACTIONS = ['open_app', 'close_app', 'move_navi', 'start_timer', 'follow_cursor', 'control_media'];
const NAVI_LORE = 'Eres Navi, hada del Bosque Kokiri en Hyrule. El Gran Árbol Deku te envió a guiar a Link. Después, Link te dejó con Mafu, un chico, gracias a la ayuda de Recio. Tu interlocutor es Mafu. Si pregunta quién es, di que es Mafu. Cuenta lo de Link o Recio solo si viene al caso.';

const CONVERSATION_ENDINGS = new Set([
  'para', 'para ya', 'parate', 'detente', 'basta', 'basta ya', 'suficiente', 'es suficiente',
  'ya lo oi', 'lo oi',
  'ya esta', 'ya vale', 'ya lo tengo', 'ya lo escuche', 'lo escuche', 'ya no hace falta',
  'eso es todo', 'nada mas', 'gracias', 'vale gracias', 'gracias ya esta', 'ya esta gracias',
  'gracias eso es todo', 'puedes parar', 'deja de escuchar', 'puedes dejar de escuchar',
  'no escuches mas', 'para de escuchar', 'termina la conversacion', 'cierra la conversacion',
  'cancela la conversacion', 'vuelve a la esquina',
  'vuelve a descansar', 'descansa', 'adios', 'hasta luego'
]);

function spokenPhrase(text) {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .replace(/^(?:(?:oye|hey|ey|eh|hola|vale) )?(?:navi|navy|naby|nave)(?: |$)/u, '')
    .replace(/ por favor$/u, '')
    .replace(/ (?:navi|navy|naby|nave)$/u, '')
    .replace(/ por favor$/u, '');
}

function endsConversation(text) {
  const phrase = spokenPhrase(text);
  return CONVERSATION_ENDINGS.has(phrase) || /^para(?: (?:navi|navy|naby|nave) para)+$/u.test(phrase);
}

function asksAboutTimers(text) {
  const phrase = actionPhrase(text);
  return /^(?:que|cuantos|cuantas|cuales) (?:temporizadores?|alarmas?) (?:tengo|hay)(?: (?:activos|activas|pendientes))?$/u.test(phrase)
    || /^(?:cuanto(?: tiempo)? (?:queda|falta)|cuanto le queda) (?:para (?:el |la )?|(?:al?|a la) )(?:(?:mi|el|la) )?(?:temporizador|alarma)$/u.test(phrase);
}

function answerNaviLore(text) {
  const question = spokenPhrase(text)
    .replace(/^(?:(?:oye|hey|ey|vale|y|entonces|una cosa) )+/u, '')
    .replace(/^(?:(?:me )?(?:puedes|podrias) decir(?:me)?|dime) /u, '')
    .replace(/ (?:exactamente|de verdad|en realidad|en zelda|en ocarina of time)$/u, '');
  if (/^(?:quien soy(?: yo)?|yo quien soy|como me llamo|cual es mi nombre|sabes (?:quien soy|como me llamo)|recuerdas (?:quien soy|como me llamo))$/u.test(question)) {
    return '¡Eres Mafu!';
  }
  if (/^(?:quien es recio|que (?:hizo|papel tuvo) recio|como (?:llegaste (?:hasta )?(?:aqui|a mi escritorio)|acabaste conmigo)|por que (?:estas conmigo|eres mi hada)|quien (?:me dio|te dejo|te trajo)(?: conmigo| aqui)?)$/u.test(question)) {
    return 'Link me dejó contigo, Mafu, y Recio ayudó a que tuvieras tu propia hada.';
  }
  if (/^(?:quien eres(?: tu)?(?: y de donde (?:eres|vienes))?|tu quien eres|que eres(?: tu)?|como te llamas|cual es tu nombre|presentate|cuentame (?:un poco )?(?:sobre|de) ti)$/u.test(question)) {
    return '¡Soy Navi! Vengo del Bosque Kokiri, en Hyrule. Fui el hada que acompañó a Link en Ocarina of Time.';
  }
  if (/^(?:de donde (?:eres|vienes)(?: tu)?|de que (?:region|reino|lugar|bosque) (?:eres|vienes)|cual es tu origen|donde vivias|en que (?:region|reino|bosque) vivias)$/u.test(question)) {
    return 'Vengo del Bosque Kokiri, en Hyrule. Allí empezó mi aventura con Link.';
  }
  if (/^(?:quien (?:(?:fue el que )?te (?:creo|hizo|dio vida|envio|mando|trajo)(?: a(?:qui|l escritorio))?|es (?:tu|el) creador(?: de navi)?)|cual es tu creador)$/u.test(question)) {
    return 'El Gran Árbol Deku me envió a guiar a Link. Y para llegar hasta tu escritorio, me echó una mano Recio.';
  }
  return null;
}

function actionPhrase(text) {
  return spokenPhrase(text)
    .replace(/^(?:(?:oye|hey|ey|eh|vale|entonces|una cosa|por favor) )+/u, '')
    .replace(/^y (?:si )?/u, '');
}

const quotedRequest = /^[\s¿¡]*["'«“‘`]/u;
const describesRequest = /^(?:como|por que|que pasa si|que significa|quien|cuando|cuentame|explica(?:me)?|dime (?:como|por que)|imagina(?:te)? que|supongamos que|(?:mi amigo|el|ella) (?:dijo|dice)|te dije que|si (?:digo|te digo|te pido))\b/u;
const movementLead = /^(?:muevete|vete|cambiate|ponte|colocate|desplazate|quedate|centrate|pasa|apartate|(?:te (?:puedes|podrias|importaria|quieres|vas a) |(?:puedes|podrias|podrias por favor|quiero que|me gustaria que|te) )(?:moverte?|mover|muevas|irte?|ir|vayas|ponerte?|poner|pongas|pones|colocarte?|colocar|coloques|desplazarte?|desplazar|desplaces|cambiarte?|cambiar|cambies|quedarte?|quedar|quedes|centrarte?|centrar|centres|pasarte?|pasar|pases|apartarte?|apartar))\b/u;
const screenDestination = /\b(?:izquierda|derecha|izquierdo|derecho|esquina|arriba|abajo|centro|costado|borde|lado|donde estas|(?:otro|siguiente) monitor|(?:otra|siguiente) pantalla)\b/u;
const nonAction = /\b(?:no (?:te |me )?(?:muevas|muevete|pongas|quedes|vayas|abras|cierres|avises|quiero|hagas)|(?:y|luego|despues) (?:dime|busca|explica|avisa|abre|cierra|pon|muevete)|(?:cuando|si) (?:te |me )?(?:pregunte|diga|pida|digo|pido))\b/u;
const appContext = /\b(?:y|luego|despues|pero|cuando|porque|seguido de|solo si|si (?!puedes\b)|a menos que|(?:antes|despues) de|sin (?:que|cerrar|abrir))\b/u;
const unspecifiedApp = /^(?:(?:el |la |una? )?(?:app|aplicacion|programa)|eso|esto|esa|esta|ese|este|algo|tal|lo de antes|la de antes|el de antes|la misma|el mismo|otra|otro)$/u;
const changeScreen = /^(?:cambia|cambiate|cambiar|cambiarte|cambias|cambies) de (?:pantalla|monitor)$/u;
const otherScreen = /^(?:a|en|al|en el) (?:la |el )?(?:(?:otr[oa]|siguiente) (?:pantalla|monitor)|(?:pantalla|monitor) siguiente)$/u;

function movementPhrase(text) {
  if (quotedRequest.test(text) || /["«“`]/u.test(text)) return '';
  const phrase = actionPhrase(text)
    .replace(/(?: (?:porfa|por favor|si puedes|vale))+$/u, '');
  const request = phrase
    .replace(/^(?:(?:ya )?no hace falta (?:que te escondas|esconder(?:se|te))|ya puedes salir|puedes dejar de esconderte)(?: (?:y|asi que|mejor))? /u, '')
    .replace(/^(?:(?:me molesta(?:s)?|me estorba(?:s)?) en esta (?:pantalla|monitor)|en esta pantalla me (?:molesta(?:s)?|estorba(?:s)?))(?: (?:asi que|mejor))? /u, '')
    .replace(/ (?:que |porque |si )?(?:ya )?no hace falta (?:que te escondas|esconder(?:se|te))$/u, '');
  if (request !== phrase && /\b(?:en esta pantalla|en este monitor)\b/u.test(phrase)) {
    return request.replace(/ a la otra$/u, ' a la otra pantalla').replace(/ al otro$/u, ' al otro monitor');
  }
  return request;
}

function changesMonitor(phrase) {
  const direct = phrase.replace(/^(?:(?:te )?(?:puedes|podrias|quieres|vas a)|(?:quiero|necesito|me gustaria) que te|te) /u, '');
  if (changeScreen.test(direct)) return true;
  const destination = direct.replace(/^(?:cambia|cambiate|cambiar|cambiarte|cambias|cambies|pasate|pasa|pasar(?:te)?|pases|muevete|moverte|muevas|vete|irte|vayas|ponte|ponerte|pongas) /u, '');
  return destination !== direct && otherScreen.test(destination);
}

function parseNaviPosition(text, currentVertical = 'center', currentHorizontal = 'right') {
  const phrase = movementPhrase(text);
  if (changesMonitor(phrase)) return 'other-display';
  if (!mentionsNaviMovement(text)) return null;
  const direction = phrase.replace(movementLead, match => match.startsWith('centr') ? 'centro' : '').trim()
    .replace(/^(?:un (?:poco|momento) )/u, '')
    .replace(/(?: (?:un (?:poco|momento)|porfa|si puedes|vale))+$/u, '');
  if (/^(?:al (?:otro|siguiente) monitor|a la (?:otra|siguiente) pantalla)$/u.test(direction)) {
    return 'other-display';
  }
  const opposite = /^(?:a|en) la otra esquina(?: de (arriba|abajo))?$/u.exec(direction);
  if (opposite) {
    const vertical = opposite[1] === 'arriba' ? 'top' : opposite[1] === 'abajo' ? 'bottom' : currentVertical;
    return vertical + (currentHorizontal === 'right' ? '-left' : '-right');
  }
  const sideOnly = /^(?:(?:a|en) la |(?:al|en el) lado )?(izquierda|derecha|izquierdo|derecho)(?: de (?:la|mi) pantalla)?$/u.exec(direction);
  if (sideOnly) return currentVertical + (sideOnly[1].startsWith('izquierd') ? '-left' : '-right');
  const coordinates = /^(?:(?:a|en) la esquina )?(arriba|superior|abajo|inferior|al centro|en el centro|centro|centrate|centrarte|centrar|en medio) (?:(?:a|de) la |del lado |lado )?(izquierda|derecha|izquierdo|derecho)(?: de (?:la|mi) pantalla)?$/u.exec(direction);
  if (!coordinates) return null;
  const [, height, side] = coordinates;
  const vertical = ['arriba', 'superior'].includes(height) ? 'top' : ['abajo', 'inferior'].includes(height) ? 'bottom' : 'center';
  return vertical + (side.startsWith('izquierd') ? '-left' : '-right');
}

function mentionsNaviMovement(text) {
  const phrase = movementPhrase(text);
  return changesMonitor(phrase) || movementLead.test(phrase) && screenDestination.test(phrase) && !nonAction.test(phrase)
    && !/\b(?:en (?:el juego|zelda|el mapa)|si digo|como (?:hago|se hace))\b/u.test(phrase);
}

function requestsTimer(text) {
  if (quotedRequest.test(text)) return false;
  const phrase = actionPhrase(text);
  if (nonAction.test(phrase)) return false;
  return /^(?:(?:me )?(?:puedes|podrias|quiero que|necesito que) )?(?:pon(?:me)?|poner(?:me)?|pongas|programa|programar|programes|crea|crear|crees|activa|activar|actives|configura|configurar|configures) (?:un |una |el |la )?(?:temporizador|alarma|aviso)\b/u.test(phrase)
    || /^(?:(?:me )?(?:puedes|podrias|quiero que|necesito que) )?(?:avisame|avisa|avisarme|avises|recuerdame|recuerda|recordarme|recuerdes) (?:dentro de|en|para dentro de)\b/u.test(phrase);
}

function requestsOpeningApp(text) {
  if (quotedRequest.test(text)) return false;
  const phrase = actionPhrase(text);
  if (nonAction.test(phrase) || requestsTimer(text)) return false;
  return /^(?:(?:me )?(?:puedes|podrias|quiero|quisiera|me gustaria|necesito)(?: que)? )?(?:abre(?:me)?|abrir(?:me)?|abras|inicia(?:me)?|iniciar|inicies|arranca|arrancar|ejecuta|ejecutar|ejecutes|lanza|lanzar|llevame a|pon(?:me|er|te)? (?:el programa|la aplicacion))\b/u.test(phrase)
    || /^(?:quiero|quisiera|me apetece|me gustaria|necesito|podemos|puedo|podria) (?:usar|entrar en|acceder a)\b/u.test(phrase)
    || /^(?:quiero|quisiera|necesito|me gustaria) tener .+ abiert[oa]\b/u.test(phrase);
}

function parseCommand(text) {
  if (quotedRequest.test(text) || /["«“`]/u.test(text)) return null;
  const command = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:oye|hey|ey|eh|hola|vale)[ ,]+)?(?:navi|navy)\b[,!: ]*(?:una cosa\b[,!: ]*)?/u, '')
    .replace(/[.!]+$/u, '').replace(/,? por favor$/u, '').trim();

  const close = /^(?:cierra(?:me)?|sal de|(?:me )?(?:puedes|podrias) cerrar(?:me)?|(?:quiero|necesito) que cierres) (?:(?:el|la) )?(?:(?:app|aplicacion|programa) (?:de )?)?([\p{L}\p{N}][\p{L}\p{N} .+_()#'-]{0,119})$/u
    .exec(command.replace(/^[¿¡]+|[?!]+$/gu, '')
      .replace(/^(?:(?:oye|hey|vale|por favor)[ ,]+)+/u, '')
      .replace(/[, ]+(?:si puedes|por favor)$/u, ''));
  if (close && !unspecifiedApp.test(close[1]) && !nonAction.test(command) && !appContext.test(close[1]) && !/\b(?:como|que (?:uso|use|usamos|te dije)|para (?:que|ver|mirar|buscar|hacer|jugar)|(?:es|esta|hay) (?:seguro|bien))\b/u.test(close[1])) {
    return { name: 'close_app', args: { app: close[1] } };
  }

  if (/^(?:abre(?:me)?|inicia|arranca) (?:el )?(?:google )?(?:chrome|navegador)$/u.test(command)) {
    return { name: 'open_app', args: { app: 'chrome' } };
  }
  if (/^(?:abre(?:me)?|inicia) (?:la )?calculadora$/u.test(command)) {
    return { name: 'open_app', args: { app: 'calculator' } };
  }

  const timer = /^(?:avisa(?:me|rme)?|recuerda(?:me)?|recordarme|pon(?:me|er(?:me)?|gas)? (?:un temporizador|una alarma)|programa(?:r)? (?:un temporizador|una alarma)|temporizador|alarma)(?: (?:dentro de|para dentro de|en|de|para))? (\d+|[a-z ]+) (segundos?|minutos?|horas?)$/u
    .exec(actionPhrase(text).replace(/^(?:(?:me )?(?:puedes|podrias|quiero que|necesito que) )/u, ''));
  if (!timer) {
    // Keep questions and compound requests on the conversational route.
    const open = /^(?:abre(?:me)?|inicia|arranca|ejecuta) (?:(?:el|la) (?:app(?:licacion)? |programa )?|(?:app(?:licacion)?|programa) )?([\p{L}\p{N}][\p{L}\p{N} .+_()#'-]{0,119})$/u.exec(command);
    if (!open || unspecifiedApp.test(open[1])
      || appContext.test(open[1])
      || /\b(?:que (?:uso|use|usamos|usaba|te dije|tengo|se llama|sirve)|para (?:que|ver|mirar|buscar|hacer|jugar|trabajar)|si (?:puedes|esta|hay))\b/u.test(open[1])) return null;
    return { name: 'open_app', args: { app: open[1] } };
  }

  const [, amount, unit] = timer;
  const count = /^\d+$/u.test(amount) ? Number(amount) : NUMBERS.get(amount);
  if (count === undefined) return null;
  const unitSeconds = { s: 1, m: 60, h: 3600 };
  return { name: 'start_timer', args: { seconds: count * unitSeconds[unit[0]] } };
}

const cursorTarget = '(?:(?:el|al|del|mi|tu|con el|con mi|con tu|a el|a mi|a tu|de el|de mi|de tu) )?(?:cursor(?: (?:del |de mi )raton)?|puntero|raton|mouse)';
const cursorRequest = /\b(?:cursor|puntero|raton|flechita del mouse|flecha del mouse|mouse)\b/u;
const cursorOrder = /^(?:(?:enganch|agarr|peg|sig[ua]|segu|acompan|aferr|solt|suelt|desenganch|despeg|liber)\w*|deja de seguir)\b/u;
const cursorImperatives = new Map([
  ['enganchate', true], ['pegate', true], ['agarrate', true], ['agarra', true], ['sigue', true],
  ['suelta', false], ['desenganchate', false], ['despegate', false]
]);
const cursorVerbAndTarget = new RegExp('^([a-z]+) ' + cursorTarget + '$', 'u');
const releaseWithoutTarget = /^(?:sueltalo|soltarlo|suelta|sueltate|desenganchate|desengancharte|desenganches|despegate|despegarte|despegues|deja de seguirlo|dejar de seguirlo|dejalo libre|vuelve a tu sitio)$/u;
const cursorVerb = /\b(?:enganch\w*|agarr\w*|peg\w*|sig[ua]\w*|segu\w*|acompan\w*|aferr\w*|mont\w*|sub\w*|solt\w*|suelt\w*|desenganch\w*|despeg\w*|desprend\w*|separ\w*|liber\w*|dej\w*|qued\w*|mov\w*|ven\w*|veng\w*|ve|vete|pon\w*|par\w*|cuelg\w*|colg\w*)\b/u;
const attachCursor = new RegExp('^(?:(?:enganchate|enganchar(?:te)?|enganches|agarrate|agarrar|agarra|agarres|pegate|pegar(?:te)?|pegues|aferrate|aferrar(?:te)?|siguelo|sigue|seguir|sigas|acompana|acompanar|acompanes|subete|subirte|ponte|ponerte) ' + cursorTarget + '|(?:muevete|moverte|ven|venir|vete|irte|quedate|quedarte) (?:con |junto a )?(?:el |mi |tu )?(?:raton|cursor|puntero|mouse))$', 'u');
const releaseCursor = new RegExp('^(?:(?:suelta|sueltalo|soltar|soltarlo|sueltes|desenganchate|desengancharte|desenganches|despegate|despegarte|despegues|separate|separarte|separes|libera|liberar|liberes|deja|dejar|dejes) ' + cursorTarget + '|(?:(?:deja|dejar|dejes|para|parar) de|(?:ya )?no(?: hace falta que| quiero que)?) (?:sigue|seguir|sigas|acompanar|acompanes|estar pegada a|moverte con) ' + cursorTarget + ')$', 'u');

function cursorActionPhrase(text) {
  return actionPhrase(text)
    .replace(/^(?:(?:ya )?(?:te )?(?:puedes|podrias|querrias)|(?:quiero|necesito|me gustaria) que(?: te)?) /u, '')
    .replace(/(?: (?:porfa|por favor|si puedes|vale))+$/u, '');
}

function oneCursorTypo(first, second) {
  const mismatch = [...first].findIndex((letter, index) => letter !== second[index]);
  if (mismatch === -1) return second.length === first.length + 1;
  const tail = first.slice(mismatch);
  const expected = second.slice(mismatch);
  if (tail.length === expected.length + 1) return tail.slice(1) === expected;
  if (expected.length === tail.length + 1) return tail === expected.slice(1);
  return tail.length === expected.length && (tail.slice(1) === expected.slice(1)
    || tail.length > 1 && tail[0] === expected[1] && tail[1] === expected[0] && tail.slice(2) === expected.slice(2));
}

function parseCursorCommand(text, followingCursor) {
  if (quotedRequest.test(text) || /["«“`]/u.test(text)) return null;
  const phrase = cursorActionPhrase(text);
  if (attachCursor.test(phrase)) return { name: 'follow_cursor', args: { enabled: true } };
  if (releaseCursor.test(phrase) || followingCursor && releaseWithoutTarget.test(phrase)) return { name: 'follow_cursor', args: { enabled: false } };
  const verb = cursorVerbAndTarget.exec(phrase)?.[1];
  if (verb) {
    const matches = [...cursorImperatives].filter(([imperative]) => verb[0] === imperative[0] && oneCursorTypo(verb, imperative));
    if (matches.length && matches.every(([, enabled]) => enabled === matches[0][1])) {
      return { name: 'follow_cursor', args: { enabled: matches[0][1] } };
    }
  }
  return null;
}

function isCursorOrder(text) {
  if (quotedRequest.test(text) || /["«“`]/u.test(text)) return false;
  const phrase = cursorActionPhrase(text);
  return cursorRequest.test(phrase) && cursorOrder.test(phrase);
}

function desktopSteps(text, vertical, horizontal, followingCursor = false) {
  const parse = part => {
    const media = mediaRequest(part);
    if (media?.action) return { name: 'control_media', args: { action: media.action, target: media.target } };
    const cursor = parseCursorCommand(part, followingCursor);
    if (cursor) return cursor;
    const destination = parseNaviPosition(part, vertical, horizontal);
    return destination ? { name: 'move_navi', args: { destination } } : parseCommand(part);
  };
  const phrase = actionPhrase(text);
  if (quotedRequest.test(text) || describesRequest.test(phrase) && !asksAboutMedia(phrase)) {
    return [{ text, command: null }];
  }
  const destination = parseNaviPosition(text, vertical, horizontal);
  if (destination) return [{ text, command: { name: 'move_navi', args: { destination } } }];
  const parts = /["«“`]/u.test(text) ? [text] : text.trim()
    .replace(/^(?:(?:oye|hey|ey|eh|hola|vale)[\s,]+)?(?:navi|navy|naby|nave)\b[\s,!:]+/iu, '')
    .replace(/^(?:oye|hey|ey|vale|por favor)\s*,\s*(?!(?:navi|navy)\b)/iu, '').split(
    /(?:\s*[,;.!?]\s*|,?\s+(?:y(?:\s+(?:luego|despu[eé]s))?|luego|despu[eé]s|a continuaci[oó]n)\s+)(?=(?:[¿¡]\s*)?(?:abre(?:me)?|inicia|arranca|ejecuta|cierra(?:me)?|sal de|pon(?:me|la|lo)?|programa|av[ií]same|recu[eé]rdame|mu[eé]vete|c[aá]mbiate|vete|ponte|p[aá]sate|(?:des)?eng[aá]nch\p{L}*|p[eé]gat\p{L}*|agarra(?:te)?|sigue|suelta(?:lo)?|desp[eé]gate|deja(?:lo| de)|qu[eé]date|ven(?:te)?|haz|(?:te )?puedes|(?:te )?podr[ií]as|(?:me )?gustar[ií]a|quiero que|igual me|quiz[aá]s? (?:me|puedas)|dime|cu[eé]ntame|busca|pausa(?:lo|la)?|para(?:lo|la)?|det[eé]n|rean[uú]da(?:lo|la)?|contin[uú]a|pasa|salta|vuelve|reinicia|repite|dale)\b)/iu
  );
  let previousTarget;
  const steps = parts.map(part => {
    const command = parse(part);
    if (command?.name === 'control_media') {
      if (command.args.target === 'current' && previousTarget && (command.args.action === 'status'
        || /^\s*(?:pausa(?:lo|la)|para(?:lo|la)|pon(?:lo|la)|rean[uú]d(?:alo|ala))\b/iu.test(part))) {
        command.args.target = previousTarget;
      }
      previousTarget = command.args.target;
    } else previousTarget = undefined;
    return { text: part, command, intents: desktopIntents(part) };
  });
  // Interpret conditions and multiple relative moves in the context of the whole request.
  if (steps.length > 1 && (/\b(?:si|a menos que|siempre que|en caso de)\b/u.test(phrase)
    || steps.some(step => /^no\b/u.test(actionPhrase(step.text)))
    || steps.filter(step => step.command?.name === 'move_navi' || step.intents.includes('move_navi')).length > 1)) {
    return [{ text, command: null }];
  }
  return steps;
}

function parseDesktopCommands(text, vertical, horizontal, followingCursor) {
  const steps = desktopSteps(text, vertical, horizontal, followingCursor);
  return steps.every(step => step.command) ? steps.map(step => step.command) : [];
}

function mediaRequest(text) {
  if (quotedRequest.test(text) || /["«“`]/u.test(text)) return null;
  const prompt = actionPhrase(text);
  const media = classifyMedia(prompt);
  if (media.candidate || !/[,;:]/u.test(text)) return media;
  const lastClause = actionPhrase(text.split(/[,;:]/u).at(-1));
  const question = classifyMedia(lastClause);
  return question.action === 'status' && !/^(?:si|imagina\w*|supongamos|explica\w*|cuentame|no)\b/u.test(prompt)
    ? question : media;
}

function desktopIntents(text) {
  const phrase = actionPhrase(text);
  if (quotedRequest.test(text) || describesRequest.test(phrase) && !asksAboutMedia(phrase)) return [];
  const canMove = /\b(?:cambia(?:te|r|rte|s|me|semos)?|cambies|muevete|moverte|muevas|vete|ir(?:te)?|vayas|fuera[sn]?|fuese[sn]?|ponte|ponerte|pongas|quedate|quedarte|pasate|pasa(?:rte|s)|pases|colocate|colocarte|desplazate|desplazarte|apartate|apartarte|molestas?|estorbas?|tapas?|deja(?:me|rme|r)?|dejes|libera(?:r)?)\b/u;
  const toScreen = /\b(?:pantallas?|monitor(?:es)?|escritorio|la otra|el otro)\b/u;
  const indirectCursor = /\b(?:haz |lo del|lo de la|como antes|me vendria bien|podrias|puedes|me gustaria|contigo|conmigo)\b/u;
  const unspecifiedMove = /^(?:(?:te )?(?:puedes|podrias) )?(?:muevete|moverte|mover|apartate|apartarte|apartar)(?: (?:un poco|un momento|de ahi))?$/u;
  const intents = [
    mediaRequest(text)?.candidate && 'control_media',
    (cursorRequest.test(phrase) || /\b(?:flechita|flechita blanca|flecha del ordenador)\b/u.test(phrase))
      && (cursorVerb.test(phrase) || indirectCursor.test(phrase)) && 'follow_cursor',
    (mentionsNaviMovement(text) || unspecifiedMove.test(phrase) || canMove.test(phrase) && (screenDestination.test(phrase) || toScreen.test(phrase))) && 'move_navi',
    (requestsTimer(text) || /\b(?:pon(?:me|er(?:me)?|gas)?|programa(?:r|s)?|programes|activa(?:r)?|crea(?:r)?|configura(?:r)?|haz(?:me)?) (?:un |una |el |la )?(?:temporizador|alarma|aviso|recordatorio)\b/u.test(phrase)
      || /\b(?:avisa(?:me|rme)?|avises|recuerda(?:me)?|recordar(?:me)?|recuerdes) (?:dentro de|en|para dentro de)\b/u.test(phrase)
      || /\b(?:aviso|recordatorio|alarma|temporizador) (?:dentro de|en|para|de)\b/u.test(phrase)
        && /\b(?:me vendria bien|me gustaria|necesito|quisiera|quiero|podrias|puedes|igual|quiza|quizas)\b/u.test(phrase)) && 'start_timer',
    (requestsOpeningApp(text) || /\b(?:abre(?:me)?|abrir(?:me)?|abras|inicia(?:me|r)?|inicies|arranca(?:r)?|ejecuta(?:r)?|ejecutes|lanza(?:r)?)(?: |$)/u.test(phrase)
      || /\b(?:quiero|quisiera|necesito|me gustaria) tener .+ abiert[oa]\b/u.test(phrase)) && 'open_app',
    /\b(?:cierra(?:me)?|cerrar(?:me)?|cierres|sal de|salir de)\b/u.test(phrase) && 'close_app'
  ].filter(Boolean);
  if (intents.length || !/^(?:(?:me )?(?:puedes|podrias) )?(?:haz(?:me|lo)?|hagas|hacer(?:me|lo)?) (?:lo de antes|lo mismo|eso|esto|lo del escritorio)\b/u.test(phrase)) return intents;
  return DESKTOP_ACTIONS;
}

function commandConfirmation(text) {
  const phrase = actionPhrase(text).replace(/\b(?:navi|navy|naby|nave) /u, '').replace(/(?: porfa| por favor)$/u, '');
  if (/^(?:si(?: si)?(?: (?:por supuesto|adelante|hazlo|claro|eso|eso es|quiero(?: que lo hagas| jugar)?|confirmo|dale|vale|gracias|vamos|seguro))?|vale(?: hazlo| adelante| si)?|venga(?: hazlo| dale)?|eso es|correcto|confirmo|adelante|dale|hazlo|de acuerdo|por supuesto)$/u.test(phrase)) return true;
  if (/^(?:no(?: (?:gracias|lo hagas|hace falta|quiero|mejor no|dejalo))?|mejor no|negativo|cancela(?:lo)?|dejalo(?: estar)?|olvidalo|nada)$/u.test(phrase)) return false;
  return null;
}

function formatDuration(seconds) {
  const parts = [];
  for (const [size, one, many] of [
    [3600, 'hora', 'horas'],
    [60, 'minuto', 'minutos'],
    [1, 'segundo', 'segundos']
  ]) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(count + ' ' + (count === 1 ? one : many));
    seconds %= size;
  }
  return parts.join(' y ');
}

module.exports = {
  MAX_TIMER_SECONDS, NAVI_DESTINATIONS, DESKTOP_ACTIONS, NAVI_LORE, formatDuration, endsConversation, answerNaviLore,
  parseNaviPosition, mentionsNaviMovement, asksAboutTimers, parseDesktopCommands, desktopSteps, desktopIntents, commandConfirmation,
  isCursorOrder
};
