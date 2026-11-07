// Код комнаты — запасной способ позвать собеседника, когда ссылку передать нельзя
// (по телефону, лично, на бумаге). Хозяин придумывает код сам. Как это устроено:
//
// 1. Из кода в браузере считается codeKey = PBKDF2-SHA256(код, 200 000 итераций).
//    Медленное хеширование нужно, чтобы код было дорого перебирать — в том числе серверу.
//    Единственное жёсткое правило — минимальная длина; живой индикатор под полем показывает,
//    насколько код трудно угадать. Чем длиннее и необычнее, тем безопаснее.
// 2. По codeKey открывается временная «комната-прихожая» (id = хеш codeKey, как у обычной комнаты).
//    Хозяин ждёт в ней до 10 минут. Гость вводит код, считает тот же codeKey и приходит туда.
// 3. Хозяин присылает гостю настоящий 256-битный ключ комнаты, зашифрованный ключом из кода,
//    и закрывает прихожую. Гость переходит в настоящую комнату и стучится как обычно: эмодзи, «впустить».
//
// Сервер видит только id прихожей и шифр. Код одноразовый и живёт 10 минут.

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MIN = 6;
export const NOTE_CODE_MIN = 8; // записка лежит на сервере, поэтому код должен быть длиннее
const ITERATIONS = 200_000;
const enc = new TextEncoder();

// Приводим к одному виду: без лишних пробелов, в нижнем регистре.
export function normalizeCode(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Почему код не годится: "short" | null (годится). Единственное правило — длина;
// остальное подсказывает живой индикатор силы.
export function codeProblem(text, min = CODE_MIN) {
  const c = normalizeCode(text);
  if (c.replace(/\s/g, "").length < min) return "short";
  return null;
}

// Грубая оценка силы кода в битах: длина × разнообразие символов.
// Словарные слова не распознаём, поэтому оценка скорее оптимистична — пороги взяты с запасом.
export function codeStrength(text) {
  const c = normalizeCode(text);
  if (!c) return { bits: 0, level: 0 };
  let perChar = 4.2; // только буквы одного алфавита
  if (/\d/.test(c) && /\p{L}/u.test(c)) perChar = 5.0;
  if (/[^\p{L}\d\s]/u.test(c)) perChar += 0.8;
  const words = c.split(" ").filter(Boolean).length;
  const bits = c.replace(/\s/g, "").length * perChar + Math.max(0, words - 1) * 2;
  return { bits, level: bits < 45 ? 0 : bits < 64 ? 1 : 2 };
}

// 32 байта ключа из кода. Занимает ~0,3–0,6 с на телефоне — это намеренно.
export async function codeKey(text) {
  const base = await crypto.subtle.importKey("raw", enc.encode(normalizeCode(text)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode("cant.chat/code/v1"), iterations: ITERATIONS },
    base,
    256,
  );
  return new Uint8Array(bits);
}
