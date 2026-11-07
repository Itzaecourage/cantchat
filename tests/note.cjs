// Записка: запечатать с кодом (текст + фото), открыть по коду на главной, второй раз — нет, срок — сгорела.
// Запуск: dev-сервер на 8788 с TEST_DROP=1 (разрешает короткий срок для теста), затем node tests/note.cjs
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const { chromium } = pw;
const assert = require('assert');
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PHOTO = require('path').join(__dirname, 'photo.png');

(async () => {
  const browser = await chromium.launch({ ...LAUNCH, args: ['--no-sandbox'] });
  const errs = [];
  const mk = async (n, locale, mobile) => { const p = await (await browser.newContext({ locale, ...(mobile ? { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true } : {}) })).newPage(); p.on('pageerror', e => errs.push(n + ': ' + e.message)); return p; };
  const A = await mk('A', 'en-US'), B = await mk('B', 'ru-RU', true);

  await A.goto('http://localhost:8788/'); await A.click('#noteBtn');
  await A.waitForSelector('#noteCompose:not([hidden])');
  // пустая записка и слабый код
  await A.click('#noteSeal');
  await A.waitForFunction(() => /Write something/.test(document.getElementById('noteErr').textContent));
  await A.fill('#noteText', 'Meet me at the old lighthouse. https://example.org/map');
  await A.fill('#noteCode', 'lamp7'); await A.click('#noteSeal');
  await A.waitForFunction(() => /at least 8/.test(document.getElementById('noteErr').textContent));
  await A.waitForFunction(() => /Weak|at least/.test(document.getElementById('noteStrength').textContent));
  await A.fill('#noteCode', 'the red lantern by the harbour');
  await A.waitForFunction(() => /Strong/.test(document.getElementById('noteStrength').textContent));
  console.log('empty note / short code rejected ok');
  // фото + срок 1 час + нормальный код
  await A.setInputFiles('#noteFile', [PHOTO]);
  await A.waitForSelector('#notePreviewWrap:not([hidden])');
  await A.click('#noteTtlSeg button[data-ttl="3600"]');
  const code = 'Red Lantern 0417';
  await A.fill('#noteCode', code); await A.click('#noteSeal');
  await A.waitForSelector('#noteSealed:not([hidden])', { timeout: 20000 });
  assert.strictEqual(await A.textContent('#noteCodeShow'), 'red lantern 0417');
  assert.ok(/1 hour/.test(await A.textContent('#noteSealedInfo')));
  assert.strictEqual(await A.inputValue('#noteText'), '', 'draft must be wiped after sealing');
  console.log('note sealed:', await A.textContent('#noteSealedInfo'));
  // тот же код второй раз — занято
  await A.click('#noteDone'); await A.click('#noteBtn');
  await A.fill('#noteText', 'another'); await A.fill('#noteCode', code); await A.click('#noteSeal');
  await A.waitForFunction(() => /already exists/.test(document.getElementById('noteErr').textContent), null, { timeout: 20000 });
  console.log('duplicate code: rejected ok');
  await A.click('#noteBack');

  // гость открывает по коду с телефона
  await B.goto('http://localhost:8788/');
  await B.fill('#codeInput', 'red LANTERN 0417'); await B.click('#codeGo');
  await B.waitForSelector('#noteRead:not([hidden])', { timeout: 20000 });
  assert.ok(/old lighthouse/.test(await B.textContent('#noteReadText')));
  assert.strictEqual(await B.getAttribute('#noteReadText a', 'href'), 'https://example.org/map');
  assert.ok(await B.isVisible('#noteReadImg'));
  const w = await B.evaluate(() => document.getElementById('noteReadImg').naturalWidth);
  assert.ok(w > 0, 'photo must render');
  console.log('note opened on mobile: text + link + photo ok');
  // второй раз — нет
  const C = await mk('C', 'en-US');
  await C.goto('http://localhost:8788/');
  await C.fill('#codeInput', code); await C.click('#codeGo');
  await C.waitForFunction(() => /No note or room/.test(document.getElementById('codeErr').textContent), null, { timeout: 20000 });
  console.log('second open: gone ok');
  // сжечь
  await B.dispatchEvent('#noteBurn', 'pointerdown', { button: 0, pointerId: 1 }); await sleep(1500);
  await B.waitForSelector('#end:not([hidden])', { timeout: 5000 });
  assert.ok(/сожжена/.test(await B.textContent('#endTitle')));
  assert.strictEqual(await B.evaluate(() => document.getElementById('noteReadText').textContent), '');
  console.log('burned:', await B.textContent('#endTitle'));

  // срок истёк (dev-сервер в тестовом режиме принимает ttl=1)
  const sealed = await A.evaluate(async () => {
    const r = await fetch('/note/' + 'b'.repeat(40), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ct: 'abc', ttl: 1 }) });
    return r.status;
  });
  assert.strictEqual(sealed, 201);
  await sleep(1300);
  const expired = await A.evaluate(async () => (await fetch('/note/' + 'b'.repeat(40), { method: 'POST' })).status);
  assert.strictEqual(expired, 404);
  console.log('expired note: 404 ok');
  // чужой сайт не может ни положить, ни открыть
  const foreign = await A.evaluate(async () => (await fetch('/note/' + 'c'.repeat(40), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Origin': 'http://evil.example' }, body: '{}' })).status).catch(() => 'blocked');
  console.log('foreign origin PUT:', foreign, '(403 or blocked by browser)');

  console.log('errors:', errs.length ? errs : 'none');
  if (errs.length) process.exitCode = 1;
  await browser.close();
  console.log('note tests: all ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
