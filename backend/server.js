require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require("express");
const session = require('express-session');
const cors = require("cors");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

let supabaseAdmin = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL || null;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || null;
  if (url && serviceKey) {
    supabaseAdmin = createClient(url, serviceKey, { auth: { persistSession: false } });
    console.log('✅ Supabase Admin inicializado');
  } else {
    console.log('⚠️ Supabase no configurado (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). V2 endpoints limitados.');
  }
} catch (e) {
  console.log('⚠️ Falta dependencia @supabase/supabase-js en server. V2 endpoints no disponibles hasta instalarla.');
}

const app = express();

app.use(session({
  secret: process.env.SESSION_SECRET || 'moyofy_secret_key_2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  process.env.RENDER_EXTERNAL_URL || 'https://moyofy-rafasbar.onrender.com'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin && process.env.NODE_ENV === 'development') return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

let ownerOauth2Client = null;
let ownerYoutube = null;

function initializeOwnerClient() {
  if (!process.env.OWNER_TOKENS_JSON) {
    console.error('❌ OWNER_TOKENS_JSON no configurado. No se puede inicializar el cliente del propietario.');
    return;
  }
  try {
    const tokens = JSON.parse(process.env.OWNER_TOKENS_JSON);
    ownerOauth2Client = new google.auth.OAuth2(
      process.env.OAUTH_CLIENT_ID,
      process.env.OAUTH_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
    ownerOauth2Client.setCredentials(tokens);
    ownerOauth2Client.on('tokens', () => {});
    ownerYoutube = google.youtube({ version: 'v3', auth: ownerOauth2Client });
    console.log('✅ Cliente de YouTube del propietario inicializado.');
  } catch (error) {
    console.error('❌ Error inicializando cliente del propietario:', error.message);
  }
}

initializeOwnerClient();

const userOauth2Client = new google.auth.OAuth2(
  process.env.OAUTH_CLIENT_ID,
  process.env.OAUTH_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const userYoutube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });

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

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'JSON mal formado en la solicitud' });
  }
  next();
});

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

app.get('/v2/public-config', (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL || null;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || null;
  const barId = process.env.BAR_ID || process.env.DEFAULT_BAR_ID || 'rafasbar';
  res.json({
    ok: true,
    supabaseUrl,
    supabaseAnonKey,
    barId
  });
});

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

    if (insert.error) return res.status(500).json({ ok: false, error: insert.error.message });
    res.json({ ok: true, user: insert.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error creando perfil' });
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

    if (q.error) return res.status(404).json({ ok: false, error: 'Perfil no encontrado' });
    res.json({ ok: true, user: q.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error cargando perfil' });
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

    if (q.error) return res.status(500).json({ ok: false, error: q.error.message });
    res.json({ ok: true, items: q.data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error cargando ranking' });
  }
});

app.post('/v2/award-song', async (req, res) => {
  if (!requireSupabase(res)) return;

  const barId = String(req.body.barId || process.env.BAR_ID || 'rafasbar').trim();
  const publicId = String(req.body.publicId || '').trim();
  const award = Math.max(parseInt(req.body.award || '10', 10), 0);
  const videoId = String(req.body.videoId || '').trim();
  const title = String(req.body.title || '').trim().slice(0, 160);
  const artist = String(req.body.artist || '').trim().slice(0, 120);

  if (!publicId) return res.status(400).json({ ok: false, error: 'publicId requerido' });

  try {
    const today = getTodayKey();

    const me = await supabaseAdmin
      .from('moyofy_users')
      .select('*')
      .eq('bar_id', barId)
      .eq('public_id', publicId)
      .single();

    if (me.error || !me.data) return res.status(404).json({ ok: false, error: 'Perfil no encontrado' });

    const u = me.data;
    const lastDay = u.streak_last_day || null;

    let streakDays = u.streak_days || 0;
    if (!lastDay) streakDays = 1;
    else if (lastDay === today) streakDays = Math.max(streakDays, 1);
    else {
      const last = new Date(lastDay + 'T00:00:00Z');
      const cur = new Date(today + 'T00:00:00Z');
      const diff = Math.round((cur - last) / (24 * 60 * 60 * 1000));
      if (diff === 1) streakDays = (streakDays || 0) + 1;
      else streakDays = 1;
    }

    const update = await supabaseAdmin
      .from('moyofy_users')
      .update({
        points: (u.points || 0) + award,
        songs_added: (u.songs_added || 0) + 1,
        streak_days: streakDays,
        streak_last_day: today,
        updated_at: nowISO()
      })
      .eq('bar_id', barId)
      .eq('public_id', publicId)
      .select('*')
      .single();

    if (update.error) return res.status(500).json({ ok: false, error: update.error.message });

    if (videoId) {
      await supabaseAdmin
        .from('moyofy_song_events')
        .insert([{
          bar_id: barId,
          public_id: publicId,
          video_id: videoId,
          title,
          artist,
          awarded: award,
          created_at: nowISO()
        }]);
    }

    res.json({ ok: true, user: update.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error otorgando MOYOS' });
  }
});

app.post('/v2/gift', async (req, res) => {
  if (!requireSupabase(res)) return;

  const barId = String(req.body.barId || process.env.BAR_ID || 'rafasbar').trim();
  const fromPublicId = String(req.body.fromPublicId || '').trim();
  const toNickname = normalizeNickname(req.body.toNickname || '');
  const giftType = String(req.body.giftType || 'beer').trim();
  const amount = Math.max(parseInt(req.body.amount || '10', 10), 1);

  if (!fromPublicId) return res.status(400).json({ ok: false, error: 'fromPublicId requerido' });
  if (!toNickname || toNickname.length < 3) return res.status(400).json({ ok: false, error: 'Destinatario inválido' });

  try {
    const fromQ = await supabaseAdmin
      .from('moyofy_users')
      .select('*')
      .eq('bar_id', barId)
      .eq('public_id', fromPublicId)
      .single();

    if (fromQ.error || !fromQ.data) return res.status(404).json({ ok: false, error: 'Emisor no encontrado' });

    const toQ = await supabaseAdmin
      .from('moyofy_users')
      .select('*')
      .eq('bar_id', barId)
      .ilike('nickname', toNickname)
      .single();

    if (toQ.error || !toQ.data) return res.status(404).json({ ok: false, error: 'Destinatario no encontrado (apodo exacto)' });

    const from = fromQ.data;
    const to = toQ.data;

    if ((from.points || 0) < amount) return res.status(400).json({ ok: false, error: 'No hay MOYOS suficientes' });
    if (from.public_id === to.public_id) return res.status(400).json({ ok: false, error: 'No podés enviarte regalos a vos mismo' });

    const today = getTodayKey();
    const giftsSentToday = from.gifts_sent_today || 0;

    const fromUpdate = await supabaseAdmin
      .from('moyofy_users')
      .update({
        points: (from.points || 0) - amount,
        gifts_sent_today: giftsSentToday + 1,
        updated_at: nowISO()
      })
      .eq('bar_id', barId)
      .eq('public_id', from.public_id)
      .select('*')
      .single();

    if (fromUpdate.error) return res.status(500).json({ ok: false, error: fromUpdate.error.message });

    const toUpdate = await supabaseAdmin
      .from('moyofy_users')
      .update({
        points: (to.points || 0) + amount,
        updated_at: nowISO()
      })
      .eq('bar_id', barId)
      .eq('public_id', to.public_id)
      .select('*')
      .single();

    if (toUpdate.error) return res.status(500).json({ ok: false, error: toUpdate.error.message });

    await supabaseAdmin
      .from('moyofy_gifts')
      .insert([{
        bar_id: barId,
        from_public_id: from.public_id,
        to_public_id: to.public_id,
        from_nickname: from.nickname,
        to_nickname: to.nickname,
        gift_type: giftType,
        amount,
        day_key: today,
        created_at: nowISO()
      }]);

    res.json({ ok: true, fromUser: fromUpdate.data, toUser: toUpdate.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error enviando regalo' });
  }
});

app.post('/v2/vote', async (req, res) => {
  if (!requireSupabase(res)) return;

  const barId = String(req.body.barId || process.env.BAR_ID || 'rafasbar').trim();
  const fromPublicId = String(req.body.fromPublicId || '').trim();
  const videoId = String(req.body.videoId || '').trim();

  if (!fromPublicId) return res.status(400).json({ ok: false, error: 'fromPublicId requerido' });
  if (!videoId) return res.status(400).json({ ok: false, error: 'videoId requerido' });

  try {
    const fromQ = await supabaseAdmin
      .from('moyofy_users')
      .select('*')
      .eq('bar_id', barId)
      .eq('public_id', fromPublicId)
      .single();

    if (fromQ.error || !fromQ.data) return res.status(404).json({ ok: false, error: 'Votante no encontrado' });

    const lastSong = await supabaseAdmin
      .from('moyofy_song_events')
      .select('public_id,video_id,created_at')
      .eq('bar_id', barId)
      .eq('video_id', videoId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastSong || !lastSong.data || !lastSong.data.public_id) {
      return res.status(404).json({ ok: false, error: 'No se encontró autor para esta canción (aún)' });
    }

    const toPublicId = lastSong.data.public_id;
    if (toPublicId === fromPublicId) return res.status(400).json({ ok: false, error: 'No podés votarte a vos mismo' });

    const today = getTodayKey();

    const existing = await supabaseAdmin
      .from('moyofy_votes')
      .select('id')
      .eq('bar_id', barId)
      .eq('day_key', today)
      .eq('from_public_id', fromPublicId)
      .eq('video_id', videoId)
      .maybeSingle();

    if (existing && existing.data) {
      return res.status(409).json({ ok: false, error: 'Ya votaste esta canción hoy' });
    }

    await supabaseAdmin
      .from('moyofy_votes')
      .insert([{
        bar_id: barId,
        day_key: today,
        from_public_id: fromPublicId,
        to_public_id: toPublicId,
        video_id: videoId,
        created_at: nowISO()
      }]);

    const reward = Math.max(parseInt(process.env.VOTE_REWARD || '3', 10), 1);

    const toQ = await supabaseAdmin
      .from('moyofy_users')
      .select('*')
      .eq('bar_id', barId)
      .eq('public_id', toPublicId)
      .single();

    if (toQ.error || !toQ.data) return res.json({ ok: true });

    const to = toQ.data;

    await supabaseAdmin
      .from('moyofy_users')
      .update({
        points: (to.points || 0) + reward,
        votes_received: (to.votes_received || 0) + 1,
        updated_at: nowISO()
      })
      .eq('bar_id', barId)
      .eq('public_id', toPublicId);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error procesando voto' });
  }
});

app.get('/auth', (req, res) => {
  const url = userOauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    redirect_uri: process.env.REDIRECT_URI
  });
  res.redirect(url);
});

app.get('/owner/auth', (req, res) => {
  if (!ownerOauth2Client) return res.status(500).send('Owner OAuth no inicializado');
  const url = ownerOauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    redirect_uri: process.env.REDIRECT_URI
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code, state } = req.query;

  if (state === 'owner') {
    try {
      const { tokens } = await ownerOauth2Client.getToken(code);
      console.log('✅ TOKENS DEL PROPIETARIO OBTENIDOS');
      console.log('⬇️ COPIA ESTE JSON EN RENDER COMO OWNER_TOKENS_JSON ⬇️');
      console.log(JSON.stringify(tokens));
      return res.send(`
        <html><body style="font-family:Arial;padding:20px">
          <h2>✅ Autenticación del PROPIETARIO completada</h2>
          <p>Copia el JSON que aparece en los logs de Render y pégalo como:</p>
          <pre>OWNER_TOKENS_JSON</pre>
          <p>Luego guarda y deja que Render haga redeploy.</p>
          <p>Puedes cerrar esta ventana.</p>
        </body></html>
      `);
    } catch (err) {
      return res.status(500).send('Error autenticando propietario');
    }
  }

  const { error } = req.query;
  if (error) return res.status(400).send(`<html><body><h1>Error OAuth</h1><p>${error}</p></body></html>`);

  try {
    const { tokens } = await userOauth2Client.getToken(code);
    req.session.userTokens = tokens;
    req.session.userAuthenticated = true;
    userOauth2Client.setCredentials(tokens);
    res.send(`<html><body><h1>Autenticación exitosa</h1><p>Puedes cerrar esta ventana y regresar a MOYOFY.</p></body></html>`);
  } catch (err) {
    res.status(500).send('<h1>Error en OAuth Callback</h1>');
  }
});

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

    const stats = {
      totalResults: response.data.items?.length || 0,
      approved: filteredItems.length,
      approvalRate: response.data.items?.length > 0
        ? Math.round((filteredItems.length / response.data.items.length) * 100)
        : 0,
      query: q,
      timestamp: nowISO()
    };

    res.json({
      ok: true,
      items: filteredItems,
      filterStats: stats,
      originalQuery: q,
      timestamp: nowISO()
    });

  } catch (error) {
    let errorMessage = 'Error al buscar videos en YouTube';
    let statusCode = 500;

    if (error.response?.data?.error?.code === 403) {
      errorMessage = 'Límite de cuota de YouTube API excedido';
      statusCode = 429;
    }

    res.status(statusCode).json({
      ok: false,
      error: errorMessage
    });
  }
});

app.post('/suggest-song', async (req, res) => {
  const { videoId, title, userId } = req.body;
  const defaultPlaylistId = process.env.DEFAULT_PLAYLIST_ID;

  if (!defaultPlaylistId) {
    return res.status(500).json({ ok: false, error: 'Playlist no configurada en el servidor', requiresAuth: false });
  }

  if (!videoId) {
    return res.status(400).json({ ok: false, error: 'Video ID es requerido', requiresAuth: false });
  }

  const videoIdRegex = /^[a-zA-Z0-9_-]{11}$/;
  if (!videoIdRegex.test(videoId)) {
    return res.status(400).json({ ok: false, error: 'Video ID con formato inválido', requiresAuth: false });
  }

  try {
    const videoResponse = await userYoutube.videos.list({ part: 'snippet,status', id: videoId });
    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      return res.status(404).json({ ok: false, error: 'Video no encontrado en YouTube', requiresAuth: false });
    }

    const video = videoResponse.data.items[0];
    if (video.status.embeddable === false) {
      return res.status(403).json({ ok: false, error: 'Esta canción no se puede agregar a playlists.', requiresAuth: false });
    }

    if (!ownerYoutube) {
      return res.status(500).json({ ok: false, error: 'Cliente propietario no disponible.', requiresAuth: true });
    }

    const existingItemsResponse = await ownerYoutube.playlistItems.list({
      part: 'snippet',
      playlistId: defaultPlaylistId,
      videoId: videoId
    });

    if (existingItemsResponse.data.items && existingItemsResponse.data.items.length > 0) {
      return res.status(409).json({ ok: false, error: 'VIDEO_DUPLICATE', message: 'El video ya existe en la playlist' });
    }

  } catch (error) {
    if (error.code === 401 || error.response?.status === 401) {
      return res.status(500).json({ ok: false, error: 'Error de autenticación del servidor.', requiresAuth: true });
    }
    return res.status(500).json({ ok: false, error: 'Error verificando la canción.', requiresAuth: false });
  }

  try {
    if (!ownerYoutube) {
      return res.status(500).json({ ok: false, error: 'Cliente propietario no disponible.', requiresAuth: true });
    }

    const response = await ownerYoutube.playlistItems.insert({
      part: 'snippet',
      resource: {
        snippet: {
          playlistId: defaultPlaylistId,
          resourceId: { kind: 'youtube#video', videoId: videoId }
        }
      }
    });

    res.status(200).json({
      ok: true,
      message: 'Canción sugerida y agregada exitosamente a la playlist.',
      videoId: videoId,
      playlistItemId: response.data.id,
      timestamp: nowISO()
    });

  } catch (error) {
    let errorMessage = 'Error al agregar canción';
    let requiresAuth = false;
    let statusCode = 500;

    if (error.code === 401 || error.response?.status === 401) {
      errorMessage = 'Error de autenticación del servidor.';
      requiresAuth = true;
    } else if (error.response?.status === 403) {
      errorMessage = 'Access denied. Check playlist permissions.';
      statusCode = 403;
    }

    res.status(statusCode).json({ ok: false, error: errorMessage, requiresAuth });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'MOYOFY API',
    timestamp: nowISO(),
    environment: process.env.NODE_ENV || 'development',
    supabase: supabaseAdmin ? '✅ Configured' : '⚠️ Not configured',
    youtubeApi: process.env.YOUTUBE_API_KEY ? '✅ Configured' : '❌ Not Configured',
    playlist: process.env.DEFAULT_PLAYLIST_ID ? '✅ Configured' : '❌ Not Configured'
  });
});

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

app.use((error, req, res, next) => {
  res.status(500).json({ ok: false, error: 'Error interno del servidor' });
});

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

    const hasRockKeyword = rockKeywords.some(keyword => title.includes(keyword) || channel.includes(keyword) || description.includes(keyword));
    const hasExcludedKeyword = excludedKeywords.some(keyword => title.includes(keyword) || channel.includes(keyword) || description.includes(keyword));

    return hasRockKeyword && !hasExcludedKeyword;
  });
}

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

function checkConfiguration() {
  const requiredVars = [
    'YOUTUBE_API_KEY',
    'OAUTH_CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    'REDIRECT_URI',
    'DEFAULT_PLAYLIST_ID',
    'OWNER_TOKENS_JSON'
  ];

  const optionalVars = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'BAR_ID'
  ];

  const missing = [];
  requiredVars.forEach(v => { if (!process.env[v]) missing.push(v); });

  if (missing.length > 0) console.log(`⚠️ Faltan variables requeridas: ${missing.join(', ')}`);
  else console.log('✅ Variables requeridas OK');

  const optMissing = optionalVars.filter(v => !process.env[v]);
  if (optMissing.length > 0) console.log(`ℹ️ Variables opcionales no configuradas (V2): ${optMissing.join(', ')}`);
  else console.log('✅ Variables opcionales V2 OK');
}

app.listen(PORT, HOST, () => {
  console.log(`🎸 MOYOFY API iniciado en http://${HOST}:${PORT} · ${nowISO()}`);
  checkConfiguration();
});
