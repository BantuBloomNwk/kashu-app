// Kashu's agent service: the chat behind the Agent tab. It talks to NEAR AI's attested enclave, keeps nothing (no
// logs of what anyone typed), and holds no keys: proposals only. Container kashu-agent on 127.0.0.1:8831.
import http from 'node:http';
import { badge, chat } from './brain.mjs';
import { teeCheck } from './tee.mjs';

const KEY = process.env.NEAR_AI_KEY;
const ORIGINS = (process.env.ALLOW_ORIGIN || '').split(',').filter(Boolean);
if (!KEY) { console.error('Set NEAR_AI_KEY.'); process.exit(1); }
const windows = new Map();
// a hard ceiling on what the AI may cost Kashu in a day (UTC): past it the chat pauses until tomorrow (chores keep running)
const BUDGET = Number(process.env.DAILY_BUDGET_USD || 1);
// the free tier: each saver (a wallet that belongs to a Kashu room) may chat this many turns a day
const TURNS_PER_SAVER = Number(process.env.TURNS_PER_SAVER || 40);
const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:8830';
const members = new Map();
async function isSaver(wallet) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(wallet))) return false;
  const hit = members.get(wallet); if (hit && Date.now() - hit.at < 3_600_000) return hit.ok;
  const r = await fetch(`${RELAY}/rooms-of?wallet=${wallet}`, { headers: { 'x-forwarded-for': 'kashu-agent' }, signal: AbortSignal.timeout(15_000) }).then((x) => x.json()).catch(() => ({ rooms: [] }));
  const ok = (r.rooms ?? []).length > 0;
  members.set(wallet, { at: Date.now(), ok });
  return ok;
}
let day = { date: '', spent: 0, turns: 0 };
const today = () => { const d = new Date().toISOString().slice(0, 10); if (day.date !== d) { if (day.date) console.log(`${day.date}: ${day.turns} chat turns cost $${day.spent.toFixed(4)}`); day = { date: d, spent: 0, turns: 0 }; } return day; };
const allow = (k, limit, ms) => { const now = Date.now(); let w = windows.get(k); if (!w || now - w.t > ms) { w = { t: now, n: 0 }; windows.set(k, w); } return ++w.n <= limit; };
const reply = (res, status, body, origin) => {
  const h = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (origin && ORIGINS.includes(origin)) Object.assign(h, { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET' });
  res.writeHead(status, h); res.end(JSON.stringify(body));
};
http.createServer((req, res) => {
  const origin = req.headers.origin, ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'OPTIONS') return reply(res, 204, {}, origin);
  if (req.method === 'GET' && req.url === '/agent/tee') {
    if (!allow(`t:${ip}`, 30, 60_000)) return reply(res, 429, { error: 'slow down' }, origin);
    return teeCheck().then((v) => reply(res, 200, v, origin));
  }
  if (req.method === 'GET' && req.url === '/agent/attestation') {
    if (!allow(`a:${ip}`, 20, 60_000)) return reply(res, 429, { error: 'slow down' }, origin);
    return badge(KEY).then((b) => reply(res, 200, b, origin), (e) => reply(res, 503, { error: String(e.message).slice(0, 120) }, origin));
  }
  if (req.method === 'POST' && req.url === '/agent/chat') {
    if (!allow(`c:${ip}`, 30, 3_600_000)) return reply(res, 429, { error: 'That\'s a lot of chatting for one hour. Try again later.' }, origin);
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16_384) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { return reply(res, 400, { error: 'bad request' }, origin); }
      if (!Array.isArray(j.messages) || !j.messages.length) return reply(res, 400, { error: 'no message' }, origin);
      if (today().spent >= BUDGET) return reply(res, 503, { error: 'The agent has chatted all it can today. Your chores still run; try again tomorrow.' }, origin);
      isSaver(j.wallet).then((ok) => {
        if (!ok) return reply(res, 403, { error: 'The agent is for Kashu savers: join or start a room first.' }, origin);
        if (!allow(`w:${j.wallet}:${today().date}`, TURNS_PER_SAVER, 86_400_000)) return reply(res, 429, { error: 'That\'s all the chatting for today. Your chores still run; talk tomorrow.' }, origin);
      chat({ key: KEY, messages: j.messages }).then(({ cost, ...r }) => { const d = today(); d.spent += cost; d.turns += 1; console.log(`turn $${cost.toFixed(5)}, today $${d.spent.toFixed(4)} over ${d.turns}`); reply(res, 200, r, origin); },
        (e) => reply(res, e.status || 500, { error: String(e.message).slice(0, 200) }, origin));
      });
    });
    return;
  }
  reply(res, 404, { error: 'not found' }, origin);
}).listen(Number(process.env.PORT || 8831), process.env.HOST || '0.0.0.0', () => console.log(`kashu agent on :${process.env.PORT || 8831}, model ${process.env.NEAR_AI_MODEL || 'default'}`));
