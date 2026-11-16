const MEDIA_ACTIONS = Object.freeze({
  pause: { reply: 'He pausado la reproducción.', question: 'pause la reproducción' },
  play: { reply: 'He reanudado la reproducción.', question: 'reanude la reproducción' },
  next: { reply: 'He pasado al siguiente.', question: 'pase al siguiente' },
  previous: { reply: 'He pedido el anterior.', question: 'vuelva al anterior' },
  restart: { reply: 'He vuelto al principio.', question: 'vuelva al principio' },
  status: { question: 'te diga qué está sonando' }
});
const MEDIA_TARGETS = ['current', 'spotify', 'youtube', 'browser', 'chrome', 'edge', 'firefox'];
const mediaNames = 'spotify|you\\s?tube|chrome|edge|firefox|navegador';
const platforms = new RegExp('\\b(?:' + mediaNames + ')\\b', 'u');
const platformSuffix = new RegExp('(?: (?:de|en))? (?:el )?(?:' + mediaNames + ')$', 'u');
const platformModifier = new RegExp(' (?:de|en) (?:el )?(?:' + mediaNames + ')(?= (?:desde|al) )', 'u');
const mediaName = '(?:cancion|musica|video|pista|tema|audio|reproduccion|podcast|episodio)';
const item = '(?:(?:la|el|mi|esta|este|esa|ese) )?' + mediaName + '(?: actual)?';
const playing = 'lo que (?:suena|esta sonando|estoy viendo|estoy escuchando|esta puesto)';
const mediaItem = /\b(?:cancion(?:es)?|musica|video(?:s)?|pista(?:s)?|tema|audio|reproduccion|podcast|episodio|playlist|lista de reproduccion)\b/u;
const mediaVerb = /\b(?:paus\w*|parar?|paralo|pares|deten\w*|continua\w*|sigue|seguir|rean\w*|reproduc\w*|adelant\w*|salt\w*|pas[aeo]\w*|vuelv\w*|volv\w*|regres\w*|retroced\w*|pon\w*|reinici\w*|repite|repet\w*|empieza|empez\w*|siguiente|anterior|cambia\w*)\b/u;

const pause = new RegExp('^(?:pausa|pausar|pauses|para|parar|pares|deten|detener|detengas)(?: (?:un (?:momento|segundo) )?(?:' + item + '|' + playing + '))?$', 'u');
const play = new RegExp('^(?:reanuda|reanudar|reanudes|continua|continuar|sigue|seguir|reproduce|reproducir)(?: con)?(?: (?:' + item + '|' + playing + '))?$', 'u');
const restart = new RegExp('^(?:pon(?:la|lo)?|poner(?:la|lo)?|empieza|empezar|reproduce|reproducir)(?: ' + item + ')? desde (?:el principio|el inicio|cero)$', 'u');
const repeat = new RegExp('^(?:reinicia|reiniciar|repite|repetir) ' + item + '(?: desde (?:el principio|el inicio|cero))?$', 'u');
const change = /^(?:(?:dale|salta|saltar|pasa|pasar|vuelve|volver|regresa|regresar) a(?:l)? |(?:pon|ponme|salta|pasame) )?(?:(?:la|el) )?(?:(?:cancion|video|pista|tema|episodio) )?(siguiente|anterior)(?: (?:cancion|video|pista|tema|episodio))?$/u;
const previous = /^(?:(?:vuelve|regresa|volver) (?:hacia )?atras|retrocede una pista)$/u;
const mediaQuestion = /^(?:que (?:estoy escuchando|estoy viendo|estoy oyendo|suena|esta sonando|esta puesto|tengo puesto|se esta reproduciendo|se reproduce)|(?:que|cual es la) (?:cancion|musica|pista) (?:es|suena|esta sonando|estoy escuchando)|(?:que|cual es el) (?:tema|video|podcast|episodio) (?:es|suena|esta puesto|estoy viendo)|como se llama (?:la cancion|el tema|el video|lo que suena|lo que estoy escuchando|esto que suena)|quien canta (?:esto|eso|esta cancion|la cancion|lo que suena))\b/u;

function asksAboutMedia(phrase) {
  return mediaQuestion.test(phrase
    .replace(/^(?:(?:(?:me )?(?:puedes|podrias|podrias por favor) (?:decirme|decir)|dime|sabes|me dices|te importaria decirme) )+/u, ''))
    && !/\b(?:shazam|identifica(?:r)? por (?:el )?microfono|por la calle|en la radio del coche|donde sale|donde aparece|en el que aparece)\b/u.test(phrase);
}

function mediaOperation(phrase, hasPlatform) {
  if (restart.test(phrase) || repeat.test(phrase)
    || /^(?:vuelve|volver|regresa|regresar) (?:al|a su) (?:principio|inicio)$/u.test(phrase)) return 'restart';
  if (/^(?:pausa(?:lo|la)|para(?:lo|la)|dale a (?:la )?pausa)$/u.test(phrase)
    || pause.test(phrase) && (hasPlatform || phrase.includes(' '))) return 'pause';
  if (/^(?:reanudalo|reanudala|dale al play|quita la pausa)$/u.test(phrase)
    || play.test(phrase) && (hasPlatform || phrase.includes(' '))) return 'play';
  if (previous.test(phrase) || /^(?:pon|vuelve a|regresa a) (?:la|el) de antes$/u.test(phrase)) return 'previous';
  if (/^cambia de (?:cancion|tema|pista|video)$/u.test(phrase)) return 'next';
  const direction = change.exec(phrase)?.[1];
  if (direction) return direction === 'siguiente' ? 'next' : 'previous';
  return null;
}

function classifyMedia(phrase) {
  const match = platforms.exec(phrase);
  const platform = match?.[0].replace(/\s/gu, '');
  const target = !platform ? 'current' : platform === 'navegador' ? 'browser' : platform;
  const hasSecondPlatform = match && platforms.test(phrase.slice(match.index + match[0].length));
  const actionText = phrase
    .replace(/^(?:(?:me )?(?:puedes|podrias)|(?:quiero|necesito|me gustaria) que) /u, '')
    .replace(/^(?:dime|decirme|sabes|decir|me dices) /u, '')
    .replace(/(?: (?:porfa|por favor|si puedes|vale))+$/u, '')
    .replace(platformModifier, '')
    .replace(platformSuffix, '');
  const qualified = !hasSecondPlatform && !/\b(?:no (?:quiero|hagas|pares|pauses)|si (?!puedes\b)|solo cuando|despues|luego|y|o)\b/u.test(phrase);
  const status = asksAboutMedia(actionText);
  const operation = mediaOperation(actionText, Boolean(match));
  const action = qualified ? (operation || (status ? 'status' : null)) : null;
  const candidate = Boolean(action) || status || (mediaItem.test(phrase) || match) && mediaVerb.test(phrase)
    || /\b(?:lo repit(?:as|a)|repetirlo|repite(?:lo|la)|pon(?:la|lo)|vuelv(?:e|as)) (?:desde el (?:principio|inicio)|desde cero|(?:hacia )?atras)\b/u.test(phrase)
    || /^(?:dale a (?:la )?pausa|dale al (?:play|siguiente|anterior))$/u.test(phrase);
  return { action, target, candidate };
}

function validMediaAction(args) {
  return typeof args?.action === 'string' && Object.hasOwn(MEDIA_ACTIONS, args.action) && MEDIA_TARGETS.includes(args.target);
}

module.exports = { MEDIA_ACTIONS, MEDIA_TARGETS, classifyMedia, validMediaAction, asksAboutMedia };
