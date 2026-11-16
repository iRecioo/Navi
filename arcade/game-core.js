(() => {
  const COLS = 7;
  const ROWS = 6;
  const CONNECT = 4;
  const field = { width: 720, height: 384, paddle: 84, thickness: 12, radius: 7, inset: 24 };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function pingResult(player, navi) {
    if (!Number.isInteger(player) || !Number.isInteger(navi) || player < 0 || navi < 0) return null;
    if (player === 6 && navi <= 5) return 'player';
    if (navi === 6 && player <= 5) return 'navi';
    return null;
  }

  function createPong(random = Math.random) {
    const state = { player: field.height / 2, navi: field.height / 2, score: [0, 0], ball: {},
      serve: 0, rally: 0, winner: null, delay: 1.6 };
    let target = state.navi;
    let decision = 0;
    let towardNavi = random() >= .5;
    function reset() {
      state.ball = { x: field.width / 2, y: field.height / 2, vx: 0, vy: 0 };
      state.rally = 0;
      decision = 0;
      target = field.height / 2;
    }
    reset();

    const limit = center => clamp(center, field.paddle / 2, field.height - field.paddle / 2);
    function hit(paddle, right) {
      const { ball } = state;
      state.rally++;
      const speed = Math.min(730, 300 + state.rally * 38);
      const angle = clamp((ball.y - paddle) / (field.paddle / 2), -1, 1) * 1.04;
      ball.vx = Math.cos(angle) * speed * (right ? -1 : 1);
      ball.vy = Math.sin(angle) * speed;
    }
    function point(side) {
      state.score[side]++;
      state.winner = pingResult(...state.score);
      state.delay = state.winner ? 0 : 1.65;
      towardNavi = side === 0;
      reset();
      return { side: side === 0 ? 'player' : 'navi', winner: state.winner, score: [...state.score] };
    }

    function step(dt, input) {
      if (state.winner) return null;
      if (Number.isFinite(input.pointer)) state.player = limit(input.pointer);
      else state.player = limit(state.player + input.direction * 420 * dt);
      const { ball } = state;
      if (state.delay > 0) {
        state.delay = Math.max(0, state.delay - dt);
        if (state.delay) return null;
        state.serve++;
        ball.vx = towardNavi ? 280 : -280;
        ball.vy = (random() < .5 ? -1 : 1) * (85 + random() * 75);
      }
      if (ball.vx > 0 && (decision -= dt) <= 0) {
        decision = .15 + random() * .06;
        const right = field.width - field.inset - field.thickness - field.radius;
        const predicted = ball.y + ball.vy * Math.max(0, (right - ball.x) / ball.vx);
        const height = field.height - field.radius * 2;
        const wrap = ((predicted - field.radius) % (height * 2) + height * 2) % (height * 2);
        target = limit(field.radius + Math.min(wrap, height * 2 - wrap) + (random() - .5) * 68);
      } else if (ball.vx < 0) target = field.height / 2;
      const pace = Math.min(305, 224 + state.score[0] * 13);
      state.navi = limit(state.navi + clamp(target - state.navi, -pace * dt, pace * dt));

      const previous = ball.x;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (ball.y < field.radius || ball.y > field.height - field.radius) {
        const wall = ball.y < field.radius ? field.radius : field.height - field.radius;
        ball.y = wall * 2 - ball.y;
        ball.vy *= -1;
      }
      const left = field.inset + field.thickness + field.radius;
      const right = field.width - left;
      if (ball.vx < 0 && previous >= left && ball.x <= left && Math.abs(ball.y - state.player) <= field.paddle / 2 + field.radius) {
        ball.x = left;
        hit(state.player, false);
      } else if (ball.vx > 0 && previous <= right && ball.x >= right && Math.abs(ball.y - state.navi) <= field.paddle / 2 + field.radius) {
        ball.x = right;
        hit(state.navi, true);
      } else if (ball.x < -field.radius) return point(1);
      else if (ball.x > field.width + field.radius) return point(0);
      return null;
    }
    return { state, step };
  }

  function emptyBoard() {
    return Array.from({ length: COLS }, () => []);
  }

  function moved(board, column, piece) {
    if (!board[column] || board[column].length >= ROWS) return null;
    const next = board.slice();
    next[column] = [...next[column], piece];
    return next;
  }

  function winningLine(board, column, row) {
    const piece = board[column]?.[row];
    if (!piece) return null;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const line = [[column, row]];
      for (const sign of [-1, 1]) {
        for (let distance = 1; distance < CONNECT; distance++) {
          const x = column + dx * distance * sign;
          const y = row + dy * distance * sign;
          if (board[x]?.[y] !== piece) break;
          line.push([x, y]);
        }
      }
      if (line.length >= CONNECT) return line;
    }
    return null;
  }

  function fourMove(board, random = Math.random) {
    const free = board.map((cells, column) => cells.length < ROWS ? column : -1).filter(column => column >= 0);
    if (!free.length) return null;
    const winning = (position, columns, piece) => columns.find(column => winningLine(moved(position, column, piece), column, position[column].length));
    const win = winning(board, free, 2);
    if (win !== undefined) return win;
    const block = winning(board, free, 1);
    if (block !== undefined) return block;
    let chosen;
    let best = -Infinity;
    for (const column of free) {
      const next = moved(board, column, 2);
      const possible = free.filter(c => next[c].length < ROWS);
      const allowsWin = winning(next, possible, 1) !== undefined;
      let traps = 0;
      for (const c of possible) {
        if (winningLine(moved(next, c, 2), c, next[c].length)) traps++;
      }
      const score = (3 - Math.abs(column - 3)) * .38 + traps * 1.1 + random() * .4 - Number(allowsWin) * 20;
      if (score > best) { best = score; chosen = column; }
    }
    return chosen;
  }

  function pairDeck(random = Math.random) {
    const cards = Array.from({ length: 16 }, (_, i) => i % 8);
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  function reflexResult(times) {
    const sorted = [...times].sort((a, b) => a - b);
    return { median: Math.round(sorted[Math.floor(sorted.length / 2)]), best: Math.round(sorted[0]) };
  }

  const api = { field, createPong, pingResult, COLS, ROWS, emptyBoard, moved, winningLine, fourMove, pairDeck, reflexResult };
  if (typeof module === 'object') module.exports = api;
  else globalThis.NaviArcade = api;
})();
