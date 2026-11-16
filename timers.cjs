const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function createTimers(file, onRing, onError) {
  let pending = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    pending = raw.filter(timer => typeof timer.id === 'string' &&
      Number.isSafeInteger(timer.due) && Number.isSafeInteger(timer.seconds));
  } catch (error) {
    if (error.code !== 'ENOENT') onError(error);
  }

  let handle;
  function save(next) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(next));
    fs.renameSync(file + '.tmp', file);
    pending = next;
  }

  function schedule(delay) {
    clearTimeout(handle);
    if (pending.length === 0) return;
    const nearest = Math.min(...pending.map(timer => timer.due));
    handle = setTimeout(check, delay ?? Math.max(0, nearest - Date.now()));
  }

  function check() {
    const now = Date.now();
    const expired = pending.filter(timer => timer.due <= now);
    if (expired.length) {
      try {
        save(pending.filter(timer => timer.due > now));
      } catch (error) {
        onError(error);
        schedule(5000);
        return;
      }
      onRing(expired);
    }
    schedule();
  }

  return {
    add(seconds) {
      const timer = { id: randomUUID(), due: Date.now() + seconds * 1000, seconds };
      save([...pending, timer]);
      schedule();
      return timer;
    },
    count() {
      return pending.length;
    },
    remaining() {
      const now = Date.now();
      return pending.map(timer => Math.max(0, Math.ceil((timer.due - now) / 1000)))
        .sort((left, right) => left - right);
    },
    check,
    dispose() {
      clearTimeout(handle);
    }
  };
}

module.exports = { createTimers };
