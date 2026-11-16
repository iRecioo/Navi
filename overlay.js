const el = id => document.getElementById(id);
const panel = el('panel');
const request = el('request');
const settings = el('settings');
const alarm = el('alarm');
const command = el('command');
const reply = el('reply');
const replyStatus = el('reply-status');
const sourcesEl = el('sources');
const mic = el('mic');
const send = el('send');
const apiKey = el('api-key');
const chime = el('chime');
const voiceStatus = el('voice-status');
const composer = el('command-form');
const controls = el('request-controls');
const rhythmChoices = el('rhythm-confirmation');
const arcadeChoices = el('arcade-choices');
const updatePanel = el('update-progress');
const updateBar = el('update-bar');
const updatePercent = el('update-percent');
let updatePhase = 'idle';
const returnDelay = 10_000;
const replyDelay = 20_000;

let config = { ai: false, wakeEnabled: false };
let view = 'idle';
let state = 'idle';
let recording;
let revision = 0;
let keyPending = false;
let speechActive;
let speechId = 0;
let voiceCapture = false;
let capturingFollowUp = false;
let conversation = false;
let returnTimer;
let writing;
let showComposer = false;
let awaitingReply = false;
let rhythmPlaying = false;
let confirmingRhythm = false;
let choosingArcade = false;
let launchingRhythm = false;
let voicePlaying = false;
let rhythmSummary = false;
const captionLetters = new Intl.Segmenter('es', { granularity: 'grapheme' });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const wake = window.NaviWake.create({
  onStatus(status, detail) {
    const messages = {
      loading: 'Iniciando el micrófono…',
      error: 'Micrófono no disponible. Prueba «Reconectar micrófono» en la bandeja.',
      suspended: 'Micrófono en espera. Pulsa el atajo o el icono de Navi.'
    };
    voiceStatus.textContent = messages[status] || '';
    voiceStatus.hidden = !messages[status];
    window.navi.wakeStatus(status, detail);
  },
  async onWake() {
    const turn = revision;
    const result = await window.navi.wake();
    if (!result?.accepted || turn !== revision) return false;
    config.ai = result.ai;
    finishWriting();
    stopSpeech();
    command.value = '';
    setView('request', false);
    if (!config.ai) {
      reply.textContent = '¡Te oigo! Abre Configurar IA para dictarme peticiones o escríbeme aquí.';
      setComposer(true);
      command.focus();
      return false;
    }
    voiceCapture = true;
    capturingFollowUp = false;
    conversation = true;
    reply.textContent = '…';
    setState('wake-recording');
    return true;
  },
  onFollowUp() {
    if (!(conversation || confirmingRhythm || choosingArcade) || view !== 'request' || state !== 'active') return false;
    voiceCapture = true;
    capturingFollowUp = true;
    setState('wake-recording');
    if ((confirmingRhythm || choosingArcade || rhythmSummary) && speechActive) stopSpeech();
    return true;
  },
  onAudio(audio) {
    if (!voiceCapture) return;
    voiceCapture = false;
    submit(() => window.navi.audio(audio, 'wav'), { voice: true });
  },
  onSilence() {
    if (!voiceCapture) return;
    voiceCapture = false;
    if (!capturingFollowUp) reply.textContent = 'No oí una petición. Te sigo escuchando.';
    setState('active');
  },
  onQuit() { window.navi.voiceQuit(); },
  onStopAlarm() {
    if (view === 'alarm') dismiss();
  },
  onInterrupt(close) {
    if (!speechActive || view !== 'request') return;
    if (close) {
      dismiss();
      return;
    }
    conversation = true;
    finishWriting();
    stopSpeech();
    showSources();
    reply.textContent = '…';
    replyStatus.textContent = 'Te escucho.';
  }
});

function syncWake() {
  const canAnswerRhythm = !voicePlaying && (confirmingRhythm || choosingArcade || rhythmSummary);
  const followUp = config.wakeEnabled && config.ai && (conversation || confirmingRhythm || choosingArcade) && view === 'request' &&
    state === 'active' && (!speechActive || canAnswerRhythm) && !writing && !command.value.trim();
  const interrupt = Boolean(speechActive && view === 'request' && !canAnswerRhythm);
  const normalWake = !speechActive && !keyPending && (view === 'idle'
    || (view === 'request' && state === 'active'));
  document.body.dataset.listening = String(followUp || state === 'wake-recording' || state === 'recording');
  window.NaviFlight.setListening(followUp);
  wake.configure({
    enabled: config.wakeEnabled && !rhythmPlaying && !recording && state !== 'connecting',
    eligible: view === 'alarm' || interrupt || normalWake || followUp,
    alarm: view === 'alarm',
    interrupt,
    followUp,
    shortReply: confirmingRhythm || choosingArcade
  });
}

function setState(next) {
  window.NaviFlight.setState(next);
  state = next;
  document.body.dataset.state = next;
  const waiting = ['working', 'processing-voice', 'connecting', 'wake-recording'].includes(next);
  mic.disabled = waiting;
  mic.textContent = next === 'recording' ? 'Enviar audio' : 'Hablar';
  send.disabled = waiting || next === 'recording';
  el('rhythm-yes').disabled = waiting;
  el('rhythm-no').disabled = waiting;
  for (const choice of arcadeChoices.querySelectorAll('button')) choice.disabled = waiting;
  syncWake();
  scheduleReturn();
}

function scheduleReturn() {
  clearTimeout(returnTimer);
  if (!updatePanel.hidden) return;
  if (view === 'request' && state === 'active' && !speechActive && !writing && !command.value.trim()) {
    returnTimer = setTimeout(dismiss, awaitingReply ? replyDelay : returnDelay);
  }
}

function setComposer(enabled) {
  showComposer = enabled;
  composer.hidden = !enabled;
  controls.hidden = !enabled;
  document.body.dataset.compose = String(enabled);
}

function setView(next, compose = false) {
  view = next;
  document.body.dataset.view = next;
  setComposer(compose);
  showSources();
  panel.hidden = next === 'idle';
  request.hidden = next !== 'request';
  settings.hidden = next !== 'settings';
  alarm.hidden = next !== 'alarm';
  if (next !== 'request') { setRhythmChoices(false); setArcadeChoices(); updatePanel.hidden = true; }
  setState(next === 'request' || next === 'settings' ? 'active' : next);
}

function finishWriting(complete = false) {
  if (!writing) return;
  const current = writing;
  writing = undefined;
  cancelAnimationFrame(current.frame);
  delete reply.dataset.writing;
  if (complete && reply.textContent !== current.text) {
    reply.textContent = current.text;
    if (reply.scrollHeight > reply.clientHeight) reply.scrollTop = reply.scrollHeight - reply.clientHeight;
  }
  syncWake();
  scheduleReturn();
}

function captionTiming(wav) {
  const view = new DataView(wav);
  if (view.byteLength < 44 || view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16) return null;
  const rate = view.getUint32(24, true);
  if (rate < 8000 || rate > 96000) return null;
  let start = 12;
  let length;
  while (start + 8 <= view.byteLength) {
    length = view.getUint32(start + 4, true);
    if (view.getUint32(start, false) === 0x64617461) break; // data
    start += 8 + length + length % 2;
  }
  start += 8;
  if (!length || start + length > view.byteLength) return null;
  const frame = Math.round(rate * .02);
  const levels = [];
  let peak = 0;
  for (let offset = 0; offset + 1 < length; offset += 2 * frame) {
    let energy = 0;
    let samples = 0;
    for (let index = offset; index + 1 < Math.min(length, offset + 2 * frame); index += 4) {
      const amplitude = view.getInt16(start + index, true) / 32768;
      energy += amplitude * amplitude;
      samples++;
    }
    const level = Math.sqrt(energy / samples);
    levels.push(level);
    peak = Math.max(peak, level);
  }
  if (!peak) return null;
  const threshold = Math.max(.0015, peak * .055);
  const weights = [0];
  for (const level of levels) {
    weights.push(weights.at(-1) + Math.max(.08, Math.min(1, (level / threshold - .65) / 1.1)));
  }
  return time => {
    const index = Math.min(weights.length - 1, time * rate / frame);
    const lower = Math.floor(index);
    return (weights[lower] + (index - lower) * ((weights[lower + 1] ?? weights[lower]) - weights[lower])) / weights.at(-1);
  };
}

function writeReply(text, speechProgress, start = 0) {
  finishWriting();
  replyStatus.textContent = 'Navi está hablando.';

  if (reducedMotion.matches) {
    reply.textContent = text;
    reply.scrollTop = reply.scrollHeight - reply.clientHeight;
    return;
  }
  const marks = [];
  let total = 0;
  for (const { segment, index } of captionLetters.segment(text.slice(start))) {
    total += /[\p{L}\p{Nd}]/u.test(segment) ? 1 : /[,.!?]/u.test(segment) ? .8 : 0;
    marks.push({ end: start + index + segment.length, total });
  }
  const current = { text, position: 0 };
  writing = current;
  syncWake();
  reply.textContent = text.slice(0, start);
  if (!start) reply.scrollTop = 0;
  reply.dataset.writing = 'true';
  const tick = () => {
    if (writing !== current) return;
    const spoken = Math.min(total, Math.max(0, speechProgress() * total) + (total > 0 ? 1 : 0));
    const previous = current.position;
    while (current.position < marks.length && marks[current.position].total <= spoken) current.position++;
    if (current.position !== previous) {
      reply.textContent = text.slice(0, marks[current.position - 1].end);
      if (reply.scrollHeight > reply.clientHeight) reply.scrollTop = reply.scrollHeight - reply.clientHeight;
    }
    if (current.position >= marks.length) finishWriting(true);
    else current.frame = requestAnimationFrame(tick);
  };
  tick();
  scheduleReturn();
}

function showSources(sources = []) {
  sourcesEl.replaceChildren();
  sourcesEl.hidden = sources.length === 0;
  for (const [index, source] of sources.entries()) {
    if (index) sourcesEl.append(' · ');
    const link = document.createElement('a');
    link.href = source.url;
    link.textContent = new URL(source.url).hostname.replace(/^www\./u, '');
    link.title = source.title;
    link.addEventListener('click', event => {
      event.preventDefault();
      window.navi.openSource(source.url).catch(() => {});
    });
    sourcesEl.append(link);
  }
}

function stopSpeech() {
  const current = speechActive;
  speechActive = undefined;
  voicePlaying = false;
  rhythmSummary = false;
  clearTimeout(current?.timeout);
  current?.cancel?.();
  current?.disposeAudio?.();
  window.NaviFlight.setSpeaking(false);
  syncWake();
  scheduleReturn();
}

function speak(text, animate = false, { summary = false } = {}) {
  stopSpeech();

  function showText() {
    if (!animate) return;
    finishWriting();
    reply.textContent = text;
    replyStatus.textContent = text;
    reply.scrollTop = 0;
  }

  if (!window.navi.synthesize) {
    showText();
    return;
  }
  const id = ++speechId;
  const current = { cancel: () => window.navi.stopSynthesis(id) };
  speechActive = current;
  rhythmSummary = summary;
  let replyFailed = false;
  let received = 0;
  let expected;
  let playing = false;
  let started = false;
  let textStart = 0;
  let generationMs = 0;
  let generationWeight = 0;
  let measured = 0;
  const requestedAt = performance.now();
  let firstSound;
  let waitingSince;
  let waits = 0;
  let waitMs = 0;
  const queue = [];
  syncWake();
  scheduleReturn();

  function fallback() {
    if (speechActive !== current) return;
    stopSpeech();
    showText();
  }

  function completeSpeech() {
    if (firstSound !== undefined) window.navi.voicePlayback?.({ startMs: firstSound, gaps: waits, waitMs });
    if (animate) {
      finishWriting(true);
      replyStatus.textContent = text;
    }
    stopSpeech();
  }

  function playWav(wav, caption) {
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const audio = new Audio(url);
    return new Promise((resolve, reject) => {
      function dispose() {
        if (summary) voicePlaying = false;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        URL.revokeObjectURL(url);
        if (summary) syncWake();
      }

      function finish(error) {
        if (current.disposeAudio !== cancel) return;
        cancel(error);
      }

      function cancel(error) {
        current.disposeAudio = undefined;
        dispose();
        if (error) reject(error);
        else resolve();
      }

      current.disposeAudio = cancel;
      audio.addEventListener('playing', () => {
        if (speechActive !== current || current.disposeAudio !== cancel) return;
        const now = performance.now();
        if (caption) firstSound ??= now - requestedAt;
        if (waitingSince !== undefined) {
          if (now - waitingSince > 120) {
            waits++;
            waitMs += now - waitingSince;
          }
          waitingSince = undefined;
        }
        window.NaviFlight.setSpeaking(true);
        voicePlaying = true;
        syncWake();
        if (caption) {
          const timing = captionTiming(wav);
          writeReply(caption, () => timing ? timing(audio.currentTime + .13)
            : audio.duration > 0 ? (audio.currentTime + .15) / audio.duration : 0, textStart);
        }
      }, { once: true });
      audio.addEventListener('ended', () => finish(), { once: true });
      audio.addEventListener('error', () => finish(new Error('No se pudo reproducir el audio.')), { once: true });
      void audio.play().catch(finish);
    });
  }

  async function drain() {
    if (playing || speechActive !== current) return;
    if (!queue.length) {
      if (replyFailed) fallback();
      else if (expected === received) completeSpeech();
      return;
    }
    const tail = queue.at(-1);
    if (!started && !replyFailed && tail.remaining > 0) {
      const lead = queue.reduce((total, part) => total + part.seconds, 0);
      const estimatedSeconds = generationMs / Math.max(1, generationWeight) * tail.remaining / 1000;
      // Start once the buffered audio covers the predicted remaining compute with headroom.
      if (!generationWeight || lead < estimatedSeconds * 1.2 + .45) return;
    }
    started = true;
    playing = true;
    try {
      while (queue.length && speechActive === current) {
        const part = queue.shift();
        await playWav(part.wav, text.slice(0, part.end));
        if (speechActive !== current) return;
        finishWriting(true);
        textStart = part.end;
      }
    } catch {
      fallback();
      return;
    } finally {
      playing = false;
    }
    if (speechActive !== current) return;
    if (replyFailed) fallback();
    else if (expected === received) completeSpeech();
    else waitingSince = performance.now();
  }

  const bySentence = animate && Boolean(window.navi.onVoiceSentence);
  current.addPart = part => {
    if (speechActive !== current) return;
    if (!part?.wav || part.wav.byteLength < 44 || speechActive !== current) return;
    const header = new DataView(part.wav);
    const seconds = (part.wav.byteLength - 44) / header.getUint32(28, true);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    clearTimeout(current.timeout);
    received++;
    if (expected !== received) current.timeout = setTimeout(fallback, 120_000);
    if (!part.cached) {
      // The first synthesis can include cold model setup.
      if (++measured === 2) generationMs = generationWeight = 0;
      generationMs += part.elapsed;
      generationWeight += part.weight;
    }
    queue.push({ ...part, seconds });
    void drain();
  };

  current.timeout = setTimeout(fallback, summary ? 12_000 : 120_000);
  void window.navi.synthesize(id, text, bySentence).then(async result => {
    if (speechActive !== current) return;
    if (bySentence && result?.count) {
      expected = result.count;
      if (expected === received) clearTimeout(current.timeout);
      void drain();
      return;
    }
    if (result?.byteLength) {
      await playWav(result, animate ? text : '');
      if (speechActive !== current) return;
      completeSpeech();
      return;
    }
    if (result?.count === 0 && !received && animate && window.navi.waitingCue) {
      const cue = await window.navi.waitingCue();
      if (speechActive !== current) return;
      if (cue?.byteLength) {
        reply.textContent = 'Espera un momento, necesito preparar mi voz.';
        replyStatus.textContent = reply.textContent;
        await playWav(cue, '');
        if (speechActive !== current) return;
      }
    }
    replyFailed = true;
    void drain();
  }).catch(() => {
    replyFailed = true;
    void drain();
  });
}

window.navi.onVoiceSentence?.((id, part) => {
  if (speechId === id) speechActive?.addPart?.(part);
});

function abandonRecording() {
  conversation = false;
  voiceCapture = false;
  capturingFollowUp = false;
  wake.cancel();
  const active = recording;
  if (!active) return;
  recording = undefined;
  clearTimeout(active.limit);
  if (active.recorder.state !== 'inactive') active.recorder.stop();
  active.stream.getTracks().forEach(track => track.stop());
}

function dismiss() {
  revision += 1;
  awaitingReply = false;
  launchingRhythm = false;
  setRhythmChoices(false);
  abandonRecording();
  finishWriting();
  apiKey.value = '';
  command.value = '';
  reply.textContent = '¿En qué te ayudo?';
  stopSpeech();
  if (view === 'alarm') {
    chime.pause();
    chime.currentTime = 0;
    window.navi.dismissAlarm();
  } else {
    window.navi.dismiss();
  }
  setView('idle');
}

function renderSettings() {
  el('key-note').textContent = config.envKey
    ? 'Navi está usando OPENAI_API_KEY del entorno o de .env.local.'
    : config.bundledKey
      ? 'Navi está usando la clave incluida en la aplicación.'
      : 'Activa el micrófono y la conversación. La clave se guarda cifrada en este ordenador.';
  apiKey.disabled = Boolean(config.envKey) || keyPending;
  el('paste-key').disabled = apiKey.disabled;
  el('save-key').disabled = apiKey.disabled;
  el('remove-key').hidden = !config.savedKey;
  el('remove-key').disabled = keyPending;
}

function showSettings() {
  revision += 1;
  abandonRecording();
  finishWriting();
  stopSpeech();
  apiKey.value = '';
  el('key-status').textContent = config.ai ? 'IA conectada.' : '';
  setView('settings');
  renderSettings();
  (apiKey.disabled ? el('back') : apiKey).focus();
}

function showRequest() {
  revision += 1;
  abandonRecording();
  finishWriting();
  stopSpeech();
  apiKey.value = '';
  reply.textContent = '¿En qué te ayudo?';
  setView('request', true);
  command.focus();
}

async function updateConfig() {
  config = await window.navi.status();
  if (config.placement) applyPlacement(config.placement);
  syncWake();
  el('settings-link').textContent = config.ai ? 'Ajustes de IA' : 'Configurar IA';
  if (view === 'settings') renderSettings();
  if (view === 'request' && ['checking', 'downloading', 'installing'].includes(config.update?.phase)) showUpdate(config.update);
}

function applyPlacement({ horizontal, vertical, followingCursor = false }) {
  document.body.dataset.horizontal = horizontal;
  document.body.dataset.vertical = vertical;
  document.body.dataset.followingCursor = String(followingCursor);
}

function setRhythmChoices(visible) {
  confirmingRhythm = visible;
  rhythmChoices.hidden = !visible;
}

function setArcadeChoices(items) {
  choosingArcade = Array.isArray(items) && items.length > 0;
  document.body.dataset.arcadeMenu = String(choosingArcade);
  arcadeChoices.hidden = !choosingArcade;
  arcadeChoices.replaceChildren();
  if (!choosingArcade) return;
  for (const [index, { label, command: game }] of items.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = (index + 1) + ' · ' + label;
    button.addEventListener('click', () => submit(() => window.navi.ask(game)));
    arcadeChoices.append(button);
  }
}

function showUpdate(state) {
  if (!state || view === 'alarm') return;
  updatePhase = state.phase;
  const active = ['checking', 'downloading', 'installing'].includes(updatePhase);
  if (!active && !['current', 'error'].includes(updatePhase)) return;
  if (!active && view === 'settings') return;
  if (view !== 'request' || updatePanel.hidden && active) {
    setView('request');
    stopSpeech();
    finishWriting();
    setArcadeChoices();
    setRhythmChoices(false);
  }
  updatePanel.hidden = !active;
  const percent = Number.isFinite(state.percent) ? state.percent : undefined;
  if (percent === undefined) updateBar.removeAttribute('value');
  else updateBar.value = percent;
  updatePercent.textContent = percent === undefined ? '' : percent + ' %';
  const labels = {
    checking: 'Buscando actualizaciones…',
    downloading: 'Descargando Navi ' + state.version + '…',
    installing: 'Instalando Navi ' + state.version + '. Me abriré al terminar.'
  };
  const text = labels[updatePhase] || state.text;
  if (reply.textContent !== text) {
    reply.textContent = text;
    replyStatus.textContent = text;
  }
  scheduleReturn();
}

async function submit(task, { voice = false } = {}) {
  if (launchingRhythm) return;
  const turn = ++revision;
  const previous = reply.textContent;
  finishWriting();
  stopSpeech();
  setState(voice ? 'processing-voice' : 'working');
  showSources();
  reply.textContent = voice ? '…' : 'Hm…';
  replyStatus.textContent = reply.textContent;
  const waitingCue = voice ? setTimeout(() => {
    if (turn !== revision) return;
    setState('working');
    reply.textContent = 'Hm…';
    replyStatus.textContent = 'Hm…';
  }, 650) : undefined;
  try {
    const response = await task();
    clearTimeout(waitingCue);
    if (turn !== revision) return;
    if (response.noSpeech) {
      reply.textContent = previous === '…' || !previous ? 'Te escucho.' : previous;
      replyStatus.textContent = reply.textContent;
      return;
    }
    if (response.quitting) {
      reply.textContent = response.text;
      replyStatus.textContent = response.text;
      return;
    }
    if (response.updating) {
      showUpdate(response.updateState);
      return;
    }
    if (response.closeConversation) {
      dismiss();
      return;
    }
    awaitingReply = Boolean(response.awaitingReply);
    if (!response.gameMenu && !response.rhythmConfirmation && !response.startRhythm) await window.NaviFlight.finishThinking();
    if (turn !== revision) return;
    showSources(response.sources);
    setRhythmChoices(Boolean(response.rhythmConfirmation));
    setArcadeChoices(response.gameMenu);
    if (response.startRhythm) {
      launchingRhythm = true;
      reply.textContent = response.text;
      replyStatus.textContent = response.text;
      const result = await window.navi.startRhythm().catch(() => false);
      if (result !== true && !result?.started && turn === revision) speak(result?.text || 'No pude abrir la partida.', true);
    } else if (response.rhythmConfirmation || response.gameMenu) {
      // Display the prompt and listen immediately, including while the voice is being prepared.
      reply.textContent = response.text;
      replyStatus.textContent = response.text;
      speak(response.text);
    } else speak(response.text, true);
  } catch {
    if (turn !== revision) return;
    reply.textContent = 'No he podido completar la petición. Prueba de nuevo.';
    replyStatus.textContent = reply.textContent;
  } finally {
    clearTimeout(waitingCue);
    if (turn === revision) {
      launchingRhythm = false;
      setState('active');
      if (showComposer && !confirmingRhythm && !choosingArcade) command.focus();
    }
  }
}

async function startRecording() {
  if (!config.ai) {
    showSettings();
    el('key-status').textContent = 'Añade tu clave para probar el micrófono.';
    return;
  }
  const turn = ++revision;
  let stream;
  setState('connecting');
  stopSpeech();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }, video: false
    });
    if (turn !== revision) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks = [];
    const current = { recorder, stream, limit: undefined };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      clearTimeout(current.limit);
      stream.getTracks().forEach(track => track.stop());
      if (recording !== current || turn !== revision) return;
      recording = undefined;
      conversation = true;
      await submit(async () => {
        const audio = await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer();
        return window.navi.audio(audio, 'webm');
      }, { voice: true });
    };
    recorder.onerror = () => {
      if (recording !== current) return;
      abandonRecording();
      setState('active');
      reply.textContent = 'Se interrumpió la grabación. Prueba de nuevo.';
    };
    recorder.start();
    recording = current;
    current.limit = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, 25000);
    setState('recording');
    reply.textContent = 'Te escucho. Pulsa «Enviar audio» al terminar.';
    mic.focus();
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    if (turn !== revision) return;
    setState('active');
    reply.textContent = 'No he podido usar el micrófono. Revisa el dispositivo y los permisos de Windows.';
  }
}

async function saveKey(value) {
  if (keyPending) return;
  keyPending = true;
  renderSettings();
  try {
    const result = await window.navi.saveKey(value);
    if (result.ok) {
      apiKey.value = '';
      await updateConfig();
    }
    el('key-status').textContent = result.text;
  } catch {
    el('key-status').textContent = 'No se ha podido guardar la configuración.';
  } finally {
    keyPending = false;
    if (view === 'settings') renderSettings();
  }
}

el('command-form').addEventListener('submit', event => {
  event.preventDefault();
  if (view !== 'request' || send.disabled || !command.value.trim()) return;
  const text = command.value.trim();
  command.value = '';
  submit(() => window.navi.ask(text));
});
mic.addEventListener('click', () => {
  if (recording) {
    if (recording.recorder.state === 'recording') recording.recorder.stop();
  } else {
    startRecording();
  }
});
el('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (apiKey.value.trim()) saveKey(apiKey.value);
});
async function pasteKey() {
  if (view !== 'settings' || apiKey.disabled) return;
  const turn = revision;
  try {
    const result = await window.navi.pasteKey();
    if (turn !== revision || view !== 'settings' || apiKey.disabled) return;
    if (result.value) {
      apiKey.value = result.value;
      apiKey.focus();
      el('key-status').textContent = 'Clave pegada. Pulsa Guardar.';
    } else {
      el('key-status').textContent = result.text;
    }
  } catch {
    if (turn === revision) el('key-status').textContent = 'No he podido leer el portapapeles.';
  }
}
el('paste-key').addEventListener('click', pasteKey);
apiKey.addEventListener('keydown', event => {
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v') {
    event.preventDefault();
    pasteKey();
  }
});
el('remove-key').addEventListener('click', () => saveKey(''));
el('back').addEventListener('click', showRequest);
el('settings-link').addEventListener('click', showSettings);
el('close').addEventListener('click', dismiss);
el('stop-alarm').addEventListener('click', dismiss);
el('rhythm-yes').addEventListener('click', () => submit(() => window.navi.ask('sí')));
el('rhythm-no').addEventListener('click', () => submit(() => window.navi.ask('no')));
for (const event of ['pointerdown', 'keydown', 'input', 'wheel']) {
  panel.addEventListener(event, scheduleReturn);
}
command.addEventListener('input', syncWake);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && view !== 'idle') dismiss();
});

window.navi.onActivate(next => {
  if (view === 'request' && ['working', 'processing-voice', 'recording', 'connecting', 'wake-recording'].includes(state) && next === 'request') {
    setComposer(true);
    (state === 'recording' ? mic : command).focus();
    return;
  }
  if (next === 'request' && view === 'request') {
    setComposer(true);
    command.focus();
    scheduleReturn();
    return;
  }
  if (next === 'settings') showSettings();
  else showRequest();
  updateConfig().catch(() => {});
});
window.navi.onUpdateState?.(showUpdate);
window.navi.onRhythmRequest?.(spotify => submit(() => window.navi.ask(spotify ? 'quiero jugar' : 'quiero jugar con archivos locales')));
window.navi.onRhythmStarted?.(() => {
  revision++;
  rhythmPlaying = true;
  launchingRhythm = false;
  awaitingReply = false;
  abandonRecording();
  finishWriting();
  stopSpeech();
  setView('idle');
});
window.navi.onRhythmResult?.((text, ended = rhythmPlaying, alreadySpoken = false) => {
  setArcadeChoices();
  if (ended) {
    rhythmPlaying = false;
    launchingRhythm = false;
    awaitingReply = false;
    command.value = '';
    conversation = Boolean(config.wakeEnabled && config.ai);
  }
  setView('request');
  if (ended) {
    reply.textContent = text;
    replyStatus.textContent = text;
    if (!alreadySpoken) speak(text, false, { summary: true });
  } else speak(text, true);
});
window.navi.onAlarm(message => {
  rhythmPlaying = false;
  launchingRhythm = false;
  revision += 1;
  abandonRecording();
  finishWriting();
  stopSpeech();
  apiKey.value = '';
  setView('alarm');
  el('alarm-message').textContent = message;
  el('alarm-voice').hidden = !config.wakeEnabled;
  chime.volume = config.wakeEnabled ? .42 : 1;
  const turn = revision;
  chime.play().catch(() => {
    if (view === 'alarm' && turn === revision) speak(message);
  });
  el('stop-alarm').focus();
});
window.navi.onHide(() => setView('idle'));
window.navi.onWakeEnabled(enabled => {
  config.wakeEnabled = enabled;
  if (!enabled) conversation = false;
  if (view === 'alarm') {
    chime.volume = enabled ? .42 : 1;
    el('alarm-voice').hidden = !enabled;
  }
  if (!enabled && voiceCapture) {
    abandonRecording();
    reply.textContent = 'Activación por voz en pausa.';
    setState('active');
  } else {
    syncWake();
  }
});
window.navi.onWakeRestart(() => wake.restart());
window.navi.onPlacement(applyPlacement);
window.navi.onCursorCue(() => window.NaviFlight.playCursorCue());
window.addEventListener('pagehide', () => {
  finishWriting();
  clearTimeout(returnTimer);
  wake.dispose();
}, { once: true });
updateConfig().catch(() => {});
