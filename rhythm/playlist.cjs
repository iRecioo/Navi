const playlistUrl = 'https://open.spotify.com/playlist/669TbjBUhtIdbK1WazNXmh';
const embedUrl = playlistUrl.replace('/playlist/', '/embed/playlist/');
const playlistUri = 'spotify:playlist:' + playlistUrl.split('/').at(-1);
const field = text => String(text ?? '').replace(/\s+/gu, ' ').trim();
const key = text => field(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const artistKeys = artist => artist.split(/[;,&]/u).map(key).filter(Boolean);

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        i++;
        cell += '"';
      } else if (quoted || !cell.length) quoted = !quoted;
      else cell += character;
    } else if (!quoted && (character === delimiter || character === '\n')) {
      row.push(field(cell));
      cell = '';
      if (character === '\n') { rows.push(row); row = []; }
    } else cell += character;
  }
  if (quoted) throw new Error('Hay comillas sin cerrar en el CSV.');
  row.push(field(cell));
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function parsePlaylist(text) {
  text = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const titles = new Set(['track name', 'song name', 'song', 'track', 'title', 'name', 'titulo', 'cancion']);
  const artists = new Set(['artist name s', 'artist name', 'artist names', 'artist', 'artists', 'artista', 'artistas']);
  for (const delimiter of [',', ';', '\t']) {
    const [header, ...rows] = parseCsv(text.trimStart(), delimiter);
    if (!header) continue;
    const titleIndex = header.findIndex(name => titles.has(key(name)));
    const artistIndex = header.findIndex(name => artists.has(key(name)));
    if (titleIndex < 0) continue;
    const tracks = rows.map(row => ({ title: field(row[titleIndex]), artist: field(row[artistIndex]) }))
      .filter(track => track.title && track.title.length <= 300 && track.artist.length <= 300);
    if (tracks.length) {
      return [...new Map(tracks.map(track => [JSON.stringify([key(track.title), key(track.artist)]), track])).values()];
    }
  }
  throw new Error('El CSV necesita una columna de título, por ejemplo Track Name.');
}

function matchPlaylist(tracks, songs) {
  const byTitle = new Map();
  for (const song of songs) {
    const title = key(song.title);
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(song);
  }
  const counts = new Map();
  for (const track of tracks) counts.set(key(track.title), (counts.get(key(track.title)) || 0) + 1);
  const matches = new Map();
  for (const track of tracks) {
    const title = key(track.title);
    const potential = byTitle.get(title) || [];
    const uploadedArtists = artistKeys(track.artist);
    const artist = key(track.artist);
    const song = potential.find(local => {
      const localArtist = key(local.artist);
      return localArtist ? !artist || localArtist === artist || artistKeys(local.artist).some(name => uploadedArtists.includes(name))
        : counts.get(title) === 1 && potential.length === 1;
    });
    if (song) matches.set(song.file, { ...song, title: track.title, artist: track.artist || song.artist });
  }
  return [...matches.values()];
}

function readScript(html, id) {
  const expression = new RegExp('<script\\b[^>]*\\bid\\s*=\\s*["\']' + id + '["\'][^>]*>([\\s\\S]*?)<\\/script>', 'iu');
  return expression.exec(html)?.[1];
}

function parsePublicPlaylist(html) {
  const embed = readScript(html, '__NEXT_DATA__');
  const web = readScript(html, 'initialState');
  const data = embed ? JSON.parse(embed) : null;
  const state = web ? JSON.parse(Buffer.from(web.trim(), 'base64').toString('utf8')) : null;
  const entity = data?.props?.pageProps?.state?.data?.entity;
  const publicPlaylist = state?.entities?.items?.[playlistUri];
  const items = entity?.type === 'playlist' && (!entity.uri || entity.uri === playlistUri) && Array.isArray(entity.trackList)
    ? entity.trackList : (publicPlaylist?.content?.items || []).map(row => {
        const track = row.itemV2?.data;
        return { uri: track?.uri, title: track?.name, duration: track?.duration?.totalMilliseconds,
          subtitle: track?.artists?.items?.map(item => item.profile?.name).filter(Boolean).join(', ') };
      });
  const tracks = [];
  for (const item of items) {
    if (!/^spotify:track:[a-z0-9]+$/iu.test(item?.uri) || typeof item.title !== 'string') continue;
    const title = field(item.title);
    const artist = typeof item.subtitle === 'string' ? field(item.subtitle) : '';
    if (title && title.length <= 300 && artist.length <= 300) {
      const { uri, duration } = item;
      tracks.push({ title, artist, uri, ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}) });
    }
  }
  return tracks;
}

async function readPublicPlaylist(fetchPage = fetch) {
  for (const url of [embedUrl, playlistUrl]) {
    try {
      const response = await fetchPage(url, { signal: AbortSignal.timeout(4000), redirect: 'error',
        headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' } });
      if (!response.ok) continue;
      const page = await response.text();
      if (page.length > 4_000_000) continue;
      const tracks = parsePublicPlaylist(page);
      if (tracks.length) return tracks;
    } catch { /* Spotify may publish either page layout. */ }
  }
  return [];
}

module.exports = { playlistKey: key, parsePlaylist, matchPlaylist, playlistUrl, playlistUri, readPublicPlaylist, parsePublicPlaylist };
