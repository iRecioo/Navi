const pingPhrases = Object.freeze({
  player: ['¡Buen golpe, Mafu!', '¡Esa sí que me pilló!'],
  navi: ['¡Punto para mí!', '¡La siguiente es tuya!'],
  tie: ['Cinco a cinco. ¡Punto decisivo!'],
  won: ['Me has ganado, Mafu. ¡Buena partida!'],
  lost: ['¡Esta partida es mía, Mafu!']
});

async function preparePongVoice(synthesize, signal) {
  const phrases = Object.entries(pingPhrases).flatMap(([group, lines]) => lines.map((text, index) => ({ group, index, text })));
  const clips = {};
  // The same local engine serves normal Navi speech. Queue its warm-up requests.
  for (const { group, index, text } of phrases) {
    if (signal.aborted) break;
    try {
      const result = await synthesize(text, signal);
      if (result?.wav && !signal.aborted) clips[group + index] = result.wav;
    } catch (error) {
      if (!signal.aborted) console.warn('Navi, frase de Ping Pong:', error.message);
    }
  }
  return clips;
}

module.exports = { pingPhrases, preparePongVoice };
