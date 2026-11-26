// Copies Jupiter Lend's MAINNET USDC market (and the USDC mint) into tests/fixtures, so tests/interest.mjs can earn
// interest at the real mainnet rate in memory. Read only: nothing is signed or sent. Account order from Jupiter's
// own Lend API (deposit and withdraw instructions). Run from the repo root: node scripts/juplend-mainnet-fixtures.mjs
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
const rpc = `https://mainnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`;
const MARKET = JSON.parse(readFileSync(new URL('./.mainnet-market.json', import.meta.url)));
const call = async (method, params) => (await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const accounts = {};
for (const [k, a] of Object.entries(MARKET)) {
  if (k === 'cluster') continue;
  const v = (await call('getAccountInfo', [a, { encoding: 'base64' }]))?.value;
  if (!v) { console.log('missing', k, a); continue; }
  accounts[a] = { owner: v.owner, lamports: v.lamports, data: v.data[0], executable: v.executable };
  console.log(k.padEnd(18), a.slice(0, 8), (v.data[0].length * 0.75) | 0, 'bytes');
}
writeFileSync('tests/fixtures/juplend-mainnet.json', JSON.stringify({ copiedAtSlot: await call('getSlot', []), market: MARKET, accounts }, null, 1));
for (const [id, name] of [['jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9', 'juplend_lending_mainnet'], ['jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC', 'juplend_liquidity_mainnet']]) {
  execFileSync('solana', ['program', 'dump', '-u', rpc, id, `tests/fixtures/${name}.so`], { stdio: 'ignore' });
  console.log('dumped', name);
}
