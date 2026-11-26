// Kashu's agent end to end on devnet: a saver signs a policy (save 50 cents, pay a friend 20 cents, $1 a week at most),
// approves the vault's agent authority, and Kashu's agent runs both chores by itself within a couple of minutes.
import { readFileSync } from 'fs'; import { homedir } from 'os';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { execFileSync } from 'child_process';
import * as V from '../client/vault.mjs';
const RELAY = 'https://kashu-relay.161-97-74-212.sslip.io', USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', WSOL = 'So11111111111111111111111111111111111111112';
const FRIEND = process.argv[2] || '6h7Y5xfcq2QZkbx4doJcqjRpaAwLvVRL3tAayjmqHqVV';
const rpcUrl = `https://devnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`;
const conn = new Connection(rpcUrl, 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
// a fresh saver (Kashu's admin owns the fee treasury, so it can't be the saver here)
const owner = Keypair.generate();
await sendAndConfirmTransaction(conn, new Transaction().add((await import('@solana/web3.js')).SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: 30_000_000 })), [admin]);
execFileSync('spl-token', ['transfer', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', '2', owner.publicKey.toBase58(), '--fund-recipient', '--allow-unfunded-recipient', '-u', rpcUrl], { stdio: 'pipe' });
const me = owner.publicKey.toBase58();
const web3 = (k) => new TransactionInstruction({ programId: new PublicKey(k.programAddress), data: Buffer.from(k.data), keys: k.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role % 2 === 1 })) });
const send = async (ixs) => sendAndConfirmTransaction(conn, new Transaction().add(...(await Promise.all(ixs)).map(web3)), [owner]);
const bal = async (a) => { try { return Number((await conn.getTokenAccountBalance(new PublicKey(a))).value.amount); } catch { return 0; } };
const ataOf = (o) => execFileSync('spl-token', ['address', '--token', USDC, '--owner', o, '--verbose', '-u', rpcUrl], { encoding: 'utf8' }).match(/Associated token address: (\w+)/)[1];
let pass = 0, fail = 0; const check = (l, ok, x = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${x ? '   ' + x : ''}`); ok ? pass++ : fail++; };
const agent = (await (await fetch(`${RELAY}/health`)).json()).agent;
check('Kashu\'s agent has a public key', !!agent, agent);
const va = await V.vaultAddresses(me);
if (!(await conn.getAccountInfo(new PublicKey(va.userVault)))) await send([V.openVaultIx({ payer: { address: me }, owner: { address: me }, usdcMint: USDC, assetMint: WSOL })]);
const mine = ataOf(me), friends = ataOf(FRIEND);
await send([V.setAgentIx({ owner: { address: me }, agent, weeklyCap: 1_000_000n, payees: [FRIEND], chores: [{ kind: V.CHORE.SAVE, amount: 500_000n }, { kind: V.CHORE.PAY, amount: 200_000n, payee: 0 }] }),
  V.approveAgentIx({ owner: { address: me }, from: mine, usdcMint: USDC, amount: 2_000_000n })]);
console.log('policy set and allowance given');
const kashu = ataOf(admin.publicKey.toBase58()), fee0 = await bal(kashu);
const cash0 = await bal(va.cash), friend0 = await bal(friends), saves0 = V.readUserVault((await conn.getAccountInfo(new PublicKey(va.userVault))).data).buysDone;
let ran = false;
for (let i = 0; i < 30 && !ran; i++) { await new Promise((r) => setTimeout(r, 10_000)); ran = (await bal(va.cash)) > cash0 && (await bal(friends)) > friend0; }
check('the agent saved 50 cents into the saver\'s vault, by itself', (await bal(va.cash)) - cash0 === 500_000, `${cash0} -> ${await bal(va.cash)}`);
check('and it counted as their save', V.readUserVault((await conn.getAccountInfo(new PublicKey(va.userVault))).data).buysDone === saves0 + 1);
check('the agent paid the friend 20 cents', (await bal(friends)) - friend0 === 200_000, `${friend0} -> ${await bal(friends)}`);
const p = V.readPolicy((await conn.getAccountInfo(new PublicKey(await V.agentPolicyPda(me)))).data);
check('Kashu took one cent per run, two cents in all', (await bal(kashu)) - fee0 === 20_000, `${(await bal(kashu)) - fee0}`);
check('the policy shows both chores ran, $0.70 of the $1 cap spent', p.chores[0].lastRun > 0n && p.chores[1].lastRun > 0n && p.spent === 700_000n, `spent ${p.spent}`);
await new Promise((r) => setTimeout(r, 70_000));
check('a minute later nothing ran again (once a week each)', (await bal(va.cash)) - cash0 === 500_000);
await send([V.setAgentIx({ owner: { address: me } })]);
console.log('agent turned off');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
