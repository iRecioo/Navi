const { createOnsetDetector, findPulse, selectLane, wrap } = require('./game-core.js');

const rate = 44100;
const lookAhead = 1.60;
const minimumLead = 1.25;
const analyzeEvery = .18;
const minimumSpacing = .22;
const quietLimit = .70;
const memory = 8.5;

function accentSimilarity(a, b) {
  return a.accents.reduce((sum, value, band) => sum + value * b.accents[band], 0) / (a.norm * b.norm);
}

function nearestBeat(time, pulse) {
  return time - wrap(time - pulse.phase, pulse.beat);
}

function compatible(first, second) {
  const phase = nearestBeat(second.phase, first);
  return Math.abs(first.beat / second.beat - 1) <= .045 && Math.abs(phase - second.phase) <= .12;
}

function createLiveBeats(onNotes, onDiscontinuity = () => {}) {
  let clock;
  let sampleIndex;
  let detector;
  let hits;
  let pulse;
  let challenger;
  let latestEvidence;
  let nextAnalysis;
  let lastNote;
  let audibleAt;
  let silenceSince;
  let quiet;
  let chooseLane;
  let envelope;

  function reset(lastKept = -Infinity) {
    clock = undefined;
    sampleIndex = 0;
    hits = [];
    pulse = undefined;
    challenger = undefined;
    latestEvidence = -Infinity;
    nextAnalysis = -Infinity;
    lastNote = Number.isFinite(lastKept) ? lastKept : -Infinity;
    audibleAt = -Infinity;
    silenceSince = undefined;
    quiet = false;
    envelope = .008;
    chooseLane = selectLane();
    detector = createOnsetDetector(hit => {
      hits.push({ ...hit, norm: Math.hypot(...hit.accents) });
    }, (time, level) => {
      if (level > .0035) audibleAt = time;
    });
  }
  reset();

  function updatePulse(instant, nearby) {
    const estimated = findPulse(nearby, pulse) || findPulse(hits, pulse);
    if (!estimated) {
      if (pulse) {
        const anchors = nearby.filter(hit => Math.abs(wrap(hit.time - pulse.phase, pulse.beat)) <= .080);
        if (anchors.length >= 2 && anchors.at(-1).time >= instant - Math.max(1.3, pulse.beat * 1.8)) latestEvidence = instant;
      }
      return;
    }
    estimated.phase = nearestBeat(instant, estimated);
    if (!pulse) {
      const double = { beat: estimated.beat * 2, phase: estimated.phase };
      if (estimated.beat < .46 && double.beat <= 1.05) {
        const even = nearby.filter(hit => Math.abs(wrap(hit.time - double.phase, double.beat)) < .075);
        const odd = nearby.filter(hit => Math.abs(wrap(hit.time - double.phase - estimated.beat, double.beat)) < .075);
        const strength = group => group.reduce((sum, hit) => sum + hit.strength, 0) / Math.max(1, group.length);
        const a = strength(even);
        const b = strength(odd);
        if (even.length >= 2 && (odd.length < even.length * .55 || a > b * 1.55)) estimated.beat *= 2;
        else if (odd.length >= 2 && (even.length < odd.length * .55 || b > a * 1.55)) {
          estimated.phase += estimated.beat;
          estimated.beat *= 2;
        }
      }
      if (estimated.confidence >= .32) {
        pulse = estimated;
        latestEvidence = instant;
      }
      return;
    }
    const anchors = nearby.filter(hit => Math.abs(wrap(hit.time - pulse.phase, pulse.beat)) <= .080);
    const hasAnchors = anchors.length >= 2 && anchors.at(-1).time >= instant - Math.max(1.3, pulse.beat * 1.8);
    if (compatible(pulse, estimated) && hasAnchors) {
      const phase = nearestBeat(instant, pulse);
      const offset = wrap(estimated.phase - phase, estimated.beat);
      const confidence = estimated.confidence;
      const adapt = confidence >= .40 ? .35 : .17;
      pulse = { beat: pulse.beat + (estimated.beat - pulse.beat) * adapt, phase: phase + offset * adapt, confidence };
      latestEvidence = instant;
      challenger = undefined;
      return;
    }
    const ratio = estimated.beat / pulse.beat;
    const sameTempoFamily = Math.abs(ratio - .5) < .04 || Math.abs(ratio - 2) < .08;
    if (hasAnchors) {
      latestEvidence = instant;
      if (sameTempoFamily || compatible(pulse, estimated)) {
        challenger = undefined;
        return;
      }
    }
    // Only switch grids when several successive windows agree and the old grid has no recent anchors.
    const count = challenger && compatible(challenger, estimated) ? challenger.count + 1 : 1;
    challenger = { ...estimated, count };
    if (count >= 3 && estimated.confidence >= .33 && instant - latestEvidence > 1.5) {
      pulse = estimated;
      latestEvidence = instant;
      challenger = undefined;
    }
  }

  function chartAhead(instant, nearby) {
    const earliest = Math.max(instant + minimumLead, lastNote + minimumSpacing);
    const end = instant + lookAhead;
    const firstBeat = pulse.phase + Math.ceil((earliest - pulse.phase) / pulse.beat) * pulse.beat;
    const candidates = [];
    const aligned = nearby.filter(hit => Math.abs(wrap(hit.time - pulse.phase, pulse.beat)) < .085);
    // A held pulse supplies playable targets even when the next bar uses different instruments.
    for (let time = firstBeat; time <= end; time += pulse.beat) {
      const attack = aligned.at(-1) || nearby.at(-1);
      candidates.push({ time, attack, base: true });
    }
    if (instant - latestEvidence < 1.7 && nearby.length >= 6) {
      const typical = nearby.map(hit => hit.strength).sort((a, b) => a - b)[Math.floor(nearby.length * .55)];
      for (const hit of nearby) {
        const beatPhase = wrap(hit.time - pulse.phase, pulse.beat);
        if (Math.abs(beatPhase) < .09 || hit.strength < typical || instant - hit.time > pulse.beat * 4.5) continue;
        for (const steps of [2, 4, 8]) {
          const period = pulse.beat * steps;
          const time = hit.time + period;
          if (time < earliest || time > end || Math.abs(wrap(time - pulse.phase, pulse.beat)) < minimumSpacing) continue;
          const support = hits.some(prior => Math.abs(prior.time - hit.time + period) < .062
            && prior.strength >= typical * .70 && accentSimilarity(prior, hit) > .76);
          if (support) candidates.push({ time, attack: hit, base: false });
        }
      }
    }
    candidates.sort((a, b) => a.time - b.time);
    const batch = [];
    for (const candidate of candidates) {
      if (candidate.time - lastNote < minimumSpacing) continue;
      if (!candidate.base && candidate.time - lastNote < .26) continue;
      lastNote = candidate.time;
      batch.push({ time: candidate.time, lane: chooseLane(candidate.attack, candidate.time) });
    }
    if (batch.length) onNotes(batch);
  }

  function schedule(instant) {
    if (instant - audibleAt > quietLimit) {
      if (!quiet && pulse) {
        quiet = true;
        silenceSince = instant;
        const kept = onDiscontinuity(instant, 'silence');
        lastNote = Number.isFinite(kept) ? kept : -Infinity;
      }
      return;
    }
    if (quiet) {
      if (instant - silenceSince > 1.1) {
        hits = hits.filter(hit => hit.time > instant - .85);
        pulse = undefined;
        challenger = undefined;
        latestEvidence = -Infinity;
      }
      quiet = false;
    }
    hits = hits.filter(hit => hit.time > instant - memory);
    const nearby = hits.filter(hit => hit.time > instant - 4.8);
    if (nearby.length >= 6) updatePulse(instant, nearby);
    if (pulse && nearby.length && instant - latestEvidence < 8 && instant - nearby.at(-1).time < 2.4) {
      chartAhead(instant, nearby);
    }
  }

  function feed(time, pcm) {
    if (clock !== undefined && Math.abs(time - clock) > .40) {
      const kept = onDiscontinuity(Math.min(time, clock), 'gap');
      reset(kept);
    }
    const start = clock === undefined ? time : clock + Math.max(-.001, Math.min(.001, (time - clock) * .04));
    for (let i = 0; i < pcm.length; i += 4) {
      if (sampleIndex++ % 4 !== 0) continue;
      const left = pcm.readInt16LE(i) / 32768;
      const right = pcm.readInt16LE(i + 2) / 32768;
      const sample = Math.abs(left) >= Math.abs(right) ? left : right;
      // Normalize slow level changes so a quiet verse is still detectable.
      envelope += (Math.abs(sample) - envelope) * .00025;
      const scaled = sample * Math.min(5, .062 / Math.max(.012, envelope));
      detector.sample(scaled, start + i / (4 * rate));
    }
    clock = start + pcm.length / (4 * rate);
    if (clock >= nextAnalysis) {
      nextAnalysis = clock + analyzeEvery;
      schedule(clock);
    }
  }

  return { feed, reset, audibleAt: () => audibleAt };
}

module.exports = { createLiveBeats, rate };
