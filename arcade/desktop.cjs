const path = require('node:path');
const { games } = require('./catalog.cjs');
const { pingResult } = require('./game-core.js');
const { pingPhrases, preparePongVoice } = require('./voice.cjs');

const url = 'navi://desktop/arcade/index.html';

function summary(id, result) {
  if (id === 'pong') {
    const winner = pingResult(result?.player, result?.navi);
    return winner ? 'Ping Pong. ' + (winner === 'player' ? 'Has ganado.' : 'Navi gana.')
      + ' Has marcado ' + result.player + ' puntos y Navi ' + result.navi + '.' : undefined;
  }
  if (id === 'four') {
    switch (result?.outcome) {
      case 'player': return '¡Has ganado la partida de Cuatro en raya!';
      case 'navi': return 'Navi ha ganado la partida de Cuatro en raya.';
      case 'draw': return 'Empate en Cuatro en raya.';
      default: return undefined;
    }
  }
  if (id === 'pairs' && Number.isSafeInteger(result?.moves) && result.moves >= 8 && result.moves < 10_000
    && Number.isSafeInteger(result.seconds) && result.seconds > 0 && result.seconds < 86_400) {
    return 'Has encontrado las ocho parejas en ' + result.moves + ' intentos y ' + result.seconds + ' segundos.';
  }
  if (id === 'reflex' && Number.isSafeInteger(result?.median) && Number.isSafeInteger(result.best)
    && result.best > 0 && result.median >= result.best && result.median < 120_000) {
    return 'Reflejos. Mediana de ' + result.median + ' milisegundos. Mejor intento, ' + result.best + ' milisegundos.';
  }
  return undefined;
}

function createArcade({ BrowserWindow, ipcMain, screen, onOpen, onReturn, synthesize }) {
  let current;

  function close(message = 'Partida cancelada.', alreadySpoken = false) {
    if (!current || current.window.isDestroyed()) return;
    current.message = message;
    current.alreadySpoken = alreadySpoken;
    current.window.close();
  }

  async function open(id, stillRequested) {
    const selected = games.find(game => game.id === id && id !== 'rhythm');
    if (!selected || current || !stillRequested()) return false;
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const pong = id === 'pong';
    const width = Math.min(pong ? 790 : 595, workArea.width);
    const height = Math.min(pong ? 568 : 620, workArea.height);
    const window = new BrowserWindow({
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width, height, frame: false, transparent: true, resizable: false, show: false,
      alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, hasShadow: false,
      webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs'),
        autoplayPolicy: 'no-user-gesture-required', navigateOnDragDrop: false }
    });
    const game = { selected, window, abort: new AbortController(), message: 'Partida cerrada.' };
    current = game;
    window.setAlwaysOnTop(true, 'screen-saver');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.once('render-process-gone', () => close('El juego se cerró. Puedes volver a abrirlo.'));
    window.once('closed', () => {
      game.abort.abort();
      if (current !== game) return;
      current = undefined;
      onReturn(game.message, game.alreadySpoken);
    });
    onOpen();
    try {
      await window.loadURL(url);
      if (current === game && !window.isDestroyed()) {
        if (!stillRequested()) close();
        else { window.show(); window.focus(); window.webContents.focus(); }
      }
    } catch {
      if (current === game) close('No pude abrir el minijuego.');
    }
    return true;
  }

  function register() {
    const handle = (name, action) => ipcMain.handle('navi-arcade:' + name, (event, payload) => {
      const game = current;
      if (!game || event.sender !== game.window.webContents || event.senderFrame?.url !== url) return null;
      return action(game, payload);
    });
    handle('load', game => ({ id: game.selected.id, label: game.selected.label,
      ...(game.selected.id === 'pong' ? { lines: pingPhrases } : {}) }));
    handle('voice', async game => {
      if (game.selected.id !== 'pong') return null;
      game.voice ??= (async () => {
        const signal = AbortSignal.any([game.abort.signal, AbortSignal.timeout(26_000)]);
        game.clips = await preparePongVoice(synthesize, signal);
        return game.clips;
      })();
      return game.voice;
    });
    handle('cancel', () => { close(); return true; });
    handle('finish', (game, result) => {
      const message = summary(game.selected.id, result);
      if (typeof message !== 'string') return false;
      const won = game.selected.id === 'pong' && result.player === 6;
      close(message, game.selected.id === 'pong' && result.finalLineHeard === true && Boolean(game.clips?.[won ? 'won0' : 'lost0']));
      return true;
    });
  }
  return { open, register, close, active: () => Boolean(current), focus: () => current?.window.focus() };
}

module.exports = { createArcade };
