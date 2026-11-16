const { execFile, spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { voiceSentences } = require('./voice-sentences.cjs');
const { clarifyVoice, spokenReply, testReplies, trimSpeechPauses } = require('./voice-profile.cjs');

const modelSource = 'https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/b7ee2e8c7459c3bea99da23e3d178125a7d1713c/';
const assets = [
  ['qwen-talker-0.6b-base-Q4_K_M.gguf', 628905056, '4b468ec7b1f62b90ef4ca316c0aa57deadfd54b2cf9651703ea753cedaf04226'],
  ['qwen-tokenizer-12hz-Q8_0.gguf', 291150624, '1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94']
];

const totalModelBytes = assets.reduce((total, [, bytes]) => total + bytes, 0);
const maxCachedReplies = 160;
const runFile = promisify(execFile);
const downloadCue = '0ce389703a9197904a5d3cea6877de4a5ef22ec8c1bd4506769cb43c24a30b41.wav';

function voiceOptions(text) {
  return { input: text.trim(), voice: 'navi', language: 'Spanish', response_format: 'wav',
    max_new_tokens: 540, seed: 42, temperature: .72, top_p: .92 };
}

function validWav(audio) {
  return audio.byteLength >= 1024 && audio.byteLength <= 3_000_000 && audio.toString('ascii', 0, 4) === 'RIFF'
    && audio.toString('ascii', 8, 12) === 'WAVE' && audio.readUInt32LE(4) + 8 === audio.byteLength;
}

async function cacheReply(directory, filename, audio) {
  await mkdir(directory, { recursive: true });
  const temp = filename + '.' + randomBytes(6).toString('hex') + '.part';
  try {
    await writeFile(temp, audio, { flag: 'wx' });
    await rename(temp, filename);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  const entries = await readdir(directory);
  const files = entries.filter(name => /^[0-9a-f]{64}\.wav$/u.test(name));
  if (files.length <= maxCachedReplies) return;
  const ages = await Promise.all(files.map(async name => {
    const file = join(directory, name);
    return { file, time: (await stat(file).catch(() => null))?.mtimeMs || 0 };
  }));
  const evicted = ages.sort((a, b) => b.time - a.time).slice(maxCachedReplies);
  await Promise.all(evicted.map(({ file }) => rm(file, { force: true })));
}

async function ensureModel(bundled, cache, [name, size, expected], signal, onProgress, source = modelSource) {
  for (const dir of [bundled, cache]) {
    const file = join(dir, name);
    if ((await stat(file).catch(() => null))?.size !== size) continue;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    if (hash.digest('hex') === expected) {
      onProgress(size, false);
      return file;
    }
  }

  const dest = join(cache, name);
  const temp = dest + '.part';
  const stalled = new AbortController();
  const watchdog = setTimeout(() => stalled.abort(Error('La descarga se quedó 60 segundos sin recibir datos.')), 60_000);
  watchdog.unref();
  const downloadSignal = AbortSignal.any([signal, stalled.signal, AbortSignal.timeout(45 * 60_000)]);
  try {
    onProgress(0, true);
    const response = await fetch(source + name + '?download=true', {
      signal: downloadSignal
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error('Descarga de voz: HTTP ' + response.status);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const check = new Transform({ transform(chunk, _encoding, done) {
      watchdog.refresh();
      bytes += chunk.length;
      if (bytes > size) return done(Error('El modelo supera el tamaño previsto.'));
      hash.update(chunk);
      onProgress(bytes, true);
      done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), check, createWriteStream(temp), { signal: downloadSignal });
    if (bytes !== size || hash.digest('hex') !== expected) throw new Error('El modelo de voz descargado está incompleto o dañado.');
    await rename(temp, dest);
    return dest;
  } catch (error) {
    if (stalled.signal.aborted) throw stalled.signal.reason;
    throw error;
  } finally {
    clearTimeout(watchdog);
    await rm(temp, { force: true }).catch(() => {});
  }
}

function startEngine(executable, models, token, signal) {
  const env = { ...process.env, NAVI_TTS_TOKEN: token };
  delete env.OPENAI_API_KEY;
  const child = spawn(executable, ['--model', models[0], '--codec', models[1], '--host', '127.0.0.1', '--port', '0', '--lang', 'Spanish'], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal
  });
  let output = '';
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2500); });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('El motor de voz tardó demasiado en arrancar.')), 45_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(Error('El motor de voz se cerró (' + code + '). ' + errors.trim()));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output = (output + chunk).slice(-1024);
      const port = /(?:^|\n)NAVI_TTS_PORT=(\d+)\r?\n/u.exec(output)?.[1];
      if (port) {
        clearTimeout(timeout);
        resolve('http://127.0.0.1:' + port);
      }
    });
  });
  return { child, ready };
}

async function engineCandidates(resources, executable, signal) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || executable !== join(resources, 'tts-server.exe')) return [executable];
  try {
    await runFile(join(resources, 'tts-cpu-check.exe'), { signal, timeout: 3000, windowsHide: true });
  } catch {
    signal.throwIfAborted();
    return [executable];
  }
  const candidates = ['tts-server-avx2-fast.exe', 'tts-server-avx2.exe'].map(name => join(resources, name));
  const available = await Promise.all(candidates.map(file => stat(file).then(info => info.isFile(), () => false)));
  return [...candidates.filter((_, index) => available[index]), executable];
}

function createLocalVoice({ resources, cache, speechCache = join(cache, 'replies'), onStatus = () => {}, chosenProfile = false,
  available = process.platform === 'win32', executable = join(resources, 'tts-server.exe') }) {
  const lifetime = new AbortController();
  let session;
  let state = available ? 'preparing' : 'unavailable';
  let label = available ? 'Preparando voz de Navi…' : 'Voz de Navi disponible en Windows';

  function report(next, message, log = true) {
    state = next;
    label = message;
    if (log) console.info('Navi, voz local: ' + message);
    onStatus(next);
  }

  async function call(current, route, body, signal) {
    const options = { signal, headers: { Authorization: 'Bearer ' + current.token } };
    if (body) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(current.url + route, options);
  }

  function start() {
    if (!available || lifetime.signal.aborted || session) return;
    const current = { token: randomBytes(24).toString('hex') };
    session = current;
    report('preparing', 'Comprobando modelos de voz…');
    void (async () => {
      try {
        const reference = await readFile(join(resources, chosenProfile ? 'navi-voz-elegida.wav' : 'navi.wav'));
        const transcript = chosenProfile ? '' : await readFile(join(resources, 'navi.txt'), 'utf8').catch(error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        const referenceText = transcript.replace(/^\uFEFF/u, '').trim();
        current.profile = createHash('sha256').update(reference).update('\0').update(referenceText).digest('hex');
        await stat(executable);
        await mkdir(cache, { recursive: true });
        const downloads = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, downloads.signal]);
        const received = assets.map(() => 0);
        let lastReport = 0;
        let lastPercent = -1;
        const pending = assets.map((asset, index) => ensureModel(resources, cache, asset, signal, (bytes, downloading) => {
          received[index] = bytes;
          if (!downloading) return;
          current.downloading = true;
          const total = received.reduce((sum, fileBytes) => sum + fileBytes, 0);
          const percent = Math.floor(total / totalModelBytes * 100);
          const now = Date.now();
          if (lastPercent >= 0 && (lastPercent === percent || now - lastReport < 1500)) return;
          lastReport = now;
          lastPercent = percent;
          report('preparing', `Descargando voz de Navi · ${percent} % (${Math.round(total / 1e6)}/${Math.round(totalModelBytes / 1e6)} MB)`);
        }));
        let models;
        try { models = await Promise.all(pending); }
        catch (error) {
          downloads.abort();
          await Promise.allSettled(pending);
          throw error;
        }
        current.downloading = false;
        report('preparing', 'Cargando el motor de voz…');
        for (const binary of await engineCandidates(resources, executable, lifetime.signal)) {
          const engine = startEngine(binary, models, current.token, lifetime.signal);
          current.child = engine.child;
          try {
            current.url = await engine.ready;
            if (binary.endsWith('avx2-fast.exe')) console.info('Navi, voz local: Qwen AVX2 con códec optimizado');
            else if (binary !== executable) console.info('Navi, voz local: aceleración AVX2 activada');
            break;
          } catch (error) {
            engine.child.kill();
            if (binary === executable || lifetime.signal.aborted) throw error;
            console.warn('Navi, voz local: iniciando el motor compatible tras un fallo de AVX2.');
          }
        }
        const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(25_000)]);
        for (;;) {
          const health = await call(current, '/health', null, deadline).catch(() => null);
          if (health?.ok) { await health.body.cancel(); break; }
          await delay(120, undefined, { signal: deadline });
        }
        const registered = await call(current, '/v1/audio/voices', {
          name: 'navi', wav_b64: reference.toString('base64'), ...(referenceText && { ref_text: referenceText })
        }, deadline);
        if (!registered.ok) throw Error('El motor rechazó la referencia de voz (' + registered.status + ').');
        await registered.body.cancel();
        if (current.child.exitCode !== null || current.child.signalCode !== null) throw Error('El motor de voz se ha cerrado.');
        current.child.once('exit', () => {
          if (session !== current || lifetime.signal.aborted) return;
          session = undefined;
          console.warn('Navi, voz local: El motor se cerró mientras estaba en uso.');
          report('error', 'Reintentar voz de Navi', false);
        });
        if (!referenceText && !chosenProfile) console.info('Navi, voz local: añade navi.txt con la transcripción exacta de navi.wav para reforzar el acento de la muestra.');
        if (session !== current || lifetime.signal.aborted) return;
        report('ready', chosenProfile ? 'Voz de Navi lista · Qwen, perfil elegido' : 'Voz de Navi lista · Qwen');
      } catch (error) {
        current.child?.kill();
        if (session === current) session = undefined;
        if (lifetime.signal.aborted) return;
        console.warn('Navi, voz local:', error.message, error.cause?.code || error.code || '');
        report('error', 'Reintentar voz de Navi', false);
      }
    })();
  }

  async function synthesize(text, signal, { waitForCache = false } = {}) {
    if (state !== 'ready' || !session) return null;
    const spoken = spokenReply(text);
    if (!/[\p{L}\p{N}]/u.test(spoken)) return null;
    return synthesizeFor(session, spoken, signal, { waitForCache });
  }

  async function narrate(text, signal, onSentence) {
    if (state !== 'ready' || !session) return 0;
    const current = session;
    const spoken = spokenReply(text);
    const fresh = chosenProfile && testReplies.has(spoken);
    if (!/[\p{L}\p{N}]/u.test(spoken)) return 0;
    if (chosenProfile && spoken.length <= 260) {
      const started = performance.now();
      const result = await synthesizeFor(current, spoken, signal, { fresh });
      signal.throwIfAborted();
      onSentence({ ...result, end: text.length, remaining: 0, weight: text.length, elapsed: performance.now() - started });
      return 1;
    }
    const sentences = voiceSentences(text).map(part => ({ ...part, text: spokenReply(part.text) }))
      .filter(part => /[\p{L}\p{N}]/u.test(part.text));
    if (!sentences.length) return 0;
    sentences.at(-1).end = text.length;
    const prepared = sentences.length > 1 ? await cachedSpeech(current, speechOptions(spoken), signal) : null;
    if (prepared || sentences.length > 24) {
      const result = prepared || await synthesizeFor(current, spoken, signal);
      if (!result) return 0;
      onSentence({ ...result, end: text.length, remaining: 0, weight: text.length, elapsed: 0 });
      return 1;
    }
    let remaining = sentences.reduce((sum, item) => sum + item.text.length + 32, 0);
    for (const sentence of sentences) {
      const weight = sentence.text.length + 32; // Include fixed model setup per sentence.
      const started = performance.now();
      const result = await synthesizeFor(current, sentence.text, signal);
      signal.throwIfAborted();
      remaining -= weight;
      onSentence({ ...result, end: sentence.end, remaining, weight, elapsed: performance.now() - started });
    }
    return sentences.length;
  }

  function replyKey(current, options) {
    return createHash('sha256').update(JSON.stringify([
      modelSource, current.profile, options, 'spoken-v5', chosenProfile ? 'clarity-v1' : ''
    ])).digest('hex');
  }

  async function cachedSpeech(current, options, signal) {
    const key = replyKey(current, options);
    const filename = join(speechCache, key + '.wav');
    for (const file of [join(resources, 'replies', key + '.wav'), filename]) {
      const cached = await readFile(file, { signal }).catch(() => null);
      signal.throwIfAborted();
      if (!cached || !validWav(cached)) continue;
      if (file === filename) {
        const now = new Date();
        void utimes(filename, now, now).catch(() => {});
      }
      return { wav: cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength), cached: true };
    }
    return null;
  }

  function speechOptions(text) {
    const options = voiceOptions(text);
    if (chosenProfile) options.max_new_tokens = options.input.length <= 90 ? 140
      : Math.min(540, Math.max(200, Math.ceil(options.input.length * 2)));
    return options;
  }

  async function synthesizeFor(current, text, signal, { waitForCache = false, fresh = false } = {}) {
    const input = spokenReply(text);
    if (!/[\p{L}\p{Nd}]/u.test(input)) return null;
    const options = speechOptions(input);
    const cached = fresh ? null : await cachedSpeech(current, options, signal);
    if (cached) return cached;
    const filename = join(speechCache, replyKey(current, options) + '.wav');
    const response = await call(current, '/v1/audio/speech', options,
      AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(55_000)]));
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('El motor de voz respondió HTTP ' + response.status + '.');
    }
    const audio = await response.arrayBuffer();
    let bytes = Buffer.from(audio);
    if (!validWav(bytes)) throw Error('El motor no devolvió un WAV válido.');
    if (chosenProfile) clarifyVoice(bytes);
    bytes = trimSpeechPauses(bytes);
    if (!fresh) {
      const save = cacheReply(speechCache, filename, bytes);
      if (waitForCache) await save;
      else void save.catch(error => console.warn('Navi, caché de voz:', error.code || error.message));
    }
    return { wav: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), cached: false };
  }

  async function waitingCue() {
    const current = session;
    if (!current?.downloading || current.noticePlayed) return null;
    current.noticePlayed = true;
    const preset = { input: 'Espera un momento, necesito preparar mi voz.', voice: 'navi',
      language: 'Spanish', response_format: 'wav', max_new_tokens: 540 };
    const refKey = replyKey(current, preset);
    let bytes = await readFile(join(speechCache, 'avisos', refKey + '.wav')).catch(() => null);
    if (!bytes || !validWav(bytes)) bytes = await readFile(join(resources, 'replies', downloadCue)).catch(() => null);
    if (session !== current || !current.downloading || !bytes || !validWav(bytes)) return null;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  return { start, state: () => state, label: () => label, synthesize, narrate, waitingCue,
    stop: () => lifetime.abort() };
}

module.exports = { createLocalVoice, ensureModel };
