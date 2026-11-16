const { join } = require('node:path');
const { createLocalVoice } = require('./local-voice.cjs');

async function main() {
  const replies = process.argv.slice(2).map(text => text.trim()).filter(Boolean);
  if (!replies.length || replies.some(text => text.length > 2000)) {
    throw Error('Uso: node preparar-voz.cjs "Vale, te aviso en 5 minutos." "Vale, te aviso en 10 minutos."');
  }
  if (process.platform !== 'win32' || !process.env.APPDATA) {
    throw Error('Ejecuta este comando en Windows, en la carpeta de Navi.');
  }

  const resources = join(__dirname, 'local-voice');
  const output = join(resources, 'replies');
  let voice;
  try {
    await new Promise((resolve, reject) => {
      voice = createLocalVoice({
        resources, cache: join(process.env.APPDATA, 'Navi', 'voice-models'), speechCache: output,
        onStatus: state => {
          if (state === 'ready') resolve();
          if (state === 'error') reject(Error('No se ha podido cargar el motor de voz.'));
        }
      });
      voice.start();
    });
    const { signal } = new AbortController();
    for (const reply of new Set(replies)) {
      const result = await voice.synthesize(reply, signal, { waitForCache: true });
      if (!result) throw Error('No se ha podido generar «' + reply + '».');
      console.log((result.cached ? 'Ya preparada: ' : 'Preparada: ') + reply);
    }
    console.log('Incluye esta carpeta en el instalador: ' + output);
  } finally {
    voice?.stop();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
