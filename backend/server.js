// backend/server.js
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const app = express();

// Permitir solicitudes desde localhost durante el desarrollo y desde tu dominio Render en producción
const allowedOrigins = ['http://localhost:3000', 'http://localhost:8080', process.env.RENDER_EXTERNAL_URL || 'https://movofy-rafasbar.onrender.com'];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public'))); // Sirve archivos estáticos desde /public

const oauth2Client = new google.auth.OAuth2(
    process.env.OAUTH_CLIENT_ID,
    process.env.OAUTH_CLIENT_SECRET,
    process.env.REDIRECT_URI // Esta variable debe apuntar al entorno correcto
);

const youtube = google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY
});

// --- RUTAS ---

// Ruta para iniciar la autenticación OAuth
app.get('/auth', (req, res) => {
    const scopes = ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/userinfo.email'];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent' // Fuerza la pantalla de consentimiento para obtener refresh_token si es necesario
    });
    res.redirect(url);
});

// Callback de OAuth
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Guardar temporalmente tokens en sesión o base de datos (idealmente usar Redis o DB)
        req.session = req.session || {};
        req.session.tokens = tokens;
        oauth2Client.credentials = tokens; // Actualiza el cliente OAuth con nuevos tokens

        res.redirect('/'); // Redirige a la página principal después de autenticar
    } catch (error) {
        console.error('Error obteniendo tokens:', error);
        res.status(500).send('Error al autenticar con Google.');
    }
});

// Ruta para buscar videos
app.post('/search', async (req, res) => {
    const { q } = req.body;
    if (!q) {
        return res.status(400).send('Consulta de búsqueda vacía');
    }

    try {
        const response = await youtube.search.list({
            part: 'snippet',
            q: q,
            maxResults: 10,
            type: 'video'
        });

        // Importar la función de filtro desde el archivo utils/music-filter.js
        const { filterMusic } = require('./utils/music-filter');

        // Aplicar el filtro a los resultados obtenidos
        const filteredItems = filterMusic(response.data.items);

        // Simular estadísticas de filtrado para el cliente (opcional)
        const stats = {
            totalResults: response.data.items.length,
            approved: filteredItems.length,
            approvalRate: response.data.items.length > 0 ? Math.round((filteredItems.length / response.data.items.length) * 100) : 0
        };

        res.json({ items: filteredItems, filterStats: stats });
    } catch (error) {
        console.error('Error buscando videos:', error);
        res.status(500).send('Error al buscar videos en YouTube.');
    }
});

// Ruta para agregar video a la playlist
app.post('/add-to-playlist', async (req, res) => {
    const { videoId } = req.body; // El cliente ahora envía videoId directamente
    const defaultPlaylistId = process.env.DEFAULT_PLAYLIST_ID;

    if (!defaultPlaylistId) {
        console.error('DEFAULT_PLAYLIST_ID no está definida en .env');
        return res.status(500).send('Playlist predeterminada no configurada.');
    }

    if (!videoId) {
        return res.status(400).send('Video ID es requerido');
    }

    try {
        // Verifica si el video ya está en la playlist
        const existingItemsResponse = await youtube.playlistItems.list({
            part: 'snippet',
            playlistId: defaultPlaylistId,
            videoId: videoId
        });

        if (existingItemsResponse.data.items.length > 0) {
             console.log(`Video ${videoId} ya está en la playlist.`);
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

         console.log(`Video ${videoId} agregado a la playlist ${defaultPlaylistId}.`);
         res.status(200).json({ ok: true, message: 'Video added to playlist successfully.' });

    } catch (error) {
        console.error('Error agregando video a la playlist:', error);
        // Podría ser un problema de autenticación si no se han obtenido tokens válidos
        if (error.code === 401) {
            res.status(401).json({ ok: false, error: 'Unauthorized. Please authenticate first.', requiresAuth: true });
        } else {
            res.status(500).json({ ok: false, error: 'Error adding video to playlist.', requiresAuth: false });
        }
    }
});

// Ruta para obtener el perfil del usuario y el ranking (simulada con datos básicos)
// En una implementación real, esto leería de una base de datos
app.get('/user/profile', (req, res) => {
    const { userId } = req.query;
    // Simular datos del ranking (en una implementación real, esto vendría de una DB)
    const mockRanking = [
        { rank: 1, nickname: 'RockMaster69', points: 500, level: 5 },
        { rank: 2, nickname: 'MetallicaFan', points: 420, level: 4 },
        { rank: 3, nickname: 'QueenLover', points: 380, level: 3 },
        { rank: 4, nickname: 'Sebas', points: 250, level: 2 },
        { rank: 5, nickname: 'Anon', points: 100, level: 1 }
    ];

    // Simular datos del usuario actual (si está en el ranking)
    let user = mockRanking.find(u => u.nickname === 'Sebas'); // Ejemplo, basado en nickname
    if (!user) {
        user = { rank: 0, nickname: userId || 'Anon', points: 100, level: 1 }; // Usuario no encontrado en ranking
    }

    res.json({
        ok: true,
        user: user,
        topUsers: mockRanking
    });
});

// Ruta principal (servirá index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 8080; // Usa el puerto de Render o 8080 local
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});