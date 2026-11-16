(() => {
  const CHART_VERSION = 4;
  const LIVE_CHART_VERSION = 5;
  const KEYS = ['KeyA', 'KeyS', 'KeyK', 'KeyL'];
  const GLOBAL_REPEAT_GAP = .24;
  const WINDOWS = { perfect: .055, good: .105, okay: .16 };
  const POINTS = { perfect: 1000, good: 700, okay: 350, miss: 0 };
  const analysisRate = 11025;
  const fftSize = 512;
  const hop = 112;
  const bands = [65, 180, 420, 1050, 2700, 5400];
  const weights = [1, .96, .82, .67, .54, .36];
  const window = Float32Array.from({ length: fftSize }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / fftSize));
  const order = Int16Array.from({ length: fftSize }, (_, i) => {
    let reverse = 0;
    for (let bits = 1; bits < fftSize; bits *= 2, i >>= 1) reverse = (reverse << 1) | (i & 1);
    return reverse;
  });
  const cos = Float32Array.from({ length: fftSize / 2 }, (_, i) => Math.cos(-2 * Math.PI * i / fftSize));
  const sin = Float32Array.from({ length: fftSize / 2 }, (_, i) => Math.sin(-2 * Math.PI * i / fftSize));
  const bandFor = Int8Array.from({ length: fftSize / 2 }, (_, i) => {
    const frequency = i * analysisRate / fftSize;
    const index = bands.findIndex(edge => frequency < edge);
    return index < 0 ? bands.length - 1 : index;
  });
  const binCounts = bands.map((_, band) => bandFor.slice(1).filter(value => value === band).length);

  function createOnsetDetector(onHit, onSound = () => {}) {
    const ring = new Float32Array(fftSize);
    const real = new Float32Array(fftSize);
    const imaginary = new Float32Array(fftSize);
    const spectrum = new Float32Array(fftSize / 2);
    const contrast = new Float64Array(bands.length);
    const baseline = new Float64Array(bands.length).fill(.016);
    let index = 0;
    let untilFrame = fftSize;
    let before;
    let recent;
    let buffered;

    function sample(value, time) {
      ring[index] = value;
      index = (index + 1) % fftSize;
      if (--untilFrame > 0) return;
      untilFrame = hop;

      let sum = 0;
      for (let i = 0; i < fftSize; i++) {
        const value = ring[(index + i) % fftSize];
        sum += value ** 2;
        real[order[i]] = value * window[i];
        imaginary[i] = 0;
      }
      const loudness = Math.sqrt(sum / fftSize);
      const center = time - (fftSize / 2) / analysisRate;
      if (loudness > .0035) onSound(center, loudness);

      for (let width = 2; width <= fftSize; width *= 2) {
        const half = width / 2;
        for (let start = 0; start < fftSize; start += width) {
          for (let i = 0; i < half; i++) {
            const a = start + i;
            const b = a + half;
            const twiddle = i * fftSize / width;
            const x = real[b] * cos[twiddle] - imaginary[b] * sin[twiddle];
            const y = real[b] * sin[twiddle] + imaginary[b] * cos[twiddle];
            real[b] = real[a] - x;
            imaginary[b] = imaginary[a] - y;
            real[a] += x;
            imaginary[a] += y;
          }
        }
      }
      contrast.fill(0);
      for (let bin = 1; bin < spectrum.length; bin++) {
        const magnitude = Math.log1p(Math.hypot(real[bin], imaginary[bin]) * .8);
        contrast[bandFor[bin]] += Math.max(0, magnitude - spectrum[bin]);
        spectrum[bin] = magnitude;
      }
      const accents = Array.from(contrast, (total, band) => {
        const change = total / binCounts[band];
        const relative = change / (.022 + baseline[band]);
        baseline[band] += (change - baseline[band]) * .06;
        return Math.min(9, relative) * weights[band];
      });
      const strength = accents[0] * .24 + accents[1] * .29 + accents[2] * .17 + accents[3] * .13
        + accents[4] * .10 + accents[5] * .07;
      const current = { time: center - .006, strength, accents, loudness };
      if (before && recent.strength > before.strength && recent.strength >= strength && recent.loudness > .003
        && recent.strength > .60 && Math.max(...recent.accents) > 1.05) {
        if (!buffered || recent.time - buffered.time > .068) {
          if (buffered) onHit(buffered);
          buffered = recent;
        } else if (recent.strength > buffered.strength) buffered = recent;
      }
      if (buffered && center > buffered.time + .074) {
        onHit(buffered);
        buffered = undefined;
      }
      before = recent;
      recent = current;
    }
    return { sample };
  }

  const modulo = (value, scale) => (value % scale + scale) % scale;
  const wrap = (value, scale) => modulo(value + scale / 2, scale) - scale / 2;

  function findPulse(hits, previous) {
    if (hits.length < 6 || hits.at(-1).time - hits[0].time < 2.2) return null;
    const first = hits[0].time;
    const last = hits.at(-1).time;
    const values = hits.map(hit => ({
      time: hit.time - first,
      weight: (.45 + .55 * Math.exp((hit.time - last) / 4))
        * (hit.strength * .50 + Math.max(...hit.accents.slice(0, 4)) * .50)
    }));
    const total = values.reduce((sum, hit) => sum + hit.weight, 0);
    const scores = new Float32Array(221);
    for (let a = 0; a < values.length; a++) {
      for (let b = a + 1; b < values.length; b++) {
        const step = Math.round((values[b].time - values[a].time) * 100);
        if (step >= scores.length - 2) break;
        const support = Math.min(values[a].weight, values[b].weight);
        scores[step] += support;
        scores[step - 1] += support * .7;
        scores[step + 1] += support * .7;
      }
    }
    const candidates = [];
    for (let i = 30; i <= 105; i++) {
      const score = scores[i] + scores[i * 2] * .40;
      if (scores[i] >= scores[i - 1] && scores[i] >= scores[i + 1] && score > total * .15) candidates.push({ i, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const periods = candidates.slice(0, 6);
    if (previous) periods.push({ i: Math.round(previous.beat * 100), score: 0 });
    let best;
    let bestScore = .32;
    for (const { i, score } of periods) {
      for (let beat = (i - .7) / 100; beat <= (i + .7) / 100; beat += .002) {
        const cells = Math.round(beat * 160);
        const distribution = new Float32Array(cells);
        for (const hit of values) distribution[Math.round(modulo(hit.time, beat) / beat * cells) % cells] += hit.weight;
        for (let cell = 0; cell < cells; cell++) {
          let aligned = 0;
          for (let offset = -5; offset <= 5; offset++) {
            aligned += distribution[modulo(cell + offset, cells)] * (1 - Math.abs(offset) / 6);
          }
          const phase = first + cell * beat / cells;
          const continuity = previous && Math.abs(beat / previous.beat - 1) < .04
            && Math.abs(wrap(phase - previous.phase, beat)) < .075 ? .06 : 0;
          const rating = aligned / total + Math.min(.22, score / total * .18) + continuity;
          if (rating > bestScore) {
            bestScore = rating;
            best = { beat, phase, confidence: aligned / total };
          }
        }
      }
    }
    return best?.confidence >= .28 ? best : null;
  }

  function selectLane() {
    const recent = [-Infinity, -Infinity, -Infinity, -Infinity];
    const history = [];
    let seed = 0x9747b28c;
    return (hit, time) => {
      const low = Math.max(hit.accents[0], hit.accents[1]);
      const middle = Math.max(hit.accents[2], hit.accents[3]);
      const high = Math.max(hit.accents[4], hit.accents[5]);
      const accent = low > middle * 1.22 ? 0 : high > middle && high > low ? 2 : 1;
      seed = Math.imul(seed ^ Math.round(hit.strength * 317) ^ Math.round(time * 11), 0x5bd1e995);
      let winner;
      let best = -Infinity;
      for (let lane = 0; lane < 4; lane++) {
        seed = Math.imul(seed, 1664525) + 1013904223 | 0;
        const side = lane < 2 ? 0 : 1;
        const outer = lane === 0 || lane === 3;
        const last = history.at(-1);
        const nextPhrase = history.slice(-3).concat(lane).join('');
        const repeated = history.slice(-7, -3).join('') === nextPhrase;
        const score = (seed >>> 0) / 4294967296
          + (accent === 0 ? Number(outer) * .40 : accent === 2 ? Number(!outer) * .35 : 0)
          + (Number.isInteger(last) && ((last < 2 ? 0 : 1) !== side) && time - recent[last] < .43 ? .65 : 0)
          + Math.min(4, time - recent[lane]) * .115
          - (repeated ? 2 : 0)
          - (time - recent[lane] < .34 ? 4 : 0);
        if (score > best) { best = score; winner = lane; }
      }
      recent[winner] = time;
      history.push(winner);
      if (history.length > 8) history.shift();
      return winner;
    };
  }

  function analyze(channels, rate, duration) {
    const hits = [];
    const detector = createOnsetDetector(hit => {
      if (hit.time >= .20 && hit.time <= duration - .24) hits.push(hit);
    });
    const stride = rate / analysisRate;
    for (let frame = 0; frame < channels[0].length; frame += stride) {
      const index = Math.floor(frame);
      let sample = channels[0][index];
      if (channels[1] && Math.abs(channels[1][index]) > Math.abs(sample)) sample = channels[1][index];
      detector.sample(sample, frame / rate);
    }
    const chooseLane = selectLane();
    const chart = [];
    let section = -1;
    let pulse;
    let typical;
    for (let index = 0; index < hits.length; index++) {
      const hit = hits[index];
      const block = Math.floor(hit.time / 3);
      if (block !== section) {
        const nearby = hits.slice(Math.max(0, index - 55), index + 70)
          .filter(candidate => Math.abs(candidate.time - hit.time) < 4);
        pulse = findPulse(nearby, pulse);
        const strengths = nearby.map(candidate => candidate.strength).sort((a, b) => a - b);
        typical = strengths[Math.floor(strengths.length * .52)] || 1;
        section = block;
      }
      const last = chart.at(-1)?.time ?? -Infinity;
      const onBeat = pulse && Math.abs(wrap(hit.time - pulse.phase, pulse.beat)) <= .067;
      const subdivision = pulse && Math.abs(wrap(hit.time - pulse.phase, pulse.beat / 2)) <= .056;
      const threshold = onBeat ? typical * .68 : subdivision ? typical * .88 : typical * 1.12;
      const minimumGap = onBeat ? .245 : hit.strength > typical * 1.35 ? .215 : .295;
      if (hit.time - last < minimumGap || hit.strength < threshold) continue;
      chart.push({ time: Math.round(hit.time * 1000) / 1000, lane: chooseLane(hit, hit.time) });
    }
    return chart;
  }

  function createScorer(chart) {
    const lanes = Array.from({ length: 4 }, () => []);
    const cursors = [0, 0, 0, 0];
    const notes = [];
    function append(chartNotes) {
      for (const raw of chartNotes) {
        const note = { ...raw, judged: false };
        notes.push(note);
        lanes[note.lane].push(note);
      }
    }
    function discardFuture(time) {
      while (notes.length && notes.at(-1).time > time) {
        const note = notes.pop();
        lanes[note.lane].pop();
        cursors[note.lane] = Math.min(cursors[note.lane], lanes[note.lane].length);
      }
      pending = Math.min(pending, notes.length);
    }
    append(chart);
    const stats = { score: 0, combo: 0, maxCombo: 0, misses: 0, hits: 0 };
    let pending = 0;
    function judge(note, accuracy) {
      if (note) note.judged = true;
      if (accuracy === 'miss') {
        stats.misses++;
        stats.combo = 0;
      } else {
        stats.hits++;
        stats.combo++;
        stats.maxCombo = Math.max(stats.maxCombo, stats.combo);
        stats.score += POINTS[accuracy];
      }
      return { accuracy, lane: note?.lane };
    }
    function expire(time) {
      let last;
      while (pending < notes.length && notes[pending].time + WINDOWS.okay < time) {
        const note = notes[pending++];
        if (!note.judged) last = judge(note, 'miss');
      }
      return last;
    }
    function press(lane, time) {
      expire(time);
      let note;
      let nearest = WINDOWS.okay + Number.EPSILON;
      const track = lanes[lane];
      while (cursors[lane] < track.length && track[cursors[lane]].judged) cursors[lane]++;
      for (let i = cursors[lane]; i < track.length; i++) {
        const item = track[i];
        if (item.time > time + WINDOWS.okay) break;
        const difference = Math.abs(item.time - time);
        if (!item.judged && difference < nearest) {
          nearest = difference;
          note = item;
        }
      }
      if (!note) {
        stats.combo = 0;
        return { accuracy: 'miss', lane };
      }
      return judge(note, nearest <= WINDOWS.perfect ? 'perfect' : nearest <= WINDOWS.good ? 'good' : 'okay');
    }
    return { notes, stats, expire, press, append, discardFuture };
  }

  const api = { CHART_VERSION, LIVE_CHART_VERSION, KEYS, GLOBAL_REPEAT_GAP, WINDOWS, analyze, findPulse, createScorer,
    createOnsetDetector, selectLane, wrap };
  if (typeof module === 'object') module.exports = api;
  else globalThis.Rhythm = api;
})();
