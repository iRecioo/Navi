importScripts('game-core.js');
self.onmessage = ({ data: { channels, rate, duration } }) => {
  try {
    postMessage({ notes: Rhythm.analyze(channels, rate, duration) });
  } catch {
    postMessage({ error: 'No pude analizar el ritmo de ese archivo.' });
  }
};
