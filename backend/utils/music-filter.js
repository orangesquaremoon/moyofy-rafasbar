// backend/utils/music-filter.js
// ================================
// MOYOFY FILTER v4 - SISTEMA INTELIGENTE DE FILTRADO
// Optimizado para Rafa's Bar - Filtro de contexto mejorado
// ================================

// ✅ LISTA DE ARTISTAS PERMITIDOS (EXPANDIDA Y OPTIMIZADA)
const ALLOWED_ARTISTS = new Set([
    // Rock Clásico y Hard Rock
    "queen", "acdc", "ac/dc", "led zeppelin", "the beatles", "rolling stones",
    "pink floyd", "deep purple", "black sabbath", "jimi hendrix", "the doors",
    "aerosmith", "van halen", "scorpions", "def leppard", "journey", "eagles",
    "fleetwood mac", "tom petty", "lynyrd skynyrd", "creedence clearwater revival",
    "the who", "the kinks", "small faces", "faces", "bad company", "free",
    "mott the hoople", "slade", "t. rex", "roxy music", "genesis", "yes",
    "king crimson", "emerson lake & palmer", "jethro tull", "van morrison",
    "cat stevens", "carole king", "elton john", "stevie nicks", "bee gees",
    "abba", "kiss", "foreigner", "reo speedwagon", "styx", "boston", "heart",
    "pat benatar", "joan jett", "bob seger", "zz top", "steely dan",
    
    // Metal y Heavy Metal
    "metallica", "iron maiden", "slayer", "megadeth", "pantera", "judas priest",
    "motorhead", "ozzy osbourne", "tool", "system of a down", "rammstein", "korn",
    "slipknot", "mötley crüe", "guns n' roses", "van halen", "dio", "black label society",
    "soundgarden", "alice in chains", "stone temple pilots", "pearl jam", "nirvana",
    "foo fighters", "queens of the stone age", "mastodon", "gojira", "lamb of god",
    "opeth", "dream theater", "rush", "saxon", "danzig", "anthrax", "testament",
    "death", "cannibal corpse", "sepultura", "meshuggah", "in flames", "children of bodom",
    
    // Rock Alternativo e Indie
    "radiohead", "the smashing pumpkins", "red hot chili peppers", "the strokes",
    "arcade fire", "interpol", "the white stripes", "muse", "coldplay", "u2", "rem",
    "weezer", "green day", "the offspring", "blink-182", "rancid", "no doubt", "bush",
    "stone roses", "the cure", "depeche mode", "joy division", "new order", "the smiths",
    "echo & the bunnymen", "television", "pixies", "sonic youth", "dinosaur jr",
    "pavement", "guided by voices", "neutral milk hotel", "modest mouse", "built to spill",
    
    // Rock en Español
    "soda stereo", "gustavo cerati", "caifanes", "jaguares", "café tacvba",
    "enjambre", "zoé", "mana", "los bunkers", "los tres", "los prisioneros",
    "heroes del silencio", "extremoduro", "platero y tu", "barricada", "marea",
    "la ley", "cerati", "andrés calamaro", "fito páez", "charly garcía", "serú girán",
    
    // Rock Industrial y Experimental
    "nine inch nails", "ministry", "killing joke", "front 242", "front line assembly",
    "skinny puppy", "kmfdm", "pig", "revolting cocks", "wumpscut", "velvet acid christ",
    
    // Classic Punk
    "sex pistols", "the clash", "ramones", "dead kennedys", "black flag", "misfits",
    "bad brains", "minor threat", "descendents", "circle jerks", "dead milkmen",
    
    // Rock Progresivo
    "porcupine tree", "the mars volta", "coheed and cambria", "spock's beard",
    "transatlantic", "neal morse", "flower kings", "roine stolt",
    
    // Stoner Rock y Doom Metal
    "kyuss", "queens of the stone age", "sleep", "electric wizard", "om", "earth",
    "high on fire", "clutch", "the sword", "orange goblin", "brant bjork",
    
    // Blues Rock
    "eric clapton", "cream", "john mayer", "stevie ray vaughan", "bb king",
    "buddy guy", "gary clark jr", "the black keys", "the raconteurs",
    
    // Classic Rock Español
    "triana", "camilo sesto", "julio iglesias", "mecano", "radio futura",
    "tequila", "nacha pop", "los secretos", "loquillo", "rosendo"
].map(artist => artist.toLowerCase()));

// ✅ GÉNEROS PERMITIDOS (PARA CONTEXTO)
const ALLOWED_GENRES = new Set([
    "rock", "metal", "hard rock", "heavy metal", "alternative", "indie",
    "punk", "grunge", "progressive", "prog", "stoner", "doom", "sludge",
    "industrial", "gothic", "post-punk", "new wave", "post-rock", "math rock",
    "shoegaze", "noise rock", "psychedelic", "blues rock", "southern rock",
    "classic rock", "arena rock", "glam rock", "art rock", "experimental",
    "hardcore", "emo", "post-hardcore", "metalcore", "deathcore", "black metal",
    "thrash metal", "power metal", "folk metal", "symphonic metal", "nu metal",
    "funk rock", "garage rock", "surf rock", "rock and roll", "rockabilly"
]);

// ❌ LISTA DE PALABRAS PROHIBIDAS OPTIMIZADA
// Solo términos que claramente indican géneros no deseados
const FORBIDDEN_KEYWORDS = [
    // Géneros explícitamente no permitidos
    "reggaeton", "trap latino", "urbano latino", "bachata", "salsa", "merengue",
    "cumbia", "vallenato", "ranchera", "corrido", "banda", "norteño", "mariachi",
    "música popular", "pop latino", "balada romántica", "balada pop",
    
    // Términos que indican contenido no musical
    "podcast", "entrevista", "talk show", "documental", "making of",
    "behind the scenes", "lyric video", "video oficial", "tutorial", "cover tutorial",
    "how to play", "lesson", "tabs", "partitura", "karaoke version", "instrumental only",
    
    // Contenido religioso o político
    "worship", "gospel", "cristiano", "religioso", "oración", "alabanza",
    "político", "propaganda", "activismo", "protesta",
    
    // Géneros electrónicos puros (no industrial)
    "edm", "dance pop", "house", "techno", "trance", "dubstep", "drum and bass",
    "electro", "synthpop", "eurodance", "hardstyle", "hardcore", "happy hardcore",
    
    // Pop comercial y teen pop
    "boy band", "girl group", "teen pop", "bubblegum pop", "dance-pop", "pop teen",
    
    // Contenido infantil
    "infantil", "niños", "kids", "children", "nursery", "lullaby", "canciones infantiles",
    
    // Música para eventos específicos (no bar)
    "wedding", "boda", "ceremonia", "graduation", "graduación", "funeral"
].map(keyword => keyword.toLowerCase());

// ❌ TÉRMINOS DE VERSIÓN NO DESEADOS (solo cuando no hay artista permitido)
const UNWANTED_VERSION_KEYWORDS = [
    "acoustic cover", "cover acoustic", "karaoke", "tribute band", "cover band",
    "tribute version", "piano cover", "guitar cover", "remix", "mashup", "medley",
    "live at", "session", "unplugged", "acoustic session", "reaction", "react"
];

/**
 * Sistema de puntuación para determinar si un video es apropiado
 * @param {Object} item - Item de YouTube
 * @returns {Object} - {score: number, reasons: string[]}
 */
function calculateMusicScore(item) {
    const title = item.snippet.title.toLowerCase();
    const description = item.snippet.description ? item.snippet.description.toLowerCase() : '';
    const channelTitle = item.snippet.channelTitle.toLowerCase();
    const combinedText = `${title} ${description} ${channelTitle}`;
    
    let score = 0;
    const reasons = [];
    
    // 1. Verificar artistas permitidos (PUNTUACIÓN ALTA)
    let containsAllowedArtist = false;
    let matchedArtist = '';
    
    for (const artist of ALLOWED_ARTISTS) {
        // Buscar artista en el título o canal
        const artistRegex = new RegExp(`\\b${artist}\\b`, 'i');
        if (artistRegex.test(title) || artistRegex.test(channelTitle)) {
            containsAllowedArtist = true;
            matchedArtist = artist;
            score += 100; // Puntuación máxima por artista permitido
            reasons.push(`✅ Artista permitido: ${artist}`);
            break;
        }
    }
    
    // 2. Si no hay artista directo, buscar en descripción
    if (!containsAllowedArtist) {
        for (const artist of ALLOWED_ARTISTS) {
            const artistRegex = new RegExp(`\\b${artist}\\b`, 'i');
            if (artistRegex.test(combinedText)) {
                containsAllowedArtist = true;
                matchedArtist = artist;
                score += 50; // Puntuación menor si está solo en descripción
                reasons.push(`✅ Artista en descripción: ${artist}`);
                break;
            }
        }
    }
    
    // 3. Verificar géneros permitidos en canal/título
    for (const genre of ALLOWED_GENRES) {
        const genreRegex = new RegExp(`\\b${genre}\\b`, 'i');
        if (genreRegex.test(channelTitle) || genreRegex.test(title)) {
            score += 30;
            reasons.push(`🎸 Género permitido: ${genre}`);
        }
    }
    
    // 4. Penalizar palabras prohibidas (solo si no hay artista permitido claro)
    if (!containsAllowedArtist || score < 80) {
        FORBIDDEN_KEYWORDS.forEach(keyword => {
            const keywordRegex = new RegExp(`\\b${keyword}\\b`, 'i');
            if (keywordRegex.test(combinedText)) {
                score -= 40; // Penalización alta
                reasons.push(`❌ Género no permitido: ${keyword}`);
            }
        });
    }
    
    // 5. Penalizar versiones no deseadas (solo si no hay artista permitido)
    if (!containsAllowedArtist) {
        UNWANTED_VERSION_KEYWORDS.forEach(keyword => {
            const keywordRegex = new RegExp(`\\b${keyword}\\b`, 'i');
            if (keywordRegex.test(title)) {
                score -= 20;
                reasons.push(`⚠️ Versión no deseada: ${keyword}`);
            }
        });
    }
    
    // 6. Bonus por términos de rock/metal en título
    const rockTerms = ["rock", "metal", "punk", "grunge", "hardcore", "heavy", "guitar", "riff"];
    rockTerms.forEach(term => {
        const termRegex = new RegExp(`\\b${term}\\b`, 'i');
        if (termRegex.test(title)) {
            score += 15;
            reasons.push(`🎵 Término de rock: ${term}`);
        }
    });
    
    // 7. Penalizar términos de pop comercial
    if (!containsAllowedArtist) {
        const popTerms = ["pop song", "top 40", "hit single", "radio hit", "chart", "billboard"];
        popTerms.forEach(term => {
            const termRegex = new RegExp(`\\b${term}\\b`, 'i');
            if (termRegex.test(title) || termRegex.test(description)) {
                score -= 25;
                reasons.push(`📻 Contenido pop comercial: ${term}`);
            }
        });
    }
    
    // 8. Bonus por canales oficiales
    const officialTerms = ["official", "vevo", "topic"];
    officialTerms.forEach(term => {
        const termRegex = new RegExp(`\\b${term}\\b`, 'i');
        if (termRegex.test(channelTitle)) {
            score += 10;
            reasons.push(`🏢 Canal oficial`);
        }
    });
    
    // 9. Penalizar videos demasiado cortos o largos (por título)
    const durationIndicators = ["short", "clip", "preview", "teaser", "excerpt", "full album", "complete"];
    durationIndicators.forEach(term => {
        const termRegex = new RegExp(`\\b${term}\\b`, 'i');
        if (termRegex.test(title)) {
            score -= 10;
            reasons.push(`⏱️ Indicador de duración: ${term}`);
        }
    });
    
    return { score, reasons, containsAllowedArtist, matchedArtist };
}

/**
 * Filtra videos basado en un sistema de puntuación inteligente
 * @param {Array} items - Array de items de YouTube
 * @returns {Array} - Items filtrados con metadata
 */
function filterMusic(items) {
    if (!items || items.length === 0) {
        console.log('📭 No hay items para filtrar');
        return [];
    }
    
    const filtered = [];
    const stats = {
        total: items.length,
        approved: 0,
        rejected: 0,
        rejectedReasons: {},
        scores: []
    };
    
    items.forEach(item => {
        const { score, reasons, containsAllowedArtist, matchedArtist } = calculateMusicScore(item);
        
        // Guardar score para estadísticas
        stats.scores.push(score);
        
        // UMBRAL DE APROBACIÓN:
        // - 70+ puntos: Aprobado automáticamente
        // - 50-69: Aprobado si contiene artista permitido
        // - Menos de 50: Rechazado
        
        let approved = false;
        
        if (score >= 70) {
            approved = true;
        } else if (score >= 50 && containsAllowedArtist) {
            approved = true;
        } else if (score >= 60 && !containsAllowedArtist) {
            // Caso especial: alto score sin artista específico
            approved = true;
        }
        
        if (approved) {
            filtered.push(item);
            stats.approved++;
            
            // Agregar metadata de puntuación para debugging
            item.filterMetadata = {
                score,
                artistMatched: matchedArtist || null,
                approved: true
            };
            
            if (process.env.NODE_ENV === 'development') {
                console.log(`✅ Aprobado [${score} pts]: ${item.snippet.title}`);
                if (matchedArtist) console.log(`   Artista: ${matchedArtist}`);
            }
        } else {
            stats.rejected++;
            const mainReason = reasons.length > 0 ? reasons.find(r => r.includes('❌') || r.includes('⚠️')) || reasons[0] : 'Score bajo';
            const reasonKey = mainReason.replace(/✅|❌|⚠️|🎸|🎵|📻|⏱️|🏢/g, '').trim();
            stats.rejectedReasons[reasonKey] = (stats.rejectedReasons[reasonKey] || 0) + 1;
            
            // Solo loguear si es útil para debugging
            if (process.env.NODE_ENV === 'development') {
                console.log(`❌ Rechazado [${score} pts]: ${item.snippet.title}`);
                reasons.forEach(reason => console.log(`   ${reason}`));
            }
        }
    });
    
    // Log de estadísticas
    const avgScore = stats.scores.length > 0 ? Math.round(stats.scores.reduce((a, b) => a + b) / stats.scores.length) : 0;
    const approvalRate = Math.round((stats.approved / stats.total) * 100);
    
    console.log(`📊 Filtro de música:`);
    console.log(`   Total: ${stats.total} videos`);
    console.log(`   Aprobados: ${stats.approved} (${approvalRate}%)`);
    console.log(`   Rechazados: ${stats.rejected}`);
    console.log(`   Score promedio: ${avgScore}`);
    
    if (Object.keys(stats.rejectedReasons).length > 0) {
        console.log(`   Razones de rechazo:`);
        Object.entries(stats.rejectedReasons).forEach(([reason, count]) => {
            console.log(`     - ${reason}: ${count}`);
        });
    }
    
    return filtered;
}

// Función auxiliar para verificar si un término específico está permitido
function isArtistAllowed(artistName) {
    return ALLOWED_ARTISTS.has(artistName.toLowerCase());
}

// Función auxiliar para verificar si un género está permitido
function isGenreAllowed(genreName) {
    return ALLOWED_GENRES.has(genreName.toLowerCase());
}

module.exports = { 
    filterMusic, 
    calculateMusicScore,
    isArtistAllowed,
    isGenreAllowed,
    ALLOWED_ARTISTS: Array.from(ALLOWED_ARTISTS),
    ALLOWED_GENRES: Array.from(ALLOWED_GENRES)
};