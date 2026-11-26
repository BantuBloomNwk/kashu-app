// Copies Jupiter Lend's devnet USDC market into tests/fixtures, so tests run the real lending program
// in memory. Run from the repo root: node scripts/juplend-fixtures.mjs <rpc>
// The market accounts come from Jupiter's own SDK context (see tests/fixtures/juplend-devnet.json).
import { writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
const rpc = process.argv[2] || 'https://rpc.magicblock.app/devnet';
const MARKET = {
  cluster: 'devnet',
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  lendingAdmin: 'DeF2BVMjWdCamK71nqBZ7uzQkLeW9MJ6C7zoCKLJXEmW',
  lending: '98Uy7eonumvRbhQvP5Jt7B3WjNqpndioMF99xvR7sDVa',
  fTokenMint: '2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu',
  supplyReserves: '644Eh222dNe1V6sSRkYHBcdpxfjtxBBptAJ6mZujRRNo',
  supplyPosition: 'B5JAZXGKaZfWsUrauprZVNQM7HwXN8AfKVTt25qtDKYV',
  rateModel: 'CpSRFppSpkdPw7juvRpSxwVyZMN3y8g7cHXCbrc3MBUs',
  vault: 'CWFPa1gcDqGyeTHTmdbhGjCnQv7eRfdhnBpZKFzNr1R2',
  liquidity: 'DFHSbFzMU67yHK9yLsLBLso7aEnzrB4ZQR7KBujmSU3M',
  // read from the market account itself (bytes 75..107); the SDK's derived address does not exist on devnet
  rewardsRateModel: 'GGtryeuwjcWoG6zg4Xi1vUJN1xRhypms4xt129BKTUxt',
  // the market's withdrawal claim account (same for every depositor), from the Lend SDK's withdraw context
  claimAccount: 'dUnUR9XxaVWZo5FUi5DGqsMWfAzYPdtgkuiDbPLLtYX',
};
const call = async (method, params) => { const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return (await r.json()).result; };
const accounts = {};
for (const [k, a] of Object.entries(MARKET)) {
  if (k === 'cluster') continue;
  const v = (await call('getAccountInfo', [a, { encoding: 'base64' }]))?.value;
  if (!v) { console.log('missing', k, a); continue; }
  accounts[a] = { owner: v.owner, lamports: v.lamports, data: v.data[0], executable: v.executable };
  console.log(k.padEnd(18), a, v.data[0].length * 0.75 | 0, 'bytes, owner', v.owner.slice(0, 8));
}
const slot = await call('getSlot', []);
writeFileSync('tests/fixtures/juplend-devnet.json', JSON.stringify({ copiedAtSlot: slot, market: MARKET, accounts }, null, 1));
console.log('saved at slot', slot);
// the two programs themselves (binary, gitignored): Earn (lending) and Liquidity
for (const [id, name] of [['7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3', 'juplend_lending'], ['5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL', 'juplend_liquidity']]) {
  execFileSync('solana', ['program', 'dump', '-u', rpc, id, `tests/fixtures/${name}.so`], { stdio: 'inherit' });
}
