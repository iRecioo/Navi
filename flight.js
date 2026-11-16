(() => {
  const fairy = document.getElementById('fairy');
  const sprite = fairy.querySelector('picture');
  const trail = document.getElementById('fairy-sparks');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const audioFormats = [
    ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['ogg', 'audio/ogg'],
    ['m4a', 'audio/mp4'], ['flac', 'audio/flac'], ['webm', 'audio/webm']
  ];
  const colors = ['#80dcff', '#4bc5ff', '#71a7ff', '#cbb0ff'];

  let state = 'idle';
  let speaking = false;
  let listeningForFollowUp = false;
  let frameId;
  let previous;
  let trailOrigin;
  let lastStar = 0;
  let cueId = 0;
  let playing;
  let playingCursorCue = false;
  let thoughtEnd = Promise.resolve();
  let finishThought;
  let audioContext;
  let floatBuffer;
  let floatLoop;
  const sounds = new Map();

  async function findSound(name, formats = audioFormats, volume = .65) {
    const audio = new Audio();
    for (const [extension, mime] of formats) {
      if (!audio.canPlayType(mime)) continue;
      const url = 'assets/' + name + '.' + extension;
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        await response.body?.cancel();
        audio.preload = 'auto';
        audio.volume = volume;
        audio.src = url;
        return audio;
      } catch {
        // Custom sounds are optional.
      }
    }
    return null;
  }

  async function playSound(name, fallback, volume, isCursorCue = false) {
    if (isCursorCue && (speaking || listeningForFollowUp || state !== 'idle' && state !== 'active' || playing && !playing.paused)) return;
    const id = ++cueId;
    playing?.pause();
    const audio = await sounds.get(name) || await sounds.get(fallback);
    if (!audio || id !== cueId) return;
    if (isCursorCue && (speaking || listeningForFollowUp || state !== 'idle' && state !== 'active')) return;
    playing = audio;
    playingCursorCue = isCursorCue;
    audio.volume = volume ?? (audio.src.includes('OOT_Navi_') ? .85 : .65);
    audio.currentTime = 0;
    await audio.play().catch(() => {});
  }

  const thoughtSounds = Promise.all([1, 2, 3, 4].map(number =>
    findSound('Navi_Hm_' + number, [['wav', 'audio/wav']], .44)
  )).then(clips => clips.filter(Boolean));

  function playThought() {
    finishThought?.();
    thoughtEnd = new Promise(resolve => {
      let thought;
      const timer = setTimeout(finish, 480);
      function finish() {
        clearTimeout(timer);
        thought?.removeEventListener('ended', finish);
        if (finishThought === finish) {
          thought?.pause();
          finishThought = undefined;
        }
        resolve();
      }
      finishThought = finish;
      void thoughtSounds.then(clips => {
        if (finishThought !== finish) return;
        if (!clips.length) { finish(); return; }
        thought = clips[Math.floor(Math.random() * clips.length)];
        thought.addEventListener('ended', finish, { once: true });
        thought.currentTime = 0;
        void thought.play().catch(finish);
      }).catch(finish);
    });
  }

  const floatVolume = .18;
  const floatBytes = fetch('assets/OOT_Navi_Float_Loop.wav')
    .then(response => response.ok ? response.arrayBuffer() : null).catch(() => null);

  function setFloatVolume(loop, volume, smoothTime) {
    const now = audioContext.currentTime;
    loop.gain.gain.cancelAndHoldAtTime(now);
    loop.gain.gain.setTargetAtTime(volume, now, smoothTime);
  }

  async function syncFloat() {
    if (state === 'idle') {
      if (floatLoop) {
        setFloatVolume(floatLoop, 0, .025);
        floatLoop.source.stop(audioContext.currentTime + .14);
        floatLoop = undefined;
      }
      return;
    }
    try {
      audioContext ??= new AudioContext();
      floatBuffer ??= floatBytes.then(bytes => bytes ? audioContext.decodeAudioData(bytes) : null);
      const buffer = await floatBuffer;
      if (!buffer || state === 'idle') return;
      if (!floatLoop) {
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = audioContext.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(audioContext.destination);
        source.onended = () => { source.disconnect(); gain.disconnect(); };
        floatLoop = { source, gain };
        source.start();
      }
      const listening = listeningForFollowUp || ['recording', 'wake-recording', 'connecting', 'processing-voice', 'alarm'].includes(state);
      setFloatVolume(floatLoop, listening ? 0 : speaking ? .025 : floatVolume, listening ? .015 : .065);
      if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
    } catch {
      // The rest of Navi still works if optional ambience cannot be played.
    }
  }

  function range(low, high) {
    return low + Math.random() * (high - low);
  }

  function emit(x, y, dx, dy, moving, scale, near) {
    if (trail.childElementCount >= 32) return;
    const star = document.createElement('i');
    const size = (moving ? range(10, 17) : range(7, 11)) * scale;
    star.className = 'fairy-star';
    if (Math.random() < .24) star.classList.add('fairy-star--orb');
    star.style.setProperty('--size', size + 'px');
    star.style.setProperty('--x', (x - size / 2 + range(-11, 11) * scale) + 'px');
    star.style.setProperty('--y', (y - size / 2 + range(-8, 8) * scale) + 'px');
    star.style.setProperty('--dx', (range(-22, 22) - dx * 21) + 'px');
    star.style.setProperty('--dy', (range(8, 29) - dy * 13) + 'px');
    star.style.setProperty('--spin', range(-65, 65) + 'deg');
    const life = moving ? range(540, 790) : range(650, 980);
    star.style.setProperty('--life', life * (1 - near * .26) + 'ms');
    star.style.setProperty('--spark', colors[Math.floor(Math.random() * colors.length)]);
    star.addEventListener('animationend', () => star.remove(), { once: true });
    trail.append(star);
  }

  function animate(now) {
    const screenX = window.screenX;
    const screenY = window.screenY;
    if (!trailOrigin || !trail.childElementCount) trailOrigin = { x: screenX, y: screenY };
    trail.style.transform = 'translate(' + (trailOrigin.x - screenX) + 'px,' + (trailOrigin.y - screenY) + 'px)';
    const bounds = sprite.getBoundingClientRect();
    const center = { x: screenX + bounds.left + bounds.width * .495, y: screenY + bounds.top + bounds.height * .59 };
    const ratio = fairy.getBoundingClientRect().width / fairy.offsetWidth;
    const scale = ratio / .65;
    const near = Math.max(0, Math.min(1, (ratio - .65) / .43));
    if (previous) {
      const dx = center.x - previous.x;
      const dy = center.y - previous.y;
      const distance = Math.hypot(dx, dy);
      const moving = distance > 1.1;
      if (now - lastStar > (moving ? 42 + near * 26 : 235 + near * 60)) {
        const count = moving && distance < 90 && near < .45 ? 2 : 1;
        for (let i = 0; i < count; i += 1) {
          const back = i / count;
          emit(center.x - trailOrigin.x - dx * back, center.y - trailOrigin.y - dy * back,
            dx / Math.max(1, distance), dy / Math.max(1, distance), moving, scale, near);
        }
        lastStar = now;
      }
    }
    previous = center;
    frameId = requestAnimationFrame(animate);
  }

  function syncMotion() {
    cancelAnimationFrame(frameId);
    trail.replaceChildren();
    previous = undefined;
    trailOrigin = undefined;
    if (!reducedMotion.matches) frameId = requestAnimationFrame(animate);
  }

  window.NaviFlight = {
    playCursorCue() {
      if (Math.random() < .5) void playSound('OOT_Navi_In', 'toSmall', .28, true);
      else void playSound('OOT_Navi_Out', 'toBig', .28, true);
    },
    setState(next) {
      if (next === state) return;
      const wasIdle = state === 'idle';
      state = next;
      if (playingCursorCue && !['idle', 'active'].includes(next)) playing?.pause();
      if (wasIdle) void playSound('OOT_Navi_Out', 'toBig');
      else if (next === 'idle') void playSound('OOT_Navi_In', 'toSmall');
      if (next === 'working') playThought();
      else if (next === 'idle' || next === 'alarm') finishThought?.();
      void syncFloat();
    },
    setSpeaking(next) {
      speaking = next;
      if (next) {
        finishThought?.();
        if (playingCursorCue) playing?.pause();
      }
      void syncFloat();
    },
    setListening(next) {
      if (listeningForFollowUp === next) return;
      listeningForFollowUp = next;
      if (next && playingCursorCue) playing?.pause();
      void syncFloat();
    },
    finishThinking: () => thoughtEnd
  };

  for (const name of ['toBig', 'toSmall']) sounds.set(name, findSound(name));
  for (const name of ['OOT_Navi_Out', 'OOT_Navi_In']) {
    sounds.set(name, findSound(name, [['wav', 'audio/wav']], .85));
  }
  reducedMotion.addEventListener('change', syncMotion);
  syncMotion();
})();
