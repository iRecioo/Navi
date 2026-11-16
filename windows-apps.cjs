const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { existsSync } = require('node:fs');
const path = require('node:path');

const run = promisify(execFile);
const inventory = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$apps = @(Get-StartApps | ForEach-Object {
  @{ name = $_.Name; target = $_.AppID; kind = 'app' }
})

$folders = @(
  @{ root = [Environment]::GetFolderPath('Programs'); recurse = $true },
  @{ root = [Environment]::GetFolderPath('CommonPrograms'); recurse = $true },
  @{ root = [Environment]::GetFolderPath('DesktopDirectory'); recurse = $false },
  @{ root = [Environment]::GetFolderPath('CommonDesktopDirectory'); recurse = $false }
)
foreach ($folder in $folders) {
  if ($folder.root) {
    $apps += @(Get-ChildItem -LiteralPath $folder.root -Filter '*.lnk' -File -Recurse:$folder.recurse |
      ForEach-Object { @{ name = $_.BaseName; target = $_.FullName; kind = 'file' } })
  }
}

$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths'
)
foreach ($root in $roots) {
  $apps += @(Get-ChildItem -LiteralPath $root | ForEach-Object {
    $target = $_.GetValue('')
    if ($target) {
      @{ name = [IO.Path]::GetFileNameWithoutExtension($_.PSChildName);
         target = $target.Trim('"'); kind = 'file' }
    }
  })
}
ConvertTo-Json -InputObject $apps -Compress
`;

const runningInventory = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$session = (Get-Process -Id $PID).SessionId
$apps = @(Get-Process | Where-Object { $_.SessionId -eq $session -and
  ($_.MainWindowHandle -ne 0 -or $_.ProcessName -eq 'EpicGamesLauncher') } | ForEach-Object {
  $exe = $_.Path
  if ($exe -and $_.StartTime) {
    @{ id = $_.Id; exe = $exe; name = $_.ProcessName; label = $_.FileVersionInfo.ProductName;
       started = $_.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }
  }
})
ConvertTo-Json -InputObject $apps -Compress
`;

const closeWindows = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$session = (Get-Process -Id $PID).SessionId
function Find-SelectedProcess($entry) {
  $p = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
  if ($p -and $p.SessionId -eq $session -and $p.Path -eq $entry.exe -and
    $p.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -eq $entry.started) { $p }
}
$remaining = @()
foreach ($entry in $entries) {
  $p = Find-SelectedProcess $entry
  if (!$p) { continue }
  if ($p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() }
  $remaining += $entry
}
if ($remaining.Count) { Start-Sleep -Milliseconds 1200 }
$status = 'closed'
foreach ($entry in $remaining) {
  $p = Find-SelectedProcess $entry
  if (!$p) { continue }
  if ($entry.forceEpic -and $p.ProcessName -eq 'EpicGamesLauncher' -and
    $p.Path -match '\\Portal\\Binaries\\Win(?:32|64)\\EpicGamesLauncher\.exe$') {
    $p.Kill()
    if (!$p.WaitForExit(1500)) { $status = 'pending' }
  } elseif ($p.MainWindowHandle -ne 0) {
    $status = 'pending'
  } elseif ($status -eq 'closed') {
    $status = 'window'
  }
}
$status
`;

const aliases = new Map([
  ['chrome', ['google chrome', 'chrome']],
  ['google chrome', ['google chrome', 'chrome']],
  ['calc', ['calculadora', 'calculator', 'calc']],
  ['calculator', ['calculadora', 'calculator', 'calc']],
  ['calculadora', ['calculadora', 'calculator', 'calc']],
  ['navegador', ['google chrome', 'chrome']],
  ['bloc de notas', ['bloc de notas', 'notepad']],
  ['vs code', ['visual studio code', 'vs code', 'code']],
  ['vscode', ['visual studio code', 'vs code', 'code']],
  ['visual studio code', ['visual studio code', 'vs code', 'code']],
  ['obs', ['obs studio', 'obs', 'obs64']],
  ['explorador de archivos', ['explorador de archivos', 'file explorer', 'explorer']],
  ['epic games', ['epic games launcher', 'epicgameslauncher']],
  ['epic games launcher', ['epic games launcher', 'epicgameslauncher']],
  ['epic', ['epic games launcher', 'epicgameslauncher']]
]);

function normalize(name) {
  return name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim();
}

function spellingDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious;
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let col = 1; col <= right.length; col += 1) {
      const substitution = left[row - 1] === right[col - 1] ? 0 : 1;
      current[col] = Math.min(previous[col] + 1, current[col - 1] + 1, previous[col - 1] + substitution);
      if (row > 1 && col > 1 && left[row - 1] === right[col - 2] && left[row - 2] === right[col - 1]) {
        current[col] = Math.min(current[col], beforePrevious[col - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length];
}

function spellingScore(query, candidate) {
  const words = query.split(' ');
  const appWords = candidate.split(' ');
  if (query.length < 5 || appWords.length < words.length) return Infinity;
  const maxChanges = query.length >= 9 ? 2 : 1;
  let best = Infinity;
  for (let start = 0; start <= appWords.length - words.length; start += 1) {
    let changes = 0;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const appWord = appWords[start + index];
      if (word === appWord) continue;
      if (/\d/u.test(word) || /\d/u.test(appWord) || word.length < 3
        || Math.abs(word.length - appWord.length) > maxChanges) {
        changes = Infinity;
        break;
      }
      changes += spellingDistance(word, appWord);
      if (changes > maxChanges) break;
    }
    if (changes <= maxChanges) best = Math.min(best, changes + .25 * (appWords.length - words.length));
  }
  return best;
}

function matches(apps, name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120
    || /[\\/<>|;&%\p{Cc}]/u.test(name)) return [];
  const normalized = normalize(name.replace(/\.exe$/iu, ''));
  if (!normalized) return [];
  const keys = aliases.get(normalized) || [normalized];
  for (const key of keys) {
    const exactMatches = apps.filter(app => normalize(app.name) === key);
    const exact = exactMatches.find(app => app.kind === 'file') || exactMatches[0];
    if (exact) return [exact];
  }

  const catalog = new Map();
  for (const app of apps) {
    const candidate = normalize(app.name);
    if (!catalog.has(candidate) || app.kind === 'file' && catalog.get(candidate).kind !== 'file') catalog.set(candidate, app);
  }
  const partial = [...catalog].filter(([candidate]) =>
    keys.some(key => key.length >= 3 && (' ' + candidate + ' ').includes(' ' + key + ' ')));
  if (partial.length) return partial.map(([, app]) => app);

  const similar = [...catalog].map(([candidate, app]) => ({ app, score: spellingScore(normalized, candidate) }))
    .filter(match => Number.isFinite(match.score)).sort((a, b) => a.score - b.score);
  if (!similar.length) return [];
  return similar.filter(match => match.score < similar[0].score + 1).map(match => match.app);
}

function closingMatches(processes, name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\\/<>|;&%\p{Cc}]/u.test(name)) return [];
  const query = normalize(name.replace(/\.exe$/iu, ''));
  if (!query) return [];
  const keys = aliases.get(query) || [query];
  const groups = new Map();
  for (const process of processes) {
    if (!Number.isSafeInteger(process.id) || process.id < 1 || !/^\d+$/u.test(process.started)
      || typeof process.exe !== 'string' || typeof process.name !== 'string'
      || /^(?:explorer|systemsettings|applicationframehost|electron|navi|taskmgr)$/iu.test(process.name)) continue;
    if (![process.name, process.label].some(value =>
      typeof value === 'string' && keys.includes(normalize(value)))) continue;
    const exe = process.exe.toLowerCase();
    const group = groups.get(exe) || [];
    group.push(process);
    groups.set(exe, group);
  }
  return [...groups.values()];
}

function createWindowsApps(shell) {
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const explorer = path.join(windows, 'explorer.exe');
  let loaded;
  let timestamp = 0;

  async function scan() {
    try {
      const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-Command', inventory], { windowsHide: true, timeout: 10000, maxBuffer: 3_000_000 });
      const apps = JSON.parse(stdout.trim());
      return apps.filter(app => typeof app.name === 'string' && typeof app.target === 'string'
        && (app.kind === 'file' && path.isAbsolute(app.target) && /\.(?:lnk|exe)$/iu.test(app.target)
          || app.kind === 'app' && /^[\p{L}\p{N}._!+{}-]{1,250}$/u.test(app.target)));
    } catch (error) {
      console.warn('Navi, catálogo de apps:', error.code || error.name);
      return [];
    }
  }

  function refresh(force = false) {
    if (!loaded || force || Date.now() - timestamp > 60000) {
      timestamp = Date.now();
      loaded = scan();
    }
    return loaded;
  }

  function fallbacks() {
    const apps = [
      { name: 'Calculadora', target: path.join(windows, 'System32', 'calc.exe') },
      { name: 'Bloc de notas', target: path.join(windows, 'System32', 'notepad.exe') },
      { name: 'Explorador de archivos', target: explorer }
    ];
    for (const root of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (root) apps.push({ name: 'Google Chrome', target: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    }
    return apps.filter(app => existsSync(app.target)).map(app => ({ ...app, kind: 'file' }));
  }

  async function launch(entry) {
    if (entry.kind === 'file') {
      const problem = await shell.openPath(entry.target);
      return !problem;
    }
    return new Promise(resolve => {
      const child = spawn(explorer, ['shell:AppsFolder\\' + entry.target], {
        windowsHide: true, detached: true, stdio: 'ignore'
      });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
  }

  return {
    warmUp() { if (process.platform === 'win32') void refresh(); },
    async open(name, onAmbiguous) {
      if (process.platform !== 'win32') return 'Esta acción está disponible en Windows.';
      const builtins = fallbacks();
      let entries = matches([...builtins, ...await refresh()], name);
      if (!entries.length && Date.now() - timestamp > 15000) {
        entries = matches([...builtins, ...await refresh(true)], name);
      }
      if (!entries.length) return 'No encuentro «' + name + '». Prueba su nombre en Inicio o crea un acceso directo en el escritorio.';
      if (entries.length > 1) {
        const options = entries.slice(0, 4).map(app => app.name);
        onAmbiguous?.(options);
        return '¿Cuál quieres abrir? ' + options.map((name, index) => (index + 1) + '. ' + name).join(', ') + '.';
      }

      const app = entries[0];
      if (await launch(app)) return 'He abierto ' + app.name + '.';
      return 'No he podido abrir ' + app.name + '.';
    },
    async close(name) {
      if (process.platform !== 'win32') return 'Esta acción está disponible en Windows.';
      const options = { windowsHide: true, timeout: 10000, maxBuffer: 3_000_000 };
      const ps = script => run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], options);
      try {
        const { stdout } = await ps(runningInventory);
        const groups = closingMatches(JSON.parse(stdout.trim()), name);
        if (!groups.length) return 'No encuentro «' + name + '» abierta.';
        if (groups.length > 1) return 'Hay varias aplicaciones que coinciden. Dime el nombre exacto de la que quieres cerrar.';
        const entries = groups[0].map(({ id, exe, started, name: exeName }) =>
          ({ id, exe, started, forceEpic: exeName.toLowerCase() === 'epicgameslauncher' }));
        const input = Buffer.from(JSON.stringify(entries), 'utf8').toString('base64');
        const script = "$entries = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + input + "')))\n";
        const { stdout: result } = await ps(script + closeWindows);
        const label = groups[0][0].label || groups[0][0].name;
        if (result.trim() === 'closed') return 'He cerrado ' + label + '.';
        if (result.trim() === 'window') return 'He cerrado la ventana de ' + label + '.';
        return label + ' sigue abierta. Puede que esté esperando a que guardes o confirmes el cierre.';
      } catch (error) {
        console.warn('Navi, cierre de app:', error.code || error.name);
        return 'No he podido cerrar «' + name + '».';
      }
    }
  };
}

module.exports = { createWindowsApps, matches, closingMatches };
