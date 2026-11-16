'use strict';

const title = document.getElementById('title');
const artist = document.getElementById('artist');
const message = document.getElementById('message');
const score = document.getElementById('score');
const misses = document.getElementById('misses');
const combo = document.getElementById('combo');
const judgement = document.getElementById('judgement');
const progress = document.getElementById('progress');
const focusGame = document.getElementById('focus-game');
const openSpotify = document.getElementById('open-spotify');
const lanes = [...document.querySelectorAll('.lane')];
const target = lanes[0].querySelector('.receptor');
const travelTime = 1.42;
const inputDeliveryGrace = .060;
const labels = { perfect: '¡Perfecto!', good: 'Bien', okay: 'A tiempo', miss: 'Fallo' };
const sprites = new Map();
let startAt = Infinity;
let spotify = false;
let spotifyOrigin = 0;
let spotifyOutputDelay = 0;
let spotifyState;
let spotifyProgress;
let spotifyError;
let duration;
let scorer;
let context;
let source;
let preparedAudio;
let frame;
let finished = false;
let clearAt = 0;
let lookAhead = 0;
let hitY = 0;
let hasFocus = document.hasFocus();
let pausedForFocus = false;
let audioReady = false;
let globalInput = false;
let focusChange = Promise.resolve();
const pressed = new Set();
const laneFlashes = lanes.map(() => 0);
const lastGlobalHit = lanes.map(() => -Infinity);

function setHitLine() {
  // Arrows and receivers have the same height. Match their tops at the hit instant.
  hitY = Math.max(1, target.offsetTop);
}
window.addEventListener('resize', setHitLine);
function updateFocus(focused) {
  hasFocus = focused || globalInput;
  focusGame.hidden = hasFocus || spotify && spotifyState === 'waiting';
  if (!hasFocus) {
    for (const lane of pressed) lanes[lane].classList.remove('lit');
    pressed.clear();
    pausedForFocus = Boolean(source && !finished);
    message.textContent = '';
  }
  focusChange = focusChange.then(async () => {
    if (!audioReady || finished || spotify) return;
    if (!hasFocus) {
      await context.suspend();
      return;
    }
    await context.resume();
    if (!hasFocus || finished) return;
    pausedForFocus = false;
    if (!source) beginPlayback();
  }).catch(() => { void window.naviRhythm.fail('No pude activar el audio de la partida.'); });
}
window.addEventListener('blur', () => updateFocus(false));
window.addEventListener('focus', () => updateFocus(true));
focusGame.addEventListener('click', () => {
  if (document.hasFocus()) updateFocus(true);
});
updateFocus(hasFocus);

function songTime(now = performance.now()) {
  if (spotify) return (performance.timeOrigin + now - spotifyOrigin) / 1000 - spotifyOutputDelay;
  const output = context.getOutputTimestamp();
  if (output.performanceTime > 0 && output.contextTime > 0) {
    return Math.min(context.currentTime, output.contextTime + (now - output.performanceTime) / 1000) - startAt;
  }
  return context.currentTime - startAt;
}

function finishPlayback() {
  if (finished) return;
  finished = true;
  cancelAnimationFrame(frame);
  scorer.expire(Infinity);
  void window.naviRhythm.finish(scorer.stats);
}

function setJudgement(result, time) {
  if (!result) return;
  judgement.textContent = labels[result.accuracy];
  judgement.dataset.accuracy = result.accuracy;
  clearAt = time + .45;
}

function playFrame() {
  if (finished) return;
  if (pausedForFocus) {
    frame = requestAnimationFrame(playFrame);
    return;
  }
  const time = songTime();
  if (!spotify && time >= duration) {
    finishPlayback();
    return;
  }
  setJudgement(scorer.expire(time - inputDeliveryGrace), time);
  if (time > clearAt) judgement.textContent = '';
  if (spotify) {
    message.textContent = spotifyError || ({
      starting: 'Iniciando la lista de Mafu…',
      waiting: 'Pulsa ▶ en la playlist si Spotify sigue en pausa.',
      tracking: 'Buscando el pulso…',
      'no-audio': 'Esperando el audio de Spotify…',
      paused: 'Spotify en pausa'
    })[spotifyState] || '';
  } else {
    message.textContent = time < 0 ? String(Math.ceil(-time)) : '';
  }
  combo.textContent = scorer.stats.combo > 1 ? scorer.stats.combo + '×' : '';
  score.textContent = scorer.stats.score.toLocaleString('es-ES') + ' pts';
  misses.textContent = scorer.stats.misses + (scorer.stats.misses === 1 ? ' fallo' : ' fallos');
  progress.value = Math.max(0, Math.min(1, spotify ? spotifyProgress || 0 : time / duration));
  lanes.forEach((lane, i) => {
    if (globalInput) lane.classList.toggle('lit', time < laneFlashes[i]);
    lane.classList.remove('on-beat');
  });
  for (; lookAhead < scorer.notes.length && scorer.notes[lookAhead].time - time < travelTime; lookAhead++) {
    const note = scorer.notes[lookAhead];
    if (note.judged) continue;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '▼';
    arrow.setAttribute('aria-hidden', 'true');
    lanes[note.lane].append(arrow);
    sprites.set(note, arrow);
  }
  for (const [note, arrow] of sprites) {
    if (note.judged) {
      arrow.remove();
      sprites.delete(note);
      continue;
    }
    const remaining = note.time - time;
    arrow.style.transform = 'translateY(' + ((1 - remaining / travelTime) * hitY) + 'px)';
    if (Math.abs(remaining) <= Rhythm.WINDOWS.perfect) lanes[note.lane].classList.add('on-beat');
  }
  frame = requestAnimationFrame(playFrame);
}

document.addEventListener('keydown', event => {
  if (event.code === 'Escape') {
    void window.naviRhythm.cancel();
    return;
  }
  const lane = Rhythm.KEYS.indexOf(event.code);
  if (lane >= 0 && globalInput) { event.preventDefault(); return; }
  if (lane < 0 || event.repeat || pressed.has(lane) || !hasFocus || (!source && spotifyState !== 'playing') || pausedForFocus || finished) return;
  event.preventDefault();
  pressed.add(lane);
  lanes[lane].classList.add('lit');
  const time = songTime(event.timeStamp);
  if (time >= -Rhythm.WINDOWS.okay) setJudgement(scorer.press(lane, time), time);
});

document.addEventListener('keyup', event => {
  const lane = Rhythm.KEYS.indexOf(event.code);
  if (pressed.delete(lane)) lanes[lane].classList.remove('lit');
});

window.naviRhythm.onHit?.((lane, queuedMs) => {
  if (!globalInput || (!source && spotifyState !== 'playing') || finished || !Number.isInteger(lane) || !lanes[lane]) return;
  const now = performance.now();
  const stamped = Number.isFinite(queuedMs) ? queuedMs - performance.timeOrigin : now;
  const time = songTime(Math.max(now - 250, Math.min(now, stamped)));
  const gap = time - lastGlobalHit[lane];
  lastGlobalHit[lane] = time;
  if (gap < Rhythm.GLOBAL_REPEAT_GAP) return;
  laneFlashes[lane] = time + .11;
  if (time >= -Rhythm.WINDOWS.okay) setJudgement(scorer.press(lane, time), time);
});

function chartAudio(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('analysis-worker.js');
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.notes);
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('No pude preparar las notas.'));
    };
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) },
      (_, channel) => buffer.getChannelData(channel).slice());
    worker.postMessage({ channels, rate: buffer.sampleRate, duration: buffer.duration }, channels.map(channel => channel.buffer));
  });
}

async function estimateSpotifyDelay() {
  let probe;
  try {
    probe = new AudioContext({ latencyHint: 'interactive' });
    await probe.resume();
    // Set the offset before any arrow is on screen. Never shift a visible note.
    if (!finished && !scorer.notes.length && Number.isFinite(probe.outputLatency)) {
      spotifyOutputDelay = Math.min(.20, Math.max(0, probe.outputLatency));
    }
  } catch {
    // The packet clock works even if audio latency is unavailable.
  } finally {
    if (probe && probe.state !== 'closed') await probe.close().catch(() => {});
  }
}

function spotifyEvent(event) {
  switch (event.type) {
    case 'clock':
      spotifyOrigin = event.origin;
      break;
    case 'state':
      spotifyState = event.value;
      openSpotify.hidden = event.value !== 'waiting';
      focusGame.hidden = hasFocus || event.value === 'waiting';
      if (event.value !== 'waiting') spotifyError = undefined;
      break;
    case 'song':
      title.textContent = event.title;
      artist.textContent = event.artist;
      break;
    case 'progress':
      spotifyProgress = event.position / event.duration;
      break;
    case 'notes':
      scorer.append(event.notes);
      break;
    case 'discard':
      scorer.discardFuture(event.cutoff);
      lookAhead = Math.min(lookAhead, scorer.notes.length);
      for (const [note, arrow] of sprites) {
        if (note.time > event.cutoff) {
          arrow.remove();
          sprites.delete(note);
        }
      }
      break;
    case 'end':
      finishPlayback();
      break;
  }
}

openSpotify.addEventListener('click', async () => {
  const opened = await window.naviRhythm.openSpotify().catch(() => false);
  if (!opened) spotifyError = 'Abre la app de Spotify y reproduce la lista de Mafu.';
});

async function prepare() {
  const song = await window.naviRhythm.load();
  if (!song) throw new Error('No pude leer el archivo de la canción.');
  globalInput = song.globalInput === true;
  if (song.spotify) {
    spotify = true;
    scorer = Rhythm.createScorer([]);
    setHitLine();
    updateFocus(document.hasFocus());
    title.textContent = 'Playlist de Mafu';
    void estimateSpotifyDelay();
    window.naviRhythm.onSpotify(spotifyEvent);
    if (!await window.naviRhythm.startSpotify()) throw new Error('No pude iniciar el modo Spotify.');
    frame = requestAnimationFrame(playFrame);
    return;
  }
  title.textContent = song.title;
  artist.textContent = song.artist || '';
  context = new AudioContext();
  let audio;
  try {
    audio = await context.decodeAudioData(song.audio);
  } catch {
    throw new Error('Navi no pudo abrir ese audio. Prueba con MP3, WAV, OGG o FLAC.');
  }
  duration = audio.duration;
  if (duration < 3 || duration > 900) throw new Error('Elige una canción de entre tres segundos y quince minutos.');
  const notes = song.chart || await chartAudio(audio);
  if (notes.length < 4) throw new Error('No encontré suficientes golpes claros en esta canción.');
  const accepted = await window.naviRhythm.chart(notes, duration);
  if (!accepted) throw new Error('No se pudo preparar la partida.');
  scorer = Rhythm.createScorer(notes);
  setHitLine();
  audioReady = true;
  preparedAudio = audio;
  updateFocus(document.hasFocus());
}

function beginPlayback() {
  startAt = context.currentTime + 3;
  source = context.createBufferSource();
  source.buffer = preparedAudio;
  preparedAudio = undefined;
  source.connect(context.destination);
  source.start(startAt);
  playFrame();
}

window.addEventListener('pagehide', () => {
  finished = true;
  cancelAnimationFrame(frame);
  if (source) {
    source.stop();
  }
  if (context && context.state !== 'closed') void context.close();
}, { once: true });

prepare().catch(error => { void window.naviRhythm.fail(error.message); });
