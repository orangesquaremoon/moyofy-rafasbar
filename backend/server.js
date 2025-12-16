// backend/server.js
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require("express");
const session = require('express-session');
const cors = require("cors");
const { google } = require("googleapis");
const fs = require("fs").promises; // Usar la versión basada en promesas
const path = require("path");

const app = express();

// Configuración de sesión
app.use(session({
  secret: 'tu_clave_secreta_para_sesion', // Cambia esto por algo más seguro
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Cambia a true si usas HTTPS en producción
}));

// Configuración CORS para desarrollo y producción
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  process.env.RENDER_EXTERNAL_URL || 'https://moyofy-rafasbar.onrender.com'
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

// --- FUNCIONES DE PERSISTENCIA EN ARCHIVO ---

const RANKING_FILE_PATH = path.join(__dirname, 'data', 'ranking.json');

// Asegurar que la carpeta 'data' exista
const ensureDataDirectory = async () => {
  const dir = path.dirname(RANKING_FILE_PATH);
  try {
    await fs.access(dir);
  } catch (error) {
    // Si no existe, crear la carpeta
    await fs.mkdir(dir, { recursive: true });
    console.log(`📁 Carpeta de datos '${dir}' creada.`);
  }
};

// Cargar ranking desde el archivo
const loadRankingFromFile = async () => {
  try {
    await ensureDataDirectory(); // Asegurar carpeta antes de leer
    const data = await fs.readFile(RANKING_FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📁 Archivo de ranking no encontrado, creando uno nuevo...');
      // Si no existe, devolver un ranking vacío
      return { users: {}, lastUpdated: new Date().toISOString() };
    } else {
      console.error('❌ Error leyendo archivo de ranking:', error.message);
      // En caso de error, también devolver un ranking vacío
      return { users: {}, lastUpdated: new Date().toISOString() };
    }
  }
};

// Guardar ranking en el archivo
const saveRankingToFile = async (rankingData) => {
  try {
    await ensureDataDirectory(); // Asegurar carpeta antes de escribir
    rankingData.lastUpdated = new Date().toISOString();
    const dataToWrite = JSON.stringify(rankingData, null, 2);
    await fs.writeFile(RANKING_FILE_PATH, dataToWrite, 'utf8');
    // console.log('💾 Ranking guardado en archivo.'); // Opcional: log para debugging
  } catch (error) {
    console.error('❌ Error escribiendo archivo de ranking:', error.message);
  }
};

// --- RUTAS ---

// Ruta para autenticación OAuth
app.get('/auth', (req, res) => {
  console.log('🔐 Iniciando autenticación OAuth');
  const scopes = [
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
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
    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);

    res.send(`
      <html><body><h1>Autenticación Exitosa</h1><p>Ahora puedes cerrar esta ventana y regresar a MOYOFY.</p></body></html>
    `);
  } catch (err) {
    console.error('❌ Error procesando callback OAuth:', err);
    res.status(500).send('<h1>Error en OAuth Callback</h1>');
  }
});

// Ruta para búsqueda de videos
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

// Ruta para agregar a playlist (MODIFICADA para actualizar ranking)
app.post('/add-to-playlist', async (req, res) => {
  const { videoId, title } = req.body;
  const defaultPlaylistId = process.env.DEFAULT_PLAYLIST_ID;

  console.log(`🎵 Intentando agregar video: ${title || 'Sin título'} (ID: ${videoId}) (Usuario: ${req.sessionID})`);

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

  // --- VERIFICAR AUTENTICACIÓN ---
  if (!req.session.tokens) {
    console.error('🔐 No hay tokens de sesión, usuario no autenticado');
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized. Please authenticate first.',
      requiresAuth: true
    });
  }

  const userOauth2Client = new google.auth.OAuth2(
    process.env.OAUTH_CLIENT_ID,
    process.env.OAUTH_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  userOauth2Client.setCredentials(req.session.tokens);
  const userYoutube = google.youtube({ version: 'v3', auth: userOauth2Client });

  // Verificar si el video ya está en la playlist
  try {
    const existingItemsResponse = await userYoutube.playlistItems.list({
      part: 'snippet',
      playlistId: defaultPlaylistId,
      videoId: videoId
    });

    if (existingItemsResponse.data.items && existingItemsResponse.data.items.length > 0) {
      console.log(`⚠️ Video ${videoId} ya existe en playlist`);
      return res.status(409).json({
        ok: false,
        error: 'Esta canción ya está en la playlist',
        requiresAuth: false
      });
    }
  } catch (error) {
     console.error('Error verificando si video existe:', error);
     if (error.code === 401 || error.response?.status === 401) {
        console.log('🔐 Error de autenticación al verificar existencia del video');
        return res.status(401).json({
            ok: false,
            error: 'Unauthorized. Please authenticate first.',
            requiresAuth: true
        });
     }
     return res.status(500).json({
        ok: false,
        error: 'Error verificando existencia de la canción.',
        requiresAuth: false
    });
  }

  // Insertar nuevo video en playlist
  try {
    const response = await userYoutube.playlistItems.insert({
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

    console.log(`✅ Video agregado exitosamente: ${title || videoId}`);
    console.log(`📝 Playlist Item ID: ${response.data.id}`);

    // --- ACTUALIZAR RANKING LOCAL ---
    // El userId para el ranking lo obtenemos del cliente (por ejemplo, del localStorage)
    // Aquí asumimos que el cliente envía un identificador único (por ejemplo, el nickname o un id derivado)
    // Una mejor práctica sería que el servidor genere un ID único por sesión o lo derive del perfil de usuario de otra manera,
    // pero para mantenerlo simple y usar el modelo actual de localStorage, lo obtenemos del body o de otra forma.
    // Por ahora, usaremos un ID derivado del nickname almacenado localmente o del ID de sesión como fallback.
    // El cliente debería enviar su nickname o ID.
    // Modifiquémoslo: El cliente debería enviar su 'userId' (el que guarda en localStorage).
    // Asumiremos que el cliente envía 'userId' en el body.
    // Si no lo envía, intentamos derivarlo de otra forma o usamos el ID de sesión como último recurso.
    // El cliente actual no lo envía. Lo que podemos hacer es que el cliente recupere su 'userId' de localStorage
    // y lo incluya en la solicitud de agregar canción.
    // Para no modificar el cliente ahora, haremos una suposición simple: el 'userId' es único por sesión
    // y lo derivamos del ID de sesión de express-session y posiblemente un nickname almacenado localmente.
    // La forma más robusta es que el cliente envíe su userId (el que tiene en localStorage).
    // Supongamos que el cliente *debería* enviarlo. Si no lo hace, lo dejamos como 'unknown_user'.
    // Modifiquemos el cliente para que lo envíe.
    // O, si el cliente guarda el 'userId' en localStorage, podemos intentar derivarlo de la sesión actual
    // si almacenamos temporalmente el nickname al iniciar sesión.
    // La solución más simple ahora es que el cliente envíe su 'userId' en el body de /add-to-playlist.
    // Supongamos que el cliente envía 'userId' (lo cual es lo ideal).
    const userIdFromBody = req.body.userId; // El cliente debe enviar su userId (el que guarda en localStorage)
    if (!userIdFromBody) {
        console.warn('⚠️ Cliente no envió userId al agregar canción. Ranking no actualizado para este usuario.');
        // Devolver éxito de la operación de YouTube, pero no actualizar ranking
        res.status(200).json({
          ok: true,
          message: 'Canción agregada exitosamente a la playlist',
          videoId: videoId,
          playlistItemId: response.data.id,
          timestamp: new Date().toISOString()
        });
        return;
    }

    // Cargar ranking actual
    let rankingData = await loadRankingFromFile();

    // Actualizar perfil del usuario
    const userKey = userIdFromBody; // Usar el userId enviado por el cliente
    if (!rankingData.users[userKey]) {
        // Si el usuario no existe en el ranking, lo creamos
        rankingData.users[userKey] = {
            nickname: req.body.nickname || 'Anónimo', // Otra forma de obtener el nombre si el cliente no lo envía bien
            points: 100,
            level: 1,
            songsAdded: 0,
            lastActive: new Date().toISOString()
        };
    }
    const user = rankingData.users[userKey];
    user.points += 10; // Sumar 10 puntos
    user.songsAdded = (user.songsAdded || 0) + 1; // Incrementar canciones
    user.level = Math.floor(user.points / 100) + 1; // Recalcular nivel
    user.lastActive = new Date().toISOString(); // Actualizar última actividad

    // Guardar ranking actualizado
    await saveRankingToFile(rankingData);

    res.status(200).json({
      ok: true,
      message: 'Canción agregada exitosamente a la playlist y puntos actualizados',
      videoId: videoId,
      playlistItemId: response.data.id,
      userPoints: user.points, // Enviar puntos actualizados al cliente (opcional)
      userLevel: user.level,   // Enviar nivel actualizado al cliente (opcional)
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error agregando video a playlist:', error);
    let errorMessage = 'Error al agregar canción';
    let requiresAuth = false;
    let statusCode = 500;

    if (error.code === 401 || error.response?.status === 401) {
      console.log('🔐 Se requiere autenticación');
      errorMessage = 'Unauthorized. Please authenticate first.';
      requiresAuth = true;
      statusCode = 401;
    } else if (error.response?.status === 403) {
      console.log('❌ Acceso denegado (verifica permisos de playlist)');
      errorMessage = 'Access denied. Check playlist permissions.';
      statusCode = 403;
    } else if (error.response?.status === 400) {
      console.log('❌ Solicitud inválida (verifica ID de video o playlist)');
      errorMessage = 'Invalid request. Check video ID or playlist ID.';
      statusCode = 400;
    }

    res.status(statusCode).json({
      ok: false,
      error: errorMessage,
      requiresAuth: requiresAuth
    });
  }
});


// Ruta para obtener perfil y ranking (MODIFICADA para leer del archivo)
app.get('/user/profile', async (req, res) => {
  const { userId } = req.query;
  console.log(`👤 Consulta de perfil: ${userId || 'anonymous'}`);

  try {
    // Cargar ranking desde archivo
    const rankingData = await loadRankingFromFile();

    // Obtener lista de usuarios ordenados por puntos (de mayor a menor)
    const allUsers = Object.entries(rankingData.users)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.points - a.points); // Ordenar por puntos descendente

    // Encontrar la posición del usuario solicitado
    const userIndex = allUsers.findIndex(u => u.id === userId);
    const user = userIndex !== -1 ? { ...allUsers[userIndex], rank: userIndex + 1 } : null;

    // Si no se encontró, devolver datos simulados o un usuario no clasificado
    if (!user) {
      res.json({
        ok: true,
        user: { rank: 0, nickname: userId || 'Invitado', points: 100, level: 1, songsAdded: 0 },
        topUsers: allUsers.slice(0, 10), // Mostrar top 10
        serverTime: new Date().toISOString(),
        totalUsers: allUsers.length,
        rankingUpdated: rankingData.lastUpdated
      });
      return;
    }

    // Devolver perfil del usuario y ranking
    res.json({
      ok: true,
      user: user,
      topUsers: allUsers.slice(0, 10), // Mostrar top 10
      serverTime: new Date().toISOString(),
      totalUsers: allUsers.length,
      rankingUpdated: rankingData.lastUpdated
    });

  } catch (error) {
    console.error('❌ Error cargando perfil/ranking:', error);
    // En caso de error al leer el archivo, devolver un ranking vacío o simulado
    res.status(500).json({
      ok: false,
      error: 'Error interno al cargar el ranking',
      user: { rank: 0, nickname: userId || 'Invitado', points: 100, level: 1, songsAdded: 0 },
      topUsers: []
    });
  }
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
    } else {
      console.log(`✅ ${varName}: Configurado`);
    }
  });
  if (missingVars.length > 0) {
    console.warn(`⚠️ ADVERTENCIA: Faltan ${missingVars.length} variables de entorno.`);
    missingVars.forEach(varName => console.log(` - ${varName}`));
    console.log('💡 Para desarrollo local, crea un archivo .env con estas variables.');
    console.log('💡 En Render, configúralas en las variables de entorno del servicio.');
  } else {
    console.log('🎉 ¡Todas las variables requeridas están configuradas!');
  }
}

app.listen(PORT, HOST, () => {
  console.log(`
    🎸 MOYOFY PREMIUM v2.0
    ==========================================
    ✅ Servidor iniciado exitosamente
    📍 URL: http://${HOST}:${PORT}
    ⏰ Hora de inicio: ${new Date().toISOString()}
    🌍 Entorno: ${process.env.NODE_ENV || 'development'}
    🚀 Node.js: ${process.version}
    📦 Memoria: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
    ==========================================
  `);

  checkConfiguration();

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