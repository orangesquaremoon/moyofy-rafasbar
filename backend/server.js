require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require("express");
const session = require('express-session');
const cors = require("cors");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

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

const userOauth2Client = new google.auth.OAuth2(
  process.env.OAUTH_CLIENT_ID,
  process.env.OAUTH_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const userYoutube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });

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

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON mal formado:', err.message);
    return res.status(400).json({ ok: false, error: 'JSON mal formado en la solicitud' });
  }
  next();
});

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

app.get('/owner/auth', (req, res) => {
  console.log('🔐 Iniciando autenticación del PROPIETARIO');

  const scopes = [
    'https://www.googleapis.com/auth/youtube'
  ];

  const url = ownerOauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state: 'owner'
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
      <html>
        <body style="font-family:Arial;padding:20px">
          <h2>✅ Autenticación del PROPIETARIO completada</h2>
          <p>Copia el JSON que aparece en los logs de Render y pégalo como:</p>
          <pre>OWNER_TOKENS_JSON</pre>
          <p>Luego guarda y deja que Render haga redeploy.</p>
          <p>Puedes cerrar esta ventana.</p>
        </body>
      </html>
    `);
    } catch (err) {
      console.error('❌ Error OAuth PROPIETARIO:', err);
      return res.status(500).send('Error autenticando propietario');
    }
  }

  const { error } = req.query;
  
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
    
    console.log('🔥🔥🔥 OWNER TOKENS JSON 🔥🔥🔥');
    console.log(JSON.stringify(tokens, null, 2));
    
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

app.post('/search', async (req, res) => {
  const { q } = req.body;
  
  if (!q || q.trim() === '') {
    return res.status(400).json({ 
      ok: false, 
      error: 'La consulta de búsqueda no puede estar vacía'
    });
  }

  console.log(`🔍 Búsqueda recibida: "${q}"`);
  
  try {
    const response = await userYoutube.search.list({
      part: 'snippet',
      q: q,
      maxResults: 15,
      type: 'video'
    });

    console.log(`📥 YouTube API respondió con ${response.data.items?.length || 0} resultados`);

    const filteredItems = filterRockMusic(response.data.items || []);

    const stats = {
      totalResults: response.data.items?.length || 0,
      approved: filteredItems.length,
      approvalRate: response.data.items?.length > 0
        ? Math.round((filteredItems.length / response.data.items.length) * 100)
        : 0,
      query: q,
      timestamp: new Date().toISOString()
    };

    console.log(`✅ Resultados filtrados: ${stats.approved}/${stats.totalResults} (${stats.approvalRate}%) aprobados`);

    res.json({
      ok: true,
      items: filteredItems,
      filterStats: stats,
      originalQuery: q,
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
      }
    }

    res.status(statusCode).json({
      ok: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

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
          error: 'VIDEO_DUPLICATE',
          message: 'El video ya existe en la playlist'
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

app.get('/user/profile', (req, res) => {
  const { userId } = req.query;
  console.log(`👤 Consulta de perfil: ${userId || 'anonymous'}`);

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

app.get('/health', (req, res) => {
  const health = {
    ok: true,
    service: 'MOYOFY Premium API',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    },
    youtubeApi: process.env.YOUTUBE_API_KEY ? '✅ Configured' : '❌ Not Configured',
    playlist: process.env.DEFAULT_PLAYLIST_ID ? '✅ Configured' : '❌ Not Configured'
  };
  console.log('🩺 Health check realizado');
  res.json(health);
});

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

app.use((error, req, res, next) => {
  console.error('❌ Error global:', error);
  res.status(500).json({
    ok: false,
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
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
        : process.env[varName];
      console.log(`✅ ${varName}: ${value}`);
    }
  });
  
  if (missingVars.length > 0) {
    console.error(`\n❌ ADVERTENCIA: Faltan ${missingVars.length} variables requeridas.`);
  } else {
    console.log('\n🎉 ¡Todas las variables requeridas están configuradas!');
  }
}

app.listen(PORT, HOST, () => {
  console.log(`
    🎸 MOYOFY PREMIUM v2.0
    ==========================================
    ✅ Servidor iniciado exitosamente
    📍 URL: http://${HOST}:${PORT}
    ⏰ Hora de inicio: ${new Date().toLocaleString()}
    🌍 Entorno: ${process.env.NODE_ENV || 'development'}
    🚀 Node.js: ${process.version}
    📦 Memoria: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
    ==========================================
  `);

  checkConfiguration();

  console.log('\n📚 Rutas disponibles:');
  console.log(' GET / - Interfaz web principal con gamificación');
  console.log(' POST /search - Buscar canciones de rock');
  console.log(' POST /suggest-song - Agregar canción a playlist');
  console.log(' GET /auth - Autenticación con Google');
  console.log(' GET /user/profile - Perfil de usuario (compatibilidad)');
  console.log(' GET /health - Estado del servidor');
  console.log('==========================================');
});