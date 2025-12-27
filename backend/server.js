const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
require('dotenv').config();

class LruTtlCache {
  constructor({ max = 500, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  _now() {
    return Date.now();
  }

  _isExpired(entry) {
    return entry.expiresAt <= this._now();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this._isExpired(entry)) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    const expiresAt = this._now() + (Number.isFinite(ttlMs) ? ttlMs : this.ttlMs);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt });
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }
}

class TokenBucket {
  constructor({ capacity = 3, refillPerMs = 1 / 4000 } = {}) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.buckets = new Map();
  }

  take(id, tokens = 1) {
    const now = Date.now();
    const b = this.buckets.get(id) || { tokens: this.capacity, last: now };
    const elapsed = now - b.last;
    const refill = elapsed * this.refillPerMs;
    b.tokens = Math.min(this.capacity, b.tokens + refill);
    b.last = now;
    if (b.tokens < tokens) {
      this.buckets.set(id, b);
      return false;
    }
    b.tokens -= tokens;
    this.buckets.set(id, b);
    return true;
  }
}

const normalizeQuery = (q) => String(q || '').trim().replace(/\s+/g, ' ').toLowerCase();

const redactKeyFromUrl = (url) => {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/([?&]key=)[^&]+/i, '$1REDACTED');
};

const safeErrorForLog = (err) => {
  try {
    const o = {};
    if (err?.message) o.message = err.message;
    if (err?.code) o.code = err.code;
    if (err?.errors) o.errors = err.errors;
    if (err?.response?.status) o.status = err.response.status;
    if (err?.response?.data) o.data = err.response.data;
    const url = err?.config?.url || err?.response?.config?.url;
    if (url) o.url = redactKeyFromUrl(url);
    return o;
  } catch {
    return { message: String(err) };
  }
};

const searchCache = new LruTtlCache({
  max: Number(process.env.SEARCH_CACHE_MAX || 800),
  ttlMs: Number(process.env.SEARCH_CACHE_TTL_MS || 6 * 60 * 60 * 1000)
});

const searchInflight = new Map();

const searchRateLimiter = new TokenBucket({
  capacity: Number(process.env.SEARCH_RL_BURST || 3),
  refillPerMs: 1 / Number(process.env.SEARCH_RL_MS_PER_REQ || 4000)
});

let quotaBlockedUntil = 0;
const isQuotaBlocked = () => Date.now() < quotaBlockedUntil;
const blockQuotaForMs = (ms) => {
  quotaBlockedUntil = Math.max(quotaBlockedUntil, Date.now() + ms);
};

const app = express();

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);

app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

const tokensPath = path.join(__dirname, 'tokens.json');

const readTokensFromEnvOrFile = () => {
  const raw = process.env.OWNER_TOKENS_JSON;
  if (raw && String(raw).trim().length > 0) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('❌ OWNER_TOKENS_JSON no es JSON válido');
    }
  }
  if (fs.existsSync(tokensPath)) {
    try {
      const fileRaw = fs.readFileSync(tokensPath, 'utf-8');
      return JSON.parse(fileRaw);
    } catch (e) {
      console.error('❌ tokens.json no es JSON válido');
    }
  }
  return null;
};

const writeTokensToFileIfPossible = (tokens) => {
  try {
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    return true;
  } catch {
    return false;
  }
};

const oauth2Client = new google.auth.OAuth2(
  process.env.OAUTH_CLIENT_ID,
  process.env.OAUTH_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const bootstrapTokens = () => {
  const tokens = readTokensFromEnvOrFile();
  if (tokens) {
    oauth2Client.setCredentials(tokens);
    return true;
  }
  return false;
};

bootstrapTokens();

oauth2Client.on('tokens', (tokens) => {
  const current = readTokensFromEnvOrFile() || {};
  const merged = { ...current, ...tokens };
  writeTokensToFileIfPossible(merged);
});

const userYoutube = google.youtube({ version: 'v3' });

app.get('/auth', (req, res) => {
  if (!process.env.OAUTH_CLIENT_ID || !process.env.OAUTH_CLIENT_SECRET || !process.env.REDIRECT_URI) {
    return res.status(500).send('Faltan variables de OAuth en el entorno.');
  }

  const scopes = ['https://www.googleapis.com/auth/youtube.force-ssl'];

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });

  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Falta el code en callback.');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    writeTokensToFileIfPossible(tokens);
    res.redirect('/');
  } catch (err) {
    console.error('❌ Error OAuth callback:', safeErrorForLog(err));
    res.status(500).send('Error en OAuth callback.');
  }
});

app.post('/search', async (req, res) => {
  const startTime = Date.now();
  const qRaw = req?.body?.q ?? req?.body?.query ?? '';
  const q = String(qRaw).trim();
  console.log(`🔍 Búsqueda recibida: "${q}"`);

  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Falta YOUTUBE_API_KEY en el entorno (Render).' });
  }

  if (q.length < 3) {
    return res.status(400).json({ ok: false, error: 'Escribe al menos 3 caracteres para buscar.' });
  }

  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown').trim();
  const nq = normalizeQuery(q);
  const cacheKey = `ytsearch:v1:${nq}`;

  const cached = searchCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cache: { hit: true } });
  }

  if (!searchRateLimiter.take(ip, 1)) {
    return res.status(429).json({ ok: false, error: 'Demasiadas búsquedas. Espera unos segundos e intenta de nuevo.' });
  }

  if (isQuotaBlocked()) {
    return res.status(429).json({ ok: false, error: 'Cuota de búsqueda de YouTube agotada temporalmente. Intenta más tarde.', quotaBlocked: true });
  }

  if (searchInflight.has(cacheKey)) {
    try {
      const shared = await searchInflight.get(cacheKey);
      return res.json({ ...shared, cache: { hit: false, shared: true } });
    } catch (e) {
      searchInflight.delete(cacheKey);
    }
  }

  const task = (async () => {
    const searchResponse = await userYoutube.search.list({
      key: process.env.YOUTUBE_API_KEY,
      part: 'snippet',
      q,
      maxResults: 25,
      type: 'video',
      safeSearch: 'moderate'
    });

    const items = Array.isArray(searchResponse?.data?.items) ? searchResponse.data.items : [];
    const rockItems = filterRockMusic(items);

    const filterStats = {
      totalOriginal: items.length,
      afterRockFilter: rockItems.length,
      query: q,
      durationMs: Date.now() - startTime
    };

    return { ok: true, items: rockItems, filterStats };
  })();

  searchInflight.set(cacheKey, task);

  try {
    const payload = await task;
    searchCache.set(cacheKey, payload);
    return res.json({ ...payload, cache: { hit: false } });
  } catch (error) {
    const status = error?.response?.status;
    const reason = error?.response?.data?.error?.errors?.[0]?.reason;
    const msg = error?.response?.data?.error?.message || error?.message || 'Error desconocido';

    console.error('❌ Error en /search:', safeErrorForLog(error));

    if (status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'userRateLimitExceeded')) {
      blockQuotaForMs(Number(process.env.SEARCH_QUOTA_BLOCK_MS || 30 * 60 * 1000));
      return res.status(429).json({ ok: false, error: 'Cuota de búsquedas agotada. Resultados no disponibles temporalmente.', quotaExceeded: true });
    }

    return res.status(500).json({ ok: false, error: msg });
  } finally {
    searchInflight.delete(cacheKey);
  }
});

app.post('/suggest-song', async (req, res) => {
  const playlistId = req.body.playlistId || process.env.DEFAULT_PLAYLIST_ID;
  const videoId = req.body.videoId;

  if (!playlistId) return res.status(400).json({ ok: false, error: 'Falta playlistId (DEFAULT_PLAYLIST_ID).' });
  if (!videoId) return res.status(400).json({ ok: false, error: 'Falta videoId.' });

  const hasTokens = bootstrapTokens();
  if (!hasTokens) return res.status(401).json({ ok: false, error: 'No hay tokens OAuth configurados. Ve a /auth.' });

  try {
    const authYoutube = google.youtube({ version: 'v3', auth: oauth2Client });

    const details = await authYoutube.videos.list({
      part: 'contentDetails,snippet',
      id: videoId
    });

    const v = details?.data?.items?.[0];
    if (!v) return res.status(404).json({ ok: false, error: 'Video no encontrado.' });

    const durationIso = v.contentDetails?.duration || '';
    const durationSeconds = isoDurationToSeconds(durationIso);

    const maxSeconds = Number(process.env.MAX_SONG_SECONDS || 420);
    if (durationSeconds > maxSeconds) {
      return res.status(400).json({
        ok: false,
        error: `Esta canción supera el límite permitido (${Math.floor(maxSeconds / 60)} min).`,
        durationSeconds
      });
    }

    await authYoutube.playlistItems.insert({
      part: 'snippet',
      requestBody: {
        snippet: {
          playlistId,
          resourceId: {
            kind: 'youtube#video',
            videoId
          }
        }
      }
    });

    return res.json({ ok: true, playlistId, videoId });
  } catch (err) {
    console.error('❌ Error en /suggest-song:', safeErrorForLog(err));
    return res.status(500).json({ ok: false, error: 'Error al agregar la canción.' });
  }
});

app.get('/user/profile', async (req, res) => {
  const hasTokens = bootstrapTokens();
  if (!hasTokens) return res.status(401).json({ ok: false, error: 'No hay tokens OAuth configurados. Ve a /auth.' });

  try {
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const me = await oauth2.userinfo.get();
    return res.json({ ok: true, user: me.data });
  } catch (err) {
    console.error('❌ Error en /user/profile:', safeErrorForLog(err));
    return res.status(500).json({ ok: false, error: 'No se pudo obtener el perfil.' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    env: {
      hasApiKey: Boolean(process.env.YOUTUBE_API_KEY),
      hasOAuth: Boolean(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET && process.env.REDIRECT_URI),
      hasTokens: Boolean(readTokensFromEnvOrFile())
    },
    cache: {
      quotaBlocked: isQuotaBlocked()
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ MOYOFY backend escuchando en puerto ${PORT}`);
});

function isoDurationToSeconds(iso) {
  const s = String(iso || '');
  const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const mi = parseInt(m[2] || '0', 10);
  const se = parseInt(m[3] || '0', 10);
  return h * 3600 + mi * 60 + se;
}

function normalizeText(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function filterRockMusic(items) {
  if (!Array.isArray(items)) return [];

  const allowedArtists = [
    'metallica', 'megadeth', 'slayer', 'pantera', 'tool', 'a perfect circle', 'puscifer', 'nirvana', 'alice in chains',
    'pearl jam', 'soundgarden', 'audioslave', 'rage against the machine', 'foo fighters', 'red hot chili peppers',
    'linkin park', 'system of a down', 'korn', 'deftones', 'limp bizkit', 'evanescence', 'paramore', 'muse',
    'radiohead', 'green day', 'blink-182', 'the offspring', 'sum 41', 'my chemical romance', 'fall out boy',
    'arctic monkeys', 'the strokes', 'kings of leon', 'queens of the stone age', 'black sabbath', 'ozzy osbourne',
    'led zeppelin', 'pink floyd', 'deep purple', 'the rolling stones', 'the doors', 'queen', 'ac/dc', 'aerosmith',
    'guns n roses', 'bon jovi', 'journey', 'boston', 'foreigner', 'scorpions', 'iron maiden', 'judas priest',
    'dio', 'motley crue', 'def leppard', 'van halen', 'kiss'
  ];

  const bannedKeywords = [
    'reggaeton', 'trap', 'corridos', 'banda', 'cumbia', 'salsa', 'bachata', 'merengue', 'mariachi', 'vallenato',
    'dembow', 'urbano', 'perreo', 'tiraera'
  ];

  const allowedSet = new Set(allowedArtists.map(normalizeText));
  const bannedSet = new Set(bannedKeywords.map(normalizeText));

  const out = [];

  for (const it of items) {
    const title = normalizeText(it?.snippet?.title || '');
    const channel = normalizeText(it?.snippet?.channelTitle || '');
    const combined = `${title} ${channel}`;

    let isBanned = false;
    for (const kw of bannedSet) {
      if (kw && combined.includes(kw)) {
        isBanned = true;
        break;
      }
    }
    if (isBanned) continue;

    let isAllowed = false;
    for (const a of allowedSet) {
      if (a && combined.includes(a)) {
        isAllowed = true;
        break;
      }
    }

    if (!isAllowed) continue;

    out.push(it);
  }

  return out;
}
