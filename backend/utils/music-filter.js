// backend/utils/music-filter.js
// Versión optimizada con listas completas de artistas permitidos y prohibidos

const normalize = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s&\/\-\.]/gi, '')
    .toLowerCase();

// ✅ ARTISTAS PERMITIDOS (Lista completa con Korn, Marillion y más)
const allowedArray = [
"Queen","AC/DC","Led Zeppelin","The Beatles","The Rolling Stones","Pink Floyd","Deep Purple","Black Sabbath","Jimi Hendrix","The Doors","Aerosmith","Van Halen","Scorpions","Def Leppard","Journey","Eagles","Fleetwood Mac","Tom Petty","Lynyrd Skynyrd","Creedence Clearwater Revival","The Who","The Kinks","Faces","Bad Company","Free","Mott The Hoople","Slade","T. Rex","Roxy Music","Genesis","Yes","King Crimson","Emerson Lake & Palmer","Jethro Tull","Van Morrison","Cat Stevens","Elton John","Bob Dylan","Neil Young","David Bowie","Kiss","Thin Lizzy","Status Quo","The Pretenders","The Police","Sting","Duran Duran","Spandau Ballet","Eurythmics","Simple Minds","The Smiths","Morrissey","Joy Division","New Order","Echo & The Bunnymen","U2","The Cure","Siouxsie And The Banshees","The Clash","Blue Oyster Cult","The Cult","The Church","The Replacements","Meat Loaf","Alice Cooper","Mötley Crüe","Poison","Winger","Mr. Big","Extreme","Living Colour","Primus","Faith No More","Mr. Bungle","Soundgarden","Alice In Chains","Stone Temple Pilots","Smashing Pumpkins","Radiohead","Blur","Oasis","Pulp","Suede","Pixies","Nirvana","R.E.M.","The Strokes","Interpol","The White Stripes","The Black Keys","Arctic Monkeys","The Killers","Kings Of Leon","Muse","Foo Fighters","Green Day","Blink-182","Sum 41","The Offspring","Weezer","Modest Mouse","Sonic Youth","Pavement","Belle & Sebastian","The National","Arcade Fire","Yeah Yeah Yeahs","The Libertines","Kasabian","Franz Ferdinand","My Bloody Valentine","Stereophonics","Manic Street Preachers","Editors","Mogwai","Travis","Doves","Suicidal Tendencies","Bad Religion","NOFX","Ramones","Sex Pistols","The Damned","Buzzcocks","Dropkick Murphys","Social Distortion","Rancid","The Misfits","Black Flag","Pennywise","Minor Threat","Against Me!","Refused","At The Drive-In","Glassjaw","Fugazi","Helmet","Jawbreaker","Descendents","Dead Kennedys","Tool","A Perfect Circle","Deftones","Korn","Slipknot","System Of A Down","Sepultura","Pantera","Anthrax","Megadeth","Metallica","Iron Maiden","Judas Priest","Slayer","Motörhead","Dio","Savatage","Testament","Overkill","Children Of Bodom","Opeth","Dream Theater","Mastodon","Gojira","Avenged Sevenfold","Disturbed","Five Finger Death Punch","Trivium","In Flames","At The Gates","Meshuggah","Behemoth","Cannibal Corpse","Carcass","Death","Obituary","Napalm Death","Type O Negative","Rammstein","Kraftwerk","Santana","Soda Stereo","Gustavo Cerati","Charly Garcia","Luis Alberto Spinetta","Los Enanitos Verdes","Enanitos Verdes","Héroes Del Silencio","Heroes Del Silencio","Enrique Bunbury","Bunbury","Caifanes","Cafe Tacvba","Café Tacvba","Maná","Molotov","Zoé","Babasónicos","Los Prisioneros","Los Fabulosos Cadillacs","Los Bunkers","La Ley","Los Tres","Fobia","Fito Paez","Andres Calamaro","Patricio Rey y sus Redonditos de Ricota","Redondos","Rata Blanca","Malón","Hermetica","Almafuerte","A.N.I.M.A.L.","Los Rodriguez","Ciro y los Persas","Divididos","Los Autenticos Decadentes","Siniestro Total","Barricada","Extremoduro","Platero y Tu","Ilegales","Baron Rojo","Barón Rojo","Miguel Rios","M Clan","Hombres G","Leño","Rosendo","Tequila","Los Secretos","Duncan Dhu","Burning","El Ultimo de la Fila","Los Enemigos","Los Planetas","Dorian","Vetusta Morla","Leiva","Fangoria","Niños Mutantes","Mago de Oz","WarCry","Saratoga","Obus","Los Suaves","Ñu","Dover","Ska-P","Pendulum","Goldfrapp","The Cranberries","The Breeders","Supergrass","Ocean Colour Scene","The Stone Roses","Happy Mondays","The La's","Primal Scream","The Verve","Oasis","Echo and the Bunnymen","The Jam","Stereolab","The Jesus and Mary Chain","My Chemical Romance","Fall Out Boy","Paramore","Evanescence","Breaking Benjamin","Chevelle","Seether","Silverchair","Anathema","P.O.D.","Incubus","Hoobastank","3 Doors Down","Shinedown","Alter Bridge","Creed","Live","Collective Soul","Bush","Staind","Sevendust","Saliva","Godsmack","Daughtry","Nickelback","Theory of a Deadman","Crossfade","Three Days Grace","Thrice","Story of the Year","Dashboard Confessional","The Used","Taking Back Sunday","Senses Fail","Circa Survive","Thompson","Los Tres","La Renga","Rush","Yes (band)","Gentle Giant","Camel","King Crimson","Marillion","Steve Hackett","Peter Gabriel","Genesis (classic)","Van der Graaf Generator","Caravan","Magnum","Jethro Tull (listed)","Camel (listed again)","Asia","The Police (listed)","Uriah Heep","Golden Earring","Shocking Blue","The Moody Blues","Status Quo (listed)","Toto","Boston","Foreigner","Asia (duplicate removed)","Styx","Journey (listed)","REO Speedwagon","Tom Petty and the Heartbreakers","The Allman Brothers Band","ZZ Top","The Band (listed)","Grateful Dead","Steppenwolf","Buffalo Springfield","Jefferson Airplane","Creedence (listed)","Iron Butterfly","Blue Cheer","Big Brother and the Holding Company","MC5","The Stooges","New York Dolls","Velvet Underground","The Velvet Underground","Joan Jett & the Blackhearts","Blondie","Pat Benatar","Heart","The Runaways","Siouxsie (listed)","Veruca Salt","Sonic Youth (listed)","Hole","L7","Babes in Toyland","The Dandy Warhols","Electric Light Orchestra","Beastie Boys (rock/rap crossover)","Los Lobos","Los Llay Llay (placeholder)"
].filter(Boolean);

// ❌ ARTISTAS PROHIBIDOS (Lista específica de artistas no deseados)
const forbiddenArray = [
"Taylor Swift","Ed Sheeran","Ariana Grande","Justin Bieber","Katy Perry","Bruno Mars","The Weeknd","Billie Eilish","Olivia Rodrigo","Dua Lipa","Doja Cat","Lizzo","Sia","Kygo","Shakira","Enrique Iglesias","Luis Fonsi","Rosalia","Pablo Alboran","Miguel Bose","Manuel Carrasco","Alejandro Sanz","Juanes","Maluma","J Balvin","Bad Bunny","Ozuna","Anuel AA","Karol G","Becky G","Natti Natasha","Reik","Morat","Camila Cabello","Nicky Jam","C Tangana","Mala Rodriguez","Nathy Peluso","Farruko","Wisin & Yandel","Luis Miguel","Daddy Yankee","Don Omar","Tego Calderon","Ivy Queen","Ricky Martin","Marc Anthony","Jennifer Lopez","Thalia","Paulina Rubio","CNCO","Prince Royce","Romeo Santos","Aventura","Monchy & Alexandra","Frank Reyes","Elvis Crespo","Olga Tañon","Sergio Vargas","Juan Luis Guerra","Carlos Vives","Sebastian Yatra","Camilo","Feid","Jhay Cortez","Sech","Rauw Alejandro","Myke Towers","Lunay","Plan B","Arcangel","Zion & Lennox","Chencho Corleone","Tainy","Anitta","Pabllo Vittar","Ivete Sangalo","Claudia Leitte","Gilberto Santa Rosa","Hector Lavoe","Willie Colon","Celia Cruz","Ruben Blades","Victor Manuelle","La India","David Guetta","Calvin Harris","Tiësto","Marshmello","Diplo","Skrillex","Major Lazer","The Chainsmokers","Avicii","Zedd","Afrojack","Martin Garrix","Hardwell","Khalid","Drake","Travis Scott","Kendrick Lamar","Cardi B","Nicki Minaj","Jay-Z","Beyonce","Rihanna","Adele","Celine Dion","Whitney Houston","Mariah Carey","Usher","Ne-Yo","Alicia Keys","Sam Smith","Shawn Mendes","Charlie Puth","Miley Cyrus","Selena Gomez","Demi Lovato","Lorde","Halsey","Ellie Goulding","Jonas Brothers","Maroon 5","Pitbull","Flo Rida","Jason Derulo","Sergio Mendes","Hinder"
].filter(Boolean);

// Crear Sets para búsqueda eficiente
const ALLOWED_ARTISTS = new Set(allowedArray.map(a => normalize(a)).filter(Boolean));
const FORBIDDEN_ARTISTS = new Set(forbiddenArray.map(a => normalize(a)).filter(Boolean));

/**
 * Verifica si un texto contiene algún término de un Set
 * @param {string} text - Texto a analizar
 * @param {Set} setOfNormalized - Set de términos normalizados
 * @returns {boolean} - true si contiene algún término
 */
function containsAnyNormalized(text, setOfNormalized) {
  if (!text) return false;
  const normalizedText = normalize(text);
  for (const term of setOfNormalized) {
    if (term && normalizedText.includes(term)) {
      return true;
    }
  }
  return false;
}

/**
 * Filtra items de YouTube para permitir solo artistas de rock/metal
 * @param {Array} items - Array de items de la API de YouTube
 * @returns {Array} - Array de items filtrados
 */
function filterMusic(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => {
    if (!item || !item.snippet) return false;
    
    const title = String(item.snippet.title || '');
    const description = String(item.snippet.description || '');
    const channelTitle = String(item.snippet.channelTitle || '');
    const combined = `${title} ${description} ${channelTitle}`;
    
    // Primero: Verificar artistas prohibidos (tiene prioridad)
    if (containsAnyNormalized(combined, FORBIDDEN_ARTISTS)) {
      console.log(`🎵 Rechazado por artista prohibido: ${title}`);
      return false;
    }
    
    // Segundo: Verificar si contiene algún artista permitido
    const containsAllowed = containsAnyNormalized(combined, ALLOWED_ARTISTS);
    if (!containsAllowed) {
      console.log(`🎵 Rechazado por artista no permitido: ${title}`);
      return false;
    }
    
    console.log(`✅ Aprobado: ${title} (contiene artista permitido)`);
    return true;
  });
}

// Exportar funciones y sets para usar en otros archivos
module.exports = { 
  filterMusic, 
  ALLOWED_ARTISTS, 
  FORBIDDEN_ARTISTS,
  containsAnyNormalized,
  normalize
};