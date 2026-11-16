const {
  app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net,
  powerMonitor, protocol, safeStorage, screen, session, shell, Tray
} = require('electron');
const { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseEnv } = require('node:util');
const {
  MAX_TIMER_SECONDS, NAVI_DESTINATIONS, formatDuration, endsConversation, answerNaviLore,
  parseNaviPosition, mentionsNaviMovement, asksAboutTimers, parseDesktopCommands, desktopSteps, desktopIntents, commandConfirmation,
  isCursorOrder
} = require('./commands.cjs');
const { createTimers } = require('./timers.cjs');
const ai = require('./ai.cjs');
const { answerFromClock } = require('./calendar.cjs');
const { parseWeather, parseWeatherFollowUp, cityReply, getForecast } = require('./weather.cjs');
const { createLocalVoice } = require('./local-voice.cjs');
const { answerKiss, spokenReply, voiceTestReply } = require('./voice-profile.cjs');

const { createWindowsApps } = require('./windows-apps.cjs');
const windowsApps = createWindowsApps(shell);
const { controlMedia } = require('./windows-media.cjs');
const { MEDIA_ACTIONS } = require('./media-commands.cjs');
const { createRhythm, rhythmIntent } = require('./rhythm/desktop.cjs');
const { createArcade } = require('./arcade/desktop.cjs');
const { gameIntent, menuChoices } = require('./arcade/catalog.cjs');
const { createNaviUpdater } = require('./navi-updater.cjs');
const { naviMaintenanceIntent } = require('./update-intents.cjs');
const width = 400;
const height = 385;
// Matches the fairy's anchor in the cursor layout in overlay.css.
const cursorAnchor = { x: 97, y: 72 };
const cursorOffset = { x: 30, y: 32 };
const overlayUrl = 'navi://desktop/overlay.html';
const overlayAssets = new Map([
  ['/overlay.html', 'text/html; charset=utf-8'],
  ['/overlay.css', 'text/css; charset=utf-8'],
  ['/overlay.js', 'text/javascript; charset=utf-8'],
  ['/update.css', 'text/css; charset=utf-8'],
  ['/arcade/menu.css', 'text/css; charset=utf-8'],
  ['/arcade/index.html', 'text/html; charset=utf-8'],
  ['/arcade/arcade.css', 'text/css; charset=utf-8'],
  ['/arcade/game-core.js', 'text/javascript; charset=utf-8'],
  ['/arcade/arcade.js', 'text/javascript; charset=utf-8'],
  ['/flight.js', 'text/javascript; charset=utf-8'],
  ['/wake.js', 'text/javascript; charset=utf-8'],
  ['/voice-worklet.js', 'text/javascript; charset=utf-8'],
  ['/rhythm/game.html', 'text/html; charset=utf-8'],
  ['/rhythm/game.css', 'text/css; charset=utf-8'],
  ['/rhythm/game-core.js', 'text/javascript; charset=utf-8'],
  ['/rhythm/game.js', 'text/javascript; charset=utf-8'],
  ['/rhythm/analysis-worker.js', 'text/javascript; charset=utf-8'],
  ['/vendor/vosk.js', 'text/javascript; charset=utf-8'],
  ['/vendor/vosk-worker.js', 'text/javascript; charset=utf-8'],
  ['/vendor/vosk-es-0.42.tar.gz', 'application/gzip'],
  ['/assets/navi.png', 'image/png'],
  ['/assets/navi-aleteo.gif', 'image/gif'],
  ['/assets/chime.wav', 'audio/wav']
]);
for (const name of ['OOT_Navi_Out', 'OOT_Navi_In', 'OOT_Navi_Float', 'OOT_Navi_Float_Loop', 'Navi_Hm_1', 'Navi_Hm_2', 'Navi_Hm_3', 'Navi_Hm_4']) {
  overlayAssets.set('/assets/' + name + '.wav', 'audio/wav');
}
const flightAudioTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', flac: 'audio/flac', webm: 'audio/webm' };
for (const name of ['toBig', 'toSmall']) {
  for (const [extension, mime] of Object.entries(flightAudioTypes)) {
    overlayAssets.set('/assets/' + name + '.' + extension, mime);
  }
}
const keyPath = () => path.join(app.getPath('userData'), 'openai-key.bin');
const voicePath = () => path.join(app.getPath('userData'), 'wake.json');
const placementPath = () => path.join(app.getPath('userData'), 'placement.json');
const isApiKey = value => /^sk-[A-Za-z0-9_-]{12,500}$/u.test(value);
const envKey = process.env.OPENAI_API_KEY?.trim() || readDevelopmentKey();
const developmentConfig = path.join(__dirname, 'openai-config.cjs');
const devConfigKey = !app.isPackaged && existsSync(developmentConfig) ? require(developmentConfig).apiKey : '';
const bundledKey = isApiKey(devConfigKey) ? devConfigKey : '';
let savedKey = '';
let key = envKey || bundledKey;
let win;
let tray;
let timers;
let shortcut;
let busy = false;
let isReady = false;
let activation;
let alarm;
let history = [];
let currentSources = new Set();
let appOptions = [];
let commandsAfterChoice = [];
let awaitingAction;
let commandRevision = 0;
let weatherCity;
let pendingWeather;
let continuingWeather = false;
let wakeEnabled = true;
let wakeStatus = 'loading';
let overlayPriority;
let placement = { horizontal: 'right', vertical: 'bottom', displayId: null };
let movement;
let cursorFollow;
let cursorTimer;
let localVoice;
let awaitingRhythm;
let awaitingGameMenu = false;
let rhythmLaunch;
let quitting = false;
const updates = createNaviUpdater({ app, notify(state) {
  if (win && !win.isDestroyed()) win.webContents.send('navi:update-state', state);
} });
function hideForGame() {
  win.webContents.send('navi:rhythm-started');
  clearInterval(cursorTimer);
  cursorTimer = undefined;
  clearInterval(movement);
  movement = undefined;
  win.setIgnoreMouseEvents(true);
  win.setFocusable(false);
  win.hide();
}

function returnFromGame(message, alreadySpoken = false) {
  if (quitting || !win || win.isDestroyed() || alarm) return;
  enableOverlayInput(false);
  win.webContents.send('navi:rhythm-result', spokenReply(message || 'Partida cerrada.'), true, alreadySpoken);
}

const rhythm = createRhythm({ app, BrowserWindow, ipcMain, screen, shell, dialog, globalShortcut,
  onOpen: hideForGame, onReturn: returnFromGame });
const arcade = createArcade({ BrowserWindow, ipcMain, screen, onOpen: hideForGame, onReturn: returnFromGame,
  synthesize: (text, signal) => localVoice.synthesize(text, signal, { waitForCache: true }) });

function activeGame() {
  if (rhythm.active()) return rhythm;
  if (arcade.active()) return arcade;
  return undefined;
}
const placementNames = {
  top: { left: 'arriba a la izquierda', right: 'arriba a la derecha' },
  center: { left: 'en el centro del lado izquierdo', right: 'en el centro del lado derecho' },
  bottom: { left: 'abajo a la izquierda', right: 'abajo a la derecha' }
};

function readDevelopmentKey() {
  if (!process.defaultApp) return '';
  try {
    const value = parseEnv(readFileSync(path.join(__dirname, '.env.local'), 'utf8'))
      .OPENAI_API_KEY?.trim() || '';
    return isApiKey(value) ? value : '';
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Navi: no se pudo leer .env.local.');
    return '';
  }
}

function status() {
  return {
    ai: Boolean(key), envKey: Boolean(envKey), savedKey: Boolean(savedKey),
    bundledKey: !envKey && !savedKey && Boolean(bundledKey), shortcut, timers: timers.count(), wakeEnabled,
    placement: cursorFollow?.layout || placement,
    version: app.getVersion(),
    update: updates.current(),
    localVoice: localVoice.state()
  };
}

function registerOverlayProtocol() {
  protocol.handle('navi', async request => {
    const url = new URL(request.url);
    const mime = overlayAssets.get(url.pathname);
    if (url.host !== 'desktop' || !mime || request.method !== 'GET') {
      return new Response(null, { status: 404 });
    }
    const assetPath = path.join(__dirname, url.pathname);
    if (!existsSync(assetPath)) return new Response(null, { status: 404 });
    const range = request.headers?.get('Range');
    const file = await net.fetch(pathToFileURL(assetPath).href, range ? { headers: { Range: range } } : undefined);
    const headers = new Headers(file.headers);
    headers.set('Content-Type', mime);
    if (url.pathname === '/vendor/vosk-worker.js') {
      // The bundled Emscripten bindings compile helpers inside the worker.
      headers.set('Content-Security-Policy',
        "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self' data:");
    }
    return new Response(file.body, { status: file.status, headers });
  });
}

function currentDisplay() {
  const displays = screen.getAllDisplays();
  return displays.find(display => display.id === placement.displayId)
    || (placement.displayId === null && win && isReady ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay());
}

function position({ workArea }, animate = false) {
  clearInterval(movement);
  movement = undefined;
  const { x, y, width: workWidth, height: workHeight } = workArea;
  const freeX = Math.max(0, workWidth - width);
  const freeY = Math.max(0, workHeight - height);
  const marginX = Math.min(8, freeX);
  const marginY = Math.min(10, freeY);
  const targetX = x + (placement.horizontal === 'left' ? marginX : freeX - marginX);
  const targetY = y + ({ top: marginY, center: Math.round(freeY / 2), bottom: freeY - marginY })[placement.vertical];
  if (!animate) {
    win.setPosition(targetX, targetY);
    return;
  }
  const [startX, startY] = win.getPosition();
  if (startX === targetX && startY === targetY) return;
  const began = performance.now();
  movement = setInterval(() => {
    const fraction = Math.min(1, (performance.now() - began) / 560);
    const destroyed = win.isDestroyed();
    if (fraction === 1 || destroyed) {
      clearInterval(movement);
      movement = undefined;
    }
    if (destroyed) return;
    const eased = fraction * fraction * (3 - 2 * fraction);
    win.setPosition(Math.round(startX + (targetX - startX) * eased), Math.round(startY + (targetY - startY) * eased));
  }, 16);
  movement.unref();
}

function moveNavi(direction) {
  if (cursorFollow) return 'Sigo enganchada al cursor. Suéltame antes de pedirme que cambie de sitio.';
  let display = currentDisplay();
  if (direction.otherDisplay) {
    const displays = screen.getAllDisplays();
    if (displays.length < 2) return 'Solo tengo una pantalla disponible.';
    display = displays[(displays.findIndex(item => item.id === display.id) + 1) % displays.length];
    placement = { ...placement, displayId: display.id };
  } else {
    placement = { ...direction, displayId: display.id };
  }
  try {
    const destination = placementPath();
    writeFileSync(destination + '.tmp', JSON.stringify(placement));
    renameSync(destination + '.tmp', destination);
  } catch (error) {
    console.warn('Navi, posición:', error.code || error.name);
  }
  win.webContents.send('navi:placement', placement);
  position(display, true);
  return direction.otherDisplay ? 'Ya estoy en la otra pantalla.'
    : 'Vale, me quedo ' + placementNames[placement.vertical][placement.horizontal] + '.';
}

function trackCursor() {
  const point = screen.getCursorScreenPoint();
  const center = { x: point.x + cursorOffset.x, y: point.y + cursorOffset.y };
  const display = screen.getDisplayNearestPoint(center);
  const bounds = display.bounds || display.workArea;
  // Clamp the fairy's center at the screen edge without flipping sides.
  const targetX = Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, center.x)) - cursorAnchor.x;
  const targetY = Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, center.y)) - cursorAnchor.y;
  cursorFollow.layout.displayId = display.id;
  const [currentX, currentY] = win.getPosition();
  if (currentX !== targetX || currentY !== targetY) win.setPosition(targetX, targetY);

  const now = performance.now();
  const previousPoint = cursorFollow.lastPoint;
  if (!previousPoint || now < cursorFollow.nextCue) cursorFollow.cueOrigin = point;
  if (previousPoint && (point.x !== previousPoint.x || point.y !== previousPoint.y) &&
    now >= cursorFollow.nextCue && Math.hypot(point.x - cursorFollow.cueOrigin.x, point.y - cursorFollow.cueOrigin.y) >= 20) {
    cursorFollow.nextCue = now + 2600 + Math.random() * 2100;
    cursorFollow.cueOrigin = point;
    win.webContents.send('navi:cursor-cue');
  }
  cursorFollow.lastPoint = point;
}

function syncCursorTracking(paused) {
  clearInterval(cursorTimer);
  cursorTimer = undefined;
  if (!cursorFollow || !win || win.isDestroyed()) return;
  if (paused) {
    cursorFollow.layout = undefined;
    win.webContents.send('navi:placement', placement);
    position(currentDisplay());
    return;
  }
  cursorFollow.lastPoint = undefined;
  cursorFollow.layout = { horizontal: 'left', vertical: 'top', followingCursor: true };
  trackCursor();
  win.webContents.send('navi:placement', cursorFollow.layout);
  cursorTimer = setInterval(trackCursor, 16);
  cursorTimer.unref();
}

function setCursorFollowing(enabled) {
  if (!win || win.isDestroyed()) return 'Ahora mismo no puedo moverme.';
  if (enabled === Boolean(cursorFollow)) return enabled ? 'Ya estoy enganchada al cursor.' : 'Ya he soltado el cursor.';
  if (enabled) {
    clearInterval(movement);
    movement = undefined;
    cursorFollow = { homeDisplayId: currentDisplay().id, nextCue: performance.now() + 650 };
    enableOverlayInput(false);
    updateTray();
    return '¡Me engancho al cursor!';
  }
  const homeDisplayId = cursorFollow.homeDisplayId;
  cursorFollow = undefined;
  syncCursorTracking(false);
  const home = screen.getAllDisplays().find(display => display.id === homeDisplayId) || screen.getPrimaryDisplay();
  win.webContents.send('navi:placement', placement);
  position(home, true);
  updateTray();
  return 'Ya he soltado el cursor.';
}

function raiseOverlay() {
  if (process.platform !== 'win32' || !win || win.isDestroyed() || !win.isVisible()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
}

function enableOverlayInput(enabled) {
  win.setIgnoreMouseEvents(!enabled);
  win.setFocusable(enabled);
  if (enabled) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
  syncCursorTracking(enabled);
  raiseOverlay();
}

function activate(view) {
  if (!isReady) {
    activation = view;
    return;
  }
  const game = activeGame();
  if (game) { game.focus(); return; }
  if (alarm) {
    enableOverlayInput(true);
    win.webContents.send('navi:alarm', alarm);
    return;
  }
  if (!cursorFollow && placement.displayId === null) position(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  enableOverlayInput(true);
  win.webContents.send('navi:activate', view);
}

function ring(expired) {
  clearPendingCommands();
  alarm = expired.length === 1
    ? 'Ha terminado el temporizador de ' + formatDuration(expired[0].seconds) + '.'
    : 'Han terminado ' + expired.length + ' temporizadores.';
  activeGame()?.close();
  if (!isReady) return;
  enableOverlayInput(true);
  win.webContents.send('navi:alarm', alarm);
}

async function execute({ name, args }) {
  if (name === 'control_media') return controlMedia(args);
  if (name === 'follow_cursor' && typeof args?.enabled === 'boolean') return setCursorFollowing(args.enabled);
  if (name === 'move_navi') {
    if (!NAVI_DESTINATIONS.includes(args?.destination)) return '¿En qué parte de la pantalla quieres que me ponga?';
    if (args.destination === 'other-display') return moveNavi({ otherDisplay: true });
    const [vertical, horizontal] = args.destination.split('-');
    return moveNavi({ horizontal, vertical });
  }
  if (name === 'start_timer') {
    if (!Number.isSafeInteger(args?.seconds) || args.seconds < 1 || args.seconds > MAX_TIMER_SECONDS) {
      return 'Dime una duración de entre un segundo y siete días.';
    }
    try {
      timers.add(args.seconds);
      return 'Vale, te aviso en ' + formatDuration(args.seconds) + '.';
    } catch (error) {
      console.error('No se pudo guardar el temporizador:', error.code);
      return 'No he podido guardar el temporizador.';
    }
  }
  if (!['open_app', 'close_app'].includes(name) || typeof args?.app !== 'string' || !args.app.trim() || args.app.length > 120) {
    return 'Esa acción todavía no está disponible.';
  }
  if (parseNaviPosition(args.app) || mentionsNaviMovement(args.app)) return actionQuestions[name];
  if (name === 'close_app') return windowsApps.close(args.app.trim());
  return windowsApps.open(args.app.trim(), options => { appOptions = options; });
}

async function executeCommands(commands) {
  const replies = [];
  const queue = [...commands];
  const revision = commandRevision;
  while (queue.length) {
    const command = queue.shift();
    if (command.interpret) {
      const plan = await interpretCommand(command.interpret, command.intents);
      if (revision !== commandRevision) return { noSpeech: true };
      if (plan?.confirm || plan?.missing) {
        const wait = waitForCommand(plan, queue);
        return { ...wait, text: [...replies, wait.text].join(' ') };
      }
      if (!plan?.actions?.length && isCursorOrder(command.interpret)) {
        const wait = waitForCommand({ missing: 'follow_cursor' }, queue);
        return { ...wait, text: [...replies, wait.text].join(' ') };
      }
      if (plan?.actions?.length) queue.unshift(...plan.actions);
      if (!plan) replies.push(interpretationFailed);
      continue;
    }
    const reply = await execute(command);
    if (revision !== commandRevision) {
      appOptions = [];
      return { noSpeech: true };
    }
    if (reply) replies.push(reply);
    if (appOptions.length) {
      commandsAfterChoice = queue;
      break;
    }
  }
  return { desktop: true, text: replies.join(' ') };
}

const actionQuestions = {
  open_app: '¿Qué aplicación quieres que abra?',
  close_app: '¿Qué aplicación quieres que cierre?',
  move_navi: '¿Quieres que cambie de monitor o que me coloque en otro sitio de esta pantalla?',
  start_timer: '¿De cuánto tiempo quieres el temporizador?',
  follow_cursor: '¿Quieres que me enganche al cursor o que lo suelte?',
  control_media: '¿Quieres que te diga qué suena, que pause, que reanude o que cambie la reproducción?'
};

const interpretationFailed = 'No he entendido bien la orden. ¿Me la puedes decir de otra forma?';

function clearPendingCommands() {
  commandRevision += 1;
  appOptions = [];
  commandsAfterChoice = [];
  awaitingAction = undefined;
  awaitingRhythm = undefined;
  awaitingGameMenu = false;
  rhythmLaunch = undefined;
}

async function interpretCommand(text, intents) {
  if (!key) return null;
  try {
    return await ai.interpretDesktop(key, text, intents, placementNames[placement.vertical][placement.horizontal], Boolean(cursorFollow));
  } catch (error) {
    console.warn('Navi, interpretación de órdenes:', error.name);
    return null;
  }
}

function waitForCommand(plan, remaining = []) {
  awaitingAction = { ...plan, remaining };
  if (plan.missing) return { desktop: true, awaitingReply: true, text: actionQuestions[plan.missing] };
  const phrases = plan.actions.map(({ name, args }) => {
    if (name === 'open_app') return 'abra ' + args.app.trim();
    if (name === 'close_app') return 'cierre ' + args.app.trim();
    if (name === 'start_timer') return 'te avise en ' + formatDuration(args.seconds);
    if (name === 'follow_cursor') return args.enabled ? 'me enganche a tu cursor' : 'suelte el cursor';
    if (name === 'control_media') {
      const player = { current: '', spotify: ' en Spotify', youtube: ' en YouTube', browser: ' en el navegador',
        chrome: ' en Chrome', edge: ' en Edge', firefox: ' en Firefox' }[args.target];
      return MEDIA_ACTIONS[args.action].question + player;
    }
    if (args.destination === 'other-display') return 'me cambie a la otra pantalla';
    const [vertical, horizontal] = args.destination.split('-');
    return 'me ponga ' + placementNames[vertical][horizontal];
  });
  return { desktop: true, awaitingReply: true, text: '¿Quieres que ' + phrases.join(' y que ') + '?' };
}

async function answer(text) {
  currentSources.clear();
  if (typeof text !== 'string' || !text.trim()) return { text: 'No me llegó ninguna petición.' };
  text = text.trim().slice(0, 1400);
  const maintenance = naviMaintenanceIntent(text);
  if (maintenance === 'quit') {
    if (updates.current().phase === 'installing') return { desktop: true, text: 'Ya me estoy actualizando. Volveré al terminar.' };
    clearPendingCommands();
    setTimeout(() => app.quit(), 250);
    return { desktop: true, quitting: true, text: 'Hasta luego.' };
  }
  if (maintenance === 'version') return { desktop: true, text: 'Soy Navi ' + app.getVersion() + '.' };
  if (maintenance === 'check') return { desktop: true, text: await updates.check() };
  if (maintenance === 'install') {
    clearPendingCommands();
    const update = updates.start();
    return update.started ? { desktop: true, updating: true, updateState: updates.current() } : { desktop: true, text: update.text };
  }
  const test = voiceTestReply(text);
  if (test) return { text: spokenReply(test) };
  const response = await routeRequest(text);
  if (typeof response.text === 'string') {
    response.text = spokenReply(response.text);
    if (!/[\p{L}\p{Nd}]/u.test(response.text)) return { noSpeech: true };
  }
  if (response.closeConversation) history = [];
  else if (response.text && !response.desktop) {
    history = [...history, { role: 'user', content: text }, { role: 'assistant', content: response.text }].slice(-6);
  }
  return response;
}

async function routeRequest(text) {
  const options = appOptions;
  const remainingCommands = commandsAfterChoice;
  const pendingAction = awaitingAction;
  const rhythmRequest = awaitingRhythm;
  const choosingGame = awaitingGameMenu;
  awaitingGameMenu = false;
  appOptions = [];
  commandsAfterChoice = [];
  awaitingAction = undefined;
  awaitingRhythm = undefined;
  const weatherFollowUp = continuingWeather ? parseWeatherFollowUp(text) : null;
  continuingWeather = false;
  const weatherQuestion = pendingWeather;
  pendingWeather = undefined;
  if (endsConversation(text)) return { closeConversation: true };
  const arcadeRequest = gameIntent(text, choosingGame);
  const rhythmRequestFromText = rhythmIntent(text);
  if (arcadeRequest?.type === 'cancel') return { desktop: true, text: 'Vale, lo dejamos para otro rato.' };
  if (arcadeRequest?.type === 'menu') {
    awaitingGameMenu = true;
    if (cursorFollow && isReady) enableOverlayInput(true);
    return { desktop: true, awaitingReply: true, gameMenu: menuChoices, text: '¿A qué jugamos hoy?' };
  }
  if (rhythmRequest && !arcadeRequest && !rhythmRequestFromText) {
    const decision = commandConfirmation(text);
    if (decision === false) return { desktop: true, text: 'Vale, dejamos el juego para otro momento.' };
    if (decision === true) {
      rhythmLaunch = rhythmRequest;
      return { desktop: true, startRhythm: true, text: 'Dame un momento. Voy a preparar el ritmo.' };
    }
    awaitingRhythm = rhythmRequest;
    return { desktop: true, awaitingReply: true, rhythmConfirmation: true, text: 'Di sí para jugar o no para cancelar.' };
  }
  if (arcadeRequest?.type === 'game' && arcadeRequest.id !== 'rhythm') {
    rhythmLaunch = { arcade: arcadeRequest.id };
    return { desktop: true, startRhythm: true, text: 'Voy a preparar la partida.' };
  }
  const gameRequest = arcadeRequest?.id === 'rhythm'
    ? { type: 'start', demo: false, playlist: true } : rhythmRequestFromText;
  if (gameRequest?.type === 'record') return { desktop: true, text: await rhythm.best(gameRequest.query) };
  if (gameRequest?.type === 'start') {
    awaitingRhythm = gameRequest;
    if (cursorFollow && isReady) enableOverlayInput(true);
    return { desktop: true, awaitingReply: true, rhythmConfirmation: true,
      text: gameRequest.playlist ? '¿Seguro que quieres jugar con la lista de Mafu?' : '¿Seguro que quieres empezar una partida de ritmo?' };
  }
  if (choosingGame && commandConfirmation(text) === true) {
    awaitingGameMenu = true;
    return { desktop: true, awaitingReply: true, gameMenu: menuChoices, text: 'Dime el nombre de un juego o su número.' };
  }
  if (pendingAction) {
    const decision = commandConfirmation(text);
    if (decision === false) return { desktop: true, text: 'De acuerdo, descarto lo que quedaba pendiente.' };
    if (decision === true && pendingAction.confirm) return executeCommands([...pendingAction.actions, ...pendingAction.remaining]);
    if (decision === true && pendingAction.missing) return waitForCommand(pendingAction, pendingAction.remaining);
  }
  if (asksAboutTimers(text)) {
    const [next, ...others] = timers.remaining();
    if (next === undefined) return { desktop: true, text: 'No hay temporizadores activos.' };
    const wait = next === 0 ? 'El próximo aviso está a punto de sonar.'
      : 'El próximo aviso suena en ' + formatDuration(next) + '.';
    return { desktop: true, text: others.length ? 'Hay ' + (others.length + 1) + ' temporizadores activos. ' + wait : wait };
  }
  const lore = answerNaviLore(text) || answerKiss(text);
  if (lore) return { text: lore };
  if (options.length) {
    const choice = text.toLowerCase().replace(/[.!]+$/u, '').trim();
    const ordinal = /^(?:la |el )?(?:opci[oó]n )?(1|2|3|4|uno|dos|tres|cuatro|primera|segunda|tercera|cuarta)$/u.exec(choice)?.[1];
    const number = Number(ordinal) || ['uno primera', 'dos segunda', 'tres tercera', 'cuatro cuarta']
      .findIndex(words => words.split(' ').includes(ordinal)) + 1;
    const name = options[Number(number) - 1] ?? options.find(option => option.toLowerCase() === choice);
    if (name) return executeCommands([{ name: 'open_app', args: { app: name } }, ...remainingCommands]);
  }
  const steps = desktopSteps(text, placement.vertical, placement.horizontal, Boolean(cursorFollow));
  if (steps.every(step => step.command)) {
    const commands = steps.map(step => step.command);
    const remaining = commands.length === 1 && commands[0].name === pendingAction?.missing ? pendingAction.remaining : [];
    return executeCommands([...commands, ...remaining]);
  }
  if (steps.some(step => step.command)) {
    return executeCommands(steps.map(step => step.command || { interpret: step.text, intents: step.intents }));
  }
  const now = new Date();
  const clockAnswer = answerFromClock(text, now);
  if (clockAnswer) return { text: clockAnswer };

  const intents = desktopIntents(text);
  const weather = parseWeather(text) || weatherFollowUp;
  if (!intents.length && !weather && pendingAction?.missing) {
    const { missing, remaining } = pendingAction;
    const phrase = text.trim().replace(/[.!]+$/u, '');
    const simpleName = /^[\p{L}\p{N}][\p{L}\p{N} +_().#'-]{0,79}$/u.test(phrase)
      && !/^(?:hola|buenas|oye|c[oó]mo|qu[eé]|cu[aá]nto|d[oó]nde|cu[aá]ndo|por qu[eé]|qui[eé]n|dime|cu[eé]ntame|no|s[ií]|nada|cancel[ao]|olv[ií]dalo)\b/iu.test(phrase);
    if (simpleName && ['open_app', 'close_app'].includes(missing)) {
      return executeCommands([{ name: missing, args: { app: phrase } }, ...remaining]);
    }
    const prefix = missing === 'move_navi' ? 'muévete ' : missing === 'start_timer' ? 'pon un temporizador de ' : '';
    if (prefix) {
      const followUp = parseDesktopCommands(prefix + phrase, placement.vertical, placement.horizontal);
      if (followUp.length === 1 && followUp[0].name === missing) return executeCommands([...followUp, ...remaining]);
    }
    if (missing === 'follow_cursor') {
      const followUp = parseDesktopCommands(phrase + ' al cursor', placement.vertical, placement.horizontal, Boolean(cursorFollow));
      if (followUp.length === 1 && followUp[0].name === missing) return executeCommands([...followUp, ...remaining]);
    }
    if (missing === 'control_media') {
      const followUp = parseDesktopCommands(phrase + ' la reproducción', placement.vertical, placement.horizontal);
      if (followUp.length === 1 && followUp[0].name === missing) return executeCommands([...followUp, ...remaining]);
    }
  }
  if (intents.length) {
    if (key) {
      const revision = commandRevision;
      const plan = await interpretCommand(text, intents);
      if (revision !== commandRevision) return { noSpeech: true };
      const remaining = pendingAction?.missing && intents.length === 1 && intents[0] === pendingAction.missing
        ? pendingAction.remaining : [];
      if (plan?.missing || plan?.confirm) return waitForCommand(plan, remaining);
      if (plan?.actions.length) return executeCommands([...plan.actions, ...remaining]);
      if (isCursorOrder(text)) return waitForCommand({ missing: 'follow_cursor' }, remaining);
      if (!plan) return { desktop: true, text: interpretationFailed };
    } else if (!weather) {
      if (isCursorOrder(text)) return waitForCommand({ missing: 'follow_cursor' });
      return { desktop: true, text: 'Dime la acción y su destino. Por ejemplo, cámbiate de pantalla o abre Steam.' };
    }
  }

  const place = !intents.length && !weather && weatherQuestion ? cityReply(text) : null;
  const forecast = weather || (place ? { ...weatherQuestion, city: place } : null);
  if (forecast) {
    const city = forecast.city || weatherCity;
    if (!city) {
      pendingWeather = forecast;
      return { text: '¿En qué ciudad quieres consultar el tiempo?' };
    }
    try {
      const result = await getForecast(forecast, city);
      if (result.retryCity) pendingWeather = forecast;
      if (result.city) {
        weatherCity = city;
        continuingWeather = true;
      }
      currentSources = new Set((result.sources || []).map(source => source.url));
      return { text: result.text, sources: result.sources };
    } catch {
      pendingWeather = forecast;
      return { text: 'No he podido consultar el tiempo ahora. Prueba de nuevo en un momento.' };
    }
  }
  if (!key) {
    if (/^(?:hola|buenas)[.! ]*$/iu.test(text)) return { text: '¡Hola! Pídeme que abra una aplicación o ponga un temporizador.' };
    return { text: 'Puedo abrir aplicaciones y poner temporizadores. Puedes conectar la IA para conversar.' };
  }

  const result = await ai.ask(key, history, text, now, { allowSearch: !intents.length });
  currentSources = new Set((result.sources || []).map(source => source.url));
  return { text: result.text, sources: result.sources };
}

async function handleRequest(work) {
  if (busy) return { text: 'Espera un momento, aún estoy con la petición anterior.' };
  busy = true;
  try {
    return await work();
  } catch (error) {
    if (error.name === 'TimeoutError') return { text: 'OpenAI ha tardado demasiado. Prueba otra vez.' };
    return { text: error.message.includes('OpenAI') ? error.message : 'No he podido completar la petición. Revisa la conexión y vuelve a intentarlo.' };
  } finally {
    busy = false;
  }
}

function registerIpc() {
  const fromOverlay = event => event.sender === win?.webContents && event.senderFrame?.url === overlayUrl;
  let synthesis;
  const handle = (channel, action) => ipcMain.handle(channel, (event, data) => {
    if (!fromOverlay(event)) return null;
    return action(data);
  });

  handle('navi:status', status);
  handle('navi:start-rhythm', async () => {
    const launch = rhythmLaunch;
    rhythmLaunch = undefined;
    if (!launch || alarm || activeGame()) return false;
    if (updates.active()) return { started: false, text: 'Estoy actualizando Navi. Podrás jugar cuando vuelva.' };
    const revision = commandRevision;
    try {
      const stillRequested = () => !quitting && !alarm && revision === commandRevision;
      const started = launch.arcade ? await arcade.open(launch.arcade, stillRequested)
        : await rhythm.open(launch.demo, stillRequested, launch.playlist);
      return started ? { started: true } : false;
    } catch (error) {
      console.warn('Navi, minijuegos:', error.name);
      return { started: false, text: error.code ? 'No pude leer los archivos de la partida.' : error.message };
    }
  });
  handle('navi:open-source', url => {
    if (currentSources.has(url) && ai.isWebSource(url)) return shell.openExternal(url);
  });
  // Closing must still work while another voice or network request is pending.
  handle('navi:ask', text => typeof text === 'string' && naviMaintenanceIntent(text) === 'quit'
    ? answer(text) : handleRequest(() => answer(text)));
  handle('navi:waiting-cue', () => localVoice.waitingCue());
  handle('navi:synthesize', async payload => {
    const { id, text } = payload || {};
    if (!Number.isSafeInteger(id) || typeof text !== 'string' || !text.trim() || text.length > 2000) return null;
    synthesis?.controller.abort();
    const current = { id, controller: new AbortController() };
    synthesis = current;
    try {
      const started = performance.now();
      if (payload.bySentence) {
        let first;
        const count = await localVoice.narrate(text, current.controller.signal, part => {
          if (!current.controller.signal.aborted && win && !win.isDestroyed()) {
            first ??= Math.round(performance.now() - started);
            win.webContents.send('navi:voice-sentence', id, part);
          }
        });
        if (count) console.info(`Navi, voz local: primer bloque en ${first} ms · ${count} bloques en ${Math.round(performance.now() - started)} ms`);
        return { count };
      }
      const result = await localVoice.synthesize(text, current.controller.signal);
      return result?.wav ?? null;
    } catch (error) {
      if (!current.controller.signal.aborted) console.warn('Navi, reproducción de voz local:', error.message);
      return null;
    } finally {
      if (synthesis === current) synthesis = undefined;
    }
  });
  ipcMain.on('navi:stop-synthesis', (event, id) => {
    if (fromOverlay(event) && synthesis?.id === id) synthesis.controller.abort();
  });
  ipcMain.on('navi:voice-playback', (event, stats) => {
    if (!fromOverlay(event) || !Number.isFinite(stats?.startMs) || !Number.isInteger(stats.gaps)) return;
    console.info(`Navi, voz local: reproducción en ${Math.round(stats.startMs)} ms · ${stats.gaps} esperas entre bloques · ${Math.round(stats.waitMs || 0)} ms de espera`);
  });
  handle('navi:audio', payload => handleRequest(async () => {
    if (!key) return { text: 'Configura la clave de OpenAI para usar el micrófono.' };
    const { audio, format } = payload || {};
    if (!['wav', 'webm'].includes(format) || !(audio instanceof ArrayBuffer)
      || audio.byteLength < 100 || audio.byteLength > 3_000_000) {
      return { text: 'No se grabó audio. Prueba de nuevo.' };
    }
    const started = performance.now();
    const revision = commandRevision;
    const transcript = (await ai.transcribe(key, audio, format))
      .replace(/^(?:(?:navi|navy)[,:.!\s]+)?(?:(?:una\s+)?cosa|una pregunta)(?:[,:.!\s]+|$)/iu, '').trim();
    if (revision !== commandRevision) return { noSpeech: true };
    if (!/[\p{L}\p{Nd}]/u.test(transcript)) return { noSpeech: true };
    const transcribed = performance.now();
    const result = await answer(transcript);
    console.info(`Navi, petición por voz: transcripción ${Math.round(transcribed - started)} ms · respuesta ${Math.round(performance.now() - transcribed)} ms`);
    return { ...result, transcript };
  }));
  ipcMain.on('navi:voice-quit', event => {
    if (fromOverlay(event) && wakeEnabled && !alarm) void answer('Navi, ciérrate');
  });
  handle('navi:wake', () => {
    if (!isReady || !wakeEnabled || alarm || busy) return { accepted: false };
    if (!cursorFollow && placement.displayId === null) position(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    if (!cursorFollow || !key) enableOverlayInput(true);
    return { accepted: true, ai: Boolean(key) };
  });
  ipcMain.on('navi:wake-status', (event, state, detail) => {
    if (!fromOverlay(event) || !['loading', 'ready', 'off', 'error', 'suspended'].includes(state)) return;
    wakeStatus = state;
    updateTray();
    if (state === 'error' && typeof detail === 'string') {
      console.warn('Navi, activación por voz:', detail.slice(0, 350));
    }
  });
  handle('navi:paste-key', () => {
    if (envKey) return { text: 'Navi está usando la clave de desarrollo.' };
    const value = clipboard.readText().trim();
    if (!value) return { text: 'El portapapeles está vacío.' };
    if (!isApiKey(value)) return { text: 'Copia solo la clave de OpenAI, que empieza por sk-.' };
    return { value };
  });
  handle('navi:save-key', value => {
    if (typeof value !== 'string' || envKey || busy) return { ok: false, text: 'La clave no se puede cambiar ahora.' };
    const next = value.trim();
    if (next && !isApiKey(next)) {
      return { ok: false, text: 'Revisa la clave de API. Debe empezar por sk-.' };
    }
    try {
      if (next) {
        if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
          return { ok: false, text: 'El cifrado local no está disponible. Usa la variable OPENAI_API_KEY.' };
        }
        writeFileSync(keyPath() + '.tmp', safeStorage.encryptString(next));
        renameSync(keyPath() + '.tmp', keyPath());
      } else {
        rmSync(keyPath(), { force: true });
      }
      savedKey = next;
      key = savedKey || bundledKey;
      history = [];
      clearPendingCommands();
      const message = savedKey ? 'Clave guardada.' : bundledKey
        ? 'Clave local eliminada. Navi vuelve a usar la clave incluida.' : 'IA desconectada.';
      return { ok: true, ai: Boolean(key), text: message };
    } catch {
      return { ok: false, text: 'No se ha podido actualizar la clave.' };
    }
  });
  ipcMain.on('navi:dismiss', event => {
    if (!fromOverlay(event) || alarm) return;
    pendingWeather = undefined;
    continuingWeather = false;
    clearPendingCommands();
    enableOverlayInput(false);
  });
  ipcMain.on('navi:dismiss-alarm', event => {
    if (!fromOverlay(event) || !alarm) return;
    alarm = undefined;
    win.webContents.send('navi:hide');
    enableOverlayInput(false);
  });
}

function createOverlay() {
  win = new BrowserWindow({
    width, height, transparent: true, frame: false, show: false, alwaysOnTop: true,
    icon: path.join(__dirname, 'assets', 'navi-icon.png'),
    resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true,
    focusable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      navigateOnDragDrop: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });
  win.setIgnoreMouseEvents(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('show', raiseOverlay);
  win.on('blur', raiseOverlay);
  const reposition = () => {
    if (win.isDestroyed()) return;
    if (cursorTimer) trackCursor();
    else if (!cursorFollow) position(currentDisplay());
    raiseOverlay();
  };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, reposition);
  }
  win.on('closed', () => {
    clearInterval(cursorTimer);
    clearInterval(movement);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, reposition);
  });
  position(currentDisplay());
  win.webContents.on('did-start-loading', () => { isReady = false; });
  win.webContents.on('did-finish-load', () => {
    isReady = true;
    win.showInactive();
    raiseOverlay();
    win.webContents.send('navi:placement', cursorFollow?.layout || placement);
    win.webContents.send('navi:wake-enabled', wakeEnabled);
    if (alarm) {
      enableOverlayInput(true);
      win.webContents.send('navi:alarm', alarm);
    } else if (activation) {
      activate(activation);
      activation = undefined;
    }
    timers.check();
  });
  return win.loadURL(overlayUrl);
}

function setWakeEnabled(enabled) {
  wakeEnabled = enabled;
  wakeStatus = enabled ? 'loading' : 'off';
  try {
    writeFileSync(voicePath() + '.tmp', JSON.stringify(enabled));
    renameSync(voicePath() + '.tmp', voicePath());
  } catch (error) {
    console.warn('Navi, preferencia de voz:', error.code);
  }
  if (isReady) win.webContents.send('navi:wake-enabled', enabled);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const label = {
    off: 'Micrófono en pausa',
    loading: 'Iniciando el micrófono',
    ready: 'Escuchando «Oye, Navi»',
    error: 'Micrófono o modelo no disponible',
    suspended: 'Micrófono en espera'
  }[wakeStatus];
  tray.setToolTip('Navi · ' + label + (shortcut ? ' · ' + shortcut : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: shortcut ? 'Llamar a Navi (' + shortcut + ')' : 'Llamar a Navi', click: () => activate('request') },
    { label: 'Detectar «Oye, Navi»', type: 'checkbox', checked: wakeEnabled,
      click: item => setWakeEnabled(item.checked) },
    { label: 'Reconectar micrófono', enabled: wakeEnabled,
      click: () => win.webContents.send('navi:wake-restart') },
    { label: localVoice.label(), enabled: localVoice.state() === 'error', click: () => localVoice.start() },
    { label: 'Configurar IA…', click: () => activate('settings') },
    { label: 'Minijuegos', submenu: [
      { label: 'Jugar…', click: () => {
        activate('request');
        if (!activeGame() && !alarm) win.webContents.send('navi:rhythm-request', true);
      } },
      { label: 'Jugar con archivos locales…', click: () => {
        activate('request');
        if (!activeGame() && !alarm) win.webContents.send('navi:rhythm-request', false);
      } },
      { label: 'Abrir carpeta de canciones', click: () => { void rhythm.showSongs().catch(error => console.warn('Navi, ritmo:', error.name)); } },
      { label: 'Importar lista de Mafu (CSV)…', click: () => {
        void rhythm.importPlaylist().then(message => {
          if (message && isReady && !activeGame() && !alarm) {
            activate('request');
            win.webContents.send('navi:rhythm-result', message);
          }
        }).catch(error => dialog.showErrorBox('Navi · Playlist', error.code ? 'No pude abrir el archivo CSV.' : error.message));
      } },
      { label: 'Ver playlist de Mafu en Spotify', click: () => { void rhythm.showPlaylist().catch(error => console.warn('Navi, ritmo:', error.name)); } }
    ] },
    ...(cursorFollow ? [{ label: 'Soltar el cursor', click: () => setCursorFollowing(false) }] : []),
    { type: 'separator' },
    { label: 'Comprobar actualizaciones…', enabled: !activeGame(), click: () => {
      activate('request');
      void updates.check().then(message => {
        if (isReady && !alarm && !activeGame()) win.webContents.send('navi:rhythm-result', message, false);
      });
    } },
    { label: 'Actualizar Navi', enabled: app.isPackaged && !activeGame(), click: () => {
      activate('request');
      updates.start();
    } },
    { label: 'Cerrar Navi', click: () => { if (updates.current().phase !== 'installing') app.quit(); } }
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  updateTray();
  tray.on('click', () => activate('request'));
}

async function start() {
  const directory = app.getPath('userData');
  mkdirSync(directory, { recursive: true });
  const installedVoice = path.join(process.resourcesPath || __dirname, 'local-voice');
  const voiceResources = app.isPackaged && existsSync(installedVoice) ? installedVoice : path.join(__dirname, 'local-voice');
  localVoice = createLocalVoice({
    resources: voiceResources,
    chosenProfile: true,
    cache: path.join(directory, 'voice-models'),
    speechCache: path.join(directory, 'voice-replies'),
    onStatus: updateTray
  });
  try {
    const saved = JSON.parse(readFileSync(placementPath(), 'utf8'));
    if (['left', 'right'].includes(saved?.horizontal) && ['top', 'center', 'bottom'].includes(saved.vertical)
      && Number.isInteger(saved.displayId)) placement = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Navi, posición:', error.code || error.name);
  }
  try {
    wakeEnabled = JSON.parse(readFileSync(voicePath(), 'utf8')) !== false;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Navi, preferencia de voz:', error.code || error.name);
  }
  wakeStatus = wakeEnabled ? 'loading' : 'off';
  if (!envKey && safeStorage.isEncryptionAvailable() && existsSync(keyPath())) {
    try {
      const stored = safeStorage.decryptString(readFileSync(keyPath())).trim();
      if (isApiKey(stored)) {
        savedKey = stored;
        key = stored;
      }
    }
    catch { console.error('No se pudo descifrar la clave de Navi.'); }
  }
  timers = createTimers(path.join(directory, 'timers.json'), ring, error => {
    console.error('Error de temporizadores:', error.code || error.name);
  });
  powerMonitor.on('resume', timers.check);
  powerMonitor.on('resume', raiseOverlay);
  if (process.platform === 'win32') {
    powerMonitor.on('unlock-screen', raiseOverlay);
  }
  powerMonitor.on('resume', () => {
    if (isReady && wakeEnabled) win.webContents.send('navi:wake-restart');
  });

  // Allow microphone capture from the local overlay only.
  const mayRecord = (contents, permission) => contents === win?.webContents
    && contents.getURL() === overlayUrl && permission === 'media';
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    mayRecord(contents, permission) && details.mediaType === 'audio');
  session.defaultSession.setPermissionRequestHandler((contents, permission, done, details) =>
    done(mayRecord(contents, permission) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'));

  registerOverlayProtocol();
  registerIpc();
  rhythm.register();
  arcade.register();
  for (const candidate of ['Control+Alt+N', 'Control+Shift+F9']) {
    if (globalShortcut.register(candidate, () => activate('request'))) {
      shortcut = candidate.replace('Control', 'Ctrl');
      break;
    }
  }
  windowsApps.warmUp();
  await createOverlay();
  if (process.platform === 'win32') {
    // Restore the desktop overlay's stacking if another topmost app moves ahead of it.
    overlayPriority = setInterval(raiseOverlay, 1500);
    overlayPriority.unref();
  }
  createTray();
  localVoice.start();
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'navi',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);
app.setName('Navi');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => activate('request'));
  app.on('will-quit', () => {
    quitting = true;
    activeGame()?.close();
    clearInterval(overlayPriority);
    clearInterval(movement);
    clearInterval(cursorTimer);
    globalShortcut.unregisterAll();
    timers?.dispose();
    localVoice?.stop();
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Navi', 'No se pudo iniciar Navi.\n' + error.message);
    app.quit();
  });
}
