const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomInt, randomUUID } = require('node:crypto');
const { CHART_VERSION, LIVE_CHART_VERSION, KEYS } = require('./game-core.js');
const { parsePlaylist, matchPlaylist, playlistUrl, readPublicPlaylist } = require('./playlist.cjs');
const { createSpotifyGame } = require('./spotify-live.cjs');
const bundledPlaylist = require('./playlist-mafu.json');
const gameUrl = 'navi://desktop/rhythm/game.html';
const demo = { title: 'Vuelo Kokiri', artist: 'Navi', demo: true };
const formats = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.webm']);
const maxBytes = 120 * 1024 * 1024;


function rhythmIntent(text) {
  const phrase = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/gu, ' ').trim()
    .replace(/^(?:(?:oye|hey|ey|vale|y|entonces|navi|navy|nave)\s+)+/u, '')
    .replace(/(?: (?:navi|por favor|porfa))+$/u, '');
  const record = /^(?:(?:dime|cual es|que) )?(?:(?:mi|el|la) )?(?:mi )?(?:record|mejor puntuacion)(?: (?:en|de|para) (.+))?$/u.exec(phrase)
    || /^cuantos puntos (?:hice|saque|tengo)(?: (?:en|de|para) (.+))?$/u.exec(phrase);
  if (record) {
    return { type: 'record', query: record[1] };
  }
  if (/["«“`]/u.test(text)) return null;
  if (/^(?:(?:quiero|vamos a|podemos|me apetece|me gustaria) )?jugar con (?:musica local|mis archivos|archivos locales)$/u.test(phrase)) {
    return { type: 'start', demo: false, playlist: false };
  }
  if (/^(?:(?:quiero|vamos a|podemos|me apetece|me gustaria) )?jugar(?: con| a una cancion de| al ritmo de| en| a) (?:la |mi )?(?:playlist(?: de (?:spotify|mafu))?|lista(?: de (?:spotify|mafu))?|spotify)$/u.test(phrase)) {
    return { type: 'start', demo: false, playlist: true };
  }
  if (/^(?:(?:quiero|vamos a|podemos|me gustaria|me apetece) )?jugar(?: (?:al (?:ritmo|minijuego(?: de ritmo)?|juego de ritmo)|a tu juego|una partida(?: de ritmo)?|contigo|a la demo(?: de ritmo)?))?$/u.test(phrase)
    || /^(?:(?:puedes|podrias) )?(?:abre|abrir|inicia|iniciar|pon|ponme|arranca|prepara) (?:el |la |una )?(?:juego de ritmo|minijuego(?: de ritmo)?|partida de ritmo|demo de ritmo)$/u.test(phrase)) {
    const demo = /\bdemo\b/u.test(phrase);
    return { type: 'start', demo, playlist: !demo };
  }
  return null;
}

async function readJson(file, fallback) {
  let contents;
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  try { return JSON.parse(contents); } catch { return fallback; }
}

async function writeJson(file, data) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify(data), 'utf8');
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function isChart(notes, duration) {
  return Array.isArray(notes) && notes.length >= 4 && notes.length <= Math.ceil(duration / .12)
    && notes.every((note, i) => Number.isFinite(note?.time) && note.time >= .15 && note.time < duration
      && Number.isInteger(note.lane) && note.lane >= 0 && note.lane < 4 && (!i || note.time > notes[i - 1].time));
}

function createRhythm({ app, BrowserWindow, ipcMain, screen, shell, dialog, globalShortcut, onOpen, onReturn }) {
  let current;
  const directory = () => path.join(app.getPath('userData'), 'ritmo');
  const musicDirectory = () => path.join(directory(), 'canciones');
  const recordsPath = () => path.join(directory(), 'records.json');
  const playlistPath = () => path.join(directory(), 'playlist-mafu.json');
  const publicPlaylistPath = () => path.join(directory(), 'playlist-mafu-publica.json');
  let recordsWrite = Promise.resolve();
  let playlistRefresh;

  function refreshPlaylist() {
    if (playlistRefresh) return;
    playlistRefresh = readPublicPlaylist().then(async tracks => {
      // The ordinary page can show just the first batch. Keep the full snapshot in that case.
      if (tracks.length >= bundledPlaylist.length) await writeJson(publicPlaylistPath(), { tracks, updated: Date.now() });
    }).catch(() => {}).finally(() => { playlistRefresh = undefined; });
  }

  async function localSongs() {
    await fs.mkdir(musicDirectory(), { recursive: true });
    const items = await fs.readdir(musicDirectory(), { withFileTypes: true });
    const songs = [];
    for (const item of items) {
      if (!item.isFile() || !formats.has(path.extname(item.name).toLowerCase())) continue;
      const file = path.join(musicDirectory(), item.name);
      const info = await fs.stat(file).catch(() => null);
      if (!info?.size || info.size > maxBytes) continue;
      const name = path.parse(item.name).name.trim();
      const separator = name.indexOf(' - ');
      const artist = separator > 0 ? name.slice(0, separator).trim() : '';
      const title = separator > 0 ? name.slice(separator + 3).trim() : name;
      songs.push({ file, artist: artist.slice(0, 100), title: title.slice(0, 160) || 'Canción local' });
    }
    return songs;
  }

  async function spotifyTracks() {
    const cached = await readJson(publicPlaylistPath(), null).catch(() => null);
    const tracks = (Array.isArray(cached?.tracks) ? cached.tracks : []).filter(track => /^spotify:track:[a-zA-Z0-9]{22}$/u.test(track?.uri)
      && Number.isFinite(track.duration) && track.duration > 0);
    if (tracks.length < bundledPlaylist.length || !cached?.updated || Date.now() - cached.updated >= 3600000) refreshPlaylist();
    return tracks.length >= bundledPlaylist.length ? tracks : bundledPlaylist;
  }

  async function chooseSong(onlyDemo) {
    if (onlyDemo) return demo;
    const songs = await localSongs();
    const tracks = await readJson(playlistPath(), null);
    const pool = tracks?.length ? matchPlaylist(tracks, songs) : songs;
    if (tracks?.length && !pool.length) throw new Error('Tengo la lista de Mafu, pero ningún archivo de la carpeta coincide con ella. Revisa el nombre, artista, guion y título.');
    return pool.length ? pool[randomInt(pool.length)] : demo;
  }

  async function best(query) {
    try {
      const records = await readJson(recordsPath(), {});
      const normalize = value => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
      const entries = Object.values(records).filter(record => typeof record?.title === 'string'
        && Number.isSafeInteger(record.score) && Number.isSafeInteger(record.maxCombo));
      const named = query && !/^(?:esta|esa|la ultima) (?:cancion|partida)$/u.test(query);
      const best = named ? entries.filter(record => normalize(record.title).includes(normalize(query)))
        .sort((a, b) => (b.chartVersion || 0) - (a.chartVersion || 0) || b.score - a.score)[0]
        : entries.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))[0];
      if (!best) return named ? 'Aún no tengo un récord guardado para esa canción.' : 'Aún no hay partidas terminadas.';
      return 'Tu récord en ' + best.title + ' es de ' + best.score + ' puntos, con un combo máximo de ' + best.maxCombo + '.';
    } catch {
      return 'No pude leer los récords guardados.';
    }
  }

  async function finish(game, stats) {
    if (game.live && !game.live.readyToSave()) return false;
    const notes = game.live ? game.live.count() : game.chart?.length;
    if (game.live && !notes) {
      close('No encontré un ritmo lo bastante claro para guardar esa partida.');
      return false;
    }
    if (!notes || !stats || !['score', 'hits', 'misses', 'maxCombo'].every(field => Number.isSafeInteger(stats[field]) && stats[field] >= 0)
      || stats.hits + stats.misses !== notes || stats.score > stats.hits * 1000 || stats.maxCombo > stats.hits) {
      close('No pude guardar el resultado de la partida.');
      return false;
    }
    const { title, artist, uri } = game.live ? game.live.song() : game.song;
    let result = title + '. ' + stats.score + ' puntos. Combo máximo de ' + stats.maxCombo + '. ' + stats.misses
      + (stats.misses === 1 ? ' fallo.' : ' fallos.');
    game.finishing = true;
    releaseKeys(game);
    const save = recordsWrite.then(async () => {
      const stored = await readJson(recordsPath(), {});
      const records = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      const chartVersion = game.live ? LIVE_CHART_VERSION : CHART_VERSION;
      const key = game.live ? 'spotify-live-' + chartVersion + '-' + uri.split(':').at(-1) : chartVersion + '-' + game.key;
      const saved = records[key];
      const prior = saved && Number.isSafeInteger(saved.score) ? saved : null;
      const record = !prior || stats.score > prior.score;
      const lastPlayed = Date.now();
      const last = { score: stats.score, maxCombo: stats.maxCombo, hits: stats.hits, misses: stats.misses };
      records[key] = record ? { title, artist, score: stats.score, maxCombo: stats.maxCombo, chartVersion, lastPlayed, last }
        : { ...prior, lastPlayed, last };
      await writeJson(recordsPath(), records);
      result += !prior ? ' Primer récord guardado.' : record ? ' ¡Nuevo récord!' : ' Tu récord sigue en ' + prior.score + ' puntos.';
    });
    recordsWrite = save.catch(() => {});
    try { await save; } catch {
      result += ' No pude guardar la partida.';
    }
    if (current === game) close(result);
    return true;
  }

  function close(message) {
    if (!current) return;
    const game = current;
    game.message = message;
    if (!game.window.isDestroyed()) game.window.close();
  }

  function releaseKeys(game) {
    for (const key of game.shortcuts) globalShortcut.unregister(key);
    game.shortcuts.length = 0;
  }

  function captureKeys(game) {
    if (process.platform !== 'win32' || !globalShortcut) return false;
    const handlers = new Map(KEYS.map((code, lane) => [code.slice(3), () => {
      if (current !== game || game.finishing || game.window.isDestroyed()) return;
      game.window.webContents.send('navi-rhythm:hit', lane, Date.now());
    }]));
    handlers.set('Escape', () => {
      if (current === game && !game.finishing) close('Partida cancelada.');
    });
    try {
      for (const [key, callback] of handlers) {
        if (!globalShortcut.register(key, callback)) {
          releaseKeys(game);
          return false;
        }
        game.shortcuts.push(key);
      }
      return true;
    } catch {
      releaseKeys(game);
      return false;
    }
  }

  async function open(onlyDemo = false, stillRequested = () => true, onlyPlaylist = false) {
    if (current) return false;
    const useSpotify = onlyPlaylist && !onlyDemo;
    if (useSpotify && process.platform !== 'win32') throw new Error('El modo Spotify está disponible en Windows.');
    const song = useSpotify ? null : await chooseSong(onlyDemo);
    const tracks = useSpotify ? await spotifyTracks() : null;
    if (current || !stillRequested()) return false;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    const w = Math.min(610, width);
    const h = Math.min(640, height);
    const window = new BrowserWindow({
      x: Math.round(x + (width - w) / 2), y: Math.round(y + (height - h) / 2),
      width: w, height: h, frame: false, transparent: true, resizable: false, show: false,
      alwaysOnTop: true, focusable: true, skipTaskbar: true, hasShadow: false, fullscreenable: false,
      webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs'),
        autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, navigateOnDragDrop: false }
    });
    const game = { window, song, shortcuts: [] };
    current = game;
    if (useSpotify) {
      game.live = createSpotifyGame({
        tracks,
        openPlaylist: uri => shell.openExternal(uri),
        restoreFocus: () => {
          if (!window.isDestroyed() && !game.globalInput) {
            window.focus();
            if (window.isFocused()) window.webContents.focus();
          }
        },
        send: event => {
          if (current === game && !window.isDestroyed()) window.webContents.send('navi-rhythm:spotify-event', event);
        },
        fail: message => { if (current === game) close(message); }
      });
    }
    window.setAlwaysOnTop(true, 'screen-saver');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        close(game.finishing ? 'Partida terminada.' : 'Partida cancelada.');
      }
    });
    window.once('closed', () => {
      releaseKeys(game);
      game.live?.stop();
      if (current !== game) return;
      current = undefined;
      onReturn(game.message);
    });
    window.webContents.once('render-process-gone', () => close('El juego se cerró. Puedes volver a abrirlo.'));
    game.globalInput = captureKeys(game);
    if (process.platform === 'win32' && !game.globalInput) {
      console.warn('Navi, ritmo: Windows no reservó las cinco teclas de la partida. Se usará el teclado de la ventana.');
      window.setSkipTaskbar(false);
    }
    onOpen();
    try {
      await window.loadURL(gameUrl);
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
        if (window.isFocused()) window.webContents.focus();
      }
    } catch {
      if (current === game) close('No pude abrir el juego de ritmo.');
    }
    return true;
  }

  function register() {
    const handle = (name, fn) => ipcMain.handle('navi-rhythm:' + name, async (event, payload) => {
      const game = current;
      if (!game || event.sender !== game.window.webContents || event.senderFrame?.url !== gameUrl || game.finishing) return null;
      return fn(game, payload);
    });
    handle('load', async game => {
      if (game.loaded) return null;
      game.loaded = true;
      if (game.live) return { spotify: true, globalInput: game.globalInput };
      const file = game.song.demo ? path.join(__dirname, 'demo.ogg') : game.song.file;
      try {
        const audio = await fs.readFile(file);
        if (!audio.length || audio.length > maxBytes) return null;
        game.key = createHash('sha256').update(audio).digest('hex');
        game.cacheFile = path.join(directory(), 'notas', CHART_VERSION + '-' + game.key + '.json');
        const chart = await readJson(game.cacheFile, null).catch(() => null);
        return {
          title: game.song.title, artist: game.song.artist, audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
          globalInput: game.globalInput,
          chart: chart && Number.isFinite(chart.duration) && isChart(chart.notes, chart.duration) ? chart.notes : null
        };
      } catch { return null; }
    });
    handle('chart', async (game, payload) => {
      const { notes, duration } = payload || {};
      if (game.live || !game.key || game.chart || !Number.isFinite(duration) || duration < 3 || duration > 900 || !isChart(notes, duration)) return false;
      game.chart = notes;
      await writeJson(game.cacheFile, { notes, duration }).catch(() => {});
      return true;
    });
    handle('spotify-start', game => {
      if (!game.live || game.liveStarted) return false;
      game.liveStarted = true;
      game.live.start();
      return true;
    });
    handle('spotify-open', game => Boolean(game.live) && game.live.openPlaylist().then(() => true, () => false));
    handle('finish', finish);
    handle('cancel', () => close('Partida cancelada.'));
    handle('fail', (_game, message) => close(typeof message === 'string' ? message.slice(0, 220) : 'No pude preparar la partida.'));
  }

  async function showSongs() {
    await fs.mkdir(musicDirectory(), { recursive: true });
    return shell.openPath(musicDirectory());
  }

  async function importPlaylist() {
    const { canceled, filePaths } = await dialog.showOpenDialog({ title: 'Importar la playlist de Mafu',
      properties: ['openFile'], filters: [{ name: 'Lista de canciones CSV', extensions: ['csv'] }] });
    if (canceled || !filePaths.length) return;
    const { size } = await fs.stat(filePaths[0]);
    if (size > 4 * 1024 * 1024) throw new Error('Ese CSV es demasiado grande.');
    const tracks = parsePlaylist(await fs.readFile(filePaths[0], 'utf8'));
    const matched = matchPlaylist(tracks, await localSongs()).length;
    await writeJson(playlistPath(), tracks);
    return 'Lista de Mafu importada. ' + tracks.length + ' canciones. ' + matched + ' disponibles para jugar.';
  }

  return {
    register, open, best, close, showSongs, importPlaylist, active: () => Boolean(current),
    showPlaylist: () => shell.openExternal(playlistUrl),
    focus: () => current?.window.focus()
  };
}

module.exports = { createRhythm, rhythmIntent };
