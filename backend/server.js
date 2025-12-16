// backend/server.js
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const app = express();

// Configuración CORS para desarrollo y producción
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  process.env.RENDER_EXTERNAL_URL || 'https://moyofy-rafasbar.onrender.com' // <- Sin espacios
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS bloqueado para origen: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Configuración de Google OAuth2
const oauth2Client = new google.auth.OAuth2(
  process.env.OAUTH_CLIENT_ID,
  process.env.OAUTH_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Configuración de YouTube API
const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });

// Middleware de logging mejorado
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
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

// Ruta para autenticación OAuth
app.get('/auth', (req, res) => {
  console.log('🔐 Iniciando autenticación OAuth');
  const scopes = [
    'https://www.googleapis.com/auth/youtube', // <- Sin espacios
    'https://www.googleapis.com/auth/userinfo.profile', // <- Sin espacios
    'https://www.googleapis.com/auth/userinfo.email' // <- Sin espacios
  ];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
    include_granted_scopes: true
  });
  res.redirect(url);
});

// Callback de OAuth
app.get('/oauth2callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    console.error('❌ Error en OAuth:', error);
    return res.status(400).send(`
      <html>
      <body><h1>Error de Autenticación</h1><p>${error}</p></body>
      </html>
    `);
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    res.send(`
      <html><body><h1>Autenticación Exitosa</h1></body></html>
    `);
  } catch (err) {
    console.error('❌ Error procesando callback OAuth:', err);
    res.status(500).send('<h1>Error en OAuth Callback</h1>');
  }
});

// Ruta para búsqueda de videos (modificada)
app.post('/search', async (req, res) => {
  const { q } = req.body;
  if (!q || q.trim() === '') {
    return res.status(400).json({ ok: false, error: 'La consulta de búsqueda no puede estar vacía' });
  }

  console.log(`🔍 Búsqueda recibida: "${q}"`);
  try {
    const response = await youtube.search.list({
      part: 'snippet',
      q: q,
      maxResults: 15,
      type: 'video'
      // videoDuration: 'medium',     // Temporalmente comentado
      // relevanceLanguage: 'en,es',  // Temporalmente comentado
      // safeSearch: 'none'           // Temporalmente comentado
    });

    console.log(`📥 YouTube API respondió con ${response.data.items?.length || 0} resultados`);

    const { filterMusic } = require('./utils/music-filter');
    const filteredItems = filterMusic(response.data.items || []);

    const stats = {
      totalResults: response.data.items?.length || 0,
      approved: filteredItems.length,
      approvalRate: response.data.items?.length > 0
        ? Math.round((filteredItems.length / response.data.items.length) * 100)
        : 0,
      query: q,
      timestamp: new Date().toISOString(),
      service: 'MOYOFY Filter v4'
    };

    console.log(`✅ Resultados filtrados: ${stats.approved}/${stats.totalResults} (${stats.approvalRate}%) aprobados`);

    let suggestions = [];
    if (stats.approved === 0 && stats.totalResults > 0) {
      suggestions = [
        "Intenta buscar el artista específico: 'Metallica'",
        "Busca por nombre de canción completa: 'Bohemian Rhapsody Queen'",
        "Usa términos de género: 'heavy metal 80s'",
        "Prueba con: 'rock clásico' o 'metal'"
      ];
    }

    res.json({
      ok: true,
      items: filteredItems,
      filterStats: stats,
      originalQuery: q,
      suggestions: suggestions,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error en búsqueda de YouTube:', error);
    let errorMessage = 'Error al buscar videos en YouTube';
    let statusCode = 500;

    if (error.response) {
      const youtubeError = error.response.data.error;
      if (youtubeError.code === 403) {
        errorMessage = 'Límite de cuota de YouTube API excedido';
        statusCode = 429;
      } else if (youtubeError.code === 400) {
        errorMessage = 'Consulta de búsqueda inválida';
        statusCode = 400;
      }
    }

    res.status(statusCode).json({
      ok: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      code: error.code
    });
  }
});

// Ruta para agregar a playlist
app.post('/add-to-playlist', async (req, res) => {
  const { videoId, title } = req.body;
  const defaultPlaylistId = process.env.DEFAULT_PLAYLIST_ID;

  if (!defaultPlaylistId) {
    console.error('❌ DEFAULT_PLAYLIST_ID no está definida en .env');
    return res.status(500).json({ ok: false, error: 'Playlist predeterminada no configurada.' });
  }

  if (!videoId) {
    return res.status(400).json({ ok: false, error: 'Video ID es requerido' });
  }

  try {
    // Verificar si el video ya está en la playlist
    const existingItemsResponse = await youtube.playlistItems.list({
      part: 'snippet',
      playlistId: defaultPlaylistId,
      videoId: videoId
    });

    if (existingItemsResponse.data.items && existingItemsResponse.data.items.length > 0) {
      console.log(`🎵 Video ${videoId} ya está en la playlist.`);
      return res.status(409).json({ ok: false, error: 'Video already in playlist.', requiresAuth: false });
    }

    const response = await youtube.playlistItems.insert({
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

    console.log(`✅ Video ${videoId} agregado a la playlist ${defaultPlaylistId}.`);
    res.status(200).json({ ok: true, message: 'Video added to playlist successfully.' });

  } catch (error) {
    console.error('❌ Error agregando video a la playlist:', error);
    let errorMessage = 'Error adding video to playlist.';
    let statusCode = 500;
    let requiresAuth = false;

    if (error.code === 401 || (error.response && error.response.status === 401)) {
      errorMessage = 'Unauthorized. Please authenticate first.';
      statusCode = 401;
      requiresAuth = true;
    } else if (error.response && error.response.status === 403) {
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

// Ruta para obtener perfil y ranking (simulado)
app.get('/user/profile', (req, res) => {
  const { userId } = req.query;
  console.log(`👤 Consulta de perfil: ${userId || 'anonymous'}`);

  // Simular datos del ranking
  const mockRanking = [
    { rank: 1, nickname: 'RockMaster69', points: 500, level: 5, songsAdded: 45 },
    { rank: 2, nickname: 'MetallicaFan', points: 420, level: 4, songsAdded: 38 },
    { rank: 3, nickname: 'QueenLover', points: 380, level: 3, songsAdded: 32 },
    { rank: 4, nickname: 'Sebas', points: 250, level: 2, songsAdded: 20 },
    { rank: 5, nickname: 'Anon', points: 100, level: 1, songsAdded: 5 },
    { rank: 6, nickname: 'RockAndRoll', points: 220, level: 2, songsAdded: 20 },
    { rank: 7, nickname: 'LedZeppelinFan', points: 190, level: 1, songsAdded: 18 },
    { rank: 8, nickname: 'ACDC_Forever', points: 170, level: 1, songsAdded: 15 },
    { rank: 9, nickname: 'PunkNotDead', points: 150, level: 1, songsAdded: 12 },
    { rank: 10, nickname: 'ClassicRockHero', points: 120, level: 1, songsAdded: 8 }
  ];

  // Buscar usuario actual
  let user = { rank: 0, nickname: userId || 'Invitado', points: 100, level: 1, songsAdded: 0 };

  if (userId && userId !== 'anonymous' && userId !== 'Invitado') {
    const foundUser = mockRanking.find(u => u.nickname.toLowerCase() === userId.toLowerCase());
    if (foundUser) {
      user = { ...foundUser };
    } else {
      // Usuario nuevo, agregar al final del ranking
      user.rank = mockRanking.length + 1;
    }
  }

  res.json({
    ok: true,
    user: user,
    topUsers: mockRanking,
    serverTime: new Date().toISOString(),
    totalUsers: mockRanking.length,
    rankingUpdated: '2024-01-15T12:00:00Z' // Fecha simulada
  });
});

// Ruta de salud del servidor
app.get('/health', (req, res) => {
  const health = {
    ok: true,
    service: 'MOYOFY Premium API',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    youtubeApi: process.env.YOUTUBE_API_KEY ? 'Configured' : 'Not Configured',
    oauth: process.env.OAUTH_CLIENT_ID ? 'Configured' : 'Not Configured',
    playlist: process.env.DEFAULT_PLAYLIST_ID ? 'Configured' : 'Not Configured'
  };
  console.log('🩺 Health check realizado');
  res.json(health);
});

// Ruta para información del sistema
app.get('/system/info', (req, res) => {
  res.json({
    ok: true,
    system: {
      name: 'MOYOFY Premium',
      version: '2.0.0',
      description: 'Sistema de entretenimiento social para bares',
      author: 'Abundia.io',
      filters: {
        version: 'v4',
        allowedArtists: '200+ artistas',
        allowedGenres: '40+ géneros',
        smartFiltering: true
      }
    },
    endpoints: {
      search: 'POST /search',
      addToPlaylist: 'POST /add-to-playlist',
      auth: 'GET /auth',
      profile: 'GET /user/profile',
      health: 'GET /health'
    }
  });
});

// Ruta principal
app.get('/', (req, res) => {
  try {
    const indexPath = path.join(__dirname, '../public/index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send(`<html><body><h1>MOYOFY Premium</h1><p>Archivo index.html no encontrado en /public</p><p>Por favor, asegúrate de que el archivo existe.</p></body></html>`);
    }
  } catch (error) {
    console.error('Error sirviendo index.html:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Ruta para archivos estáticos fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({
      ok: false,
      error: 'Ruta API no encontrada',
      path: req.path,
      available: ['/search', '/add-to-playlist', '/auth', '/user/profile', '/health', '/system/info']
    });
  } else {
    // Intentar servir el archivo estático
    const filePath = path.join(__dirname, '../public', req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.sendFile(filePath);
    } else {
      res.status(404).send(`<html><body><h1>404 - Ruta no encontrada</h1><p>La ruta: ${req.path}</p></body></html>`);
    }
  }
});

// Manejo global de errores
app.use((error, req, res, next) => {
  console.error('❌ Error global:', error);
  res.status(500).json({
    ok: false,
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined
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
    'DEFAULT_PLAYLIST_ID'
  ];
  const missingVars = [];
  requiredVars.forEach(varName => {
    if (!process.env[varName]) {
      missingVars.push(varName);
      console.error(`❌ ${varName}: NO CONFIGURADO`);
    }
  });
  if (missingVars.length > 0) {
    console.warn(`⚠️ ADVERTENCIA: Faltan ${missingVars.length} variables de entorno.`);
  }
}

app.listen(PORT, HOST, () => {
  console.log(`🎸 MOYOFY PREMIUM v2.0`);
  console.log(`==========================================`);
  console.log(`✅ Servidor iniciado exitosamente`);
  console.log(`📍 URL: http://${HOST}:${PORT}`);
  console.log(`⏰ Hora de inicio: ${new Date().toISOString()}`);
  console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🚀 Node.js: ${process.version}`);
  console.log(`📦 Memoria: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  console.log(`==========================================`);

  // Verificar configuración
  checkConfiguration();

  // Mostrar rutas disponibles
  console.log('📚 Rutas disponibles:');
  console.log(' GET / - Interfaz web principal');
  console.log(' POST /search - Buscar canciones');
  console.log(' POST /add-to-playlist - Agregar canción a playlist');
  console.log(' GET /auth - Autenticación con Google');
  console.log(' GET /oauth2callback - Callback de autenticación');
  console.log(' GET /user/profile - Perfil de usuario y ranking');
  console.log(' GET /health - Estado del servidor');
  console.log(' GET /system/info - Información del sistema');
  console.log(`==========================================`);

  // Verificar filtro
  try {
    const { ALLOWED_ARTISTS } = require('./utils/music-filter');
    console.log(`🎵 Filtro de música cargado: ${ALLOWED_ARTISTS.length} artistas permitidos`);
  } catch (error) {
    console.error('❌ Error cargando filtro de música:', error.message);
  }
});