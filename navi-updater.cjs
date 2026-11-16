function createNaviUpdater({ app, notify, createUpdater = () => require('electron-updater').autoUpdater,
  waitForInstall = () => new Promise(resolve => setTimeout(resolve, 650)), platform = process.platform }) {
  let updater;
  let toCheck;
  let operation;
  const supported = () => app.isPackaged && platform === 'win32';
  let current = { phase: 'idle' };
  let installError;

  function publish(phase, details = {}) {
    current = { phase, ...details };
    notify(current);
  }

  function engine() {
    if (updater) return updater;
    updater = createUpdater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('download-progress', ({ percent }) => {
      if (current.phase !== 'downloading' || !Number.isFinite(percent)) return;
      const value = Math.max(current.percent ?? 0, Math.min(100, Math.floor(percent)));
      if (value !== current.percent) publish('downloading', { version: current.version, percent: value });
    });
    updater.on('error', error => {
      if (current.phase === 'installing') {
        installError = error;
        if (!operation) fail(error);
      }
    });
    return updater;
  }

  function fail(error, visible = true) {
    console.warn('Navi, actualización:', error?.code || error?.name || 'Error');
    const unavailable = ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
      'ERR_UPDATER_NO_PUBLISHED_VERSIONS'].includes(error?.code);
    const text = unavailable ? 'Todavía no encuentro una release publicada con latest.yml en GitHub.'
      : 'No pude completar la actualización. Puedes volver a pedírmelo.';
    if (visible) publish('error', { text });
    return text;
  }

  async function check() {
    if (!app.isPackaged) return 'Llevas Navi ' + app.getVersion() + ' en modo desarrollo. Las actualizaciones de GitHub se comprueban desde la instalación de Windows.';
    if (!supported()) return 'La actualización integrada de Navi está disponible en Windows.';
    if (operation || current.phase === 'installing') return 'Ya estoy preparando la actualización.';
    if (!toCheck) {
      toCheck = (async () => {
        try {
          const result = await engine().checkForUpdates();
          if (result?.isUpdateAvailable) {
            return 'Tienes Navi ' + app.getVersion() + ' y está disponible la versión ' + result.updateInfo.version
              + '. Si quieres instalarla, dime «Navi, actualízate».';
          }
          return 'Ya tienes la última versión disponible, Navi ' + app.getVersion() + '.';
        } catch (error) {
          return fail(error, false);
        }
      })().finally(() => { toCheck = undefined; });
    }
    return toCheck;
  }

  function start() {
    if (!supported()) return { started: false, text: 'Instala Navi con su instalador de Windows para poder actualizarla por voz.' };
    if (operation || current.phase === 'installing') return { started: true };
    publish('checking');
    operation = Promise.resolve().then(async () => {
      try {
        if (toCheck) await toCheck;
        const installed = engine();
        const result = await installed.checkForUpdates();
        if (!result?.isUpdateAvailable) {
          publish('current', { text: 'Ya tienes la última versión disponible, Navi ' + app.getVersion() + '.' });
          return;
        }
        const { version } = result.updateInfo;
        publish('downloading', { version });
        const files = await installed.downloadUpdate();
        if (!Array.isArray(files) || !files.length) throw new Error('No se descargó el instalador.');
        publish('installing', { version, percent: 100 });
        await waitForInstall();
        installError = undefined;
        installed.quitAndInstall(true, true);
        if (installError) throw installError;
      } catch (error) {
        fail(error);
      }
    }).finally(() => { operation = undefined; });
    return { started: true };
  }

  return { check, start, current: () => current,
    active: () => ['checking', 'downloading', 'installing'].includes(current.phase) };
}

module.exports = { createNaviUpdater };
