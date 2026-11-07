// Слова для имён комнат: silent-fox-42 и т. п.
export const ADJ = [
  "silent", "quiet", "hidden", "velvet", "amber", "misty", "lunar", "secret",
  "gentle", "wild", "golden", "midnight", "silver", "hollow", "drifting", "sleepy",
  "brave", "clever", "frozen", "lucky", "nimble", "proud", "rusty", "shy",
  "swift", "tiny", "wandering", "whispering", "crimson", "foggy", "starry", "smoky",
];

export const NOUN = [
  "fox", "owl", "moth", "raven", "otter", "lynx", "heron", "wolf",
  "cat", "crow", "hare", "badger", "lantern", "ember", "comet", "harbor",
  "river", "willow", "cedar", "pebble", "candle", "echo", "meadow", "falcon",
  "tiger", "whale", "sparrow", "maple", "garden", "anchor", "violin", "orchid",
];

// Ровно 64 легко различимых и легко называемых вслух эмодзи.
export const EMOJI = [
  "🦊", "🦉", "🐙", "🐢", "🐳", "🦋", "🐝", "🐞",
  "🐼", "🐧", "🦄", "🐸", "🦁", "🐯", "🐨", "🐰",
  "🌙", "⭐", "🔥", "🌈", "❄️", "⚡", "🌊", "🌵",
  "🌻", "🍀", "🍄", "🌹", "🍎", "🍋", "🍉", "🍇",
  "🍕", "🍩", "🧀", "🥑", "🌶️", "🥨", "🍪", "🎂",
  "🎈", "🎁", "🎸", "🎺", "🥁", "🎲", "🧩", "🪁",
  "🚀", "⛵", "🚲", "🛸", "🏰", "🗝️", "💎", "🔔",
  "📷", "💡", "🧭", "⏳", "☂️", "🎩", "👑", "⚓",
];

// Названия тех же эмодзи, в том же порядке: чтобы их легко было прочитать вслух.
export const EMOJI_NAMES = {
  en: [
    "fox", "owl", "octopus", "turtle", "whale", "butterfly", "bee", "ladybug",
    "panda", "penguin", "unicorn", "frog", "lion", "tiger", "koala", "rabbit",
    "moon", "star", "fire", "rainbow", "snowflake", "lightning", "wave", "cactus",
    "sunflower", "clover", "mushroom", "rose", "apple", "lemon", "watermelon", "grapes",
    "pizza", "donut", "cheese", "avocado", "chili", "pretzel", "cookie", "cake",
    "balloon", "gift", "guitar", "trumpet", "drum", "dice", "puzzle", "kite",
    "rocket", "sailboat", "bicycle", "UFO", "castle", "key", "gem", "bell",
    "camera", "bulb", "compass", "hourglass", "umbrella", "top hat", "crown", "anchor",
  ],
  sv: [
    "räv", "uggla", "bläckfisk", "sköldpadda", "val", "fjäril", "bi", "nyckelpiga",
    "panda", "pingvin", "enhörning", "groda", "lejon", "tiger", "koala", "kanin",
    "måne", "stjärna", "eld", "regnbåge", "snöflinga", "blixt", "våg", "kaktus",
    "solros", "klöver", "svamp", "ros", "äpple", "citron", "vattenmelon", "druvor",
    "pizza", "munk", "ost", "avokado", "chili", "kringla", "kaka", "tårta",
    "ballong", "present", "gitarr", "trumpet", "trumma", "tärning", "pussel", "drake",
    "raket", "segelbåt", "cykel", "UFO", "slott", "nyckel", "ädelsten", "klocka",
    "kamera", "glödlampa", "kompass", "timglas", "paraply", "hög hatt", "krona", "ankare",
  ],
  ru: [
    "лиса", "сова", "осьминог", "черепаха", "кит", "бабочка", "пчела", "божья коровка",
    "панда", "пингвин", "единорог", "лягушка", "лев", "тигр", "коала", "кролик",
    "луна", "звезда", "огонь", "радуга", "снежинка", "молния", "волна", "кактус",
    "подсолнух", "клевер", "гриб", "роза", "яблоко", "лимон", "арбуз", "виноград",
    "пицца", "пончик", "сыр", "авокадо", "перец", "крендель", "печенье", "торт",
    "шарик", "подарок", "гитара", "труба", "барабан", "кубик", "пазл", "змей",
    "ракета", "парусник", "велосипед", "тарелка", "замок", "ключ", "алмаз", "колокол",
    "камера", "лампочка", "компас", "часы", "зонт", "цилиндр", "корона", "якорь",
  ],
};

export function emojiName(e, lang) {
  const i = EMOJI.indexOf(e);
  const names = EMOJI_NAMES[lang] || EMOJI_NAMES.en;
  return i >= 0 ? names[i] : "";
}

export function roomName() {
  const r = crypto.getRandomValues(new Uint32Array(3));
  return `${ADJ[r[0] % ADJ.length]}-${NOUN[r[1] % NOUN.length]}-${(r[2] % 90) + 10}`;
}
