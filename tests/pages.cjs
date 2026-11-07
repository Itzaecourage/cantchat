// Статические страницы: главная ссылается на legal/privacy/abuse, они открываются,
// в них нет немецкого, переключатель языка показывает одну версию и запоминает выбор.
// Запуск: dev-сервер на 8788, затем node tests/pages.cjs
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const { chromium } = pw;
const assert = require('assert');
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const BASE = 'http://localhost:8788';

(async () => {
  const browser = await chromium.launch({ ...LAUNCH, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ locale: 'en-US' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(BASE + '/');
  const hrefs = await page.$$eval('.homefoot a', (as) => as.map((a) => a.getAttribute('href')));
  for (const h of ['/legal.html', '/privacy.html', '/abuse.html', '/how.html']) assert.ok(hrefs.includes(h), 'home must link ' + h);
  const texts = await page.$$eval('.homefoot a', (as) => as.map((a) => a.textContent.trim()));
  assert.ok(texts.includes('Legal') && texts.includes('Privacy') && texts.includes('Report abuse'), 'footer labels: ' + texts);
  console.log('home footer links ok:', texts.join(' · '));

  for (const old of ['/impressum.html', '/datenschutz.html']) {
    const r = await page.request.get(BASE + old);
    assert.ok(!/Angaben gemäß|Datenschutzerklärung/.test(await r.text()), old + ' must be gone');
  }

  for (const path of ['/legal.html', '/privacy.html', '/abuse.html', '/how.html']) {
    const r = await page.goto(BASE + path);
    assert.strictEqual(r.status(), 200, path);
    const html = await page.content();
    assert.ok(!/Deutsch|Impressum|Datenschutzerkl|DDG|MStV|Germany|Deutschland/.test(html), path + ' must not contain German');
    // ровно одна секция видна, вкладка English активна
    const vis = await page.$$eval('.page > section', (ss) => ss.filter((s) => !s.hidden).map((s) => s.id));
    assert.deepStrictEqual(vis, ['en'], path + ' visible sections: ' + vis);
    assert.strictEqual(await page.getAttribute('.langs a[aria-current]', 'href'), '#en');
    // переключаем на русский
    await page.click('.langs a[href="#ru"]');
    const vis2 = await page.$$eval('.page > section', (ss) => ss.filter((s) => !s.hidden).map((s) => s.id));
    assert.deepStrictEqual(vis2, ['ru'], path + ' after switch: ' + vis2);
    assert.strictEqual(await page.evaluate(() => document.documentElement.lang), 'ru');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('lang')), 'ru');
    // перезагрузка без хеша — выбор запомнен
    await page.goto(BASE + path);
    const vis3 = await page.$$eval('.page > section', (ss) => ss.filter((s) => !s.hidden).map((s) => s.id));
    assert.deepStrictEqual(vis3, ['ru'], path + ' remembered: ' + vis3);
    // прямой хеш побеждает
    await page.goto(BASE + path + '#en');
    const vis4 = await page.$$eval('.page > section', (ss) => ss.filter((s) => !s.hidden).map((s) => s.id));
    assert.deepStrictEqual(vis4, ['en'], path + ' hash: ' + vis4);
    {
      await page.click('.langs a[href="#sv"]');
      const vis5 = await page.$$eval('.page > section', (ss) => ss.filter((s) => !s.hidden).map((s) => s.id));
      assert.deepStrictEqual(vis5, ['sv'], path + ' swedish: ' + vis5);
      assert.ok(/Sverige|svenska|webbläsare/.test(await page.textContent('#sv')), path + ' swedish text');
    }
    await page.evaluate(() => localStorage.removeItem('lang'));
    console.log(path, 'ok');
  }

  // исходный код лежит на самом сайте и ссылка на него есть на странице «Как это устроено»
  const src = await page.request.get(BASE + '/source.zip');
  assert.strictEqual(src.status(), 200, 'source.zip must be served');
  const buf = await src.body();
  assert.ok(buf[0] === 0x50 && buf[1] === 0x4b, 'source.zip must be a zip');
  assert.ok(buf.includes(Buffer.from('src/worker.js')), 'source.zip must contain the server code');
  await page.goto(BASE + '/how.html#en');
  assert.ok(await page.isVisible('#en a[href="/source.zip"]'), 'how.html links the source');
  console.log('source.zip ok,', buf.length, 'bytes');

  // Швеция и IMY в privacy, никаких немецких органов
  await page.goto(BASE + '/privacy.html');
  const body = await page.textContent('body');
  assert.ok(/Integritetsskyddsmyndigheten|IMY/.test(body) && /Sweden/.test(body), 'privacy must name IMY and Sweden');
  await page.goto(BASE + '/legal.html');
  assert.ok(/Sweden/.test(await page.textContent('body')), 'legal must say Sweden');

  // шведский браузер открывает шведскую версию; метка происхождения видна на главной и на страницах, но не в комнате
  const sv = await (await browser.newContext({ locale: 'sv-SE' })).newPage();
  await sv.goto(BASE + '/legal.html');
  assert.deepStrictEqual(await sv.$$eval('.page > section', (ss) => ss.filter((s) => !s.hidden).map((s) => s.id)), ['sv']);
  assert.ok(await sv.isVisible('.logo .origin'), 'origin mark on legal page');
  await sv.goto(BASE + '/');
  // шведский интерфейс и переключатель по кругу EN → SV → RU
  assert.strictEqual(await sv.textContent('#lang'), 'SV');
  assert.strictEqual((await sv.textContent('.roomdoor h2')).trim(), 'Rum');
  assert.strictEqual((await sv.textContent('.notedoor h2')).trim(), 'Lapp');
  assert.strictEqual(await sv.getAttribute('#codeInput', 'placeholder'), 'Har du en kod? Skriv den här');
  await sv.click('#lang'); assert.strictEqual(await sv.textContent('#lang'), 'RU'); assert.strictEqual((await sv.textContent('.roomdoor h2')).trim(), 'Комната');
  await sv.click('#lang'); assert.strictEqual(await sv.textContent('#lang'), 'EN'); assert.strictEqual((await sv.textContent('.roomdoor h2')).trim(), 'Room');
  await sv.click('#lang'); assert.strictEqual(await sv.textContent('#lang'), 'SV');
  assert.strictEqual(await sv.evaluate(() => localStorage.getItem('lang')), 'sv');
  assert.ok(await sv.isVisible('.logo .origin'), 'origin mark on home');
  assert.strictEqual((await sv.textContent('.logo .origin')).trim(), 'Byggt i Sverige');
  await sv.click('#create');
  await sv.waitForSelector('#sharePanel:not([hidden])');
  assert.ok(await sv.isVisible('.logo .origin'), 'origin mark stays inside a room');
  // на компьютере QR виден сразу, кнопки нет
  assert.ok(await sv.isVisible('#qr svg'), 'desktop: QR visible');
  assert.ok(!(await sv.isVisible('#qrBtn')), 'desktop: no QR button');
  // на телефоне QR спрятан за кнопкой
  const m = await (await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true })).newPage();
  await m.goto(BASE + '/'); await m.click('#create'); await m.waitForSelector('#sharePanel:not([hidden])');
  assert.ok(!(await m.isVisible('#qr')), 'mobile: QR hidden by default');
  assert.ok(await m.isVisible('#qrBtn'), 'mobile: QR button visible');
  assert.ok(await m.isVisible('#codeEdit'), 'mobile: code field visible without QR');
  await m.tap('#qrBtn');
  assert.ok(await m.isVisible('#qr svg'), 'mobile: QR shown after tap');
  assert.strictEqual(await m.getAttribute('#qrBtn', 'aria-expanded'), 'true');
  await m.tap('#qrBtn');
  assert.ok(!(await m.isVisible('#qr')), 'mobile: QR hidden again');
  await m.screenshot({ path: '/tmp/share_mobile.png' });
  console.log('qr toggle ok');
  console.log('swedish locale + origin mark ok');

  assert.deepStrictEqual(errs, [], 'page errors: ' + errs.join('; '));
  await browser.close();
  console.log('PAGES OK');
})().catch((e) => { console.error(e); process.exit(1); });
