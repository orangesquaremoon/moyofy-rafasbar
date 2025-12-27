require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require("express");
const session = require('express-session');
const cors = require("cors");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const rateLimit = require('express-rate-limit');
const LRU = require('lru-cache');
const crypto = require('crypto');
const app = express();

// Configuración de caché global (6 horas de TTL)
const searchCache = new LRU({
  max: 500, // Máximo 500 queries cacheadas
  ttl: 1000 * 60 * 60 * 6, // 6 horas en milisegundos
  updateAgeOnGet: true,
  dispose: (value, key) => {
    console.log(`🧹 Cache: Eliminando búsqueda antigua para "${key}"`);
  }
});

// Estado del circuit breaker
let quotaExceededUntil = 0;
const CIRCUIT_BREAKER_RESET_MINUTES = 30;

// Configuración de sesión
app.use(session({
  secret: process.env.SESSION_SECRET || 'moyofy_secret_key_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Configuración CORS
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  process.env.RENDER_EXTERNAL_URL || 'https://moyofy-rafasbar.onrender.com'
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin && process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS bloqueado para origen: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());

// Rate limiting por IP (1 búsqueda cada 8 segundos)
const searchLimiter = rateLimit({
  windowMs: 8 * 1000, // 8 segundos
  max: 1, // máximo 1 petición por ventana
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfter = Math.ceil((searchLimiter.windowMs - (Date.now() - req.rateLimit.resetTime)) / 1000);
    console.log(`🚫 Rate limit excedido para IP: ${req.ip} - Esperar ${retryAfter}s`);
    res.status(429).json({
      ok: false,
      error: 'Demasiadas búsquedas. Espera unos segundos antes de intentar de nuevo.',
      retryAfter: retryAfter
    });
  },
  keyGenerator: (req) => {
    return req.ip.replace(/[^0-9a-fA-F.:]/g, '');
  }
});

// Middlewares
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// --- CLIENTE DE GOOGLE PARA EL PROPIETARIO ---
let ownerOauth2Client = null;
let ownerYoutube = null;
let youtubeApiUsedToday = 0;
const MAX_DAILY_QUOTA = 10000; // Ajusta según tu cuota real

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
    ownerOauth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        console.log('🔄 Token de refresh recibido para propietario');
      }
      console.log('🔄 Token de acceso actualizado para propietario');
    });
    ownerYoutube = google.youtube({ version: 'v3', auth: ownerOauth2Client });
    console.log('✅ Cliente de YouTube del propietario inicializado.');
  } catch (error) {
    console.error('❌ Error inicializando cliente del propietario:', error.message);
  }
}
initializeOwnerClient();

// --- CLIENTE DE GOOGLE PARA EL USUARIO ---
const userOauth2Client = new google.auth.OAuth2(
  process.env.OAUTH_CLIENT_ID,
  process.env.OAUTH_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Usar YOUTUBE_API_KEY para búsquedas (más eficiente)
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
if (!YOUTUBE_API_KEY) {
  console.error('❌ YOUTUBE_API_KEY no configurado. Las búsquedas no funcionarán.');
}
const userYoutube = google.youtube({ version: 'v3', auth: YOUTUBE_API_KEY });

// --- MÓDULO DE FILTRADO DE MÚSICA ---
const { filterMusic, ALLOWED_ARTISTS, FORBIDDEN_ARTISTS } = require('./utils/music-filter');

// --- SINGLE FLIGHT PATTERN PARA BÚSQUEDAS ---
const activeSearches = new Map();

async function youtubeSearch(query, maxResults = 10) {
  // Verificar si hay circuit breaker activo
  if (quotaExceededUntil > Date.now()) {
    const minutesLeft = Math.ceil((quotaExceededUntil - Date.now()) / 60000);
    throw new Error(`Límite de cuota excedido temporalmente. Inténtalo nuevamente en ${minutesLeft} minutos.`);
  }

  // Normalizar el query para mejor caching
  const normalizedQuery = normalizeQuery(query);
  const cacheKey = `search:${normalizedQuery}`;

  // Verificar cache primero
  if (searchCache.has(cacheKey)) {
    console.log(`📦 Cache hit para búsqueda: "${query}"`);
    return searchCache.get(cacheKey);
  }

  // Verificar si ya hay una búsqueda activa para este query
  if (activeSearches.has(cacheKey)) {
    console.log(`⚡ Esperando búsqueda en progreso para: "${query}"`);
    return activeSearches.get(cacheKey);
  }

  // Crear un nuevo promise para esta búsqueda
  const searchPromise = (async () => {
    try {
      console.log(`🔍 YouTube API: Buscando "${query}"`);
      youtubeApiUsedToday++;
      
      const response = await userYoutube.search.list({
        part: 'snippet',
        q: query,
        maxResults: maxResults,
        type: 'video',
        fields: 'items(id/videoId,snippet(title,description,channelTitle,thumbnails))'
      });

      const filteredItems = filterMusic(response.data.items || []);
      const result = {
        items: filteredItems,
        totalResults: response.data.items?.length || 0,
        approved: filteredItems.length,
        query: normalizedQuery,
        timestamp: new Date().toISOString()
      };

      // Guardar en cache
      searchCache.set(cacheKey, result);
      console.log(`💾 Cache guardado para búsqueda: "${query}" (${filteredItems.length}/${response.data.items?.length || 0} aprobados)`);
      
      return result;
    } catch (error) {
      // Manejar quotaExceeded específicamente
      if (error.code === 403 && error.errors && error.errors[0].reason === 'quotaExceeded') {
        quotaExceededUntil = Date.now() + (CIRCUIT_BREAKER_RESET_MINUTES * 60000);
        console.error(`🔥 CUOTA EXCEDIDA - Circuito breaker activado por ${CIRCUIT_BREAKER_RESET_MINUTES} minutos`);
        throw new Error(`Límite de cuota de YouTube API excedido. Las búsquedas estarán disponibles nuevamente en ${CIRCUIT_BREAKER_RESET_MINUTES} minutos.`);
      }
      throw error;
    } finally {
      // Limpiar la búsqueda activa
      activeSearches.delete(cacheKey);
    }
  })();

  // Guardar el promise en activeSearches
  activeSearches.set(cacheKey, searchPromise);
  
  return searchPromise;
}

function normalizeQuery(query) {
  return query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s\-_'"]/g, '');
}

// --- FUNCIONES AUXILIARES ---
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
    if (!item.snippet || !item.snippet.title || !item.snippet.channelTitle) {
      return false;
    }
    const title = item.snippet.title.toLowerCase();
    const channel = item.snippet.channelTitle.toLowerCase();
    const description = item.snippet.description ? item.snippet.description.toLowerCase() : '';
    const isAllowedArtist = allowedArtists.some(artist =>
      channel.includes(artist) || title.includes(artist)
    );
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

// Middleware de logging mejorado
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
    originalEnd.apply(res, args);
  };
  next();
});

// Middleware para manejar JSON mal formado
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON mal formado:', err.message);
    return res.status(400).json({ ok: false, error: 'JSON mal formado en la solicitud' });
  }
  next();
});

// --- RUTAS ---
// Ruta para autenticación (sin cambios)
app.get('/auth', (req, res) => {
  console.log('🔐 Iniciando autenticación de USUARIO');
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
  ];
  const url = userOauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
    include_granted_scopes: true
  });
  res.redirect(url);
});

// Callback de autenticación (sin cambios)
app.get('/oauth2callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    console.error('❌ Error en OAuth del usuario:', error);
    return res.status(400).send(`
      <html>
      <body>
        <h1>Error de Autenticación del Usuario</h1>
        <p>${error}</p>
      </body>
      </html>
    `);
  }
  try {
    const { tokens } = await userOauth2Client.getToken(code);
    req.session.userTokens = tokens;
    req.session.userAuthenticated = true;
    userOauth2Client.setCredentials(tokens);
    res.send(`
      <html><body><h1>Autenticación de Usuario Exitosa</h1><p>Ahora puedes cerrar esta ventana y regresar a MOYOFY.</p></body></html>
    `);
  } catch (err) {
    console.error('❌ Error procesando callback OAuth del usuario:', err);
    res.status(500).send('<h1>Error en OAuth Callback del Usuario</h1>');
  }
});

// Ruta para búsqueda de videos (MEJORADA - CON CACHE Y RATE LIMITING)
app.post('/search', searchLimiter, async (req, res) => {
  const { q } = req.body;
  
  // Validaciones básicas
  if (!q || q.trim() === '') {
    return res.status(400).json({ 
      ok: false, 
      error: 'La consulta de búsqueda no puede estar vacía'
    });
  }
  
  if (q.trim().length < 4) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Ingresa al menos 4 caracteres para buscar'
    });
  }

  // Verificar si hay circuit breaker activo
  if (quotaExceededUntil > Date.now()) {
    const minutesLeft = Math.ceil((quotaExceededUntil - Date.now()) / 60000);
    return res.status(503).json({
      ok: false,
      error: `Límite de cuota de YouTube API excedido. Las búsquedas estarán disponibles nuevamente en ${minutesLeft} minutos.`,
      circuitBreaker: true,
      resetInMinutes: minutesLeft
    });
  }

  // Verificar si ya hemos excedido nuestra cuota diaria
  if (youtubeApiUsedToday > MAX_DAILY_QUOTA * 0.9) {
    return res.status(429).json({
      ok: false,
      error: `Casi hemos llegado al límite diario de búsquedas. Por favor, intenta más tarde.`,
      quotaWarning: true,
      used: youtubeApiUsedToday,
      limit: MAX_DAILY_QUOTA
    });
  }

  const normalizedQuery = normalizeQuery(q);
  console.log(`🔍 Búsqueda recibida: "${normalizedQuery}" desde IP: ${req.ip}`);

  try {
    // Obtener resultados de búsqueda (usando cache y single flight)
    const searchResult = await youtubeSearch(normalizedQuery, 10);
    
    const stats = {
      totalResults: searchResult.totalResults,
      approved: searchResult.approved,
      approvalRate: searchResult.totalResults > 0
        ? Math.round((searchResult.approved / searchResult.totalResults) * 100)
        : 0,
      query: normalizedQuery,
      timestamp: new Date().toISOString(),
      cacheHit: searchCache.has(`search:${normalizedQuery}`),
      fromCache: searchCache.has(`search:${normalizedQuery}`)
    };

    console.log(`✅ Resultados para "${normalizedQuery}": ${stats.approved}/${stats.totalResults} (${stats.approvalRate}%) aprobados`);
    
    res.json({
      ok: true,
      items: searchResult.items,
      filterStats: stats,
      originalQuery: q,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error en búsqueda de YouTube:', error.message);
    
    let errorMessage = 'Error al buscar videos en YouTube';
    let statusCode = 500;
    
    // Manejo específico de errores de cuota
    if (error.message.includes('cuota excedida') || error.message.includes('quotaExceeded')) {
      statusCode = 503;
      errorMessage = 'Servicio temporalmente no disponible. Límite de búsquedas alcanzado.';
    } else if (error.message.includes('máximo 1 petición')) {
      statusCode = 429;
      errorMessage = 'Demasiadas búsquedas. Espera unos segundos antes de intentar de nuevo.';
    }
    
    res.status(statusCode).json({
      ok: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      retryAfter: statusCode === 429 ? 8 : undefined,
      circuitBreaker: statusCode === 503 && quotaExceededUntil > Date.now()
    });
  }
});

// Ruta para SUGERIR agregar a playlist (sin cambios)
app.post('/suggest-song', async (req, res) => {
  const { videoId, title, userId } = req.body;
  const defaultPlaylistId = process.env.DEFAULT_PLAYLIST_ID;
  console.log(`🎵 Solicitud de agregar video: ${title || 'Sin título'} (ID: ${videoId}) (Usuario: ${userId || 'Anónimo'})`);
  
  if (!defaultPlaylistId) {
    console.error('❌ DEFAULT_PLAYLIST_ID no configurada en variables de entorno');
    return res.status(500).json({
      ok: false,
      error: 'Playlist no configurada en el servidor',
      requiresAuth: false
    });
  }
  
  if (!videoId) {
    console.error('❌ Video ID es requerido');
    return res.status(400).json({
      ok: false,
      error: 'Video ID es requerido',
      requiresAuth: false
    });
  }
  
  const videoIdRegex = /^[a-zA-Z0-9_-]{11}$/;
  if (!videoIdRegex.test(videoId)) {
    console.error('❌ Video ID con formato inválido');
    return res.status(400).json({
      ok: false,
      error: 'Video ID con formato inválido',
      requiresAuth: false
    });
  }
  
  // --- VALIDACIONES ANTES DE AGREGAR ---
  try {
    const videoResponse = await userYoutube.videos.list({
      part: 'snippet,status',
      id: videoId
    });
    
    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Video no encontrado en YouTube',
        requiresAuth: false
      });
    }
    
    const video = videoResponse.data.items[0];
    console.log(`📹 Video encontrado: "${video.snippet.title}"`);
    
    if (video.status.embeddable === false) {
      return res.status(403).json({
        ok: false,
        error: 'Esta canción no se puede agregar a playlists.',
        requiresAuth: false
      });
    }
    
    if (ownerYoutube) {
      const existingItemsResponse = await ownerYoutube.playlistItems.list({
        part: 'snippet',
        playlistId: defaultPlaylistId,
        videoId: videoId
      });
      
      if (existingItemsResponse.data.items && existingItemsResponse.data.items.length > 0) {
        console.log(`⚠️ Video ${videoId} ya existe en playlist del propietario.`);
        return res.status(409).json({
          ok: false,
          error: 'Esta canción ya está en la playlist.',
          requiresAuth: false
        });
      }
    } else {
      console.error('❌ Cliente de YouTube del propietario no inicializado.');
      return res.status(500).json({
        ok: false,
        error: 'Error interno del servidor (cliente propietario no disponible).',
        requiresAuth: false
      });
    }
  } catch (error) {
    console.error('Error verificando video antes de agregar:', error);
    if (error.code === 401 || error.response?.status === 401) {
      return res.status(500).json({
        ok: false,
        error: 'Error de autenticación del servidor.',
        requiresAuth: true
      });
    }
    return res.status(500).json({
      ok: false,
      error: 'Error verificando la canción.',
      requiresAuth: false
    });
  }
  
  // --- AGREGAR VIDEO A PLAYLIST DEL PROPIETARIO ---
  try {
    if (!ownerYoutube) {
      console.error('❌ Cliente de YouTube del propietario no disponible para agregar.');
      return res.status(500).json({
        ok: false,
        error: 'Error interno del servidor (cliente propietario no disponible).',
        requiresAuth: false
      });
    }
    
    const response = await ownerYoutube.playlistItems.insert({
      part: 'snippet',
      resource: {
        snippet: {
          playlistId: defaultPlaylistId,
          resourceId: {
            kind: 'youtube#video',
            videoId: videoId
          }
        }
      }
    });
    
    console.log(`✅ Video agregado exitosamente por el propietario: ${title || videoId}`);
    console.log(`📝 Playlist Item ID: ${response.data.id}`);
    
    res.status(200).json({
      ok: true,
      message: 'Canción sugerida y agregada exitosamente a la playlist.',
      videoId: videoId,
      playlistItemId: response.data.id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error agregando video a playlist del propietario:', error);
    let errorMessage = 'Error al agregar canción';
    let requiresAuth = false;
    let statusCode = 500;
    
    if (error.code === 401 || error.response?.status === 401) {
      console.log('🔐 Error de autenticación del propietario');
      errorMessage = 'Error de autenticación del servidor.';
      requiresAuth = true;
    } else if (error.response?.status === 403) {
      errorMessage = 'Access denied. Check playlist permissions.';
      statusCode = 403;
    }
    
    res.status(statusCode).json({
      ok: false,
      error: errorMessage,
      requiresAuth: requiresAuth
    });
  }
});

// Ruta para obtener perfil (sin cambios)
app.get('/user/profile', (req, res) => {
  const { userId } = req.query;
  console.log(`👤 Consulta de perfil: ${userId || 'anonymous'}`);
  
  // Simular datos básicos para compatibilidad
  const mockRanking = [
    { rank: 1, nickname: 'RockMaster69', points: 850, level: 8, songsAdded: 75 },
    { rank: 2, nickname: 'MetallicaFan', points: 720, level: 7, songsAdded: 62 },
    { rank: 3, nickname: 'QueenLover', points: 680, level: 6, songsAdded: 58 }
  ];
  
  let user = { 
    rank: 0, 
    nickname: userId && userId !== 'anonymous' ? userId : 'Invitado', 
    points: 100, 
    level: 1, 
    songsAdded: 0 
  };
  
  if (userId && userId !== 'anonymous' && userId !== 'Invitado') {
    const foundUser = mockRanking.find(u => u.nickname.toLowerCase() === userId.toLowerCase());
    if (foundUser) {
      user = { ...foundUser };
    } else {
      user.rank = mockRanking.length + 1;
    }
  }
  
  res.json({
    ok: true,
    user: user,
    topUsers: mockRanking,
    serverTime: new Date().toISOString(),
    totalUsers: mockRanking.length
  });
});

// Ruta de salud del servidor (MEJORADA - CON ESTADÍSTICAS DE CUOTA)
app.get('/health', (req, res) => {
  const now = new Date();
  const cacheStats = {
    size: searchCache.size,
    max: searchCache.max,
    percentUsed: Math.round((searchCache.size / searchCache.max) * 100)
  };
  
  const circuitBreakerActive = quotaExceededUntil > Date.now();
  const circuitBreakerReset = circuitBreakerActive ? 
    Math.ceil((quotaExceededUntil - Date.now()) / 60000) : 0;
  
  const health = {
    ok: true,
    service: 'MOYOFY Premium API',
    version: '2.0.1',
    timestamp: now.toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    },
    youtubeApi: {
      configured: !!process.env.YOUTUBE_API_KEY,
      usedToday: youtubeApiUsedToday,
      dailyLimit: MAX_DAILY_QUOTA,
      percentUsed: Math.round((youtubeApiUsedToday / MAX_DAILY_QUOTA) * 100),
      quotaExceeded: circuitBreakerActive
    },
    cache: cacheStats,
    circuitBreaker: {
      active: circuitBreakerActive,
      resetInMinutes: circuitBreakerReset
    },
    ownerClient: ownerYoutube ? '✅ Initialized' : '❌ Not Initialized',
    filterStats: {
      allowedArtists: ALLOWED_ARTISTS.size,
      forbiddenArtists: FORBIDDEN_ARTISTS.size
    }
  };
  
  console.log('🩺 Health check realizado - Cuota YouTube: ' + 
    `${youtubeApiUsedToday}/${MAX_DAILY_QUOTA} (${Math.round((youtubeApiUsedToday / MAX_DAILY_QUOTA) * 100)}%)`);
  
  res.json(health);
});

// Ruta principal (sin cambios)
app.get('/', (req, res) => {
  try {
    const indexPath = path.join(__dirname, '../public/index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>MOYOFY · Rafa's Bar</title>
          <style>
            body { font-family: Arial, sans-serif; background: #12121f; color: white; text-align: center; padding: 50px; }
            h1 { color: #ff004c; }
            .container { max-width: 800px; margin: 0 auto; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🎸 MOYOFY Premium</h1>
            <p>Sistema de entretenimiento social para Rafa's Bar</p>
            <p>El servidor está funcionando correctamente.</p>
            <p><a href="/health" style="color: #00ffaa;">Ver estado del servidor</a></p>
          </div>
        </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('Error sirviendo index.html:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Ruta para archivos estáticos fallback (sin cambios)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({
      ok: false,
      error: 'Ruta API no encontrada',
      path: req.path,
      available: ['/search', '/suggest-song', '/auth', '/user/profile', '/health']
    });
  } else {
    const filePath = path.join(__dirname, '../public', req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.sendFile(filePath);
    } else {
      res.redirect('/');
    }
  }
});

// Manejo global de errores (MEJORADO - SIN LOGS SENSIBLES)
app.use((error, req, res, next) => {
  console.error('❌ Error global:', {
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    ok: false,
    error: 'Error interno del servidor',
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
  });
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

function checkConfiguration() {
  console.log('🔍 Verificando configuración...');
  const requiredVars = [
    'YOUTUBE_API_KEY',
    'OAUTH_CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    'REDIRECT_URI',
    'DEFAULT_PLAYLIST_ID',
    'OWNER_TOKENS_JSON'
  ];
  
  const missingVars = [];
  requiredVars.forEach(varName => {
    if (!process.env[varName]) {
      missingVars.push(varName);
      console.error(`❌ ${varName}: NO CONFIGURADO`);
    } else {
      const value = varName.includes('SECRET') || varName.includes('KEY') 
        ? '••••••••' 
        : (varName === 'OWNER_TOKENS_JSON' ? 'JSON configurado' : process.env[varName]);
      console.log(`✅ ${varName}: ${value}`);
    }
  });
  
  if (missingVars.length > 0) {
    console.error(`
❌ ADVERTENCIA: Faltan ${missingVars.length} variables requeridas.`);
  } else {
    console.log(`
🎉 ¡Todas las variables requeridas están configuradas!
🎵 Filtro de música cargado: ${ALLOWED_ARTISTS.size} artistas permitidos, ${FORBIDDEN_ARTISTS.size} artistas prohibidos.`);
  }
}

// Limpieza periódica de caché (cada hora)
setInterval(() => {
  const beforeSize = searchCache.size;
  searchCache.purgeStale();
  const afterSize = searchCache.size;
  if (beforeSize !== afterSize) {
    console.log(`🧹 Limpieza de caché: ${beforeSize} → ${afterSize} items`);
  }
}, 60 * 60 * 1000);

// Reset de contador diario (a medianoche)
function resetDailyCounter() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow - now;
  
  setTimeout(() => {
    console.log(`🔄 Reiniciando contador diario de YouTube API. Total usado hoy: ${youtubeApiUsedToday}`);
    youtubeApiUsedToday = 0;
    resetDailyCounter();
  }, msUntilMidnight);
}

resetDailyCounter();

app.listen(PORT, HOST, () => {
  console.log(`
    🎸 MOYOFY PREMIUM v2.1 (¡CON CACHE Y RATE LIMITING!)
    ==========================================
    ✅ Servidor iniciado exitosamente
    📍 URL: http://${HOST}:${PORT}
    ⏰ Hora de inicio: ${new Date().toLocaleString()}
    🌍 Entorno: ${process.env.NODE_ENV || 'development'}
    🚀 Node.js: ${process.version}
    📦 Memoria: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
    ⚡ Cache configurado con TTL de 6 horas
    🛑 Rate limiting: 1 búsqueda cada 8 segundos por IP
    🔌 Circuit breaker automático para quotaExceeded
    ==========================================
  `);
  
  checkConfiguration();
  
  console.log(`
📚 Rutas disponibles:
  GET / - Interfaz web principal con gamificación
  POST /search - Buscar canciones de rock (CON CACHE Y RATE LIMITING)
  POST /suggest-song - Agregar canción a playlist (con autenticación del propietario)
  GET /auth - Autenticación con Google
  GET /oauth2callback - Callback de autenticación OAuth
  GET /user/profile - Perfil de usuario (compatibilidad)
  GET /health - Estado del servidor (con estadísticas de cuota)
  ==========================================
  💡 TIP: Usa /health para monitorear el uso de cuota de YouTube API
  `);
});