const tests = new Map([
  ['prueba de voz corta', '¡Hostia, tío! A las cinco, cruza la plaza y trae los zapatos azules.'],
  ['prueba de voz larga', 'Cuando llegues al bosque, fíjate en las luces junto al sendero. Si ves una azul, acércate despacio. ¿La oyes? Es el hada que cuida del camino. Salúdala y te enseñará dónde encontrar la entrada.'],
  ['prueba de emojis', '**¡Gracias, Mafu!** Te mando un beso. 😘💋']
]);
const testReplies = new Set([...tests.values()].map(spokenReply));

function answerKiss(text) {
  const phrase = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z ]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
    .replace(/^(?:(?:oye|hey|ey|hola|vale|navi|navy|nave) )+/u, '')
    .replace(/^y si /u, '')
    .replace(/(?: (?:navi|navy|nave|por favor|porfa))+$/u, '');
  if (/^(?:(?:me )?(?:puedes|podrias) )?(?:(?:lanza|manda|envia|tira|da)(?:r|s)?(?:me)?|me (?:lanzas|mandas|envias|tiras|das)|(?:quiero que me )?(?:lances|mandes|envies|tires|des)) un (?:beso|besito)$/u.test(phrase)) {
    return '¡Un beso para ti, Mafu!';
  }
  return null;
}

function voiceTestReply(text) {
  return tests.get(text.toLocaleLowerCase('es').replace(/^[¿¡]+|[.!?]+$/gu, ''));
}

function spokenReply(text) {
  return text
    .normalize('NFC')
    .replace(/\*{1,3}\s*(?:le |te )?(?:lanza|manda|envia|envía|da|tira) (?:un )?(?:beso|besito)[^*\r\n]*\*{1,3}/giu, ' ')
    .replace(/\[\s*emoji(?:\s+de)?\s+[^\]\r\n]+\]|\(\s*emoji(?:\s+de)?\s+[^)\r\n]+\)/giu, ' ')
    .replace(/&(?:#x[0-9a-f]+|#\d+|(?:zwj|zwnj|nbsp|hearts|star|smile|heart|sparkles));/giu, ' ')
    .replace(/!\[([^\]\r\n]*)\]\([^\r\n)]+\)/gu, '$1')
    .replace(/\[([^\]\r\n]+)\]\(https?:\/\/[^\r\n)]+\)/gu, '$1')
    .replace(/^[ \t]*```[^\r\n]*$/gmu, '')
    .replace(/https?:\/\/[^\s<>()]+(?<![,.!?])/gu, ' ')
    .replace(/(?<![\p{L}\p{N}]):[a-z][a-z0-9_+-]*:/giu, ' ')
    .replace(/(?<!\S)(?:<3|[;:=8][-^']?[)(dDpP/\\|*])(?=$|\s|[,.!?])/gu, ' ')
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]\p{M}*/gu, ' ')
    .replace(/[…]/gu, '...')
    .replace(/[;:]/gu, ',')
    .replace(/[\u200C\u200D\uFE00-\uFE0F]|\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[^\p{L}\p{M}\p{Nd}\s,.¡!¿?]/gu, ' ')
    .replace(/(?<!\p{L})\p{M}+/gu, '')
    .replace(/\s+([,.!?])/gu, '$1')
    .replace(/([!?])\.+/gu, '$1')
    .replace(/\s+/gu, ' ').trim();
}

function clarityCoefficients(frequency, q, gain, rate, highShelf = false) {
  const amplitude = 10 ** (gain / 40);
  const angle = 2 * Math.PI * frequency / rate;
  const cosine = Math.cos(angle);
  const alpha = Math.sin(angle) / (2 * q);
  if (!highShelf) {
    return [1 + alpha * amplitude, -2 * cosine, 1 - alpha * amplitude,
      1 + alpha / amplitude, -2 * cosine, 1 - alpha / amplitude];
  }
  const low = amplitude + 1;
  const high = amplitude - 1;
  const beta = 2 * Math.sqrt(amplitude) * alpha;
  return [amplitude * (low + high * cosine + beta), -2 * amplitude * (high + low * cosine),
    amplitude * (low + high * cosine - beta), low - high * cosine + beta,
    2 * (high - low * cosine), low - high * cosine - beta];
}

function clarifyVoice(wav) {
  let rate;
  let start;
  let size;
  for (let index = 12; index + 8 <= wav.length;) {
    const tag = wav.toString('ascii', index, index + 4);
    const length = wav.readUInt32LE(index + 4);
    const offset = index + 8;
    if (offset + length > wav.length) throw Error('Bloque WAV incompleto.');
    if (tag === 'fmt ' && length >= 16) {
      if (wav.readUInt16LE(offset) !== 1 || wav.readUInt16LE(offset + 2) !== 1
        || wav.readUInt16LE(offset + 14) !== 16) throw Error('Formato de voz inesperado.');
      rate = wav.readUInt32LE(offset + 4);
    } else if (tag === 'data') {
      start = offset;
      size = length;
    }
    index = offset + length + length % 2;
  }
  if (!rate || !start || !size || size % 2 || rate < 16000) throw Error('WAV de voz inválido.');

  const filters = [
    clarityCoefficients(550, .9, -1.6, rate),
    clarityCoefficients(2650, .85, 1.7, rate),
    // Match the shelf used in the audio comparison.
    clarityCoefficients(7100, Math.SQRT1_2, .6, rate, true)
  ].map(([b0, b1, b2, a0, a1, a2]) => ({
    b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0, z1: 0, z2: 0
  }));
  for (let index = start; index < start + size; index += 2) {
    let sample = wav.readInt16LE(index);
    for (const filter of filters) {
      const value = filter.b0 * sample + filter.z1;
      filter.z1 = filter.b1 * sample - filter.a1 * value + filter.z2;
      filter.z2 = filter.b2 * sample - filter.a2 * value;
      sample = value;
    }
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), index);
  }
}

function trimSpeechPauses(wav) {
  // The synthesis server returns mono signed 16-bit PCM with a fixed WAV header.
  if (wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt16LE(22) !== 1
    || wav.readUInt16LE(34) !== 16 || wav.readUInt32LE(40) !== wav.length - 44) return wav;
  const rate = wav.readUInt32LE(24);
  if (rate < 8000 || rate > 96000) return wav;
  const samples = (wav.length - 44) / 2;
  const frame = Math.round(rate * .02);
  const frameCount = Math.ceil(samples / frame);
  const quiet = new Uint8Array(frameCount);
  let active = false;
  for (let n = 0; n < frameCount; n++) {
    let power = 0;
    const end = Math.min(samples, (n + 1) * frame);
    for (let i = n * frame; i < end; i++) {
      const value = wav.readInt16LE(44 + i * 2);
      power += value * value;
    }
    quiet[n] = power / (end - n * frame) < 175 * 175;
    if (!quiet[n]) active = true;
  }
  if (!active) return wav;

  const cuts = [];
  for (let start = 0; start < frameCount;) {
    if (!quiet[start]) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < frameCount && quiet[end]) end++;
    const edge = start === 0 || end === frameCount;
    if (end - start >= (edge ? 9 : 26)) {
      const padding = edge ? 5 : 9;
      cuts.push([start === 0 ? 0 : (start + padding) * frame,
        end === frameCount ? samples : (end - padding) * frame]);
    }
    start = end;
  }
  if (!cuts.length) return wav;
  const parts = [wav.subarray(0, 44)];
  let cursor = 0;
  for (const [start, end] of cuts) {
    parts.push(wav.subarray(44 + cursor * 2, 44 + start * 2));
    cursor = end;
  }
  parts.push(wav.subarray(44 + cursor * 2));
  const output = Buffer.concat(parts);
  output.writeUInt32LE(output.length - 8, 4);
  output.writeUInt32LE(output.length - 44, 40);
  return output;
}

module.exports = { voiceTestReply, testReplies, spokenReply, clarifyVoice, answerKiss, trimSpeechPauses };
