// backend/utils/music-filter.js
// MOYOFY PREMIUM v2.0 - SISTEMA INTELIGENTE DE FILTRADO POR ARTISTAS
// Rafa's Bar - Versión Premium: Solo artistas/bandas permitidos y prohibidos explícitos
// ================================================================

// ✅ FUNCIÓN DE NORMALIZACIÓN (elimina acentos, símbolos y convierte a minúsculas)
const normalize = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s&\/\-\.]/gi, '')
    .toLowerCase();

// ✅ ARTISTAS Y BANDAS PERMITIDOS (Lista Blanca - EXCLUSIVAMENTE ESTOS)
// Lista de artistas/bandas permitidos. El sistema buscará coincidencias exactas (insensibles a mayúsculas/minúsculas) de estas palabras
// en el título, descripción y nombre del canal del video.
// NOTA: Esta es una lista de ejemplo. DEBES reemplazarla con TU lista completa de artistas permitidos.
// Los artistas de rock, metal, punk, etc. deben estar aquí.
const ALLOWED_ARTISTS = new Set([
    // Rock Clásico y Hard Rock
    "queen", "acdc", "ac/dc", "led zeppelin", "the beatles", "rolling stones",
    "pink floyd", "deep purple", "black sabbath", "jimi hendrix", "the doors",
    "aerosmith", "van halen", "scorpions", "def leppard", "journey", "eagles",
    "fleetwood mac", "tom petty", "lynyrd skynyrd", "creedence clearwater revival",
    "the who", "the kinks", "faces", "bad company", "free", "mott the hoople",
    "slade", "t. rex", "roxy music", "genesis", "yes", "king crimson",
    "emerson lake & palmer", "jethro tull", "van morrison", "cat stevens", "elton john",
    "bob dylan", "neil young", "david bowie", "kiss", "thin lizzy", "status quo",
    "the pretenders", "the police", "sting", "duran duran", "spandau ballet", "eurythmics",
    "simple minds", "the smiths", "morrissey", "joy division", "new order",
    "echo & the bunnymen", "u2", "the cure", "siouxsie and the banshees", "the clash",
    "blue oyster cult", "the cult", "the church", "the replacements", "meat loaf",
    "alice cooper", "mötley crüe", "poison", "winger", "mr. big", "extreme",
    "living colour", "primus", "faith no more", "mr. bungle", "soundgarden",
    "alice in chains", "stone temple pilots", "smashing pumpkins", "radiohead",
    "blur", "oasis", "pulp", "suede", "pixies", "nirvana", "r.e.m.", "the strokes",
    "interpol", "the white stripes", "the black keys", "arctic monkeys", "the killers",
    "kings of leon", "muse", "foo fighters", "green day", "blink-182", "sum 41",
    "the offspring", "weezer", "modest mouse", "sonic youth", "pavement",
    "belle & sebastian", "the national", "arcade fire", "yeah yeah yeahs",
    "the libertines", "kasabian", "franz ferdinand", "my bloody valentine",
    "stereophonics", "manic street preachers", "editors", "mogwai", "travis",
    "doves", "suicidal tendencies", "bad religion", "n ofx", "ramones", "sex pistols",
    "the damned", "buzzcocks", "dropkick murphys", "social distortion", "rancid",
    "the misfits", "black flag", "pennywise", "minor threat", "against me!",
    "refused", "at the drive-in", "glassjaw", "fugazi", "helmet", "jawbreaker",
    "descendents", "dead kennedys", "tool", "a perfect circle", "deftones",
    "korn", "slipknot", "system of a down", "sepultura", "pantera", "anthrax",
    "megadeth", "metallica", "iron maiden", "judas priest", "slayer", "motörhead",
    "dio", "savatage", "testament", "overkill", "children of bodom", "opeth",
    "dream theater", "mastodon", "gojira", "avenged sevenfold", "disturbed",
    "five finger death punch", "trivium", "in flames", "at the gates", "meshuggah",
    "behemoth", "cannibal corpse", "carcass", "death", "obituary", "napalm death",
    "type o negative", "rammstein", "kraftwerk", "santana", "soda stereo",
    "gustavo cerati", "charly garcia", "luis alberto spinetta", "los enanitos verdes",
    "enrique bunbury", "bunbury", "caifanes", "cafe tacvba", "maná", "molotov",
    "zoe", "babasonicos", "los prisioneros", "los fabulosos cadillacs", "los bunkers",
    "la ley", "los tres", "fobia", "fito paez", "andres calamaro", "patricio rey y sus redonditos de ricota",
    "redondos", "rata blanca", "malón", "hermetica", "almafuerte", "a.n.i.m.a.l.",
    "los rodriguez", "ciro y los persas", "divididos", "los autenticos decadentes",
    "siniestro total", "barricada", "extremoduro", "platero y tu", "ilegales",
    "baron rojo", "miguel rios", "m clan", "hombres g", "leño", "rosendo", "tequila",
    "los secretos", "duncan dhu", "burning", "el ultimo de la fila", "los enemigos",
    "los planetas", "dorian", "vetusta morla", "leiva", "fangoria", "niños mutantes",
    "mago de oz", "warcry", "saratoga", "obus", "los suaves", "ñu", "dover", "ska-p",
    "pendulum", "goldfrapp", "the cranberries", "the breeders", "supergrass",
    "ocean colour scene", "the stone roses", "happy mondays", "the la's",
    "primal scream", "the verve", "oasis", "echo and the bunnymen", "the jam",
    "stereolab", "the jesus and mary chain", "my chemical romance", "fall out boy",
    "paramore", "evanescence", "breaking benjamin", "chevelle", "seether", "silverchair",
    "anathema", "p.o.d.", "incubus", "hoobastank", "3 doors down", "shinedown",
    "alter bridge", "creed", "live", "collective soul", "bush", "staind", "sevendust",
    "saliva", "godsmack", "daughtry", "nickelback", "theory of a deadman", "crossfade",
    "three days grace", "thrice", "story of the year", "dashboard confessional",
    "the used", "taking back sunday", "senses fail", "circa survive", "thompson",
    "los tres", "la renga", "rush", "gentle giant", "camel", "marillion",
    "steve hackett", "peter gabriel", "van der graaf generator", "caravan",
    "magnum", "toto", "boston", "foreigner", "asia", "styx", "re o speedwagon",
    "tom petty and the heartbreakers", "the allman brothers band", "zz top",
    "the band", "grateful dead", "steppenwolf", "buffalo springfield", "jefferson airplane",
    "creedence", "iron butterfly", "blue cheer", "big brother and the holding company",
    "mc5", "the stooges", "new york dolls", "velvet underground", "joan jett & the blackhearts",
    "blondie", "pat benatar", "heart", "the runaways", "siouxsie", "veruca salt",
    "sonic youth", "hole", "l7", "babes in toyland", "the dandy warhols", "electric light orchestra",
    "beastie boys (rock/rap crossover)", "los lobos", "los llay llay"
].map(artist => artist.toLowerCase()).filter(Boolean));

// ✅ ARTISTAS Y BANDAS PROHIBIDOS (Lista Negra - EXCLUSIVAMENTE ESTOS)
// Lista de artistas/bandas PROHIBIDOS. El sistema rechazará cualquier video que contenga estos nombres
// en el título, descripción o nombre del canal.
// NOTA: Esta es una lista de ejemplo. DEBES reemplazarla con TU lista completa de artistas prohibidos.
// Artist pop, reggaeton, salsa, etc. deben estar aquí.
const FORBIDDEN_ARTISTS = new Set([
    // Pop Internacional
    "taylor swift", "ed sheeran", "ariana grande", "justin bieber", "katy perry",
    "bruno mars", "the weeknd", "billie eilish", "olivia rodrigo", "dua lipa",
    "doja cat", "lizzo", "sia", "kygo", "shakira",
    
    // Pop Latino/Reggaeton
    "enrique iglesias", "luis fonsi", "rosalía", "pablo alboran", "miguel bose",
    "manuel carrasco", "alejandro sanz", "juan es", "maluma", "j balvin",
    "bad bunny", "ozuna", "anuel aa", "karol g", "becky g", "natti natasha",
    "reik", "morat", "camila cabello", "nicky jam", "c tangana", "mala rodriguez",
    "nathy peluso", "farruko", "wisin & yandel", "luis miguel", "daddy yankee",
    "don omar", "tego calderon", "ivy queen", "ricky martin", "marc anthony",
    "jennifer lopez", "thalia", "paulina rubio", "cnco", "prince royce",
    "romeo santos", "aventura", "monchy & alexandra", "frank reyes", "elvis crespo",
    "olga tañon", "sergio vargas", "juan luis guerra", "carlos vives", "sebastian yat",
    "camilo", "feid", "jhay cortez", "sech", "rauw alejandro", "myke towers",
    "lunay", "plan b", "arcangel", "zion & lennox", "chencho corleone", "tainy",
    
    // K-Pop y Otros Géneros No Deseados
    "anitta", "pabllo vittar", "ivete sangalo", "claudia leitte", "gilberto santa rosa",
    "hector lavoe", "willie colon", "celia cruz", "ruben blades", "victor manuelle",
    "la india", "david guetta", "calvin harris", "tiësto", "marshmello", "diplo",
    "skrillex", "major lazer", "the chainsmokers", "avicii", "zedd", "afrojack",
    "martin garrix", "hardwell", "khalid", "drake", "travis scott", "kendrick lamar",
    "cardi b", "nicki minaj", "jay-z", "beyonce", "rihanna", "adele", "celine dion",
    "whitney houston", "mariah carey", "usher", "ne-yo", "alicia keys", "sam smith",
    "shawn mendes", "charlie puth", "miley cyrus", "selena gomez", "demi lovato",
    "lorde", "halsey", "ellie goulding", "jonas brothers", "maroon 5", "pitbull",
    "flo rida", "jason derulo", "sergio mendes", "bts", "blackpink", "exo", "twice",
    "psy", "bigbang", "red velvet", "got7", "nct", "stray kids", "seventeen", "iu",
    "zayn malik", "one direction", "little mix", "spice girls", "backstreet boys",
    "n-sync", "christina aguilera", "fifth harmony", "olly murs", "olivia newton-john",
    "debbie gibson", "erasure", "pet shop boys", "robbie williams", "s club 7",
    "a*teens", "rick astley", "cyndi lauper", "prince", "prince (as pop legend)",
    "madonna", "lady gaga", "sophie ellis-bextor", "clean bandit", "jessie j",
    "paloma faith", "sigala", "years & years", "iggy azalea", "m.i.a.", "ksi",
    "olivia newton john", "olivia newton john (dup)", "garth brooks", "dolly parton",
    "carrie underwood", "blake shelton", "luke bryan", "jason aldean", "eric church",
    "kenny chesney", "tim mcgraw", "faith hill", "post malone", "kanye west",
    "ye", "snoop dogg", "tupac", "notorious b.i.g.", "eminem", "50 cent", "dr. dre",
    "lil wayne", "future", "young thug", "migos", "gorillaz", "gorillaz (hybrid)",
    "enya", "new age artists", "soundtrack pop artists", "disney pop artists",
    "vocal house artists", "eurodance acts", "techno pop acts", "reggaeton producers (general)",
    "salsa artists (general)", "merengue artists (general)", "bachata artists (general)",
    "trap latin (general)", "k-pop mainstream (expanded)"
].map(artist => artist.toLowerCase()).filter(Boolean));

// ✅ FUNCIÓN DE FILTRADO PRINCIPAL
// Esta función filtra los resultados de YouTube para permitir SOLO artistas en ALLOWED_ARTISTS
// y rechazar cualquier artista en FORBIDDEN_ARTISTS
function containsAnyNormalized(text, setOfNormalized) {
  if (!text) return false;
  for (const term of setOfNormalized) {
    if (!term) continue;
    if (text.includes(term)) return true;
  }
  return false;
}

function filterMusic(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => {
    if (!item || !item.snippet) return false;
    const title = String(item.snippet.title || '');
    const description = String(item.snippet.description || '');
    const channelTitle = String(item.snippet.channelTitle || '');
    const combined = `${title} ${description} ${channelTitle}`;
    const normalizedCombined = normalize(combined);
    
    // 1. Rechazar si contiene algún artista PROHIBIDO
    if (containsAnyNormalized(normalizedCombined, FORBIDDEN_ARTISTS)) return false;
    
    // 2. Aceptar SOLO si contiene algún artista PERMITIDO
    if (!containsAnyNormalized(normalizedCombined, ALLOWED_ARTISTS)) return false;
    
    return true;
  });
}

// ✅ EXPORTAR FUNCIONES Y SETS
module.exports = { 
  filterMusic, 
  ALLOWED_ARTISTS, 
  FORBIDDEN_ARTISTS 
};