const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { MEDIA_ACTIONS, validMediaAction } = require('./media-commands.cjs');

const run = promisify(execFile);
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const mediaSetup = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation?1'
} | Select-Object -First 1

function Wait-MediaResult($operation, [Type] $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (!$task.Wait(4000)) { throw 'Media operation timed out.' }
  return $task.Result
}

$manager = Wait-MediaResult ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $managerType
`;

const playbackScript = mediaSetup + String.raw`
$session = $null
$browsers = @{
  browser = 'chrome|msedge|firefox|brave|opera|vivaldi';
  chrome = 'chrome'; edge = 'msedge|microsoftedge'; firefox = 'firefox';
}
if ($target -eq 'current') {
  $session = $manager.GetCurrentSession()
  if ($action -eq 'status' -and (!$session -or $session.GetPlaybackInfo().PlaybackStatus -ne 'Playing')) {
    $playing = @($manager.GetSessions() | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' })
    if ($playing.Count -eq 1) { $session = $playing[0] }
    elseif ($playing.Count -gt 1) { 'ambiguous'; return }
  }
} else {
  $candidates = @()
  foreach ($item in $manager.GetSessions()) {
    $appId = $item.SourceAppUserModelId
    if ($target -eq 'spotify' -and $appId -match 'spotify') {
      $candidates += $item
    } elseif ($browsers.ContainsKey($target) -and $appId -match $browsers[$target]) {
      $candidates += $item
    } elseif ($target -eq 'youtube') {
      if ($appId -match '(^|[.!_-])youtube(?:music)?([.!_-]|$)') {
        $candidates += $item
      } elseif ($appId -notmatch 'spotify') {
        try {
          $properties = Wait-MediaResult ($item.TryGetMediaPropertiesAsync()) $propertiesType
          if ($properties.Title -match '[-|\u2013\u2014]\s*YouTube( Music)?\s*$' -or
              $properties.AlbumTitle -match '^YouTube( Music)?$') { $candidates += $item }
        } catch {}
      }
    }
  }
  if ($candidates.Count -eq 1) {
    $session = $candidates[0]
  } elseif ($candidates.Count -gt 1) {
    $playing = @($candidates | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' })
    if ($playing.Count -eq 1) { $session = $playing[0] }
    else { 'ambiguous'; return }
  }
}

if (!$session) { 'missing'; return }
$playback = $session.GetPlaybackInfo()
if (!$playback) { 'unsupported'; return }
if ($action -eq 'status') {
  if ($playback.PlaybackStatus -in @('Closed', 'Opened', 'Stopped')) { 'missing'; return }
  $properties = Wait-MediaResult ($session.TryGetMediaPropertiesAsync()) $propertiesType
  ConvertTo-Json -Compress -InputObject @{
    title = $properties.Title
    artist = $properties.Artist
    playback = [string] $playback.PlaybackStatus
    source = $session.SourceAppUserModelId
  }
  return
}
$controls = $playback.Controls
$operation = $null
switch ($action) {
  'pause' {
    if ($playback.PlaybackStatus -in @('Paused', 'Stopped')) { 'paused'; return }
    if ($controls.IsPauseEnabled) { $operation = $session.TryPauseAsync() }
    elseif ($controls.IsPlayPauseToggleEnabled -and $playback.PlaybackStatus -eq 'Playing') {
      $operation = $session.TryTogglePlayPauseAsync()
    }
  }
  'play' {
    if ($playback.PlaybackStatus -eq 'Playing') { 'playing'; return }
    if ($controls.IsPlayEnabled) { $operation = $session.TryPlayAsync() }
    elseif ($controls.IsPlayPauseToggleEnabled -and $playback.PlaybackStatus -in @('Paused', 'Stopped')) {
      $operation = $session.TryTogglePlayPauseAsync()
    }
  }
  'next' {
    if ($controls.IsNextEnabled) { $operation = $session.TrySkipNextAsync() }
  }
  'previous' {
    if ($controls.IsPreviousEnabled) { $operation = $session.TrySkipPreviousAsync() }
  }
  'restart' {
    if ($controls.IsPlaybackPositionEnabled) {
      $timeline = $session.GetTimelineProperties()
      if ($timeline -and $timeline.MinSeekTime.Ticks -gt $timeline.StartTime.Ticks) {
        'unsupported'; return
      }
      $start = if ($timeline) { $timeline.StartTime.Ticks } else { 0 }
      $operation = $session.TryChangePlaybackPositionAsync([long] $start)
    }
  }
}
if (!$operation) { 'unsupported'; return }
if (Wait-MediaResult $operation ([bool])) { 'ok' } else { 'failed' }
`;

function describeMedia({ title, artist, playback, source }) {
  const label = typeof title === 'string' ? title.replace(/\s+/gu, ' ').trim().slice(0, 180) : '';
  const author = typeof artist === 'string' ? artist.replace(/\s+/gu, ' ').trim().slice(0, 100) : '';
  const inSpotify = typeof source === 'string' && /spotify/iu.test(source);
  const player = inSpotify ? ' en Spotify' : '';
  if (!/[\p{L}\p{N}]/u.test(label)) {
    return playback === 'Paused' ? 'Hay una reproducción en pausa' + player + ', pero el reproductor no indica el título.'
      : 'El reproductor no indica el título de lo que suena.';
  }
  const item = label + (/[\p{L}\p{N}]/u.test(author) && author.toLowerCase() !== label.toLowerCase() ? ', de ' + author : '');
  if (playback === 'Paused') return 'Está en pausa' + player + '. ' + item + '.';
  if (playback === 'Playing') return (inSpotify ? 'En Spotify suena ' : 'Está sonando ') + item + '.';
  return 'El reproductor tiene seleccionado ' + item + '.';
}

async function controlMedia(args) {
  if (!validMediaAction(args)) return '¿Qué quieres que haga con la reproducción?';
  if (process.platform !== 'win32') return 'Los controles multimedia están disponibles en Windows.';
  const { action, target } = args;
  try {
    // Both values are from closed lists. The spoken text is never passed to PowerShell.
    const script = `$action = '${action}'; $target = '${target}'\n` + playbackScript;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 11000, maxBuffer: 65_536 });
    const result = stdout.trim();
    if (action === 'status' && result.startsWith('{')) return describeMedia(JSON.parse(result));
    switch (result) {
      case 'ok': return MEDIA_ACTIONS[action].reply || 'No he recibido información sobre lo que suena.';
      case 'paused': return 'La reproducción ya está en pausa.';
      case 'playing': return 'Ya se está reproduciendo.';
      case 'missing':
        if (target === 'youtube') return 'Windows no identifica ese vídeo como YouTube. Prueba con «el vídeo actual» si es el que tienes puesto.';
        if (target === 'spotify') return 'No veo ninguna reproducción activa o pausada en la app de Spotify.';
        if (target !== 'current') return 'No encuentro una reproducción en ese navegador. Prueba con «el vídeo actual» si es el que tienes puesto.';
        return action === 'status' ? 'Windows no muestra ninguna reproducción ahora mismo.' : 'No encuentro una reproducción que pueda controlar.';
      case 'ambiguous':
        return action === 'status' ? 'Hay varias reproducciones. Dime en qué reproductor quieres que mire.'
          : 'Hay varias reproducciones que coinciden. Prueba con «la reproducción actual» tras seleccionar la que quieres.';
      case 'unsupported':
        if (action === 'restart') return 'Ese reproductor no me deja volver al principio desde Windows.';
        if (action === 'next' || action === 'previous') return 'Ese reproductor no ofrece ese salto ahora mismo.';
        return 'Ese reproductor no permite esa acción ahora mismo.';
      default: return 'El reproductor no ha aceptado la acción.';
    }
  } catch (error) {
    console.warn('Navi, multimedia:', error.code ?? error.name);
    return 'No he podido acceder a los controles multimedia de Windows.';
  }
}


const spotifyShuffleScript = String.raw`
foreach ($session in $manager.GetSessions()) {
  if ($session.SourceAppUserModelId -notmatch 'spotify') { continue }
  $playback = $session.GetPlaybackInfo()
  if ($playback.IsShuffleActive -eq $true) { return }
  if ($playback.Controls.IsShuffleEnabled) {
    try {
      if (Wait-MediaResult ($session.TryChangeShuffleActiveAsync($true)) ([bool])) { return }
    } catch {}
  }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$byButton = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
foreach ($process in @(Get-Process -Name Spotify -ErrorAction SilentlyContinue)) {
  if (!$process.MainWindowHandle) { continue }
  try {
    $root = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $buttons = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $byButton)
    foreach ($button in $buttons) {
      if ($button.Current.Name -notmatch '^(Enable Shuffle|Turn on Shuffle|Activar (?:la )?reproducci.n aleatoria|Activar (?:el )?(?:modo )?aleatorio)$') { continue }
      $pattern = $null
      if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref] $pattern)) {
        $pattern.Invoke()
        return
      }
    }
  } catch {}
}
`;

const spotifyPlaylistScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
$view = [Windows.Automation.TreeScope]::Descendants
$buttonType = [Windows.Automation.ControlType]::Button
$documentType = [Windows.Automation.ControlType]::Document
$byTitle = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $playlistTitle)
$byDocument = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $documentType)
$byButton = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $buttonType)
$enabled = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsEnabledProperty, $true)
$visible = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
$buttonFilter = [Windows.Automation.AndCondition]::new($byButton, $enabled, $visible)
$play = '^(Play|Reproducir|Lecture|Abspielen|Riproduci|Tocar|Reproduzir)$'
$namedPlay = '^(Play|Reproducir|Lecture|Abspielen|Riproduci|Tocar|Reproduzir)(?: playlist| lista)?\s*[:"]?\s*' + [regex]::Escape($playlistTitle) + '\s*"?$'
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  foreach ($process in @(Get-Process -Name Spotify -ErrorAction SilentlyContinue)) {
    if (!$process.MainWindowHandle) { continue }
    try {
      $root = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      foreach ($document in $root.FindAll($view, $byDocument)) {
        $heading = $document.FindFirst($view, $byTitle)
        if (!$heading -and !$document.Current.Name.Contains($playlistTitle)) { continue }
        $headBottom = if ($heading) { $heading.Current.BoundingRectangle.Bottom } else { 0 }
        foreach ($button in $document.FindAll($view, $buttonFilter)) {
          $name = $button.Current.Name
          $rectangle = $button.Current.BoundingRectangle
          $nearHeader = $headBottom -gt 0 -and $rectangle.Top -ge ($headBottom - 22) -and $rectangle.Top -le ($headBottom + 230)
          if ($name -notmatch $namedPlay -and !($nearHeader -and $name -match $play)) { continue }
          $pattern = $null
          if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref] $pattern)) {
            $pattern.Invoke()
            return
          }
        }
      }
    } catch {}
  }
  Start-Sleep -Milliseconds 350
}
`;

async function runSpotifyScript(script, signal, timeout) {
  if (signal?.aborted) return;
  await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout, signal, maxBuffer: 65_536 });
}

function shuffleSpotify(signal) {
  return runSpotifyScript(mediaSetup + spotifyShuffleScript, signal, 5500);
}

function invokeSpotifyPlaylist(signal) {
  // This is the exact public playlist title. Look for its visible play control in Spotify only.
  const title = '$playlistTitle = [string]([char]0x2014) + " " + [char]0x02C3 + [char]0x02C2 + "." + [char]0x141F\n';
  return runSpotifyScript(title + spotifyPlaylistScript, signal, 4800);
}

function pauseSpotify(signal) {
  return runSpotifyScript("$action = 'pause'; $target = 'spotify'\n" + playbackScript, signal, 5500);
}

const monitorScript = mediaSetup + String.raw`
while ($true) {
  try {
    $session = $null
    $playing = $null
    foreach ($item in $manager.GetSessions()) {
      if ($item.SourceAppUserModelId -notmatch 'spotify') { continue }
      if (!$session) { $session = $item }
      if ($item.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { $playing = $item; break }
    }
    if ($playing) { $session = $playing }
    if (!$session) {
      '{}'
    } else {
      $properties = Wait-MediaResult ($session.TryGetMediaPropertiesAsync()) $propertiesType
      $timeline = $session.GetTimelineProperties()
      $playback = $session.GetPlaybackInfo()
      ConvertTo-Json -Compress -InputObject @{
        title = $properties.Title; artist = $properties.Artist
        status = [string] $playback.PlaybackStatus
        duration = ($timeline.EndTime - $timeline.StartTime).TotalSeconds
        position = ($timeline.Position - $timeline.StartTime).TotalSeconds
        updated = $timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
      }
    }
  } catch { '{}' }
  Start-Sleep -Milliseconds 500
}
`;

function watchSpotify(onStatus, onError) {
  const encoded = Buffer.from(monitorScript, 'utf16le').toString('base64');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '';
  let stopped = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      let status;
      try { status = JSON.parse(line); } catch { continue; }
      if (!stopped) onStatus(status);
    }
  });
  child.once('error', error => { if (!stopped) onError(error); });
  child.once('close', () => { if (!stopped) onError(new Error('Spotify monitor stopped')); });
  return () => {
    stopped = true;
    child.kill();
  };
}

module.exports = { controlMedia, watchSpotify, shuffleSpotify, invokeSpotifyPlaylist, pauseSpotify };
