// Проверка правил сервера (через tests/devserver.cjs, который повторяет src/worker.js):
// токены переподключения, выдача ICE только в комнате на двоих, закрытый /ice, лимит частоты.
let WS;
try { WS = require('ws'); } catch { WS = require('/opt/npm-tools/node_modules/ws'); }
const http = require('http');
const assert = require('assert');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROOM = 'a'.repeat(40);
const open = (q = '') => new Promise((res, rej) => {
  const ws = new WS(`ws://127.0.0.1:8788/ws/${ROOM}${q}`, { headers: { Origin: 'http://127.0.0.1:8788' } });
  const inbox = []; ws.inbox = inbox; ws.closedWith = null;
  ws.on('message', (b) => inbox.push(JSON.parse(b.toString())));
  ws.on('close', (c) => (ws.closedWith = c));
  ws.on('open', () => res(ws)); ws.on('error', rej);
});
const next = async (ws, pred, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const i = ws.inbox.findIndex(pred); if (i >= 0) return ws.inbox.splice(i, 1)[0]; await sleep(20); }
  throw new Error('timeout waiting for message');
};

(async () => {
  // /ice закрыт
  await new Promise((res) => http.get('http://127.0.0.1:8788/ice', (r) => { assert.strictEqual(r.statusCode, 410); r.resume(); res(); }));
  console.log('/ice: 410 ok');

  // чужой Origin не пускаем
  await new Promise((res) => {
    const ws = new WS(`ws://127.0.0.1:8788/ws/${ROOM}`, { headers: { Origin: 'http://evil.example' } });
    ws.on('error', () => res()); ws.on('open', () => { throw new Error('foreign origin accepted'); });
  });
  console.log('foreign origin: rejected ok');

  const host = await open();
  const hello = await next(host, (m) => m.sys === 'hello');
  assert.strictEqual(hello.role, 'host'); assert.ok(/^[a-f0-9]{32}$/.test(hello.token));

  // ICE в одиночестве: только STUN
  host.send('{"cmd":"ice"}');
  const iceAlone = await next(host, (m) => m.sys === 'ice');
  assert.strictEqual(iceAlone.relay, false);
  console.log('ice alone: stun only ok');

  // злоумышленник со ссылкой пытается занять роль хозяина без токена
  const evil = await open('?r=host');
  const eh = await next(evil, (m) => m.sys === 'hello');
  assert.strictEqual(eh.role, 'guest', 'host must not be replaced without token');
  assert.strictEqual(host.closedWith, null);
  await next(host, (m) => m.sys === 'peer-join');
  evil.close(); await next(host, (m) => m.sys === 'peer-left');
  console.log('reconnect without token: host kept ok');

  // с неверным токеном — тоже
  const evil2 = await open('?r=host&t=' + 'f'.repeat(32));
  assert.strictEqual((await next(evil2, (m) => m.sys === 'hello')).role, 'guest');
  evil2.close(); await next(host, (m) => m.sys === 'peer-left');
  console.log('reconnect with wrong token: host kept ok');

  // настоящий гость + ICE для двоих
  const guest = await open();
  const gh = await next(guest, (m) => m.sys === 'hello');
  assert.strictEqual(gh.role, 'guest');
  await next(host, (m) => m.sys === 'peer-join');
  host.send('{"cmd":"ice"}');
  const ice2 = await next(host, (m) => m.sys === 'ice');
  assert.ok(Array.isArray(ice2.iceServers) && ice2.iceServers.length >= 1);
  console.log('ice with two peers: ok (relay=' + ice2.relay + ')');
  // повторный запрос сразу — снова только STUN (не чаще раза в 25 минут)
  host.send('{"cmd":"ice"}');
  assert.strictEqual((await next(host, (m) => m.sys === 'ice')).relay, false);
  console.log('ice rate limit per socket: ok');

  // третий — комната полна
  const third = await open();
  await next(third, (m) => m.sys === 'full');
  await sleep(100); assert.strictEqual(third.closedWith, 4001);
  console.log('third peer: full ok');

  // хозяин переподключается со своим токеном: старое соединение тихо заменяется, гость не видит peer-left
  const host2 = await open(`?r=host&t=${hello.token}`);
  const h2 = await next(host2, (m) => m.sys === 'hello');
  assert.strictEqual(h2.role, 'host'); assert.strictEqual(h2.resumed, true); assert.strictEqual(h2.peers, 1);
  await sleep(150);
  assert.strictEqual(host.closedWith, 4004);
  assert.ok(!guest.inbox.some((m) => m.sys === 'peer-left'), 'guest must not see peer-left on silent resume');
  console.log('resume with token: ok');

  // пересылка как есть + команда kick только от хозяина
  guest.send('{"s":"opaque"}');
  await next(host2, (m) => m.s === 'opaque');
  guest.send('{"cmd":"kick"}'); await sleep(100); assert.strictEqual(host2.closedWith, null);
  host2.send('{"cmd":"kick"}'); await sleep(150); assert.strictEqual(guest.closedWith, 4002);
  console.log('relay + kick: ok');
  host2.close();

  // лимит частоты: RATE_LIMIT=5 в окружении dev-сервера
  if (process.env.RATE_LIMIT) {
    let refused = 0;
    for (let i = 0; i < Number(process.env.RATE_LIMIT) + 3; i++) {
      try { const w = await open(); w.close(); } catch { refused++; }
    }
    assert.ok(refused >= 1, 'rate limit must refuse some connections');
    console.log('rate limit: refused', refused, 'ok');
  }
  console.log('server tests: all ok');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
