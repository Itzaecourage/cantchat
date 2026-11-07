# cant.chat

**A secret language for one conversation.**

A one-time, end-to-end encrypted room for two people — chat, voice/video calls and file transfer — straight in the browser. No app, no account, no phone number, no email. The room exists only while you're both in it. Leave, and it's gone.

**[cant.chat](https://cant.chat)** · [How it works](https://cant.chat/how.html) · Built in Sweden 🇸🇪 · MIT licensed

---

## Why

Sometimes you need exactly one private conversation with exactly one person — hand over a password, discuss something sensitive, send a document — and you don't want it living forever in someone's chat history. Installing an app and exchanging phone numbers for that is overkill. cant.chat is the minimum thing that works: open a room, send the link, talk, close the tab.

## What makes it trustworthy

**Nothing to trust, everything to verify.** The claims below can be checked by reading this repository — the whole project is ~4,600 lines, and all the cryptography lives in [`public/crypto.js`](public/crypto.js), which is 138 lines.

- **Keys never leave your browser.** The 32-byte room key is in the URL *fragment* (after `#`). Browsers never send the fragment to any server. The server only ever learns a hash-derived room ID that cannot be reversed to the key.
- **Even the host can't read anything.** Every message is sealed client-side with AES-256-GCM before it touches the network. The server (and the hosting provider underneath it) relays ciphertext. We designed it so that trusting the host is not required.
- **Forward secrecy.** Each session does a fresh ephemeral ECDH P-256 exchange, so a link that leaks *later* does not expose what was said *earlier*.
- **Zero crypto dependencies.** Built only on the browser's native WebCrypto API — no npm crypto libraries, no supply chain to compromise.
- **No account, no identity.** No sign-up, no phone number, no email, no cookies.
- **No trackers, no third-party resources.** Strict CSP (`default-src 'none'`), HSTS, `Referrer-Policy: no-referrer`. Open DevTools → Network and see for yourself: every request goes to `cant.chat` and nowhere else.
- **Rooms live in memory only.** A room is one Durable Object holding at most two WebSockets; the storage API is never called for rooms (see [`src/worker.js`](src/worker.js)). There is no database to subpoena, breach, or "accidentally" retain.
- **Replay protection.** Every message carries a fresh 96-bit IV and a strictly increasing counter; replays and reflections are rejected.
- **MITM check.** Both sides see four emoji derived from the room key and both public keys. If they match, nobody is in the middle.
- **Calls and files are peer-to-peer.** WebRTC with DTLS-SRTP, browser to browser. Optional "Hide my IP" mode relays media through a TURN server (still encrypted end-to-end).

## What it does *not* protect against

We'd rather you know the limits than find out later.

| Protects against | Does not protect against |
|---|---|
| Your ISP, Wi-Fi, or anyone on the wire | The other person in the room (they can screenshot, copy, forward) |
| The server operator and the hosting provider reading content | Someone who legitimately receives the link (the emoji check detects a man-in-the-middle, not an impostor) |
| A link that leaks after the conversation (forward secrecy) | Traffic analysis: the server sees IP addresses, timing, and data volume |
| Replay and reflection attacks | A compromised device or browser |
| Third-party tracking | A compromised server serving malicious JavaScript — see below |

**On "web crypto can't be trusted":** this is a real limitation of any browser-delivered app — the code is fetched from the server on every visit. Our mitigations: the code is small enough to actually read, there are no bundlers or minifiers obscuring what ships, and the repository is exactly what runs on cant.chat, server included. You can compare the served files against this repo at any time (`curl -s https://cant.chat/crypto.js | diff - public/crypto.js`). If you need stronger guarantees than that, use a native app with reproducible builds — we won't pretend otherwise.

## How it works (short version)

1. The browser generates a random 32-byte **link key** and puts it in the URL fragment.
2. `wrapKey = HKDF-SHA256(linkKey)` encrypts the **handshake**, so the server can't tamper with it.
3. Each participant generates an ephemeral **ECDH P-256** key pair; the shared secret goes through HKDF-SHA256 into a per-session **AES-256-GCM** key.
4. Messages are sealed with that key, a fresh 96-bit IV and a monotonic counter.
5. When either participant leaves or presses **Burn**, both browsers wipe memory and the Durable Object is discarded. There is no server-side copy to delete.

Optional extras:

- **Room code** — a human-friendly code instead of a link. PBKDF2-SHA256, 200,000 iterations, single-use 10-minute lobby.
- **Notes** — a sealed asynchronous message the recipient opens by code. This is the *only* thing the server stores: one encrypted blob plus an expiry (1 hour, 24 hours or 7 days). It is deleted on first open or at expiry, whichever comes first. The server cannot read it, restore it, or tell who opened it.

Full details, in three languages: [cant.chat/how.html](https://cant.chat/how.html).

## What the server sees

| Sees | Never sees |
|---|---|
| IP addresses | Keys |
| Connection timing | Message text |
| Data volume | Files, voice, video |
| Hashed room fingerprint | Names (there are none) |

Logging and observability are disabled in [`wrangler.toml`](wrangler.toml).

## Project layout

```
public/
  crypto.js      all cryptography (138 lines) — start here
  app.js         UI and room state machine
  rtc.js         WebRTC calls, P2P file transfer
  code.js        room codes (PBKDF2)
  files.js       file sealing / fallback through the server
  _headers       CSP, HSTS and other security headers
  how.html       the full technical explanation
src/
  worker.js      Cloudflare Worker + Room / Note Durable Objects (311 lines)
tests/           end-to-end tests in a real browser (two peers, fake camera and mic);
                 the relay log is checked to contain no plaintext
```

## Run it yourself

Requirements: [Node.js](https://nodejs.org) LTS and a free [Cloudflare](https://dash.cloudflare.com) account.

```bash
npm install
npx wrangler deploy
```

Wrangler prints a `https://cant-chat.<you>.workers.dev` URL. Open it, create a room, open the link on your phone, talk.

To use your own domain, add it to Cloudflare, then uncomment the two `[[routes]]` lines at the bottom of `wrangler.toml` and deploy again.

Optional TURN relay ("Hide my IP" mode) needs two Cloudflare secrets: `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` (`npx wrangler secret put …`). Without them the site works fine, just without the relay option.

### Tests

```bash
npm i -D playwright ws && npx playwright install chromium
LOG=1 TEST_DROP=1 node tests/devserver.cjs &   # local stand-in for the Worker, http://localhost:8788
node tests/e2e.cjs        # chat, verification, P2P, files, voice, calls, network drop, burn
node tests/reconnect.cjs  # server restart mid-conversation
node tests/code.cjs       # room codes
node tests/note.cjs       # notes
node tests/server.cjs     # server rules: tokens, ICE only with two peers, rate limit
node tests/hideip.cjs     # TURN relay mode
node tests/pages.cjs      # static pages, three languages
```

See [`tests/README.md`](tests/README.md) for environment variables.

## Security

Found a weakness? We want to hear it. Please report it through the [abuse/contact page](https://cant.chat/abuse.html) before publishing, and we'll respond quickly. There has been no independent third-party audit yet — the code is short on purpose so that anyone can do their own.

## License

[MIT](LICENSE). Use it, fork it, host your own.
