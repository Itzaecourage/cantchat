// Код комнаты: хозяин задаёт свой код, гость вводит его на главной и попадает к «тук-тук».
// Запуск: dev-сервер на 8788 (см. tests/README.md), затем node tests/code.cjs
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const { chromium } = pw;
const assert = require('assert');
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};

(async () => {
  const browser = await chromium.launch({ ...LAUNCH, args: ['--no-sandbox'] });
  const errs = [];
  const mk = async (n, locale) => { const p = await (await browser.newContext({ locale })).newPage(); p.on('pageerror', e => errs.push(n + ': ' + e.message)); return p; };
  const A = await mk('A', 'ru-RU'), B = await mk('B', 'en-US'), C = await mk('C', 'en-US');

  await A.goto('http://localhost:8788/'); await A.click('#create');
  await A.waitForSelector('#sharePanel:not([hidden])');
  // слабые коды отклоняются
  for (const [bad, re] of [['abc12', /коротко/], ['     ', /коротко/]]) {
    await A.fill('#codeEdit', bad); await A.click('#codeSet');
    await A.waitForFunction((re) => new RegExp(re).test(document.getElementById('codeSetErr').textContent), re.source);
  }
  console.log('weak codes rejected ok');
  const code = 'Moon River 2041';
  await A.fill('#codeEdit', code); await A.click('#codeSet');
  await A.waitForSelector('#codePanel:not([hidden])', { timeout: 15000 });
  assert.strictEqual(await A.textContent('#codeShow'), 'moon river 2041');
  assert.ok(/^\d+:\d\d$/.test(await A.textContent('#codeTimer')));
  console.log('host code set:', await A.textContent('#codeShow'));

  // гость: поле видно сразу; неверный формат; чужой код; верный код в другом регистре и с лишними пробелами
  await B.goto('http://localhost:8788/');
  assert.ok(await B.isVisible('#codeInput'), 'code input must be visible on home');
  await B.fill('#codeInput', 'abc'); await B.click('#codeGo');
  await B.waitForFunction(() => /doesn't look like a code/.test(document.getElementById('codeErr').textContent));
  await B.fill('#codeInput', 'some other code 99'); await B.click('#codeGo');
  await B.waitForFunction(() => /No note or room/.test(document.getElementById('codeErr').textContent), null, { timeout: 20000 });
  console.log('bad/unknown code:', await B.textContent('#codeErr'));
  await B.fill('#codeInput', '  MOON   river 2041 '); await B.click('#codeGo');
  await B.waitForSelector('#waitPanel:not([hidden])', { timeout: 20000 });
  await A.waitForSelector('#knockPanel:not([hidden])', { timeout: 20000 });
  assert.strictEqual(await B.evaluate(() => location.hash), '');
  await B.waitForFunction(() => document.querySelectorAll('#waitEmoji .e:not(.dot)').length === 4);
  const ea = await A.$$eval('#knockEmoji .e i', els => els.map(e => e.textContent).join(''));
  const eb = await B.$$eval('#waitEmoji .e i', els => els.map(e => e.textContent).join(''));
  assert.strictEqual(ea, eb);
  console.log('guest by code → knocking, emoji match:', ea);
  await A.click('#admit');
  await B.waitForSelector('#chat:not([hidden])');
  await A.waitForFunction(() => document.getElementById('codePanel').hidden);
  console.log('admitted, code panel closed ok');

  // тот же код второй раз — не работает (одноразовый)
  await C.goto('http://localhost:8788/');
  await C.fill('#codeInput', code); await C.click('#codeGo');
  await C.waitForFunction(() => /No note or room/.test(document.getElementById('codeErr').textContent), null, { timeout: 20000 });
  console.log('reused code: rejected ok');

  await B.fill('#input', 'via code'); await B.press('#input', 'Enter');
  await A.waitForFunction(() => [...document.querySelectorAll('.msg.theirs')].some(m => m.textContent.includes('via code')));
  console.log('chat after code join: ok');
  console.log('errors:', errs.length ? errs : 'none');
  if (errs.length) process.exitCode = 1;
  await browser.close();
  console.log('code tests: all ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
