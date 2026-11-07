// Сквозной тест в настоящем браузере: два собеседника, фейковые камера и микрофон.
// Запуск: см. tests/README.md
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const { chromium } = pw;
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const SHOTS = process.env.SHOTS ? require('path').resolve(process.env.SHOTS) : null;
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: require('path').join(SHOTS, name + '.png') }); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const assert = require('assert');
const BIG = require('path').join(require('os').tmpdir(), 'cant-big.bin');
require('fs').writeFileSync(BIG, require('crypto').randomBytes(3000000));
if (SHOTS) require('fs').mkdirSync(SHOTS, { recursive: true });

// «Сжечь» теперь нужно зажать: имитируем удержание.
const holdBurn = async (p) => { await p.dispatchEvent('#burn', 'pointerdown', { button: 0, pointerId: 1 }); await sleep(1400); };

(async () => {
  const browser = await chromium.launch({ ...LAUNCH, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const mk = async (name, opts = {}, init) => {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], ...opts });
    if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(name + ' console: ' + m.text()); });
    p.ctx = ctx; return p;
  };
  const A = await mk('A', { locale: 'ru-RU', viewport: { width: 1200, height: 820 } });
  const B = await mk('B', { locale: 'en-US', viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  await A.goto('http://localhost:8788/');
  await shot(A, 'home_desktop');
  await B.goto('http://localhost:8788/');
  await shot(B, 'home_mobile');
  await A.click('#create');
  await A.waitForSelector('#sharePanel:not([hidden])');
  log('QR svg present:', await A.locator('#qr svg').count());
  await shot(A, 'share_desktop');
  const link = await A.inputValue('#shareLink');
  assert.ok(/^http:\/\/localhost:8788\/#[a-z]+-[a-z]+-\d\d\.[A-Za-z0-9_-]{43}$/.test(link), 'link format');

  await B.goto(link);
  // ключ стёрт из адресной строки
  assert.strictEqual(await B.evaluate(() => location.hash), '', 'hash must be stripped');
  await B.waitForSelector('#waitPanel:not([hidden])');
  await A.waitForSelector('#knockPanel:not([hidden])');
  // гость видит те же 4 эмодзи с названиями
  await B.waitForFunction(() => document.querySelectorAll('#waitEmoji .e:not(.dot)').length === 4);
  const ea = await A.$$eval('#knockEmoji .e i', els => els.map(e => e.textContent).join(''));
  const eb = await B.$$eval('#waitEmoji .e i', els => els.map(e => e.textContent).join(''));
  assert.strictEqual(ea, eb, 'emoji must match on both sides');
  const names = await B.$$eval('#waitEmoji .e span', els => els.map(e => e.textContent));
  assert.ok(names.every(n => n.length > 0), 'emoji names present');
  log('knock emoji match:', ea, '| names:', names.join(', '));
  await shot(B, 'knocking_mobile');
  await shot(A, 'knock_desktop');
  await A.click('#admit');
  await B.waitForSelector('#chat:not([hidden])');
  await A.waitForFunction(() => /напрямую/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await B.waitForFunction(() => /direct/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  log('P2P status A:', await A.textContent('#status'), '| B:', await B.textContent('#status'));

  // ритуал сверки: оба подтверждают — появляется «проверено»
  await A.click('#verifyBtn');
  await B.waitForFunction(() => /your turn/.test(document.getElementById('verifyState').textContent));
  await B.click('#verifyBtn');
  await Promise.all([A.waitForSelector('#verifiedBar:not([hidden])'), B.waitForSelector('#verifiedBar:not([hidden])')]);
  await A.waitForFunction(() => /Проверено/.test(document.getElementById('status').textContent));
  log('verify ritual: both ✓ |', await A.textContent('#status'));

  // текст + прочитано + реакция + ссылка
  await B.bringToFront();
  await A.fill('#input', 'Привет! Проверка связи https://example.com/x?a=1');
  await A.press('#input', 'Enter');
  await B.waitForSelector('.msg.theirs');
  const href = await B.getAttribute('.msg.theirs .body a', 'href');
  const rel = await B.getAttribute('.msg.theirs .body a', 'rel');
  assert.strictEqual(href, 'https://example.com/x?a=1'); assert.ok(/noopener/.test(rel));
  await A.waitForSelector('.msg.mine.seen', { timeout: 5000 }).then(() => log('seen ✓✓: ok')).catch(() => log('seen: not marked (focus)'));
  await B.dblclick('.msg.theirs');
  await A.waitForFunction(() => { const r = document.querySelector('.msg.mine .react'); return r && !r.hidden; });
  log('reaction on A:', await A.textContent('.msg.mine .react'), '| link ok');

  // ответ на сообщение (через меню по правому клику)
  await B.click('.msg.theirs', { button: 'right' });
  await B.waitForSelector('#sheet:not([hidden])');
  await B.click('#sheet [data-act="reply"]');
  await B.waitForSelector('#replyBar:not([hidden])');
  await B.fill('#input', 'это ответ'); await B.click('#send');
  await A.waitForFunction(() => [...document.querySelectorAll('.msg.theirs .quote')].some(q => q.textContent.includes('Проверка связи')));
  log('reply quote on A: ok');

  // удалить у обоих
  await A.fill('#input', 'секрет, удалю'); await A.press('#input', 'Enter');
  await B.waitForFunction(() => [...document.querySelectorAll('.msg.theirs')].some(m => m.textContent.includes('удалю')));
  const delId = await A.$eval('.msg.mine:last-of-type', el => el.dataset.id);
  await A.click(`.msg.mine[data-id="${delId}"]`, { button: 'right' });
  await A.click('#sheet [data-act="del"]');
  await B.waitForFunction(() => ![...document.querySelectorAll('.msg.theirs')].some(m => m.textContent.includes('удалю')), null, { timeout: 5000 });
  await A.waitForFunction((id) => !document.querySelector(`.msg[data-id="${id}"]`), delId, { timeout: 5000 });
  log('delete for both: ok');

  // файлы напрямую: картинка + 3 МБ
  await A.setInputFiles('#fileInput', [require('path').join(__dirname,'photo.png'), BIG]);
  await B.waitForFunction(() => document.querySelectorAll('.msg.theirs.file.ready').length === 2, null, { timeout: 20000 });
  const sizes = await B.evaluate(async () => Promise.all([...document.querySelectorAll('.msg.theirs.file a.save')].map(async a => (await (await fetch(a.href)).arrayBuffer()).byteLength)));
  assert.deepStrictEqual(sizes.sort((a, b) => a - b), [2924, 3000000]);
  log('B received files sizes:', sizes, 'img thumb:', await B.locator('.msg.theirs img.thumb').count());

  // фото-вспышка: B видит только «зажми», держит — видно, отпустил — исчезло, A видит «просмотрено»
  await A.click('#more'); await A.click('#flashBtn'); // 3 с
  assert.strictEqual(await A.textContent('#flashVal'), '3s');
  await A.click('body', { position: { x: 5, y: 400 } });
  await A.setInputFiles('#fileInput', [require('path').join(__dirname,'photo.png')]);
  await B.waitForSelector('.msg.theirs.flash.ready', { timeout: 15000 });
  assert.strictEqual(await B.locator('.msg.theirs.flash img').count(), 0, 'flash must not render image before hold');
  assert.strictEqual(await B.locator('.msg.theirs.flash a.save').count(), 0, 'flash must have no save link');
  await B.dispatchEvent('.msg.theirs.flash', 'pointerdown', { button: 0, pointerId: 7 });
  await B.waitForSelector('#flashView:not([hidden])');
  assert.ok(/^blob:/.test(await B.getAttribute('#flashImg', 'src')));
  await sleep(500);
  await B.dispatchEvent('.msg.theirs.flash', 'pointerup', { pointerId: 7 });
  await B.waitForFunction(() => document.getElementById('flashView').hidden);
  await B.waitForSelector('.msg.theirs.flash.viewed');
  assert.strictEqual(await B.getAttribute('#flashImg', 'src'), null, 'image must be gone after release');
  await A.waitForFunction(() => /Просмотрено/.test(document.querySelector('.msg.mine.flash .flashbadge')?.textContent || ''));
  // повторное нажатие ничего не показывает
  await B.dispatchEvent('.msg.theirs.flash', 'pointerdown', { button: 0, pointerId: 8 }); await sleep(200);
  assert.ok(await B.isHidden('#flashView'), 'viewed flash must not reopen');
  await B.dispatchEvent('.msg.theirs.flash', 'pointerup', { pointerId: 8 });
  log('flash photo: hold → view → gone, sender sees viewed ok');
  await A.click('#more'); await A.click('#flashBtn'); await A.click('#flashBtn'); await A.click('#flashBtn'); // off
  assert.strictEqual(await A.textContent('#flashVal'), 'выкл');
  await A.click('body', { position: { x: 5, y: 400 } });

  // голосовое с эффектом «робот»
  await A.click('#more'); await A.click('#fxBtn'); await A.click('#fxBtn'); await A.click('#fxBtn');
  log('fx:', await A.textContent('#fxVal'));
  await A.click('body', { position: { x: 5, y: 400 } });
  await A.dispatchEvent('#mic', 'pointerdown');
  await sleep(1800);
  await A.dispatchEvent('#mic', 'pointerdown');
  await B.waitForSelector('.msg.theirs.voicemsg.ready .voice', { timeout: 15000 });
  log('voice note received, duration label:', await B.textContent('.msg.theirs.voicemsg .vtime'));
  await shot(B, 'chat_mobile');
  await shot(A, 'chat_desktop');

  // видеозвонок
  await A.click('#more'); await A.click('#fxBtn'); // fx -> off
  await A.click('#videoCall');
  await B.waitForSelector('#ring:not([hidden])');
  log('ring on B:', await B.textContent('#ringText'));
  await shot(B, 'ring_mobile');
  await B.click('#ringAccept');
  const vidOk = (p) => p.waitForFunction(() => { const v = document.getElementById('remoteVideo'); return v.classList.contains('on') && v.videoWidth > 0 && v.currentTime > 0; }, null, { timeout: 20000 });
  await Promise.all([vidOk(A), vidOk(B)]);
  log('video both ways: ok', await A.evaluate(() => document.getElementById('remoteVideo').videoWidth));
  const audioTracks = await A.evaluate(() => document.getElementById('remoteVideo').srcObject.getAudioTracks().length);
  assert.strictEqual(audioTracks, 1);
  await sleep(1500);
  await shot(A, 'call_desktop');
  await shot(B, 'call_mobile');

  // B выключает камеру и микрофон
  await B.click('#cCam'); await B.click('#cMic');
  await A.waitForFunction(() => !document.getElementById('remoteVideo').classList.contains('on'));
  await A.waitForFunction(() => /микрофон/.test(document.getElementById('peerFlags').textContent));
  log('A sees B cam off + muted:', await A.textContent('#peerFlags'));
  await A.click('#cFx');
  log('A call state with fx:', await A.textContent('#callState'));
  await A.click('#cEnd');
  await B.waitForFunction(() => document.getElementById('call').hidden);
  log('hangup synced: ok');

  // повторный звонок (аудио), теперь звонит B
  await B.click('#audioCall');
  await A.waitForSelector('#ring:not([hidden])');
  await A.click('#ringAccept');
  await Promise.all([A, B].map(p => p.waitForFunction(() => { const v = document.getElementById('remoteVideo'); return v.srcObject && v.srcObject.getAudioTracks().length === 1 && !document.getElementById('call').hidden; }, null, { timeout: 20000 })));
  await sleep(800);
  await B.click('#cEnd');
  await A.waitForFunction(() => document.getElementById('call').hidden);
  log('second call (audio, other direction): ok');

  // обрыв сети у B на 4 секунды
  await B.ctx.setOffline(true);
  await A.waitForFunction(() => /отключился/.test(document.getElementById('status').textContent), null, { timeout: 10000 }).then(() => log('A sees peer away:', 'ok')).catch(() => log('A did not notice drop (ok if ws survived)'));
  await A.fill('#input', 'сообщение пока тебя не было'); await A.press('#input', 'Enter');
  await sleep(3000);
  await B.ctx.setOffline(false);
  await B.waitForFunction(() => [...document.querySelectorAll('.msg.theirs')].some(m => m.textContent.includes('пока тебя не было')), null, { timeout: 20000 });
  log('B got queued message after reconnect: ok; A status:', await A.textContent('#status'));
  await B.fill('#input', 'back!'); await B.click('#send');
  await A.waitForFunction(() => [...document.querySelectorAll('.msg.theirs')].some(m => m.textContent.includes('back!')));
  log('chat after reconnect both ways: ok');

  // запасной путь: без WebRTC, файл через сервер
  const noRtc = () => { delete window.RTCPeerConnection; window.RTCPeerConnection = undefined; };
  const C = await mk('C', {}, noRtc), D = await mk('D', {}, noRtc);
  await C.goto('http://localhost:8788/'); await C.click('#create');
  const l2 = await C.inputValue('#shareLink');
  await D.goto(l2); await C.waitForSelector('#knockPanel:not([hidden])'); await C.click('#admit');
  await D.waitForSelector('#chat:not([hidden])');
  await sleep(500);
  await C.setInputFiles('#fileInput', [BIG]);
  await D.waitForSelector('.msg.theirs.file.ready', { timeout: 30000 });
  const rs = await D.evaluate(async () => (await (await fetch(document.querySelector('.msg.theirs a.save').href)).arrayBuffer()).byteLength);
  assert.strictEqual(rs, 3000000);
  log('relay file size:', rs);
  const rtcErr = errs.filter(e => /^[CD]/.test(e)); errs.splice(0, errs.length, ...errs.filter(e => !/^[CD]/.test(e)));
  if (rtcErr.length) log('(expected errors in no-RTC pages):', rtcErr.slice(0, 2));

  // третий со ссылкой — комната полна
  const E = await mk('E');
  await E.goto(link);
  await E.waitForFunction(() => !document.getElementById('end').hidden, null, { timeout: 8000 });
  log('third with link:', await E.textContent('#endTitle'));
  await E.close();

  // гость открыл ссылку, пока хозяин временно отключён — ждёт, а потом стучится заново
  const F = await mk('F'), G = await mk('G', { locale: 'en-US' });
  await F.goto('http://localhost:8788/'); await F.click('#create');
  const l3 = await F.inputValue('#shareLink');
  await G.goto(l3);
  await F.waitForSelector('#knockPanel:not([hidden])');
  // у хозяина «падает сеть»: сервер рвёт его сокет (тестовый эндпоинт dev-сервера)
  await A.evaluate(() => fetch('/__drop?role=host'));
  await G.waitForFunction(() => /host dropped/i.test(document.getElementById('status').textContent), null, { timeout: 8000 });
  log('guest while host offline:', await G.textContent('#status'));
  // хозяин переподключается с токеном, гость стучится заново, хозяин снова видит «тук-тук»
  await G.waitForFunction(() => document.querySelectorAll('#waitEmoji .e.dot').length === 4); // эмодзи сброшены
  await G.waitForFunction(() => /Knocking/.test(document.getElementById('status').textContent) && document.querySelectorAll('#waitEmoji .e:not(.dot)').length === 4, null, { timeout: 15000 });
  await F.waitForSelector('#knockPanel:not([hidden])', { timeout: 15000 });
  await F.click('#admit');
  await G.waitForSelector('#chat:not([hidden])');
  log('host back → knock re-sent: ok');
  await F.close(); await G.close();

  // сжечь (зажать): быстрый тап не сжигает
  await A.dispatchEvent('#burn', 'pointerdown', { button: 0, pointerId: 1 }); await sleep(200); await A.dispatchEvent('#burn', 'pointerup', { pointerId: 1 });
  await sleep(300);
  assert.ok(!(await A.isHidden('#chat')), 'short tap must not burn');
  log('short tap on burn: ignored ok');
  await holdBurn(A);
  await Promise.all([A.waitForSelector('#end:not([hidden])'), B.waitForSelector('#end:not([hidden])')]);
  log('burn: A', await A.textContent('#endTitle'), '| B', await B.textContent('#endTitle'), '| stats:', await A.textContent('#endStats'));
  await shot(A, 'end_desktop'); await shot(B, 'end_mobile');
  // закрытие вкладки → собеседник сразу видит
  await C.close();
  await D.waitForSelector('#end:not([hidden])', { timeout: 5000 });
  log('tab close → D:', await D.textContent('#endTitle'));

  log('ERRORS:', errs.length ? errs : 'none');
  if (errs.length) process.exitCode = 1;
  const relayed = require('fs').readFileSync(require('path').join(__dirname,'relay.log'), 'utf8').split('\n').filter(Boolean);
  const leak = relayed.some(l => /Привет|back!|photo|big\.bin|секрет|ответ/.test(l));
  log('relay frames:', relayed.length, 'any plaintext?', leak);
  if (leak) process.exitCode = 1;
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
