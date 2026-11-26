// Copies a live Jupiter route (USDC -> SOL, one Orca Whirlpool leg) and everything it touches from mainnet
// into tests/fixtures, so tests/jupiter.mjs can run the vault's weekly buy through Jupiter's real
// aggregator in memory. Run from the repo root: node scripts/jupiter-fixtures.mjs
// Needs ~/.helius-main (a Helius key, never printed). Refresh the route first with --route.
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const key = readFileSync(`${homedir()}/.helius-main`, 'utf8').trim();
const rpc = `https://mainnet.helius-rpc.com/?api-key=${key}`;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', WSOL = 'So11111111111111111111111111111111111111112';
const PYTH_SOL_USD = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
const USER = '8Kv6r3iTA6Yw8oZ9JuxhRGTH2X3JZ3pF1bKu7yWzQqFk'; // a placeholder user the route is asked for
// a placeholder destination: Jupiter lands the swap in the user's own account, then forwards it here (the vault's hold)
const DEST = '2bWkkMiQ7YjEqFRUW2mm4sHeyixWfrmCZHHYGbDpeMa3';

if (process.argv.includes('--route')) {
  const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${WSOL}&amount=5000000&slippageBps=100&onlyDirectRoutes=true&dexes=Whirlpool`)).json();
  const s = await (await fetch('https://lite-api.jup.ag/swap/v1/swap-instructions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: USER, wrapAndUnwrapSol: false, useSharedAccounts: false }) })).json();
  writeFileSync('tests/fixtures/jupiter-route.json', JSON.stringify({ quote: q, swap: s }, null, 1));
}
const { swap } = JSON.parse(readFileSync('tests/fixtures/jupiter-route.json', 'utf8'));
const call = async (method, params) => (await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;

const ix = swap.swapInstruction;
const userAtas = [ix.accounts[2].pubkey, ix.accounts[3].pubkey]; // the user's source and destination, mapped to the vault's
const programs = new Set(['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);
const want = new Set([USDC, WSOL]);
for (const a of ix.accounts) if (a.pubkey !== USER && a.pubkey !== DEST && !userAtas.includes(a.pubkey) && !programs.has(a.pubkey)) want.add(a.pubkey);
// the price last, so it is at least as fresh as the pool it will judge
want.add(PYTH_SOL_USD);
const slot = await call('getSlot', []);
const accounts = {};
for (const a of want) {
  const v = (await call('getAccountInfo', [a, { encoding: 'base64' }]))?.value;
  if (!v) { console.log('  (no account)', a); continue; }
  accounts[a] = { owner: v.owner, lamports: v.lamports, data: v.data[0], executable: v.executable };
}
const blockTime = await call('getBlockTime', [slot]);
writeFileSync('tests/fixtures/jupiter-accounts.json', JSON.stringify({ copiedAtSlot: slot, blockTime, user: USER, dest: DEST, userAtas, pythSolUsd: PYTH_SOL_USD, accounts }, null, 1));
console.log(`copied ${Object.keys(accounts).length} accounts at slot ${slot}`);
for (const [id, name] of [['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'jupiter_v6'], ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'orca_whirlpool']]) {
  // the CLI echoes its URL on errors; keep its output out of the terminal so the key never shows
  try { execFileSync('solana', ['program', 'dump', '-u', rpc, id, `tests/fixtures/${name}.so`], { stdio: 'ignore' }); console.log(`dumped ${name}`); }
  catch { console.log(`could not dump ${name}`); }
}
