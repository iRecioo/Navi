function naviMaintenanceIntent(text) {
  if (/[«»“”"`]/u.test(text)) return null;
  const normalized = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const spoken = normalized.replace(/^(?:(?:oye|hey|ey|eh|hola|buenas|escucha|mira|vale|bueno|por favor|navi|navy|nave) )+/u, '')
    .replace(/(?: (?:navi|navy|nave|por favor|porfa|ya))+$/u, '');
  const phrase = spoken.replace(/^(?:(?:te )?(?:puedes|podrias|te importaria|quiero que) )/u, '');
  if (/^(?:cierrate|cerrarte|cerrar|cierres|sal(?:te)?(?: de (?:la app|la aplicacion|navi))?|salir(?: de (?:la app|la aplicacion|navi))?|(?:cierra|cerrar|cierres|sal de) (?:la app|la aplicacion|el programa|navi)|apagate|apagarte|apagues)$/u.test(phrase)
      || /^(?:(?:oye|hey|ey|eh|hola|buenas|escucha|mira) )?(?:cierra|cerrar|salir de|cierra la app de) (?:navi|navy|nave)(?: por favor| porfa)?$/u.test(normalized)) return 'quit';
  if (/^(?:(?:comprueba|comprueba si hay|comprobar si hay|buscar si hay|revisar si hay|ver si hay|busca|mira si hay|mira|revisa|buscar|comprobar|consultar|revisar|consultame|dime si hay) (?:nuevas )?actualizaciones(?: disponibles| de navi)?|(?:tienes|hay|hay alguna|tienes alguna|tienes alguna nueva) (?:nuevas? )?actualizaci(?:on|ones)(?: nuevas?| disponibles?)?|(?:hay|tienes|busca|comprueba si hay) (?:alguna |una )?(?:nueva version|version nueva)(?: disponible)?)$/u.test(phrase)) return 'check';
  if (/^(?:actualizate|actualizarte|actualices|actualiza(?: la aplicacion| la app| navi)?|(?:descarga|instala|descargar|instalar|descargues|instales|aplica) (?:la |las )?(?:ultima |nueva )?(?:actualizacion(?:es)?|version(?: nueva)?|version de navi))$/u.test(phrase)) return 'install';
  if (/^(?:que version (?:tienes|usas|eres)|cual es tu version|dime tu version|version de navi)$/u.test(phrase)) return 'version';
  return null;
}

module.exports = { naviMaintenanceIntent };
