// Режим «скрыть мой IP»: сам поднимает dev-сервер с FAKE_TURN на порту 8789.
// Релей ненастоящий (127.0.0.1), поэтому в режиме «скрыть IP» прямое соединение не поднимается —
// это ожидаемо: переписка и файлы идут через сервер. Выключаем режим — соединение становится прямым.
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const { chromium } = pw;
const { spawn } = require('child_process');
const assert = require('assert');
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 8789;

async function scenario(browser, env, expectOn) {
  const srv = spawn('node', [require('path').join(__dirname, 'devserver.cjs')], { env: { ...process.env, PORT: String(PORT), FAKE_TURN: '1', ...env }, stdio: 'ignore' });
  await sleep(700);
  try {
    const errs = [];
    const mk = async (n) => { const p = await (await browser.newContext({ locale: 'en-US' })).newPage(); p.on('pageerror', e => errs.push(n + e.message)); return p; };
    const A = await mk('A'), B = await mk('B');
    await A.goto(`http://localhost:${PORT}/`); await A.click('#create');
    const link = await A.inputValue('#shareLink');
    await B.goto(link); await A.waitForSelector('#knockPanel:not([hidden])'); await A.click('#admit');
    await B.waitForSelector('#chat:not([hidden])');
    await A.waitForFunction(() => /^(on|off)$/.test(document.getElementById('ipVal').textContent), null, { timeout: 8000 });
    const val = await A.textContent('#ipVal');
    assert.strictEqual(val, expectOn ? 'on' : 'off', 'default hide-IP state');
    if (expectOn) {
      // релей недоступен → прямого соединения нет, но переписка через сервер работает
      await A.fill('#input', 'through the server'); await A.press('#input', 'Enter');
      await B.waitForFunction(() => [...document.querySelectorAll('.msg.theirs')].some(m => m.textContent.includes('through the server')));
      assert.ok(!/direct/.test(await A.textContent('#status')), 'must not be direct while relay-only');
      console.log('hide-IP on by default: relay-only, chat via server ok');
      // A выключает → всё ещё не напрямую: B по-прежнему прячет свой IP (каждый защищает себя сам)
      await A.click('#more'); await A.click('#ipBtn');
      await A.waitForFunction(() => document.getElementById('ipVal').textContent === 'off');
      await sleep(2500);
      assert.ok(!/direct/.test(await A.textContent('#status')), 'B still relay-only → no direct');
      console.log('A off, B on → still no direct ok');
      // B тоже выключает → соединение пересобирается и становится прямым
      await B.click('#more'); await B.click('#ipBtn');
      await A.waitForFunction(() => /direct/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
      await B.waitForFunction(() => /direct/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
      console.log('both off → direct on both sides ok');
      // и обратно: включаем → прямое соединение исчезает (релей фейковый)
      await A.click('#more'); await A.click('#ipBtn');
      await A.waitForFunction(() => !/direct/.test(document.getElementById('status').textContent), null, { timeout: 10000 });
      await A.fill('#input', 'still works'); await A.press('#input', 'Enter');
      await B.waitForFunction(() => [...document.querySelectorAll('.msg.theirs')].some(m => m.textContent.includes('still works')));
      console.log('hide-IP on again → relay-only, chat still ok');
    } else {
      await A.waitForFunction(() => /direct/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
      console.log('HIDE_IP_DEFAULT=off: off by default, direct ok');
    }
    assert.deepStrictEqual(errs, []);
    await A.ctx?.close?.(); await A.context().close(); await B.context().close();
  } finally {
    srv.kill();
    await sleep(300);
  }
}

(async () => {
  const browser = await chromium.launch({ ...LAUNCH, args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  await scenario(browser, {}, true);
  await scenario(browser, { HIDE_IP_DEFAULT: 'off' }, false);
  await browser.close();
  console.log('hide-ip tests: all ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
