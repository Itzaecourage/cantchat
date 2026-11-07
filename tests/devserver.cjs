// Локальная имитация Cloudflare Worker + Durable Object (повторяет src/worker.js).
// Если меняешь src/worker.js — меняй и этот файл.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
let WSS;
try { WSS = require('ws').WebSocketServer; } catch { WSS = require('/opt/npm-tools/node_modules/playwright-core/lib/utilsBundle.js').wsServer; }
const PUB = process.argv[2] || path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 8788;
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json', '.txt':'text/plain' };
const hdr = fs.readFileSync(path.join(PUB, '_headers'), 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.trim().split(/:\s(.+)/));
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
// FAKE_TURN=1 — притворяемся, что TURN настроен (для проверки режима «скрыть IP» в интерфейсе).
const ICE = process.env.FAKE_TURN
  ? { iceServers: STUN.concat([{ urls: ['turn:127.0.0.1:3478?transport=udp'], username: 'u', credential: 'p' }]), relay: true, ttl: 7200 }
  : { iceServers: STUN, relay: false };
const ICE_MIN_GAP_MS = 25 * 60 * 1000, ICE_MAX_PER_SOCKET = 4;

const srv = http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/ice') { res.writeHead(410); return res.end('Gone'); }
  // Записки (повторяет класс Note из src/worker.js): PUT — оставить, POST — открыть и удалить.
  const nm = p.match(/^\/note\/([a-f0-9]{40})$/);
  if (nm) {
    if (req.method !== 'PUT' && req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const origin = req.headers.origin;
    if (origin ? new URL(origin).host !== req.headers.host : req.headers['sec-fetch-site'] !== 'same-origin') { res.writeHead(403); return res.end(); }
    if (!allow((req.method === 'PUT' ? 'note-put:' : 'note-open:') + req.socket.remoteAddress)) { res.writeHead(429); return res.end(); }
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
      const cur = notes.get(nm[1]); const now = Date.now(); const alive = cur && cur.exp > now;
      if (req.method === 'PUT') {
        if (alive) return json(409, { error: 'taken' });
        let body; try { body = JSON.parse(raw); } catch { return json(400, { error: 'bad' }); }
        const ct = typeof body.ct === 'string' ? body.ct : ''; const ttl = Math.floor(Number(body.ttl));
        const minTtl = process.env.TEST_DROP ? 1 : 60;
        if (!ct || ct.length > 1900000 || !/^[A-Za-z0-9_-]+$/.test(ct)) return json(400, { error: 'bad' });
        if (!(ttl >= minTtl && ttl <= 7 * 86400)) return json(400, { error: 'bad' });
        notes.set(nm[1], { ct, exp: now + ttl * 1000 });
        return json(201, { ok: true, exp: now + ttl * 1000 });
      }
      if (!alive) { notes.delete(nm[1]); return json(404, { error: 'none' }); }
      notes.delete(nm[1]); return json(200, { ct: cur.ct });
    });
    return;
  }
  // Только для тестов: оборвать сокет на стороне сервера, как будто у человека пропала сеть.
  if (p === '/__drop' && process.env.TEST_DROP) {
    const role = new URL(req.url, 'http://x').searchParams.get('role') || 'host';
    const last = [...rooms.keys()].pop(); let n = 0;
    if (last) for (const o of rooms.get(last)) if (o.role === role) { o.terminate(); n++; }
    res.writeHead(200); return res.end(String(n));
  }
  let f = path.join(PUB, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  const h = { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' };
  for (const [k, v] of hdr) if (k !== 'Strict-Transport-Security') h[k] = v.replace("connect-src 'self'", "connect-src 'self' blob:");
  res.writeHead(200, h); fs.createReadStream(f).pipe(res);
});

// Ограничение частоты как в wrangler.toml: 30 подключений в минуту с одного адреса.
const hits = new Map();
function allow(ip) {
  const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a);
  return a.length <= (Number(process.env.RATE_LIMIT) || 30);
}

const rooms = new Map();
const notes = new Map();
const wss = new WSS({ noServer: true, maxPayload: 256 * 1024 });
srv.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/ws\/([a-f0-9]{40})$/);
  if (!m) return sock.destroy();
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return sock.destroy();
  if (!allow(req.socket.remoteAddress)) { sock.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n'); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const set = rooms.get(m[1]) || new Set(); rooms.set(m[1], set);
    const wanted = u.searchParams.get('r'); const token = u.searchParams.get('t') || '';
    let resumed = false;
    if ((wanted === 'host' || wanted === 'guest') && token) {
      for (const o of set) if (o.role === wanted && o.token === token) { o.replaced = true; set.delete(o); o.close(4004); resumed = true; }
    }
    if (set.size >= 2) { ws.send('{"sys":"full"}'); return ws.close(4001); }
    const taken = new Set([...set].map(o => o.role));
    let role = (wanted === 'host' || wanted === 'guest') && !taken.has(wanted) ? wanted : (taken.has('host') ? 'guest' : 'host');
    ws.role = role; ws.token = resumed ? token : crypto.randomBytes(16).toString('hex'); ws.iceN = 0; ws.iceAt = 0;
    const peers = set.size; set.add(ws);
    ws.send(JSON.stringify({ sys: 'hello', role, token: ws.token, peers, resumed }));
    const bc = (msg) => { for (const o of set) if (o !== ws) o.send(msg); };
    const live = () => [...set].filter(o => !o.replaced);
    bc('{"sys":"peer-join"}');
    ws.on('message', (buf) => {
      const msg = buf.toString();
      if (msg.length > 256*1024) return;
      if (msg.startsWith('{"cmd"')) {
        let c; try { c = JSON.parse(msg).cmd; } catch { return; }
        if (c === 'kick' && ws.role === 'host') for (const o of set) if (o !== ws) o.close(4002);
        if (c === 'burn') for (const o of set) o.close(4003);
        if (c === 'leave') { bc('{"sys":"peer-bye"}'); ws.close(1000); }
        if (c === 'ice') {
          const now = Date.now();
          const ok = live().length >= 2 && ws.iceN < ICE_MAX_PER_SOCKET && !(ws.iceAt && now - ws.iceAt < ICE_MIN_GAP_MS);
          if (!ok) return ws.send(JSON.stringify({ sys: 'ice', iceServers: STUN, relay: false }));
          ws.iceN++; ws.iceAt = now;
          ws.send(JSON.stringify({ sys: 'ice', ...ICE, hideIpDefault: String(process.env.HIDE_IP_DEFAULT || '').toLowerCase() !== 'off' }));
        }
        return;
      }
      if (process.env.LOG) fs.appendFileSync(path.join(__dirname,'relay.log'), msg.slice(0, 120) + '\n');
      bc(msg);
    });
    ws.on('close', () => { if (ws.replaced) return; set.delete(ws); bc('{"sys":"peer-left"}'); if (!set.size) rooms.delete(m[1]); });
  });
});
srv.listen(PORT, () => console.log('dev on ' + PORT));
