(() => {
  const SAMPLE_RATE = 16000;
  // The bundled Spanish model normally transcribes the name as «navy».
  const wakeNames = new Set(['navy', 'navi', 'nave']);
  const greetings = ['oye', 'ey', 'hey', 'eh', 'hola', 'buenas', 'escucha', 'oiga', 'mira', 'a ver', 'que tal', 'buenos dias', 'buenas tardes', 'buenas noches'];
  const leadIns = ['una', 'una pregunta', 'una cosa', 'quiero', 'quiero jugar', 'puedes', 'podrias', 'dime', 'ayudame',
    'me puedes', 'me ayudas', 'vamos a jugar', 'cierrate', 'apagate', 'salte', 'actualizate', 'actualiza', 'tienes actualizaciones'];
  const WAKE_PHRASES = new Set([
    ...greetings.flatMap(word => [...wakeNames].map(name => word + ' ' + name)),
    ...['navi', 'navy'].flatMap(name => leadIns.map(lead => name + ' ' + lead))
  ]);
  const VOSK_DECOYS = ['oye navega', 'oye nadie', 'oye david', 'oye dani', 'oye mami', 'oye amigo', 'hola nadie',
    'hola dani', 'hola david', 'hola mami', 'la nave', 'una nave', 'nave espacial', 'esta nave', 'en la nave',
    'el navy', 'una pregunta', 'quiero jugar', 'me puedes', 'hola', 'oye', '[unk]'];
  const stopCommands = [
    'para', 'para ya', 'basta', 'basta ya', 'ya esta', 'ya lo escuche', 'lo escuche',
    'ya lo oi', 'lo oi', 'para el temporizador', 'para la alarma', 'silencia la alarma',
    'apaga la alarma', 'deten el temporizador', 'gracias'
  ];
  // These are the spellings the Spanish recognition vocabulary uses for Navi.
  const alarmNames = new Set(['navy', 'nave']);
  const STOP_PHRASES = new Set([...alarmNames].flatMap(name => stopCommands.flatMap(command => [
    name + ' ' + command, command + ' ' + name, 'vale ' + name + ' ' + command,
    'oye ' + name + ' ' + command
  ])));
  const WAKE_GRAMMAR = JSON.stringify([
    ...WAKE_PHRASES, 'navy', 'navi', 'nave',
    ...greetings.flatMap(word => [...wakeNames].map(name => word + ' ' + name + ' [unk]')),
    'navy [unk]', 'navi [unk]', ...VOSK_DECOYS
  ]);

  function activation(result, allowBare) {
    const words = result.result;
    if (!words?.length || !words.every(word => Number.isFinite(word.conf) && Number.isFinite(word.end))) return null;
    const phrase = words.map(word => word.word).join(' ');
    const first = words[0];
    const second = words[1];
    if (!Number.isFinite(first.start) || first.start > .57) return null;
    const namedAt = words.findIndex(word => wakeNames.has(word.word));
    if (namedAt >= 1 && namedAt <= 2) {
      const name = words[namedAt];
      const address = words.slice(0, namedAt);
      if (greetings.includes(address.map(word => word.word).join(' '))
        && (words.length === namedAt + 1 || words[namedAt + 1].word === '[unk]')
        && address.every(word => word.conf >= .76) && name.conf >= (name.word === 'nave' ? .94 : .88)
        && name.start - address.at(-1).end < .45 && name.end <= 2.45) return name;
    }
    if (!['navy', 'navi'].includes(first.word) || first.end > 1.45) return null;
    if (words.length === 1) return allowBare && first.conf >= .97 && first.end - first.start >= .22 ? first : null;
    if (second.start - first.end >= .65 || first.conf < .91) return null;
    return (WAKE_PHRASES.has(phrase) && words.slice(1).every(word => word.conf >= .73)
      || (allowBare && second.word === '[unk]' && first.conf >= .97)) ? first : null;
  }

  function possiblePartial(partial, phrases, commandMode) {
    if (phrases.has(partial)) return true;
    if (commandMode) return false;
    return [...WAKE_PHRASES].some(phrase => partial.startsWith(phrase + ' [unk]'));
  }
  const STOP_GRAMMAR = JSON.stringify([
    ...STOP_PHRASES, 'navy', 'nave', 'oye navy', 'hola navy', 'vale', 'vale nadie', 'para',
    'gracias', 'ya lo escuche', 'para nadie', 'nadie para', 'nadie ya lo escuche', '[unk]'
  ]);
  const INTERRUPT_STOP = new Set(['navy para', 'para navy', 'navy para ya', 'navy ya esta', 'navy basta',
    'navy ya lo escuche', 'ya lo escuche navy', 'navy gracias', 'gracias navy']);
  const QUIT_PHRASES = new Set(['navy', 'navi'].flatMap(name =>
    ['cierrate', 'apagate', 'salte'].flatMap(command => [name + ' ' + command, 'oye ' + name + ' ' + command])));
  const quitPartials = new Set([...QUIT_PHRASES].map(phrase => phrase + ' [unk]'));
  for (const phrase of QUIT_PHRASES) WAKE_PHRASES.add(phrase);
  const wakeGrammar = JSON.stringify([...new Set([...JSON.parse(WAKE_GRAMMAR), ...QUIT_PHRASES, ...quitPartials])]);
  const INTERRUPT_PHRASES = new Set([
    'navy espera', 'oye navy espera', 'navy un momento', 'navy escucha', ...INTERRUPT_STOP, ...QUIT_PHRASES
  ]);
  const INTERRUPT_GRAMMAR = JSON.stringify([
    ...INTERRUPT_PHRASES, ...quitPartials, 'navy', 'nave espera', 'nadie espera', 'espera', 'un momento', '[unk]'
  ]);
  const MODEL_URL = 'vendor/vosk-es-0.42.tar.gz';
  const SPEECH_START = .12 * SAMPLE_RATE;
  const CONFIRMATION_START = .06 * SAMPLE_RATE;

  function voicedFrame(samples, rms) {
    const minLag = 34;
    const maxLag = 205;
    let fastPeak = 0;
    let slowPeak = 0;
    for (let lag = minLag; lag <= maxLag; lag += 2) {
      let cross = 0;
      let left = 0;
      let right = 0;
      for (let i = maxLag; i < samples.length; i += 4) {
        const a = samples[i] - samples[i - 1];
        const b = samples[i - lag] - samples[i - lag - 1];
        cross += a * b;
        left += a * a;
        right += b * b;
      }
      if (Math.min(left, right) < rms * rms * .1) continue;
      const score = cross / Math.sqrt(left * right);
      if (lag < 95) fastPeak = Math.max(fastPeak, score);
      else slowPeak = Math.max(slowPeak, score);
    }
    return fastPeak >= .41 || slowPeak >= .5;
  }

  function wav(frames, start, end) {
    const output = new ArrayBuffer(44 + (end - start) * 2);
    const view = new DataView(output);
    const text = (offset, value) => {
      for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, output.byteLength - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, output.byteLength - 44, true);
    for (const frame of frames) {
      const from = Math.max(start, frame.start);
      const to = Math.min(end, frame.end);
      for (let i = from; i < to; i += 1) {
        const sample = Math.max(-1, Math.min(1, frame.samples[i - frame.start]));
        view.setInt16(44 + (i - start) * 2, Math.round(sample * 32767), true);
      }
    }
    return output;
  }

  function create({ onStatus, onWake, onFollowUp, onAudio, onSilence, onStopAlarm, onInterrupt, onQuit }) {
    let microphone;
    let starting;
    let model;
    let loading;
    let enabled = false;
    let eligible = false;
    let listeningForAlarm = false;
    let listeningForInterrupt = false;
    let followUp = false;
    let shortReply = false;
    let followUpAfter = 0;
    let followUpVoicing = 0;
    let generation = 0;
    let cursor = 0;
    let frames = [];
    let speech;
    let capture;
    let floor = 0.003;
    let lastStatus;
    let retryContext;

    function report(status, detail) {
      if (lastStatus === status && !detail) return;
      lastStatus = status;
      onStatus(status, detail);
    }

    function loadModel() {
      if (model?.ready) return Promise.resolve(model);
      if (loading) return loading;
      loading = new Promise((resolve, reject) => {
        const instance = new Vosk.Model(new URL(MODEL_URL, location.href).href, -1);
        let settled = false;
        const timeout = setTimeout(() => fail(Error('El modelo de voz local no respondió.')), 25000);
        function fail(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          instance.terminate();
          reject(error);
        }
        instance.on('load', result => {
          if (!result.result) {
            fail(Error('El modelo de voz local no se pudo abrir.'));
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          model = instance;
          resolve(model);
        });
        instance.on('error', result => {
          if (!instance.ready) fail(Error(result.error || 'No se pudo abrir el modelo de voz.'));
        });
      }).finally(() => { loading = undefined; });
      return loading;
    }

    function resetSpeech() {
      speech?.recognizer.remove();
      speech?.verifier?.remove();
      speech = undefined;
    }

    function finishCapture() {
      const current = capture;
      capture = undefined;
      frames = [];
      if (current && current.voicedSamples >= (current.minimumVoice ?? SPEECH_START)) {
        const end = Math.min(cursor, current.lastVoice + Math.round(SAMPLE_RATE * .24));
        onAudio(wav(current.frames, current.start, end));
      } else {
        onSilence();
      }
    }

    function wake(result, utterance, final = true) {
      if (!eligible || !enabled || speech !== utterance || capture) return false;
      const words = result.result;
      const commandMode = listeningForAlarm || listeningForInterrupt;
      const name = commandMode ? null : activation(result, final);
      if (commandMode) {
        if (!utterance.phrases.has(result.text) || !words?.length
          || words.some(word => !Number.isFinite(word.conf) || word.conf < (listeningForAlarm
            ? alarmNames.has(word.word) ? .73 : .72 : word.word === 'navy' ? .90 : .80))) return false;
      } else if (!name) return false;
      const end = (name || words.at(-1)).end;
      if (!Number.isFinite(end) || end > (listeningForAlarm ? 4 : 3)) return false;
      if (final && !listeningForAlarm && QUIT_PHRASES.has(result.text) && words.every(word => word.conf >= .90)) {
        resetSpeech();
        frames = [];
        onQuit?.();
        return true;
      }
      if (listeningForAlarm) {
        resetSpeech();
        frames = [];
        onStopAlarm();
        return true;
      }
      if (listeningForInterrupt) {
        if (QUIT_PHRASES.has(result.text)) return false;
        resetSpeech();
        frames = [];
        onInterrupt(INTERRUPT_STOP.has(result.text));
        return true;
      }

      // Vosk reports word times relative to the first frame in this recognizer.
      const wakeEnd = utterance.start + Math.round(end * SAMPLE_RATE);
      // Keep the command even when it starts immediately after the name.
      const tail = Math.max(0, wakeEnd - Math.round(SAMPLE_RATE * .18));
      const retained = frames.filter(frame => frame.end > tail);
      const start = Math.max(tail, retained[0]?.start ?? cursor);
      resetSpeech();
      frames = [];
      const current = { start, wakeEnd, lastVoice: 0, voicedSamples: 0, frames: retained, armed: false,
        minimumVoice: .09 * SAMPLE_RATE };
      for (const frame of retained) {
        if (frame.voice && frame.end > wakeEnd + SAMPLE_RATE * .025) {
          let power = 0;
          for (const sample of frame.samples) power += sample * sample;
          noteVoice(current, { ...frame, voiced: voicedFrame(frame.samples, Math.sqrt(power / frame.samples.length)) });
        }
      }
      capture = current;
      Promise.resolve(onWake()).then(canRecord => {
        if (capture !== current) return;
        if (!canRecord) { capture = undefined; frames = []; return; }
        current.armed = true;
        checkCapture(current);
      }).catch(() => {
        if (capture === current) { capture = undefined; frames = []; }
      });
      return true;
    }

    function createRecognizer() {
      const grammar = listeningForAlarm ? STOP_GRAMMAR : listeningForInterrupt ? INTERRUPT_GRAMMAR : wakeGrammar;
      const recognizer = new model.KaldiRecognizer(SAMPLE_RATE, grammar);
      recognizer.setWords(true);
      return recognizer;
    }

    function verify(utterance) {
      const verifier = createRecognizer();
      utterance.verifier = verifier;
      verifier.on('error', () => {
        if (utterance.verifier !== verifier) return;
        verifier.remove();
        utterance.verifier = undefined;
      });
      verifier.on('result', message => {
        if (speech !== utterance || utterance.verifier !== verifier) return;
        verifier.remove();
        utterance.verifier = undefined;
        // Early results require a greeting or a verified command lead-in.
        wake(message.result, utterance, false);
      });
      for (const frame of frames) {
        if (frame.start >= utterance.start) verifier.acceptWaveformFloat(frame.samples, SAMPLE_RATE);
      }
      verifier.retrieveFinalResult();
    }

    function beginSpeech() {
      const recognizer = createRecognizer();
      const utterance = {
        recognizer, start: frames[0].start, lastVoice: cursor,
        phrases: listeningForAlarm ? STOP_PHRASES : listeningForInterrupt ? INTERRUPT_PHRASES : WAKE_PHRASES
      };
      speech = utterance;
      recognizer.on('partialresult', ({ result }) => {
        const commandMode = listeningForAlarm || listeningForInterrupt;
        if (speech !== utterance || QUIT_PHRASES.has(result.partial)
          || !possiblePartial(result.partial || '', utterance.phrases, commandMode)) return;
        if (utterance.verifier || cursor - utterance.start > SAMPLE_RATE * (listeningForAlarm ? 4 : 3)) return;
        if (utterance.checked === result.partial && cursor - utterance.checkedAt < SAMPLE_RATE * .34) return;
        utterance.checked = result.partial;
        utterance.checkedAt = cursor;
        verify(utterance);
      });
      recognizer.on('result', ({ result }) => {
        if (speech !== utterance || wake(result, utterance)) return;
        resetSpeech();
      });
      recognizer.on('error', () => {
        if (speech === utterance) resetSpeech();
      });
      for (const frame of frames) recognizer.acceptWaveformFloat(frame.samples, SAMPLE_RATE);
    }

    function noteVoice(current, frame) {
      if ((current.followUp || frame.end > current.wakeEnd + SAMPLE_RATE * .025) && frame.voice) {
        if (frame.voiced) current.voicedSamples += frame.samples.length;
        if (frame.voiced || current.voicedSamples >= (current.minimumVoice ?? SPEECH_START) && frame.end - current.lastVoice < .18 * SAMPLE_RATE) {
          current.lastVoice = frame.end;
        }
      }
    }

    function checkCapture(current) {
      if (!current.armed) return;
      const elapsed = cursor - current.wakeEnd;
      const hasRequest = current.voicedSamples >= (current.minimumVoice ?? SPEECH_START);
      const silence = current.minimumVoice === CONFIRMATION_START ? .55 : elapsed >= SAMPLE_RATE * 6 ? 1.2 : .9;
      const finishedSpeaking = hasRequest && cursor - current.lastVoice >= SAMPLE_RATE * silence;
      const captureLimit = hasRequest ? 25 : current.followUp ? 1.25 : 5;
      if (finishedSpeaking || elapsed >= SAMPLE_RATE * captureLimit) finishCapture();
    }

    function processFrame(samples) {
      const start = cursor;
      cursor += samples.length;
      if (!enabled || (!eligible && !capture)) return;

      let power = 0;
      for (const sample of samples) power += sample * sample;
      const rms = Math.sqrt(power / samples.length);
      const voice = rms >= Math.max(.005, Math.min(.025, floor * 2.8));
      if (!voice) floor += (rms - floor) * .04;
      const voiced = voice && Boolean(capture || followUp) && voicedFrame(samples, rms);
      // A short answer can fit in one worklet frame with just a partial vowel.
      const briefVoice = shortReply && followUp && !capture && voice && !voiced && samples.length > 512
        && voicedFrame(samples.subarray(samples.length - 512), rms);
      const frame = { start, end: cursor, samples, voice, voiced };

      if (capture) {
        capture.frames.push(frame);
        noteVoice(capture, frame);
        checkCapture(capture);
        return;
      }

      if (followUp && performance.now() < followUpAfter) return;
      frames.push(frame);
      if (followUp) {
        followUpVoicing = voiced || briefVoice ? followUpVoicing + samples.length : Math.max(0, followUpVoicing - samples.length);
        const minimumVoice = shortReply ? CONFIRMATION_START : SPEECH_START;
        if (followUpVoicing >= minimumVoice && !listeningForAlarm) {
          const current = {
            start: frames[0].start, wakeEnd: start - SAMPLE_RATE * .12,
            lastVoice: cursor, voicedSamples: followUpVoicing, frames, armed: true, followUp: true, minimumVoice
          };
          capture = current;
          frames = [];
          followUpVoicing = 0;
          if (!onFollowUp?.()) capture = undefined;
        } else {
          while (frames[0] && frames[0].end < cursor - SAMPLE_RATE * .40) frames.shift();
        }
        return;
      }
      if (speech) {
        if (voice) speech.lastVoice = cursor;
        if (cursor - speech.start >= SAMPLE_RATE * 5 || cursor - speech.lastVoice >= SAMPLE_RATE * 1.05) {
          resetSpeech();
        } else {
          speech.recognizer.acceptWaveformFloat(samples, SAMPLE_RATE);
        }
      } else if (voice) {
        beginSpeech();
      }
      const maxFrames = speech ? 5 * SAMPLE_RATE : SAMPLE_RATE * .24;
      while (frames[0] && frames[0].end < cursor - maxFrames) frames.shift();
    }

    function release(session) {
      if (!session) return;
      session.stream.getTracks().forEach(track => track.stop());
      if (session.node) {
        session.node.port.onmessage = null;
        session.node.disconnect();
      }
      if (session.context && session.context.state !== 'closed') session.context.close().catch(() => {});
    }

    function disconnect() {
      generation += 1;
      resetSpeech();
      capture = undefined;
      frames = [];
      followUpVoicing = 0;
      release(microphone);
      microphone = undefined;
      retryContext = undefined;
    }

    function start() {
      if (!enabled || microphone || starting) return;
      const attempt = generation;
      report('loading');

      starting = (async () => {
        let session;
        try {
          await loadModel();
          if (attempt !== generation) return;
          const stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
          });
          session = { stream };
          if (attempt !== generation) return;

          // The default input is resampled by Web Audio to match the local model.
          const context = new AudioContext({ sampleRate: SAMPLE_RATE });
          session.context = context;
          await context.audioWorklet.addModule('voice-worklet.js');
          if (attempt !== generation) return;

          const node = new AudioWorkletNode(context, 'navi-microphone', {
            numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit'
          });
          session.node = node;
          const active = session;
          node.port.onmessage = event => {
            if (microphone === active) processFrame(event.data);
          };
          const mute = context.createGain();
          mute.gain.value = 0;
          const rumble = context.createBiquadFilter();
          rumble.type = 'highpass';
          rumble.frequency.value = 82;
          rumble.Q.value = Math.SQRT1_2;
          context.createMediaStreamSource(stream).connect(rumble).connect(node).connect(mute).connect(context.destination);
          stream.getAudioTracks()[0].addEventListener('ended', () => {
            if (microphone === active) restart();
          });
          microphone = session;
          session = undefined;

          // If Chromium needs a gesture, resume on the next keyboard or click event.
          retryContext = context;
          context.onstatechange = () => {
            if (microphone?.context === context) {
              report(context.state === 'running' ? 'ready' : 'suspended');
            }
          };
          report(context.state === 'running' ? 'ready' : 'suspended');
          context.resume().catch(() => {});
        } catch (error) {
          if (attempt === generation) report('error', error.message || String(error));
        } finally {
          release(session);
        }
      })().finally(() => {
        starting = undefined;
        if (enabled && attempt !== generation && !microphone) start();
      });
    }

    function restart() {
      const interrupted = Boolean(capture);
      disconnect();
      if (interrupted) onSilence();
      start();
    }

    const resume = () => {
      if (retryContext?.state === 'suspended') retryContext.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    navigator.mediaDevices?.addEventListener('devicechange', restart);

    return {
      configure({ enabled: nextEnabled, eligible: nextEligible, alarm = false, interrupt = false,
        followUp: nextFollowUp = false, shortReply: nextShortReply = false }) {
        eligible = nextEligible;
        if (listeningForAlarm !== alarm || listeningForInterrupt !== interrupt || followUp !== nextFollowUp
          || shortReply !== nextShortReply || (!eligible && !capture)) {
          resetSpeech();
          frames = [];
          followUpVoicing = 0;
        }
        if (!followUp && nextFollowUp) followUpAfter = performance.now() + (nextShortReply ? 0 : 140);
        followUp = nextFollowUp;
        shortReply = nextShortReply;
        listeningForAlarm = alarm;
        listeningForInterrupt = interrupt;
        if (nextEnabled === enabled) return;
        enabled = nextEnabled;
        if (enabled) start();
        else {
          disconnect();
          report('off');
        }
      },
      cancel() {
        capture = undefined;
        resetSpeech();
        frames = [];
        followUpVoicing = 0;
      },
      restart,
      dispose() {
        enabled = false;
        disconnect();
        model?.terminate();
        navigator.mediaDevices?.removeEventListener('devicechange', restart);
        window.removeEventListener('pointerdown', resume);
        window.removeEventListener('keydown', resume);
      }
    };
  }

  window.NaviWake = { create };
})();
