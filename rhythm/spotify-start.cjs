const { randomInt } = require('node:crypto');
const { playlistUri } = require('./playlist.cjs');

function createSpotifyPlayback({ tracks, open, invoke, shuffle, pause, publish, showManual, accept, now = Date.now }) {
  const controller = new AbortController();
  const { signal } = controller;
  let starting;
  let stage = 'idle';
  let baseline;
  let requested;
  let startedAt;
  let playbackShuffle;
  let lastStatus;
  let wake;
  let timer;

  function wakeUp() {
    clearTimeout(timer);
    const resolve = wake;
    wake = undefined;
    resolve?.();
  }

  function wait(ms) {
    if (signal.aborted || stage === 'playing') return Promise.resolve();
    return new Promise(resolve => {
      wake = resolve;
      timer = setTimeout(wakeUp, ms);
    });
  }

  async function tryOpen(uri) {
    if (signal.aborted || stage === 'playing') return;
    try { await open(uri); } catch (error) { console.warn('Navi, inicio de Spotify:', error.message); }
  }

  function changeStage(next) {
    stage = next;
    publish(next === 'manual' ? 'waiting' : 'starting');
  }

  async function launch() {
    if (!lastStatus) await wait(2400);
    if (signal.aborted) return;
    baseline = lastStatus;
    startedAt = now();
    changeStage('playlist');
    void shuffle(signal).catch(() => {});
    await tryOpen(playlistUri + ':play');
    await wait(baseline?.status ? 2300 : 4400);
    if (signal.aborted || stage === 'playing') return;

    await tryOpen(playlistUri);
    if (signal.aborted || stage === 'playing') return;
    try { await invoke(signal); } catch (error) {
      if (!signal.aborted) console.warn('Navi, botón de Spotify:', error.message);
    }
    await wait(1800);
    if (signal.aborted || stage === 'playing') return;

    const eligible = tracks.filter(track => track.uri !== baseline?.track?.uri);
    requested = eligible.length ? eligible[randomInt(eligible.length)] : tracks[0];
    if (requested) {
      changeStage('track');
      if (lastStatus?.status === 'Playing') {
        await pause(signal).catch(() => {});
      }
      await tryOpen(requested.uri + ':play');
      await wait(5500);
    }
    if (signal.aborted || stage === 'playing') return;
    changeStage('manual');
    await showManual();
  }

  function status(info, track, position, freshPosition) {
    lastStatus = { status: info.status, track, position, updated: info.updated };
    if (stage === 'idle') {
      wakeUp();
      return;
    }
    if (!track || info.status !== 'Playing' || stage === 'playing') return;
    if (stage === 'track' && requested.uri !== track.uri
      && (!freshPosition || position > 4 || track.uri === baseline?.track?.uri)) return;
    if (stage === 'playlist') {
      const sameSong = baseline?.track?.uri === track.uri;
      const unchanged = sameSong && baseline.status === 'Playing'
        && !(freshPosition && position < 3 && (baseline.position > 4 || baseline.updated !== info.updated));
      if (unchanged) return;
      if (freshPosition && position > Math.max(6, (now() - startedAt) / 1000 + 3)) return;
    }
    stage = 'playing';
    wakeUp();
    controller.abort();
    accept(track);
    playbackShuffle = new AbortController();
    void shuffle(playbackShuffle.signal).catch(() => {});
  }

  return {
    start() { starting ??= launch().catch(error => {
      if (!signal.aborted) {
        console.warn('Navi, inicio de Spotify:', error.message);
        changeStage('manual');
      }
    }); },
    status,
    manual() {
      if (stage !== 'manual' || signal.aborted) return Promise.resolve(false);
      return showManual();
    },
    stop() { controller.abort(); playbackShuffle?.abort(); wakeUp(); }
  };
}
module.exports = { createSpotifyPlayback };
