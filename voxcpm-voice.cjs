const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { access, mkdir, readFile } = require('node:fs/promises');
const { availableParallelism } = require('node:os');
const { dirname, join, relative } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { ensureModel } = require('./local-voice.cjs');
const { voiceSentences } = require('./voice-sentences.cjs');

const source = 'https://huggingface.co/tc-mb/MiniCPM-V-Apps-gguf/resolve/2a3a3ddfbfc3d8e98c1070680b2fa98df88c3452/';
const assets = [
  ['VoxCPM2-BaseLM-Q4_K_M.gguf', 1002374880, '75806a47e11d48499a9ebcb9c0ca0750117975d08364043ecf7229625aaa160d'],
  ['VoxCPM2-Acoustic-F16.gguf', 1825096352, '5bde898488ad635ff55d24da53543768fa33d5e5cdc538ce190e5ef831038e85']
];
const totalBytes = assets.reduce((sum, [, bytes]) => sum + bytes, 0);
const shortTest = '¿Has visto mis zapatos azules junto a la cesta?';
const longTest = 'Celia cruzó la plaza a las cinco. Junto a la fuente vio un zorro con una cesta. «¿Me ayudas a encontrar el bosque?», le preguntó. El zorro movió la cola y echó a correr. Celia le siguió hasta un sendero entre los árboles. Al fondo vio una luz azul. Se acercó despacio y encontró a Navi esperándola bajo un árbol.';
const testCommands = new Map([
  ['prueba de voz corta', shortTest],
  ['prueba de voz larga', longTest]
]);

function voxTestReply(text) {
  return testCommands.get(text.trim().toLowerCase().replace(/[.!?]+$/u, ''));
}

async function checkResponse(response) {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw Error('VoxCPM2 HTTP ' + response.status + (detail ? ' · ' + detail : ''));
  }
  return response;
}

function createVoxVoice({ resources, cache, onStatus = () => {},
  executable = join(resources, 'llama-tts-server.exe') }) {
  const lifetime = new AbortController();
  let state = 'preparing';
  let label = 'Preparando VoxCPM2…';
  let active;
  let backend = '';
  let reference;
  let prompt;

  function report(next, message) {
    state = next;
    label = message;
    console.info('Navi, VoxCPM2: ' + message);
    onStatus(next);
  }

  async function call(server, route, body, signal) {
    const headers = { Authorization: 'Bearer ' + server.token };
    if (body) headers['Content-Type'] = 'application/json';
    return checkResponse(await fetch(server.url + route, {
      headers, signal, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined
    }));
  }

  function launch(models) {
    const cwd = dirname(models[0]);
    const token = randomBytes(24).toString('hex');
    const env = { ...process.env, NAVI_TTS_TOKEN: token };
    delete env.OPENAI_API_KEY;
    delete env.NODE_OPTIONS;
    delete env.GGML_BACKEND_PATH;
    const child = spawn(executable, [
      '--host', '127.0.0.1', '--port', '0', '--threads-http', '2',
      '--threads', String(Math.min(8, Math.max(2, availableParallelism() - 1))),
      '--voxcpm2-base-lm', relative(cwd, models[0]), '--voxcpm2-acoustic', relative(cwd, models[1]),
      '--voxcpm2-n-gpu-layers', '-1'
    ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const server = { token, child };
    active = server;
    return new Promise((resolve, reject) => {
      let tail = '';
      const timeout = setTimeout(() => reject(Error('VoxCPM2 tardó demasiado en cargar.')), 120_000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        const message = 'El motor se cerró (' + (code ?? signal) + '). ' + tail.trim().slice(-550);
        reject(Error(message));
        if (active === server && state === 'ready' && !lifetime.signal.aborted) {
          active = undefined;
          report('error', message);
        }
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
          tail = (tail + chunk).slice(-3000);
          backend = /custom component backend=([^\r\n]+)/u.exec(tail)?.[1]?.trim() || backend;
          const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/u.exec(tail)?.[1];
          if (!port || server.url) return;
          server.url = 'http://127.0.0.1:' + port;
          clearTimeout(timeout);
          resolve(server);
        });
      }
    });
  }

  function start() {
    if (active || lifetime.signal.aborted) return;
    const preparation = { controller: new AbortController() };
    active = preparation;
    const signal = AbortSignal.any([lifetime.signal, preparation.controller.signal]);
    backend = '';
    report('preparing', 'Comprobando los modelos de voz…');
    void (async () => {
      try {
        await access(executable);
        reference = (await readFile(join(resources, 'navi.wav'))).toString('base64');
        prompt = (await readFile(join(resources, 'navi.txt'), 'utf8')).replace(/^\uFEFF/u, '').trim();
        if (!prompt) throw Error('Falta la transcripción de la referencia de Navi.');
        await mkdir(cache, { recursive: true });
        const received = [0, 0];
        let lastProgress = -1;
        const downloads = assets.map((asset, index) => ensureModel(resources, cache, asset, signal, (bytes, downloading) => {
          received[index] = bytes;
          const total = received[0] + received[1];
          const percent = Math.floor(total * 100 / totalBytes);
          if (!downloading || percent === lastProgress) return;
          lastProgress = percent;
          report('preparing', 'Descargando modelos · ' + percent + ' %');
        }, source));
        let models;
        try { models = await Promise.all(downloads); }
        catch (error) {
          preparation.controller.abort();
          await Promise.allSettled(downloads);
          throw error;
        }
        lifetime.signal.throwIfAborted();
        report('preparing', 'Cargando VoxCPM2…');
        const server = await launch(models);
        const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000)]);
        const health = await call(server, '/health', null, deadline);
        await health.body?.cancel();
        if (/^vulkan/i.test(backend)) {
          report('preparing', 'Preparando la voz en ' + backend + '…');
          const warm = await speech(server, 'Hola.', deadline, 12);
          if ((await warm.arrayBuffer()).byteLength <= 44) throw Error('La gráfica no pudo generar audio.');
          report('ready', 'VoxCPM2 listo · ' + backend);
        } else {
          report('ready', 'VoxCPM2 listo en CPU · Vulkan no disponible');
        }
      } catch (error) {
        active?.child?.kill();
        active = undefined;
        if (!lifetime.signal.aborted) report('error', error.message);
      }
    })();
  }

  function speech(server, text, signal, maxSteps) {
    return call(server, '/v1/audio/speech/stream', {
      model: 'voxcpm2', input: text, reference_audio: reference, prompt_text: prompt,
      seed: 42, inference_timesteps: 10, max_steps: maxSteps
    }, signal);
  }

  async function stream(text, signal, onAudio) {
    if (state !== 'ready' || !active) return null;
    const server = active;
    const cancel = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(90_000)]);
    const sentences = text.length <= 390 ? [{ text, end: text.length }] : voiceSentences(text);
    let samples = 0;
    let count = 0;
    for (const sentence of sentences) {
      const maxSteps = Math.min(400, Math.max(42, Math.ceil(sentence.text.length * .65 + 24)));
      const response = await speech(server, sentence.text, cancel, maxSteps);
      let header = Buffer.alloc(0);
      let sampleRate;
      let remainder = Buffer.alloc(0);
      let sentenceSamples = 0;
      for await (const bytes of response.body) {
        let chunk = Buffer.from(bytes);
        if (!sampleRate) {
          header = Buffer.concat([header, chunk]);
          if (header.length < 44) continue;
          sampleRate = header.readUInt32LE(24);
          if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE'
            || header.toString('ascii', 36, 40) !== 'data'
            || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1
            || header.readUInt16LE(34) !== 16 || sampleRate !== 48000) {
            throw Error('VoxCPM2 devolvió un formato de audio inesperado.');
          }
          chunk = header.subarray(44);
        }
        if (remainder.length) chunk = Buffer.concat([remainder, chunk]);
        const length = chunk.length - chunk.length % 2;
        remainder = chunk.subarray(length);
        if (!length) continue;
        sentenceSamples += length / 2;
        samples += length / 2;
        count++;
        onAudio({
          pcm: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + length),
          sampleRate, end: sentence.end
        });
      }
      if (!sentenceSamples || remainder.length) throw Error('VoxCPM2 devolvió audio incompleto.');
      onAudio({ sentenceEnd: true, end: sentence.end });
    }
    return { count, duration: samples / 48000, backend };
  }

  function stop() {
    lifetime.abort();
    active?.child?.kill();
  }

  return { start, stop, stream, state: () => state,
    waitingCue: () => null,
    label: () => state === 'error' ? 'Reintentar VoxCPM2' : label };
}

module.exports = { createVoxVoice, voxTestReply };
