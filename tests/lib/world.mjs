// A whole chain in memory (LiteSVM), with both programs loaded, two mints and a few funded
// people. Tests and the demo script share it. Nothing here touches a network.

import {
  address, getProgramDerivedAddress, appendTransactionMessageInstructions, createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getTransactionEncoder, setTransactionMessageConfig, lamports, none, pipe,
  setTransactionMessageFeePayerSigner, signTransactionMessageWithSigners, some,
} from '@solana/kit';
import { getMintEncoder, getTokenDecoder, getTokenEncoder } from '@solana-program/token';
import { LiteSVM } from 'litesvm';
import {
  PYTH_RECEIVER, STUB_SWAP_PROGRAM, TOKEN_PROGRAM, VAULT_PROGRAM, initPoolIx, initializeIx, poolAddresses, priceUpdateBytes, programDataPda, setVenueIx,
  readConfig, readUserVault, configPda, vaultAddresses,
} from '../../client/vault.mjs';
import { ROOMS_PROGRAM, VRF_PROGRAM } from '../../client/rooms.mjs';

const ATA_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const so = (name) => new URL(`../../target/deploy/${name}.so`, import.meta.url).pathname;
export const USDC = (n) => BigInt(Math.round(n * 1e6));
export const START = 1_800_000_000n;

export async function makeWorld({ vaultSo = so('vault'), usdcMint, assetMint } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(VAULT_PROGRAM, vaultSo);
  svm.addProgramFromFile(STUB_SWAP_PROGRAM, so('stub_swap'));
  svm.addProgramFromFile(ROOMS_PROGRAM, so('rooms'));
  // a stand-in at the VRF program's address so account checks pass; the real oracle runs on devnet
  svm.addProgramFromFile(VRF_PROGRAM, so('stub_swap'));

  const w = { svm };
  w.setTime = (t) => { const c = svm.getClock(); c.unixTimestamp = BigInt(t); svm.setClock(c); };
  w.now = () => svm.getClock().unixTimestamp;
  w.setTime(START);

  w.person = async () => { const s = await generateKeyPairSigner(); svm.airdrop(s.address, lamports(10_000_000_000n)); return s; };

  /** Sends one transaction. Returns { ok, logs, units }. */
  w.send = async (payer, ixs, { version = 0, loadedLimit = 1024 * 1024, units = 400_000 } = {}) => {
    let msg = pipe(
      createTransactionMessage({ version }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    // v1 transactions (up to 4,096 bytes) carry their compute and loaded-data limits in the message itself.
    if (version === 1) msg = setTransactionMessageConfig({ computeUnitLimit: units, loadedAccountsDataSizeLimit: loadedLimit }, msg);
    const tx = await signTransactionMessageWithSigners(msg);
    w.lastSize = getTransactionEncoder().encode(tx).length;
    const r = svm.sendTransaction(tx);
    svm.expireBlockhash();
    const failed = typeof r.err === 'function';
    const meta = failed ? r.meta() : r;
    return { ok: !failed, logs: meta.logs().join('\n') + (failed ? '\n' + r.toString() : ''), units: meta.computeUnitsConsumed() };
  };

  const put = (addr, data, owner) => svm.setAccount({
    address: addr, data, executable: false, programAddress: owner, space: BigInt(data.length),
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
  });

  w.mint = async (decimals) => {
    const m = (await generateKeyPairSigner()).address;
    put(m, new Uint8Array(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals, isInitialized: true, freezeAuthority: none() })), TOKEN_PROGRAM);
    return m;
  };

  /** A token account with a starting balance, written straight into the chain. */
  w.tokenAccount = async (mint, owner, amount = 0n) => {
    const a = (await generateKeyPairSigner()).address;
    put(a, new Uint8Array(getTokenEncoder().encode({
      mint, owner, amount, delegate: none(), state: 1, isNative: none(), delegatedAmount: 0n, closeAuthority: none(),
    })), TOKEN_PROGRAM);
    return a;
  };

  /** An empty associated token account (at its real address) for `owner`. */
  w.ataAccount = async (mint, owner) => {
    const [a] = await getProgramDerivedAddress({ programAddress: ATA_ID, seeds: [getAddressEncoder().encode(owner), getAddressEncoder().encode(TOKEN_PROGRAM), getAddressEncoder().encode(mint)] });
    put(a, new Uint8Array(getTokenEncoder().encode({ mint, owner, amount: 0n, delegate: none(), state: 1, isNative: none(), delegatedAmount: 0n, closeAuthority: none() })), TOKEN_PROGRAM);
    return a;
  };

  /** The swap authority's own dollar and asset accounts for `owner`'s vault (anyone may create them). */
  w.swapAccounts = async (owner, usdcMint = w.usdcMint, assetMint = w.assetMint) => {
    const { vaultAddresses } = await import('../../client/vault.mjs');
    const sa = (await vaultAddresses(owner)).swapAuthority;
    for (const m of [usdcMint, assetMint]) {
      const [a] = await getProgramDerivedAddress({ programAddress: ATA_ID, seeds: [getAddressEncoder().encode(sa), getAddressEncoder().encode(TOKEN_PROGRAM), getAddressEncoder().encode(m)] });
      const acc = svm.getAccount(a);
      if (!acc || !acc.data || acc.data.length === 0) await w.ataAccount(m, sa);
    }
  };

  /** Adds tokens to an existing token account, the way a stranger's transfer in would. */
  w.gift = (addr, amount) => {
    const acc = svm.getAccount(addr);
    const t = getTokenDecoder().decode(acc.data);
    svm.setAccount({ ...acc, data: new Uint8Array(getTokenEncoder().encode({ ...t, amount: t.amount + BigInt(amount) })) });
  };

  w.token = (addr) => getTokenDecoder().decode(svm.getAccount(addr).data);
  w.balance = (addr) => w.token(addr).amount;
  w.config = async () => readConfig(svm.getAccount(await configPda()).data);
  w.vault = async (owner) => readUserVault(svm.getAccount((await vaultAddresses(owner)).userVault).data);

  /** Makes `who` the program's upgrade authority, as a real deploy would. */
  w.setUpgradeAuthority = async (who) => {
    const pd = svm.getAccount(await programDataPda());
    const data = new Uint8Array(pd.data);
    data[12] = 1;
    data.set(getAddressEncoder().encode(who), 13);
    svm.setAccount({ ...pd, data });
  };

  w.usdcMint = usdcMint ?? await w.mint(6);
  w.assetMint = assetMint ?? await w.mint(9);
  w.admin = await w.person();
  await w.setUpgradeAuthority(w.admin.address);

  /** Sets up the vault program and a funded stub pool. One dollar buys 0.005 of the asset. */
  w.boot = async ({ rate = 5_000_000_000n, floorRate = 4_900_000_000n, mode = 0, perUserCap = USDC(50), totalCap = USDC(5000) } = {}) => {
    const r1 = await w.send(w.admin, [await initializeIx({ admin: w.admin, usdcMint: w.usdcMint, assetMint: w.assetMint, perUserCap, totalCap, floorRate })]);
    if (!r1.ok) throw new Error('initialize failed\n' + r1.logs);
    const r2 = await w.send(w.admin, [await initPoolIx({ payer: w.admin, usdcMint: w.usdcMint, assetMint: w.assetMint, rate, mode })]);
    if (!r2.ok) throw new Error('init_pool failed\n' + r2.logs);
    w.pool = await poolAddresses(w.usdcMint, w.assetMint);
    w.gift(w.pool.poolAsset, 1_000_000_000_000n);
    w.rate = rate;
    // a Pyth price for the asset: $200, the stub venue's honest price (0.005 of the asset per dollar)
    w.feedId = new Uint8Array(32).fill(7);
    w.priceFeed = (await generateKeyPairSigner()).address;
    w.priceOpts = {};
    w.setPrice = (o = w.priceOpts) => {
      const { price = 20_000_000_000n, conf = 20_000_000n, expo = -8, age = 0, feedId = w.feedId } = o;
      const data = priceUpdateBytes({ feedId, price, conf, expo, publishTime: Number(w.now()) - age });
      put(w.priceFeed, data, PYTH_RECEIVER);
    };
    w.setPrice();
    const r3 = await w.send(w.admin, [await setVenueIx({ admin: w.admin, swapProgram: STUB_SWAP_PROGRAM, priceFeed: w.priceFeed, feedId: w.feedId })]);
    if (!r3.ok) throw new Error('set_venue failed\n' + r3.logs);
  };

  return w;
}
