/**
 * MOYOFY backend/server.js
 * - Guarda tokens del OWNER en Supabase (moyofy_kv)
 * - Re-auth automático si tokens son invalid_grant
 * - No depende de archivos (owner_tokens.json) en Render
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require("express");
const session = require('express-session');
const cors = require("cors");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// ------------------------ SUPABASE ADMIN ------------------------
let supabaseAdmin = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL || null;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    null;

  if (url && serviceKey) {
    supabaseAdmin = createClient(url, serviceKey, { auth: { persistSession: false } });
    console.log('✅ Supabase Admin inicializado');
  } else {
    console.log('⚠️ Supabase no configurado (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
  }
} catch (e) {
  console.log('⚠️ Falta dependencia @supabase/supabase-js en server. V2 endpoints no disponibles hasta instalarla.');
}

// ------------------------ APP ------------------------
const app = express();

// Session (warning MemoryStore es normal; no bloquea)
app.use(session({
  secret: process.env.SESSION_SECRET || 'moyofy_secret_key_2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// CORS
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  process.env.RENDER_EXTERNAL_URL || 'https://moyofy-rafasbar.onrender.com'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permitir llamadas sin origin en dev/herramientas
    if (!origin && process.env.NODE_ENV !== 'production') return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || !origin) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());

// Body + static
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
    originalEnd.apply(res, args);
  };
  next();
});

// JSON malformed handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'JSON mal formado en la solicitud' });
  }
  next();
});

// ------------------------ HELPERS ------------------------
function nowISO() { return new Date().toISOString(); }

function getTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeNickname(nick) {
  return String(nick || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function randomPublicId() {
  const a = Math.random().toString(36).slice(2, 8);
  const b = Date.now().toString(36).slice(-6);
  return `u_${a}${b}`;
}

function requireSupabase(res) {
  if (!supabaseAdmin) {
    res.status(503).json({ ok: false, error: 'Supabase no disponible en el servidor' });
    return false;
  }
  return true;
}

// ------------------------ OWNER TOKENS (SUPABASE KV) ------------------------
async function saveOwnerTokensToSupabase(tokens) {
  if (!supabaseAdmin) return false;

  const { error } = await supabaseAdmin
    .from('moyofy_kv')
    .upsert([{ key: 'owner_tokens', value: tokens, updated_at: nowISO() }], { onConflict: 'key' });

  if (error) {
    console.error('❌ Supabase error guardando owner_tokens:', error);
    return false;
  }

  console.log('✅ OWNER tokens guardados en Supabase (moyofy_kv.owner_tokens)');
  return true;
}

async function loadOwnerTokensFromSupabase() {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from('moyofy_kv')
    .select('value')
    .eq('key', 'owner_tokens')
    .maybeSingle();

  if (error) {
    console.error('❌ Supabase error cargando owner_tokens:', error);
    return null;
  }

  return data?.value || null;
}

async function clearOwnerTokensInSupabase() {
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin
    .from('moyofy_kv')
    .delete()
    .eq('key', 'owner_tokens');

  if (error) {
    console.error('❌ Supabase error borrando owner_tokens:', error);
    return false;
  }
  console.log('🧨 owner_tokens borrados de Supabase (para forzar re-auth)');
  return true;
}

// ------------------------ YOUTUBE CLIENTS ------------------------
let ownerOauth2Client = null;
let ownerYoutube = null;

// User client (solo para /auth si lo usás; NO sirve para insertar a playlist del bar)
const userOauth2Client = new google.auth.OAuth2(
  process.env.OAUTH_CLIENT_ID,
  process.env.OAUTH_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// API KEY: para buscar y leer info pública
const userYoutube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });

async function initializeOwnerClient() {
  try {
    ownerOauth2Client = new google.auth.OAuth2(
      process.env.OAUTH_CLIENT_ID,
      process.env.OAUTH_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );

    // 1) Preferir Supabase
    let tokens = await loadOwnerTokensFromSupabase();

    // 2) Fallback a env var (por si querés usar OWNER_TOKENS_JSON)
    if (!tokens && process.env.OWNER_TOKENS_JSON) {
      try {
        tokens = JSON.parse(process.env.OWNER_TOKENS_JSON);
      } catch (e) {
        console.error('❌ OWNER_TOKENS_JSON inválido (no es JSON):', e?.message || e);
      }
    }

    if (!tokens) {
      console.log('⚠️ Owner tokens no disponibles. Se requiere /owner/auth.');
      ownerYoutube = null;
      return;
    }

    ownerOauth2Client.setCredentials(tokens);

    // Cuando Google rota tokens, este evento dispara y podemos guardar el refresh/access nuevo
    ownerOauth2Client.on('tokens', async (newTokens) => {
      try {
        const merged = { ...tokens, ...newTokens };
        tokens = merged;
        await saveOwnerTokensToSupabase(merged);
      } catch (e) {
        console.error('❌ Error guardando tokens rotados:', e?.message || e);
      }
    });

    ownerYoutube = google.youtube({ version: 'v3', auth: ownerOauth2Client });
    console.log('✅ Cliente de YouTube del propietario inicializado.');
  } catch (e) {
    console.error('❌ Error inicializando cliente owner:', e?.message || e);
    ownerYoutube = null;
  }
}

// Inicializar owner al arranque
initializeOwnerClient();

// ------------------------ CONFIG / V2 ------------------------
app.get('/v2/public-config', (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL || null;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || null;
  const barId = process.env.BAR_ID || process.env.DEFAULT_BAR_ID || 'rafasbar';

  res.json({
    ok: true,
    supabaseUrl,
    supabaseAnonKey,
    barId,
    ownerAuthReady: !!ownerYoutube
  });
});

// ------------------------ BOOTSTRAP / ME / LEADERBOARD / AWARD / GIFT / VOTE ------------------------
// (Tu parte Supabase V2 la dejo igual, con mínimos ajustes, porque esto NO es el problema del invalid_grant)

app.post('/v2/bootstrap', async (req, res) => {
  if (!requireSupabase(res)) return;

  const barId = String(req.body.barId || process.env.BAR_ID || 'rafasbar').trim();
  let nickname = normalizeNickname(req.body.nickname || '');
  const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
  const guest = !!req.body.guest;

  if (!nickname || nickname.length < 3) nickname = guest ? `Invitado${Math.floor(Math.random() * 900 + 100)}` : nickname;
  if (!nickname || nickname.length < 3) return res.status(400).json({ ok: false, error: 'Apodo inválido' });

  try {
    const publicId = randomPublicId();
    const today = getTodayKey();

    const existing = await supabaseAdmin
      .from('moyofy_users')
      .select('*')
      .eq('bar_id', barId)
      .ilike('nickname', nickname)
      .maybeSingle();

    if (existing?.error) {
      console.error('❌ Supabase error in bootstrap(existing):', existing.error);
      return res.status(500).json({ ok: false, error: existing.error.message });
    }

    if (existing && existing.data) {
      return res.json({ ok: true, user: existing.data });
    }

    const insert = await supabaseAdmin
      .from('moyofy_users')
      .insert([{
        bar_id: barId,
        public_id: publicId,
        nickname,
        email,
        points: 100,
        songs_added: 0,
        votes_received: 0,
        gifts_sent_today: 0,
        streak_days: 1,
        streak_last_day: today,
        created_at: nowISO(),
        updated_at: nowISO()
      }])
      .select('*')
      .single();

    if (insert?.error) {
      console.error('❌ Supabase error in bootstrap(insert):', insert.error);
      return res.status(500).json({ ok: false, error: insert.error.message });
    }

    res.json({ ok: true, user: insert.data });

  } catch (e) {
    console.error('❌ Exception in /v2/bootstrap:', e);
    res.status(500).json({ ok: false, error: e?.message || 'Error creando perfil' });
  }
});

app.get('/v2/me', async (req, res) => {
  if (!requireSupabase(res)) return;

  const barId = String(req.query.barId || process.env.BAR_ID || 'rafasbar').trim();
  const publicId = String(req.query.publicId || '').trim();
  if (!publicId) return res.status(400).json({ ok: false, error: 'publicId requerido' });

  try {
    const q = await supabaseAdmin
      .from('moyofy_users')
      .select('*')
      .eq('bar_id', barId)
      .eq('public_id', publicId)
      .single();

    if (q?.error) {
      console.error('❌ Supabase error in /v2/me:', q.error);
      return res.status(404).json({ ok: false, error: q.error.message });
    }

    res.json({ ok: true, user: q.data });
  } catch (e) {
    console.error('❌ Exception in /v2/me:', e);
    res.status(500).json({ ok: false, error: e?.message || 'Error cargando perfil' });
  }
});

app.get('/v2/leaderboard', async (req, res) => {
  if (!requireSupabase(res)) return;

  const barId = String(req.query.barId || process.env.BAR_ID || 'rafasbar').trim();
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

  try {
    const q = await supabaseAdmin
      .from('moyofy_users')
      .select('nickname,points,songs_added,votes_received,public_id')
      .eq('bar_id', barId)
      .order('points', { ascending: false })
      .limit(limit);

    if (q?.error) {
      console.error('❌ Supabase error in /v2/leaderboard:', q.error);
      return res.status(500).json({ ok: false, error: q.error.message });
    }

    res.json({ ok: true, items: q.data || [] });

  } catch (e) {
    console.error('❌ Exception in /v2/leaderboard:', e);
    res.status(500).json({ ok: false, error: e?.message || 'Error cargando ranking' });
  }
});

// ------------------------ OAUTH ROUTES (OWNER) ------------------------

// Ruta para autenticar el OWNER (la cuenta del bar / dueña de la playlist)
app.get('/owner/auth', (req, res) => {
  const redirectUri = process.env.REDIRECT_URI;

  if (!process.env.OAUTH_CLIENT_ID || !process.env.OAUTH_CLIENT_SECRET || !redirectUri) {
    return res.status(500).send('Faltan variables OAuth (OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET / REDIRECT_URI)');
  }

  // Creamos client si aún no existe
  if (!ownerOauth2Client) {
    ownerOauth2Client = new google.auth.OAuth2(
      process.env.OAUTH_CLIENT_ID,
      process.env.OAUTH_CLIENT_SECRET,
      redirectUri
    );
  }

  const url = ownerOauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube'
    ],
    redirect_uri: redirectUri,
    state: 'owner'
  });

  return res.redirect(url);
});

// (Opcional) auth para usuario normal (NO necesario para agregar a playlist del bar)
app.get('/auth', (req, res) => {
  const url = userOauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube'
    ],
    redirect_uri: process.env.REDIRECT_URI
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`<html><body><h1>Error OAuth</h1><p>${String(error)}</p></body></html>`);
  }

  if (!code) {
    return res.status(400).send('<html><body><h1>Error</h1><p>Falta "code" en callback.</p></body></html>');
  }

  // OWNER callback
  if (state === 'owner') {
    try {
      if (!ownerOauth2Client) {
        ownerOauth2Client = new google.auth.OAuth2(
          process.env.OAUTH_CLIENT_ID,
          process.env.OAUTH_CLIENT_SECRET,
          process.env.REDIRECT_URI
        );
      }

      const { tokens } = await ownerOauth2Client.getToken(code);

      // Guardar en Supabase (persistente)
      const saved = await saveOwnerTokensToSupabase(tokens);

      // Reinicializar cliente owner para que ya quede listo
      await initializeOwnerClient();

      return res.send(`
        <html><body style="font-family:Arial;padding:20px">
          <h2>✅ OWNER Autorizado</h2>
          <p>${saved ? 'Tokens guardados en Supabase.' : 'No se pudieron guardar tokens en Supabase (revisa SUPABASE_SERVICE_ROLE_KEY).'}</p>
          <p>Ahora vuelve a MOYOFY e intenta agregar una canción.</p>
          <p>Puedes cerrar esta ventana.</p>
        </body></html>
      `);
    } catch (err) {
      console.error('❌ Error autenticando OWNER:', err?.response?.data || err);
      return res.status(500).send('<html><body><h1>Error OWNER OAuth</h1><p>Revisa logs en Render.</p></body></html>');
    }
  }

  // User callback (opcional)
  try {
    const { tokens } = await userOauth2Client.getToken(code);
    req.session.userTokens = tokens;
    req.session.userAuthenticated = true;
    userOauth2Client.setCredentials(tokens);

    return res.send(`<html><body><h1>Autenticación exitosa</h1><p>Puedes cerrar esta ventana y regresar a MOYOFY.</p></body></html>`);
  } catch (err) {
    console.error('❌ Error en oauth2callback usuario:', err?.response?.data || err);
    return res.status(500).send('<h1>Error en OAuth Callback</h1>');
  }
});

// ------------------------ SEARCH ------------------------
app.post('/search', async (req, res) => {
  const { q } = req.body;

  if (!q || String(q).trim() === '') {
    return res.status(400).json({ ok: false, error: 'La consulta de búsqueda no puede estar vacía' });
  }

  try {
    const response = await userYoutube.search.list({
      part: 'snippet',
      q: q,
      maxResults: 15,
      type: 'video'
    });

    const filteredItems = filterRockMusic(response.data.items || []);

    res.json({
      ok: true,
      items: filteredItems,
      originalQuery: q,
      timestamp: nowISO()
    });

  } catch (error) {
    console.error('❌ Error en /search:', error?.response?.data || error);
    let errorMessage = 'Error al buscar videos en YouTube';
    let statusCode = 500;

    if (error.response?.data?.error?.code === 403) {
      errorMessage = 'Límite de cuota de YouTube API excedido';
      statusCode = 429;
    }

    res.status(statusCode).json({ ok: false, error: errorMessage });
  }
});

// ------------------------ SUGGEST SONG (OWNER REQUIRED) ------------------------
app.post('/suggest-song', async (req, res) => {
  const { videoId } = req.body;
  const defaultPlaylistId = process.env.DEFAULT_PLAYLIST_ID;

  if (!defaultPlaylistId) {
    return res.status(500).json({ ok: false, error: 'DEFAULT_PLAYLIST_ID no configurado en el servidor', requiresOwnerAuth: true });
  }

  if (!videoId) {
    return res.status(400).json({ ok: false, error: 'Video ID es requerido', requiresOwnerAuth: false });
  }

  const videoIdRegex = /^[a-zA-Z0-9_-]{11}$/;
  if (!videoIdRegex.test(videoId)) {
    return res.status(400).json({ ok: false, error: 'Video ID con formato inválido', requiresOwnerAuth: false });
  }

  // Si ownerYoutube no está listo, pedimos auth del owner
  if (!ownerYoutube || !ownerOauth2Client) {
    return res.status(401).json({
      ok: false,
      error: 'OWNER_NOT_AUTHORIZED',
      message: 'Necesitás autorizar la cuenta del bar (OWNER) para poder agregar canciones.',
      requiresOwnerAuth: true,
      ownerAuthUrl: '/owner/auth'
    });
  }

  // 1) Validar video (con API Key)
  try {
    const videoResponse = await userYoutube.videos.list({ part: 'snippet,status', id: videoId });
    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      return res.status(404).json({ ok: false, error: 'Video no encontrado en YouTube', requiresOwnerAuth: false });
    }

    const video = videoResponse.data.items[0];
    if (video.status?.embeddable === false) {
      return res.status(403).json({ ok: false, error: 'Esta canción no se puede agregar a playlists.', requiresOwnerAuth: false });
    }
  } catch (error) {
    console.error('❌ Error validando video:', error?.response?.data || error);
    return res.status(500).json({ ok: false, error: 'Error verificando la canción.', requiresOwnerAuth: false });
  }

  // 2) Insertar a playlist (con OWNER OAuth)
  try {
    const response = await ownerYoutube.playlistItems.insert({
      part: 'snippet',
      resource: {
        snippet: {
          playlistId: defaultPlaylistId,
          resourceId: { kind: 'youtube#video', videoId: videoId }
        }
      }
    });

    return res.status(200).json({
      ok: true,
      message: 'Canción agregada a la playlist.',
      videoId: videoId,
      playlistItemId: response.data.id,
      timestamp: nowISO()
    });

  } catch (error) {
    const payload = error?.response?.data || error;
    console.error('❌ Error insertando en playlist:', payload);

    // Caso típico: invalid_grant = refresh token revocado/expirado
    const isInvalidGrant =
      payload?.error === 'invalid_grant' ||
      payload?.error_description?.includes('expired or revoked') ||
      (payload?.error?.message && String(payload.error.message).includes('invalid_grant'));

    if (isInvalidGrant) {
      console.log('🧨 invalid_grant detectado: tokens del owner expirados/revocados. Limpiando tokens y solicitando re-auth...');
      await clearOwnerTokensInSupabase();
      ownerYoutube = null;
      ownerOauth2Client = null;

      return res.status(401).json({
        ok: false,
        error: 'OWNER_TOKENS_INVALID',
        message: 'La autorización del OWNER expiró o fue revocada. Volvé a autorizar.',
        requiresOwnerAuth: true,
        ownerAuthUrl: '/owner/auth'
      });
    }

    // 401 genérico
    if (error.code === 401 || error.response?.status === 401) {
      return res.status(401).json({
        ok: false,
        error: 'OWNER_UNAUTHORIZED',
        message: 'Owner no autorizado. Volvé a autorizar.',
        requiresOwnerAuth: true,
        ownerAuthUrl: '/owner/auth'
      });
    }

    // 403 (permisos)
    if (error.response?.status === 403) {
      return res.status(403).json({
        ok: false,
        error: 'YOUTUBE_ACCESS_DENIED',
        message: 'Acceso denegado. Revisá permisos de playlist/canal.',
        requiresOwnerAuth: false
      });
    }

    return res.status(500).json({ ok: false, error: 'Error al agregar canción', requiresOwnerAuth: false });
  }
});

// ------------------------ HEALTH ------------------------
app.get('/health', async (req, res) => {
  let ownerTokensPresent = false;
  try {
    const t = await loadOwnerTokensFromSupabase();
    ownerTokensPresent = !!t;
  } catch (_) {}

  res.json({
    ok: true,
    service: 'MOYOFY API',
    timestamp: nowISO(),
    environment: process.env.NODE_ENV || 'development',
    supabase: supabaseAdmin ? '✅ Configured' : '⚠️ Not configured',
    youtubeApi: process.env.YOUTUBE_API_KEY ? '✅ Configured' : '❌ Not Configured',
    playlist: process.env.DEFAULT_PLAYLIST_ID ? '✅ Configured' : '❌ Not Configured',
    ownerTokensInSupabase: ownerTokensPresent ? '✅ Present' : '❌ Missing',
    ownerClientReady: ownerYoutube ? '✅ Ready' : '❌ Not ready (needs /owner/auth)'
  });
});

// ------------------------ STATIC ------------------------
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, '../public/index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).send('index.html no encontrado');
});

app.get('*', (req, res) => {
  const filePath = path.join(__dirname, '../public', req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return res.sendFile(filePath);
  return res.redirect('/');
});

// ------------------------ FILTER ------------------------
function filterRockMusic(items) {
  if (!items || !Array.isArray(items)) return [];

  const rockKeywords = [
    'rock', 'metal', 'punk', 'grunge', 'alternative', 'indie', 'hard rock',
    'classic rock', 'heavy metal', 'thrash', 'emo', 'gothic', 'industrial'
  ];

  const excludedKeywords = [
    'reggaeton', 'trap', 'hip hop', 'rap', 'pop', 'reggae', 'salsa',
    'bachata', 'cumbia', 'balada', 'ranchera', 'k-pop', 'j-pop'
  ];

  const allowedArtists = [
    'queen', 'metallica', 'led zeppelin', 'ac/dc', 'guns n roses', 'nirvana',
    'foo fighters', 'the beatles', 'rolling stones', 'black sabbath', 'iron maiden',
    'judas priest', 'motorhead', 'slayer', 'pantera', 'megadeth', 'soundgarden',
    'pearl jam', 'red hot chili peppers', 'the who', 'deep purple', 'aerosmith',
    'van halen', 'kiss', 'ozzy osbourne', 'rush', 'cream', 'jimi hendrix',
    'the doors', 'pink floyd', 'the clash', 'ramones', 'sex pistols', 'the cure',
    'joy division', 'radiohead', 'muse', 'system of a down', 'tool', 'rage against the machine'
  ];

  return items.filter(item => {
    if (!item.snippet || !item.snippet.title || !item.snippet.channelTitle) return false;

    const title = item.snippet.title.toLowerCase();
    const channel = item.snippet.channelTitle.toLowerCase();
    const description = item.snippet.description ? item.snippet.description.toLowerCase() : '';

    const isAllowedArtist = allowedArtists.some(artist => channel.includes(artist) || title.includes(artist));
    if (isAllowedArtist) return true;

    const hasRockKeyword = rockKeywords.some(keyword =>
      title.includes(keyword) || channel.includes(keyword) || description.includes(keyword)
    );

    const hasExcludedKeyword = excludedKeywords.some(keyword =>
      title.includes(keyword) || channel.includes(keyword) || description.includes(keyword)
    );

    return hasRockKeyword && !hasExcludedKeyword;
  });
}

// ------------------------ START ------------------------
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

function checkConfiguration() {
  const requiredVars = [
    'YOUTUBE_API_KEY',
    'OAUTH_CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    'REDIRECT_URI',
    'DEFAULT_PLAYLIST_ID'
  ];

  const missing = requiredVars.filter(v => !process.env[v]);

  if (missing.length > 0) console.log(`⚠️ Faltan variables requeridas: ${missing.join(', ')}`);
  else console.log('✅ Variables requeridas OK');

  const supa = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;
  console.log(`ℹ️ Supabase KV tokens: ${supa ? '✅ Disponible' : '⚠️ No disponible (no guardará tokens OWNER)'}`);
}

app.listen(PORT, HOST, () => {
  console.log(`🎸 MOYOFY API iniciado en http://${HOST}:${PORT} · ${nowISO()}`);
  checkConfiguration();
});
