const { spawn } = require('node:child_process');
const path = require('node:path');
const { watchSpotify, shuffleSpotify, invokeSpotifyPlaylist, pauseSpotify } = require('../windows-media.cjs');
const { createLiveBeats, rate } = require('./live-beats.cjs');
const { playlistKey, playlistUri } = require('./playlist.cjs');

const { createSpotifyPlayback } = require('./spotify-start.cjs');

const appPath = path.join(__dirname, 'native', 'spotify-loopback.exe').replace(/\.asar([\\/])/u, '.asar.unpacked$1');

function findTrack(tracks, { title, artist, duration }) {
  const titleKey = playlistKey(title);
  if (!titleKey) return null;
  const artistKeys = value => String(value || '').split(/[,;&]/u).map(playlistKey).filter(Boolean);
  const names = artistKeys(artist);
  const candidates = tracks.filter(track => playlistKey(track.title) === titleKey);
  const named = candidates.filter(track => artistKeys(track.artist).some(name => names.includes(name)));
  if (named.length === 1) return named[0];
  if (named.length > 1 && duration > 0) {
    const sameLength = named.filter(track => Math.abs(track.duration / 1000 - duration) < 3);
    if (sameLength.length === 1) return sameLength[0];
  }
  return names.length === 0 && candidates.length === 1 ? candidates[0] : null;
}

function captureSpotify(onPacket, onError) {
  const child = spawn(appPath, [String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = Buffer.alloc(0);
  let diagnostics = '';
  let stopped = false;
  function stop() {
    stopped = true;
    child.kill();
  }
  function fail(error) {
    if (stopped) return;
    stop();
    onError(error);
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-350); });
  child.stdout.on('data', chunk => {
    if (stopped) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (!stopped && pending.length >= 16) {
      const time = pending.readDoubleLE(0);
      const frames = pending.readUInt32LE(8);
      if (!Number.isFinite(time) || frames < 1 || frames > 44100 || pending.readUInt32LE(12)) {
        fail(new Error('Formato inesperado en el audio de Spotify.'));
        return;
      }
      const length = 16 + frames * 4;
      if (pending.length < length) break;
      const pcm = pending.subarray(16, length);
      pending = pending.subarray(length);
      onPacket(time, pcm);
    }
  });
  child.once('error', fail);
  child.once('close', code => fail(new Error(diagnostics.trim() || 'Capturador cerrado (' + code + ')')));
  return stop;
}

function createSpotifyGame({ tracks, openPlaylist, send, fail, restoreFocus }, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const monitor = dependencies.watch || watchSpotify;
  const capture = dependencies.capture || captureSpotify;
  const origin = now();
  const elapsed = () => (now() - origin) / 1000;
  const position = () => observedPosition + (resumedAt === undefined ? 0 : Math.max(0, elapsed() - resumedAt));
  const notes = [];
  let state;
  let song;
  let duration;
  let lastTimeline;
  let observedPosition = 0;
  let resumedAt;
  let capturedAt;
  let lastPacketAt;
  let lastCaptureStart;
  let lastCaptureEnd;
  let captureSeen;
  let audioWaitStarted;
  let captureProgress;
  let lastNoteAt;
  let resumedAudioAt;
  let audioStarted;
  let stopMonitor;
  let stopCapture;
  let deadline;
  let deadlineCheck;
  let stopped = false;
  let ended = false;

  const tracker = createLiveBeats(batch => {
    if (stopped || state === 'paused') return;
    const remaining = lastTimeline?.duration ? lastTimeline.duration - currentPosition(lastTimeline) : duration - position();
    const playTime = elapsed();
    const playable = batch.filter(note => note.time - playTime >= .80 && note.time - playTime < remaining - .18);
    if (!playable.length) return;
    notes.push(...playable);
    lastNoteAt = playable.at(-1).time;
    setState('playing');
    send({ type: 'notes', notes: playable });
  }, (time, reason) => {
    // Keep notes in the current judgement window so a confirmed hit is never erased.
    discardNotes(Math.max(time, elapsed()) + .22);
    if (reason === 'gap') console.info('Navi, ritmo: el audio volvió tras un salto de captura.');
    setState('tracking');
    return notes.at(-1)?.time;
  });

  const playback = createSpotifyPlayback({
    tracks, now, open: openPlaylist,
    invoke: dependencies.invoke || invokeSpotifyPlaylist,
    shuffle: dependencies.shuffle || shuffleSpotify,
    pause: dependencies.pause || pauseSpotify,
    publish: setState,
    showManual: () => openPlaylist(playlistUri).then(() => true, () => false),
    accept(track) {
      song = track;
      duration = track.duration / 1000;
      resumedAt = elapsed();
      resumedAudioAt = resumedAt;
      send({ type: 'song', title: track.title, artist: track.artist, duration });
      restoreFocus?.();
    }
  });

  function setState(value) {
    if (state === value) return;
    state = value;
    send({ type: 'state', value });
  }

  function currentPosition(timeline) {
    const age = (now() - timeline.updated) / 1000;
    return timeline.position + (timeline.status === 'Playing' && age >= 0 && age < timeline.duration ? age : 0);
  }

  function discardNotes(cutoff) {
    while (notes.at(-1)?.time > cutoff) notes.pop();
    send({ type: 'discard', cutoff });
  }

  function clearNotes(cutoff) {
    discardNotes(cutoff);
    tracker.reset(notes.at(-1)?.time);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(deadlineCheck);
    playback.stop();
    stopCapture?.();
    stopMonitor?.();
  }

  function end() {
    if (ended) return;
    ended = true;
    clearNotes(elapsed() + .22);
    stop();
    send({ type: 'end' });
  }

  function handleStatus(status) {
    if (stopped) return;
    const track = status.title ? findTrack(tracks, status) : null;
    const knownTimeline = status.duration > 3 && status.position >= 0 && status.position <= status.duration + 1
      && Number.isFinite(status.updated) && status.updated > origin - 86_400_000;
    if (!song) {
      playback.status(status, track, knownTimeline ? currentPosition(status) : 0, knownTimeline);
      if (!song) return;
    } else if (status.title && song.uri !== track?.uri) {
      const expectedEnd = lastTimeline ? currentPosition(lastTimeline) >= lastTimeline.duration - 5
        : position() >= duration - 5;
      if (expectedEnd) end();
      else fail('La canción de Spotify cambió antes de terminar la partida.');
      return;
    }

    const timeline = knownTimeline && (status.status !== 'Playing' || now() - status.updated <= (status.duration + 2) * 1000)
      ? status : null;
    // WinRT occasionally emits an empty snapshot while the PCM stream is fine.
    if (status.status !== 'Playing') {
      const nearEnd = lastTimeline ? currentPosition(lastTimeline) >= lastTimeline.duration - 3
        : position() >= duration - 3;
      if (status.status === 'Stopped' && nearEnd) {
        end();
        return;
      }
      if (!status.status) return;
      if (state !== 'paused') {
        observedPosition = position();
        resumedAt = undefined;
        audioWaitStarted = undefined;
        setState('paused');
        clearNotes(elapsed() + .22);
      }
      if (timeline) lastTimeline = timeline;
      return;
    }

    if (resumedAt === undefined) {
      resumedAt = elapsed();
      resumedAudioAt = resumedAt;
    }

    if (timeline) {
      const advanced = lastTimeline?.status === 'Playing' && timeline.updated > lastTimeline.updated;
      const movement = advanced ? currentPosition(timeline) - currentPosition(lastTimeline) : 0;
      if (advanced && Math.abs(movement) > 2 && Math.abs(timeline.position - lastTimeline.position) > 1.25) {
        if (currentPosition(lastTimeline) >= lastTimeline.duration - 3 && timeline.position < 1.5) {
          end();
          return;
        }
        clearNotes(elapsed() + .22);
        setState('tracking');
      }
      observedPosition = currentPosition(timeline);
      resumedAt = elapsed();
      lastTimeline = timeline;
      send({ type: 'progress', position: currentPosition(timeline), duration: timeline.duration });
      if (currentPosition(timeline) >= timeline.duration - .05) {
        end();
        return;
      }
    } else {
      lastTimeline = null;
      send({ type: 'progress', position: position(), duration });
    }

    if (!timeline && position() >= duration + 2) {
      end();
      return;
    }
    if (state === 'starting' || state === 'waiting' || state === 'paused') {
      setState('tracking');
      if (!audioStarted) deadline = now() + 12000;
      lastPacketAt = now();
      lastCaptureStart = lastCaptureEnd = captureSeen = undefined;
    }
    if (!stopCapture) {
      stopCapture = capture((time, pcm) => {
        if (stopped || state === 'paused') return;
        const receipt = now();
        const receivedAt = (receipt - origin) / 1000;
        const packetLength = pcm.length / (4 * rate);
        let packetAt = (time - origin) / 1000;
        // Windows normally timestamps the first PCM sample. Recover isolated bad
        // timestamps from contiguous sample counts without restarting beat detection.
        if (lastCaptureStart !== undefined && packetAt <= lastCaptureStart && receivedAt - captureSeen < .06) {
          packetAt = lastCaptureEnd;
        }
        if (Math.abs(receivedAt - packetAt) > .90) {
          packetAt = lastCaptureEnd !== undefined && receivedAt - captureSeen < .35
            ? lastCaptureEnd : receivedAt - packetLength;
        }
        if (packetAt < resumedAudioAt - .45) return;
        lastPacketAt = receipt;
        captureSeen = receivedAt;
        lastCaptureStart = packetAt;
        lastCaptureEnd = packetAt + packetLength;
        tracker.feed(packetAt, pcm);
        if (tracker.audibleAt() > (capturedAt ?? -Infinity)) {
          audioStarted = true;
          capturedAt = tracker.audibleAt();
        }
      }, error => {
        console.warn('Navi, audio de Spotify:', error.message);
        fail('No pude captar el audio de la aplicación de Spotify en Windows.');
      });
    }
  }

  function start() {
    setState('starting');
    send({ type: 'clock', origin });
    stopMonitor = monitor(handleStatus, error => {
      console.warn('Navi, estado de Spotify:', error.message);
      fail('No pude leer qué canción reproduce la aplicación de Spotify.');
    });
    playback.start();
    const checks = () => {
      if (stopped) return;
      if (deadline && now() > deadline && !audioStarted && state !== 'paused') {
        fail('Spotify muestra que está reproduciendo, pero no me llega su audio. Comprueba el volumen y que suene en este PC.');
        return;
      }
      if (song && state !== 'paused' && lastPacketAt !== undefined && now() - lastPacketAt > 2100) {
        if (audioWaitStarted === undefined) {
          audioWaitStarted = now();
          clearNotes(elapsed() + .22);
          setState('no-audio');
          console.warn('Navi, ritmo: el capturador dejó de entregar paquetes de Spotify.');
        }
        if (now() - audioWaitStarted > 9000) {
          fail('Se interrumpió el audio de Spotify. Vuelve a decir «quiero jugar» para reconectar.');
          return;
        }
      } else if (audioWaitStarted !== undefined) {
        audioWaitStarted = undefined;
        if (state === 'no-audio') setState('tracking');
      }
      if (state === 'playing' && (elapsed() - capturedAt > 3 || elapsed() - lastNoteAt > 2.5)) setState('tracking');
      if (song && state !== 'paused' && now() - (captureProgress || 0) >= 10000) {
        captureProgress = now();
        console.info('Navi, ritmo:', notes.length, 'notas;', lastPacketAt === undefined
          ? 'esperando audio' : 'último paquete hace ' + (now() - lastPacketAt) + ' ms');
      }
      deadlineCheck = setTimeout(checks, 1000);
      deadlineCheck.unref?.();
    };
    checks();
  }

  return { start, stop, openPlaylist: () => playback.manual(), song: () => song,
    readyToSave: () => ended, count: () => notes.length };
}

module.exports = { createSpotifyGame };
