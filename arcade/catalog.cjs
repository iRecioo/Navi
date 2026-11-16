const games = Object.freeze([
  { id: 'rhythm', label: 'Ritmo · Spotify', command: 'ritmo', names: ['ritmo', 'spotify', 'ritmo con spotify', 'juego de ritmo', 'lista de mafu', 'playlist de spotify'] },
  { id: 'pong', label: 'Ping Pong', command: 'ping pong', names: ['ping pong', 'ping pon', 'pin pon', 'pin pong', 'pong', 'tenis de mesa', 'juego de las palas', 'palas'] },
  { id: 'four', label: 'Cuatro en raya', command: 'cuatro en raya', names: ['cuatro en raya', '4 en raya', 'conecta cuatro', 'conecta 4', 'cuatro en linea', '4 en linea'] },
  { id: 'pairs', label: 'Parejas', command: 'parejas', names: ['parejas', 'memoria', 'juego de memoria', 'juego de las parejas', 'juego de parejas', 'las cartas'] },
  { id: 'reflex', label: 'Reflejos', command: 'reflejos', names: ['reflejos', 'juego de reflejos', 'tiempo de reaccion', 'reaccion', 'prueba de reflejos'] }
].map(game => Object.freeze(game)));

const ordinals = ['uno', 'dos', 'tres', 'cuatro', 'cinco'];
const positions = ['primero', 'segundo', 'tercero', 'cuarto', 'quinto'];
const menuChoices = games.map(({ label, command }) => ({ label, command }));

function gameIntent(text, choosing = false) {
  if (/["«“`]/u.test(text)) return null;
  const phrase = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/gu, ' ').trim()
    .replace(/^(?:(?:oye|hey|ey|vale|y|entonces|bueno|navi|navy|nave)\s+)+/u, '')
    .replace(/(?: (?:navi|navy|nave|por favor|porfa))+$/u, '');
  if (/^(?:(?:yo )?quiero|me apetece|me gustaria|vamos a|podemos|podriamos|puedo|te apetece|te gustaria)?\s*jugar(?: (?:algo|a algo|a alguna cosa|algo contigo|contigo|un rato|una partida|un juego|un minijuego|a un minijuego|a algun juego|a algun minijuego))?$/u.test(phrase)
    || /^(?:a que|que) jugamos(?: hoy| ahora)?$/u.test(phrase)
    || /^(?:muestrame|ensename|abre|ponme|dime) (?:tus |los |el menu de )?(?:mini)?juegos$/u.test(phrase)) return { type: 'menu' };
  if (choosing && /^(?:no|cancelar?|salir|mejor no|da igual|otro dia|ninguno)$/u.test(phrase)) return { type: 'cancel' };

  const command = /^(?:(?:yo )?quiero jugar|me gustaria jugar|me apetece jugar|vamos a jugar|podemos jugar|podriamos jugar|jugar|pon(?:me)?|abre|inicia|elige|elijo|prefiero|quiero|me quedo con|vamos con|jugamos) (.+)$/u.exec(phrase);
  if (!command && !choosing && !/^(?:al |al de |a la |a las )/u.test(phrase)) return null;
  const target = (command?.[1] || phrase).replace(/^(?:al |a la |a las |a |con la |con |el |la |los |las )/u, '')
    .replace(/^(?:el |la )?de (?:las? |los? )?/u, '').replace(/ (?:porfa|ahora|hoy)$/u, '');
  if (choosing) {
    const option = target.replace(/^(?:opcion |numero )+/u, '');
    let index = ordinals.indexOf(option === 'un' ? 'uno' : option);
    if (index < 0) index = positions.indexOf(option.replace(/a$/u, 'o'));
    if (index < 0 && /^[1-5]$/u.test(option)) index = Number(option) - 1;
    if (index >= 0) return { type: 'game', id: games[index].id };
  }
  const game = games.find(item => item.names.includes(target));
  return game ? { type: 'game', id: game.id } : null;
}

module.exports = { games, gameIntent, menuChoices };
