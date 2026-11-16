'use strict';

const { field, createPong, COLS, ROWS, emptyBoard, moved, winningLine, fourMove, pairDeck, reflexResult } = NaviArcade;
const stage = document.getElementById('stage');
const title = document.getElementById('title');
const status = document.getElementById('status');
const fairy = document.getElementById('fairy');
const again = document.getElementById('continue');
const bridge = window.naviArcade;
let finished;
let playingClip;
let finalLineHeard = false;
let activeFrame;

function finish(result, message) {
  if (finished) return;
  finished = result;
  status.textContent = message;
  again.hidden = false;
  again.focus();
  // Give the final caption and prepared voice time to be heard.
  setTimeout(() => { if (finished === result) void bridge.finish(finalLineHeard ? { ...result, finalLineHeard } : result); }, 4500);
}

function leave() {
  if (finished) void bridge.finish(finalLineHeard ? { ...finished, finalLineHeard } : finished);
  else void bridge.cancel();
}
document.getElementById('close').addEventListener('click', leave);
again.addEventListener('click', leave);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); leave(); }
});
window.addEventListener('pagehide', () => {
  cancelAnimationFrame(activeFrame);
  playingClip?.pause();
});

function chooseVoice(lines, clips) {
  const cursor = {};
  return function say(group) {
    const options = lines[group];
    const index = (cursor[group] || 0) % options.length;
    cursor[group] = index + 1;
    status.textContent = options[index];
    fairy.classList.remove('react');
    void fairy.offsetWidth;
    fairy.classList.add('react');
    const clip = clips[group + index];
    if (!clip) return;
    playingClip?.pause();
    playingClip = clip;
    clip.currentTime = 0;
    void clip.play().then(() => {
      if (group === 'won' || group === 'lost') finalLineHeard = true;
    }).catch(() => {});
  };
}

async function pong(lines) {
  fairy.classList.add('big');
  status.textContent = 'Preparando la voz de Navi…';
  const canvas = document.createElement('canvas');
  canvas.width = field.width;
  canvas.height = field.height;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Ping Pong. Mueve la pala con el ratón, flechas o W y S.');
  stage.append(canvas);
  const ctx = canvas.getContext('2d');
  const match = createPong();
  const { state } = match;
  let ready = false;
  let previous;
  let pointer;
  let hold = 0;
  let elapsedSincePoint = 0;
  const keys = new Set();
  const inputKeys = ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS'];
  canvas.addEventListener('pointermove', event => {
    const box = canvas.getBoundingClientRect();
    const height = Math.max(1, Math.min(box.height, box.width * field.height / field.width));
    pointer = (event.clientY - box.top - (box.height - height) * .5) * field.height / height;
  });
  document.addEventListener('keydown', event => {
    if (!inputKeys.includes(event.code)) return;
    event.preventDefault();
    pointer = undefined;
    keys.add(event.code);
  });
  document.addEventListener('keyup', event => keys.delete(event.code));
  window.addEventListener('blur', () => { keys.clear(); previous = undefined; });

  function draw() {
    const { width, height, inset, paddle, thickness, radius } = field;
    ctx.fillStyle = '#11172e';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#474b73';
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    ctx.moveTo(width/2, 0);
    ctx.lineTo(width/2, height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#89f3f0';
    ctx.fillText(state.score[0], width/2 - 65, 49);
    ctx.fillRect(inset, state.player - paddle/2, thickness, paddle);
    ctx.fillStyle = '#e0a1ff';
    ctx.fillText(state.score[1], width/2 + 65, 49);
    ctx.fillRect(width - inset - thickness, state.navi - paddle/2, thickness, paddle);
    ctx.fillStyle = '#f3f4ff';
    ctx.beginPath();
    ctx.arc(state.ball.x, state.ball.y, radius, 0, Math.PI*2);
    ctx.fill();
    if (ready && state.delay > .04 && !state.winner) {
      ctx.font = '16px monospace';
      ctx.fillText(Math.ceil(state.delay).toString(), width/2, height/2 - 19);
    }
  }

  const clips = {};
  const urls = [];
  const say = chooseVoice(lines, clips);
  window.addEventListener('pagehide', () => urls.forEach(url => URL.revokeObjectURL(url)), { once: true });

  function animate(time) {
    if (ready && previous !== undefined && document.hasFocus()) {
      const dt = Math.min(.025, (time - previous) / 1000);
      elapsedSincePoint += dt;
      const up = keys.has('ArrowUp') || keys.has('KeyW');
      const down = keys.has('ArrowDown') || keys.has('KeyS');
      const ret = match.step(dt, { pointer, direction: Number(down) - Number(up) });
      if (ret) {
        elapsedSincePoint = 0;
        hold = 2.4;
        if (ret.winner) {
          say(ret.winner === 'player' ? 'won' : 'lost');
          finish({ player: ret.score[0], navi: ret.score[1] }, status.textContent);
        } else if (ret.score.every(score => score === 5)) say('tie');
        else say(ret.side);
      } else if (!finished && elapsedSincePoint >= hold) {
        status.textContent = 'Ratón, ↑ ↓ o W S · Gana quien llegue a seis';
      }
    }
    previous = time;
    draw();
    if (!finished) activeFrame = requestAnimationFrame(animate);
  }

  draw();
  activeFrame = requestAnimationFrame(animate);
  const prepared = await bridge.prepareVoice().catch(() => ({}));
  const loading = [];
  for (const [key, wav] of Object.entries(prepared || {})) {
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    urls.push(url);
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = .88;
    loading.push(new Promise(resolve => {
      const settle = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(settle, 900);
      audio.addEventListener('canplaythrough', settle, { once: true });
      audio.addEventListener('error', settle, { once: true });
      audio.load();
      if (audio.readyState >= 3) settle();
    }));
    clips[key] = audio;
  }
  await Promise.all(loading);
  ready = true;
  status.textContent = 'Ratón, ↑ ↓ o W S · Gana quien llegue a seis';
  canvas.focus();
}

function connectFour() {
  let board = emptyBoard();
  let waiting = false;
  const grid = document.createElement('div');
  grid.id = 'four';
  const buttons = Array.from({ length: COLS }, (_, column) => {
    const button = document.createElement('button');
    button.className = 'column';
    button.setAttribute('aria-label', 'Columna ' + (column + 1));
    const label = document.createElement('span');
    label.textContent = column + 1;
    button.append(label);
    const cells = Array.from({ length: ROWS }, () => {
      const cell = document.createElement('span');
      cell.className = 'cell';
      button.append(cell);
      return cell;
    }).reverse();
    button.addEventListener('click', () => playerMove(column));
    grid.append(button);
    return { button, cells };
  });
  stage.append(grid);
  document.addEventListener('keydown', event => {
    if (/^[1-7]$/u.test(event.key) && !event.repeat) playerMove(Number(event.key) - 1);
  });
  status.textContent = 'Tu turno · Elige una columna o pulsa 1–7';

  function place(column, piece) {
    board = moved(board, column, piece);
    const row = board[column].length - 1;
    buttons[column].cells[row].classList.add(piece === 1 ? 'player' : 'navi');
    const line = winningLine(board, column, row);
    if (line) {
      for (const [x, y] of line) buttons[x].cells[y].classList.add('winning');
      finish({ outcome: piece === 1 ? 'player' : 'navi' }, piece === 1 ? '¡Has hecho cuatro en raya!' : '¡Cuatro en raya para Navi!');
    } else if (board.every(cells => cells.length === ROWS)) finish({ outcome: 'draw' }, 'Empate. El tablero está lleno.');
    for (let i = 0; i < COLS; i++) buttons[i].button.disabled = Boolean(finished) || board[i].length === ROWS;
  }

  function playerMove(column) {
    if (waiting || finished || board[column].length === ROWS) return;
    place(column, 1);
    if (finished) return;
    waiting = true;
    status.textContent = 'Turno de Navi…';
    setTimeout(() => {
      const choice = fourMove(board);
      if (choice === null || finished) return;
      place(choice, 2);
      waiting = false;
      if (!finished) status.textContent = 'Tu turno · Elige una columna o pulsa 1–7';
    }, 460);
  }
}

function pairs() {
  const labels = ['Luna', 'Rombo', 'Estrella', 'Sol', 'Triángulo', 'Órbita', 'Cruz', 'Flor'];
  const shapes = ['☾', '◆', '✦', '☀', '▲', '◎', '✚', '✿'];
  const grid = document.createElement('div');
  grid.id = 'pairs';
  const deck = pairDeck();
  let open = [];
  let moves = 0;
  let matches = 0;
  let since;
  status.textContent = 'Encuentra las ocho parejas';
  const buttons = deck.map((_, index) => {
    const card = document.createElement('button');
    card.className = 'card';
    card.textContent = '?';
    card.setAttribute('aria-label', 'Carta ' + (index + 1) + ', boca abajo');
    card.addEventListener('click', () => flip(index));
    grid.append(card);
    return card;
  });
  stage.append(grid);

  function flip(index) {
    const card = buttons[index];
    if (finished || open.length >= 2 || card.dataset.open !== undefined || card.disabled) return;
    since ??= performance.now();
    card.dataset.open = '';
    card.textContent = shapes[deck[index]];
    card.setAttribute('aria-label', 'Carta ' + (index + 1) + ', ' + labels[deck[index]]);
    open.push(index);
    if (open.length < 2) return;
    moves++;
    if (deck[open[0]] === deck[open[1]]) {
      for (const index of open) {
        buttons[index].dataset.match = '';
        buttons[index].disabled = true;
      }
      open = [];
      matches++;
    } else {
      setTimeout(() => {
        for (const index of open) {
          delete buttons[index].dataset.open;
          buttons[index].textContent = '?';
          buttons[index].setAttribute('aria-label', 'Carta ' + (index + 1) + ', boca abajo');
        }
        open = [];
      }, 630);
    }
    status.textContent = matches + ' de 8 parejas · ' + moves + ' intentos';
    if (matches === 8) {
      const seconds = Math.max(1, Math.round((performance.now() - since)/1000));
      finish({ moves, seconds }, 'Ocho parejas en ' + moves + ' intentos y ' + seconds + ' s.');
    }
  }
}

function reflex() {
  const button = document.createElement('button');
  button.id = 'reflex';
  button.textContent = 'Pulsa para empezar';
  stage.append(button);
  const times = [];
  let timer;
  let readyAt;
  let mode = 'idle';
  status.textContent = 'Cinco rondas · Usa Espacio o el ratón cuando cambie el color';
  function show(next, text) { mode = next; button.dataset.mode = next; button.textContent = text; }
  function hit(time) {
    if (finished) return;
    if (mode === 'waiting') {
      clearTimeout(timer);
      show('early', 'Demasiado pronto · Reintentar');
      return;
    }
    if (mode === 'ready') {
      if (time < readyAt) return;
      times.push(Math.max(1, time - readyAt));
      if (times.length >= 5) {
        const result = reflexResult(times);
        show('done', result.median + ' ms');
        finish(result, 'Mediana de ' + result.median + ' ms · Mejor tiempo de ' + result.best + ' ms');
      } else {
        status.textContent = 'Ronda ' + times.length + ' de 5 · ' + Math.round(times.at(-1)) + ' ms';
        show('idle', 'Siguiente ronda');
      }
      return;
    }
    show('waiting', 'Espera…');
    timer = setTimeout(() => {
      requestAnimationFrame(() => {
        if (mode !== 'waiting' || finished) return;
        readyAt = performance.now();
        show('ready', '¡Ahora!');
      });
    }, 1000 + Math.random() * 2200);
  }
  button.addEventListener('click', event => hit(event.timeStamp));
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space') return;
    event.preventDefault();
    if (!event.repeat) hit(event.timeStamp);
  });
  button.focus();
}

bridge.load().then(game => {
  if (!game) { status.textContent = 'No se pudo abrir la partida.'; return; }
  title.textContent = game.label;
  if (game.id === 'pong') return pong(game.lines);
  if (game.id === 'four') connectFour();
  if (game.id === 'pairs') pairs();
  if (game.id === 'reflex') reflex();
}).catch(() => { status.textContent = 'No se pudo preparar el juego.'; });
