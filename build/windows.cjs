const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createReadStream, existsSync } = require('node:fs');
const { readFile, rm, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const { version, repository } = require('../package.json');
const output = path.join(project, 'dist');
const appUpdateFile = 'app-update.yml';
const artifactName = 'Navi-Setup-' + version + '.exe';

function releaseRepository() {
  let origin;
  try {
    origin = execFileSync('git', ['remote', 'get-url', 'origin'],
      { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* The project can also be compiled from a ZIP. */ }
  const npmRepository = typeof repository === 'string' ? repository : repository?.url;
  const value = (process.env.NAVI_RELEASE_REPO || origin || npmRepository || '').trim();
  const match = /^(?:(?:git\+)?https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/|github:)?([\w-]+)\/([\w.-]+?)\/?$/u.exec(value);
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error('Configura origin en GitHub o define NAVI_RELEASE_REPO como propietario/repositorio.');
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/u, '');
  if (!repo || repo === '.' || repo === '..') throw new Error('El nombre del repositorio de releases no es válido.');
  return { provider: 'github', owner, repo, private: false, releaseType: 'release' };
}

function buildConfig(publish) {
  return {
    appId: 'com.irecioo.navi',
    productName: 'Navi',
    directories: { output, buildResources: 'build' },
    artifactName: 'Navi-Setup-${version}.${ext}',
    asarUnpack: ['rhythm/native/**'],
    files: [
      '*.cjs', '*.html', '*.css', '*.js', 'package.json', 'assets/**', 'vendor/**', 'arcade/**', 'rhythm/**',
      '!preparar-voz.cjs', '!openai-config.cjs', '!**/.env*', '!**/*.pem', '!**/*.pfx', '!**/.git/**'
    ],
    extraResources: [{
      from: 'local-voice', to: 'local-voice',
      filter: ['**/*', '!**/.env*', '!**/*.pem', '!**/*.pfx']
    }],
    win: { icon: 'assets/navi.ico', target: 'nsis' },
    nsis: { oneClick: true, perMachine: false, runAfterFinish: true, differentialPackage: true },
    publish,
    // Keep the feed embedded even when artifact publishing is explicitly disabled.
    afterPack: async ({ appOutDir }) => {
      const file = path.join(appOutDir, 'resources', appUpdateFile);
      if (!existsSync(file)) {
        await writeFile(file, [
          'provider: github', 'owner: ' + JSON.stringify(publish.owner),
          'repo: ' + JSON.stringify(publish.repo), 'private: false', 'updaterCacheDirName: navi-updater', ''
        ].join('\n'));
      }
    }
  };
}

async function ensureReleaseManifest() {
  const installer = path.join(output, artifactName);
  const [{ size }] = await Promise.all([stat(installer), stat(installer + '.blockmap')]);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  const sha512 = hash.digest('base64');
  const manifestPath = path.join(output, 'latest.yml');
  const manifest = await readFile(manifestPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const manifestVersion = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/mu.exec(manifest)?.[1];
  if (manifestVersion === version && manifest.includes(artifactName) && manifest.includes(sha512)) return;
  await writeFile(manifestPath, [
    'version: ' + JSON.stringify(version), 'files:', '  - url: ' + artifactName,
    '    sha512: ' + sha512, '    size: ' + size, 'path: ' + artifactName,
    'sha512: ' + sha512, 'releaseDate: ' + JSON.stringify(new Date().toISOString()), ''
  ].join('\n'));
}

async function run() {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Usa una versión estable X.Y.Z para las releases de Navi.');
  const publish = releaseRepository();
  if (!existsSync(path.join(project, 'vendor', 'vosk-es-0.42.tar.gz')) || !existsSync(path.join(project, 'local-voice', 'tts-server.exe'))) {
    throw new Error('Extrae el parche en tu carpeta completa de Navi. Faltan el modelo de activación o el motor de voz.');
  }
  const { build, Platform, Arch } = require('electron-builder');
  const installer = path.join(output, artifactName);
  await Promise.all([installer, installer + '.blockmap', path.join(output, 'latest.yml')].map(file => rm(file, { force: true })));
  await build({
    projectDir: project,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: buildConfig(publish)
  });
  await ensureReleaseManifest();
  console.log('GitHub Releases de ' + publish.owner + '/' + publish.repo + '\n'
    + 'dist/' + artifactName + '\n'
    + 'dist/' + artifactName + '.blockmap\n'
    + 'dist/latest.yml');
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { releaseRepository, buildConfig, ensureReleaseManifest };
