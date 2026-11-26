# Kashu

**Save together. Win on Fridays.**

Kashu is a savings app for friends. You and your friends join a room and put a little away on
payday. Your savings stay yours and earn interest. Each week, a share of that interest (plus a
sponsor's bonus) becomes a prize, and a draw anyone can check picks who gets it. Your friends see
your streak, never your amount. The draw never touches your savings.

It is our answer to Pedro Miranda's Solana Request for Startups, "Entertainment finance for
everyone", and our entry to MagicBlock's Solana Blitz v10 (Entertainment Finance). Social savings
for entertainment finance: the habit of a savings circle (ajo, chama, paluwagan, kutu, susu, tanda)
with a weekly show at the end of it.

## Try it

Open **[getkashu.com](https://getkashu.com)** on your phone or computer. Chrome, Edge or Safari work best.

You don't need to know anything about crypto to use it. Here is what to expect.

**It runs on test money.** Kashu is in a test phase on Solana's test network. Every dollar in it is a free test dollar with no real value, so you can try everything without risking anything. The app shows you where to get them: tap **Get test dollars**, and Circle's free faucet gives you some (choose "Solana Devnet" there). Kashu copies your address for you, so you only paste it.

**A week is 10 minutes.** On the test network, Kashu's week lasts 10 minutes instead of 7 days, so you can see a whole week happen while you watch: saves, streaks, the draw and the prize. That's also why some test profiles show streaks like "18 weeks in a row" after an afternoon. On the real network a week is a real week.

**No seed phrase, no wallet app.** You sign in with a passkey, the same face or fingerprint check your phone already uses. Kashu pays the network fees for you.

**What you can do:**

1. **Open your vault and save.** Put away a few test dollars. They start earning interest right away on Jupiter Lend.
2. **Start or join a room.** Invite friends. They see that you saved and your streak, never your amount.
3. **Pick a plan.** Keep everything in dollars, or put part of each week into SOL. Kashu buys it for you each week at a fair, checked price.
4. **Wait for draw night.** Every week, one saver in the room wins a prize paid from the room's interest and a sponsor bonus. Nobody's savings are ever used for the prize.
5. **Turn winnings into SOL.** If you win, you can have a few dollars of your prize turned into SOL each week. Your own savings stay as they are.
6. **Send money by name.** Pay a friend by their Kashutag (like $ada). Or use your private pocket, where payments between friends don't show up anywhere public.
7. **Ask the agent.** Tell it something like "save $5 every Friday" and it sets that up for you, within limits you approve.

**Words you'll see:**

| Word | What it means |
|---|---|
| Vault | Your savings account inside Kashu. Only you can take money out. |
| Room | A small group of friends (up to 12) saving together. |
| Streak | How many weeks in a row you've saved. |
| Draw night | When the week's prize is given to one saver, picked by a random number anyone can check. |
| Pocket | A private balance. Payments between pockets aren't visible to anyone else. |
| Kashutag | Your name in Kashu, like $ada, so friends can pay you without a long address. |
| Receipt | Every action ends with a plain-words receipt and a link to check it on Solana. |

**Is it safe?** Your savings sit in a vault that only you can take money out of. The program has no button for Kashu to move them, and before real money, any change to the program will need several people to approve it and a waiting period. The code is open below, tested, and every step leaves a public record you can check. The test phase is free and uses no real money. Before real money, the plan is an outside security audit, small limits per person, and invite-only access.

## Live on devnet

| | Address |
|---|---|
| Vault program | `3jYUfoa788SJpFbbPS7vFxTNkWCRN1c4gx3rcgmH9GxH` |
| Rooms program | `8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q` |
| Devnet swap venue (stub, see below) | `2GHiWi58tM1BMVHU52ey88ncEzQq2q6AHNnbujcvrUTF` |

What has run there, with real transactions:

- **A private room on MagicBlock's TEE rollup.** A room and its member record were handed to the
  TEE validator, `share_room` ran inside the private rollup, and then a member could read the room
  while a stranger signed in to the same rollup saw nothing
  ([delegation](https://explorer.solana.com/tx/1nVH3wgpZd2CSbFdF74856jm2TAGxBZNhG2y9czPARm3PoRimHtcZ2Y2YN3JjndP61SeW3oYYAe8B9qzTTxwSBU?cluster=devnet)).
  `scripts/devnet-rooms.mjs`.
- **Savings earning on Jupiter Lend.** 10 USDC saved, lent on Jupiter Lend's devnet USDC market,
  2 brought back, 8 left earning
  ([lend](https://explorer.solana.com/tx/4eSXSfoVHEZunXmdAja34pdRmF81sfodwwhPZUcyUPx9P5kAnpnLsvZuxMVWmdncoMGpRn4Me2pdYvwNzXUfhEfN?cluster=devnet),
  [unlend](https://explorer.solana.com/tx/55hcyk7Eg5dER82Mqx6VQ5p5VwB6ciycFA8VXxTieRiv5LsFXrWUCxcyPYVSeZiYaLUNnogpbKP3R1aDnwLm93XP?cluster=devnet)).
  `scripts/devnet-lend.mjs`.
- **The weekly buy on lent savings.** A saver lends everything; when the week is up a stranger
  brings back exactly the shortfall and presses the weekly button, which buys SOL at a price
  checked against Pyth. `scripts/devnet-weekly.mjs`. ([prepare_buy](https://explorer.solana.com/tx/8mXSwkMtVh3U4Ca4VRftc71QWcTWLsw1zPhApVoxesnHHPdTkk85rq2HtXSEZtpUdeRu9u4JrNZDXSQJAkMKFLL?cluster=devnet), [weekly buy](https://explorer.solana.com/tx/2msGWeqjHoXnSossPsDUH1oiFKK2QCFXpUACWSYAZdNbG83N7j5v291xpxdvxcXxhXY4Ejh2nhUoLSBWz1TBJanq?cluster=devnet): 1 USDC bought 0.01423 SOL against a Pyth price of $70.62; 2 USDC stay lent)
- **The Friday prize pot.** Kashu's cut set at 10% (the program refuses more), a pot opened for the
  private room above (still on the TEE rollup, read through its delegation record), the demo saver's
  interest linked to it, and a sponsor's dollar in it
  ([pot opened](https://explorer.solana.com/tx/mwewZnudV4c6Ssj3VU5PxLvc9QcTwqYv4Hb8CJSANMTRmYBXk6zwKqCFUuDjfhoQySukmyB2Qp5sRwm8d3m5D1t?cluster=devnet),
  [linked](https://explorer.solana.com/tx/3wF52rR2pP5hysWJUQF3oWLtyPhG31GXWf4ZxCKd8yMPXAAdu9dyLZgobwdS7qBuBPcvxM2TDarJHFg47LEQXy6A?cluster=devnet),
  [sponsor](https://explorer.solana.com/tx/4pv9YCVBr6ivERD1Bi2KCja9JaXFmLonwzafKMpr6qefgD5EryWx8k7huy62hbXtha95cRQeCFsXfPkfT3gU2xaS?cluster=devnet)).
  Jupiter Lend's devnet market pays almost nothing (about 0.013% a year), so the harvest there waits
  for its one-cent minimum; tests/prize.mjs harvests real devnet-program interest in memory.
  `scripts/devnet-prize.mjs`.

- **The app, live.** [kashu-preview.netlify.app](https://kashu-preview.netlify.app/#app-start): a passkey
  (Face ID or fingerprint) controls a [Swig](https://github.com/anagrambuild/swig-wallet) smart wallet; you open a
  vault, start or join a room and save, each step read back in plain words before you approve. Kashu's relay pays
  the network fees under strict rules and keeps every key off your phone (`relay/relay.mjs`).
- **A whole week with nobody pressing a button.** Kashu's keeper (`relay/keeper.mjs`) counted saves, added a
  sponsor's bonus, asked MagicBlock's VRF for the draw
  ([request](https://explorer.solana.com/tx/5NrrkYzcD3fFqVpDdML2B6mtX52JyjYyLrF3L5CDJNfoz4nhuT7bmEZfm8PWtGQDsvhkRkx7xnJ92LvVhXcZVkrc?cluster=devnet)),
  settled it with the saver holding the winning ticket
  ([settle](https://explorer.solana.com/tx/39GCud7XEGCjYQ6K73xhdJ4QvJjgdB7K5ABBQyjZ6Uj9tKVFi4MVftPEi8NX1GQ4rD65LLZuyMVNM1tWJdi4SLmr?cluster=devnet)),
  paid the pot into their vault
  ([prize](https://explorer.solana.com/tx/Vg8uJFTX4Zi2dTokG1ZfTxk9NBLMwiH7TYVkqov9Ed2o8t2KG6bwZpFPDgfSKQPriaimPeqPiTFg5wQGrk9zmu7?cluster=devnet))
  and started the next week. App rooms run on Solana for now; the private-rollup room above is the next step for them.

Devnet builds differ from mainnet in three stated ways: a 10-minute week (vault and rooms) (so a whole cycle can be
watched), a Pyth price up to 3 hours old (Pyth refreshes devnet feeds about every half hour), and
a stub swap venue priced from Pyth (Jupiter's aggregator is not on devnet). The mainnet path
through Jupiter is proven against a live mainnet route; see Tests.

## How the money moves

1. **Save.** You deposit USDC into your own vault: a program account derived from your wallet. No
   one else can withdraw from it, including us.
2. **Earn.** Your vault lends on **Jupiter Lend**. The vault itself is the depositor and holds the
   lending shares, so the money never leaves your vault. Only you move money in or out of lending.
3. **Invest a little each week (optional).** Your rule says how much of each week goes into SOL.
   Once a week anyone may press the weekly button. They bring a route from **Jupiter's
   aggregator** and nothing else; the minimum the buy must return comes from **Pyth**.
4. **Room and streak.** Your room lives on a **MagicBlock Private Ephemeral Rollup**. Saving
   grows your streak; each week in a row is a chance in Friday's draw, up to four.
5. **Draw night.** **MagicBlock VRF** picks a ticket. The winner's chances, the random number and
   the ticket ranges are all on chain, so anyone can check the result.
6. **The prize is interest, never savings.** Savers who join their room's pot let anyone harvest
   their interest: only what the lending shares are worth above what they put in leaves Jupiter
   Lend, and afterwards the shares must still cover every dollar saved, or nothing happens. Kashu
   keeps a cut (set at 10%; the program refuses more), the rest goes to the pot, and sponsors can
   add to it. Once the draw is settled anyone pays the whole pot into the winner's vault. Not joining
   is Keep mode: your interest stays yours and Kashu takes nothing.

## Why it is safe to press the weekly button for someone else

The weekly button is permissionless, so everything about it is boxed in:

1. **The caller chooses nothing that matters.** The amount comes from the owner's rule, the asset
   from the menu, the venue from settings the admin names once, and the minimum from Pyth.
2. **The route is treated as hostile.** The vault moves exactly this week's spend into the swap
   authority's own account (a vault-program address only the vault can sign for), and the route
   swaps from there. The route gets no signature but the swap authority's, and may not name the
   vault's record, cash or holding account.
3. **Balances decide.** Afterwards everything the swap produced is swept into your holding account
   and unspent dollars back to cash. If exactly the week's spend did not leave, or less than the
   oracle-priced minimum arrived, the whole transaction is refused.
4. **The price is checked, not trusted.** A Pyth update counts only if it is owned by Pyth's
   receiver, fully verified, for the venue's feed, fresh (2 minutes on mainnet) and narrow
   (confidence under 1%). The admin's floor can only make the minimum stricter.
5. **Admin bounds are hard limits.** Slippage up to 3%, price age up to 5 minutes, confidence up to
   2%, set once. Loosening them takes a program upgrade.
6. **Lent savings come back only as needed.** `prepare_buy` lets anyone bring back from Jupiter
   Lend exactly the shortfall a due buy needs, and nothing when it is not due.

## MagicBlock, where and how

| Product | Where | What it does |
|---|---|---|
| Private Ephemeral Rollup (TEE) | `programs/rooms`, `share_room` | Room and member records are delegated to the TEE validator; their permissions let exactly the room's roster read them (with logs, balances, messages and signatures). Records pay their own ephemeral permission rent. |
| Ephemeral Rollup | `programs/rooms` | Check-ins, streaks and cheers run on the rollup with session keys, then settle to Solana. |
| VRF | `programs/rooms`, `request_draw` / `callback_draw` | The weekly draw's random number; the callback is authenticated by the VRF macros; settlement is permissionless by ticket range. |

## Tests

```
npm install
npm run build     # vault (mainnet and devnet builds), rooms, stub venue; Agave 4.3.2, sBPF v3
npm test          # 227 checks on an in-memory chain (LiteSVM)
npm run flow      # the whole story once, in plain words
```

| Suite | Checks | What it runs against |
|---|---|---|
| `tests/vault.mjs` | 108 | Caps, rules, the weekly button and its attacks, the oracle and venue bounds, withdrawals, admin handover, hostile venues, the hash-based key |
| `tests/rooms.mjs` | 37 | Rooms, check-ins against real vault saves, streaks, tickets, the draw, cheers, the private roster and its funding |
| `tests/lend.mjs` | 29 | **Jupiter Lend's real devnet programs and USDC market**, copied into memory (`scripts/juplend-fixtures.mjs`): lend, unlend, caps, pause, look-alike markets, and the weekly buy on lent savings |
| `tests/prize.mjs` | 42 | **The Friday prize against Jupiter Lend's real devnet program and the real rooms program**: the cut's hard limit, pots only for real rooms, interest harvested to the pot and treasury while the savings stay covered, Keep mode, sponsors, paying the settled winner once, rooms read while delegated, and savers leaving |
| `tests/interest.mjs` | 16 | **Interest at the real mainnet rate**: Jupiter Lend's mainnet USDC market and programs copied into memory (`npm run test:interest`). A week on 50 dollars earned about $0.039 (about 4.1% a year at the time of copying); 90% reached the prize, exactly 10% went to Kashu, the winner was paid, and the saver took home 50 dollars plus the prize |
| `tests/jupiter.mjs` | 11 | **Jupiter's aggregator on a live mainnet route** (USDC to SOL through an Orca Whirlpool) with every account it touches and the live Pyth SOL price, copied from mainnet (`scripts/jupiter-fixtures.mjs`): exactly 5 dollars spent, Jupiter's quoted SOL received, 84,800 compute units, a 969-byte transaction; oversized routes and routes that pay someone else are refused |

## Layout

| Path | What |
|---|---|
| `programs/vault` | The vault (Anchor 1.2.1). `lib.rs` instructions, `state.rs` accounts, `swap.rs` the only door to a venue, `oracle.rs` Pyth, `lending.rs` Jupiter Lend, `wots.rs` the hash-based signature check |
| `programs/rooms` | Rooms, streaks, the draw, the private roster (MagicBlock SDK 0.17) |
| `programs/stub_swap` | A fixed-price test venue with two deliberate misbehaving modes. Devnet and tests only |
| `client/` | Instruction builders and account readers (Solana Kit) |
| `app/` | The Kashu web app and landing page (Vite, React) |
| `scripts/` | Devnet runs and fixture copiers |

## Quantum resistance

What is true today, and tested:

- A user can enrol a Winternitz one-time signature key (w = 16, SHA-256, 67 chains) under a
  Merkle tree on their vault. Its security rests on the hash function, not on elliptic curves.
- Once enrolled, the everyday key can no longer withdraw. A withdrawal needs a fresh one-time
  signature that names the token, the amount and the receiving account. Anyone can deliver it.
  Change any of the three and it fails. Each key number works once.
- The key can be replaced under its own signature and never removed.
- It fits one v1 transaction: about 2,800 bytes at tree height 4, about 120,000 compute units.

What is not quantum resistant, and we say so:

- The user's everyday wallet key (ed25519) and passkeys (P-256).
- Deposits, rules, lending and the weekly button. Someone who forged the everyday key could
  change the rule so the vault buys more SOL each week. They still could not take money out.
- A vault with no hash-based key enrolled. Enrolment is signed by the everyday key, so it has to
  happen before that key is at risk. The app should enrol at sign-up.
- The admin key, the upgrade authority, Solana's validators and consensus, the token program,
  the USDC issuer's keys, Jupiter, Pyth and MagicBlock.

What we tell users: "your savings leave the vault only with a hash-based signature; the
rest of Solana is ed25519 like everyone else."

## Threat list

| Threat | What stops it | Left open |
|---|---|---|
| The caller of the weekly button redirects the buy | The amount, asset, venue and minimum are fixed by rule, menu, settings and oracle; the route may not name the vault's own accounts | |
| A hostile route takes too much or pays too little | The swap authority holds exactly the week's spend; balances are judged after the sweep | |
| Sandwiching the weekly buy | The Pyth-priced minimum less at most 3% | A thin route can still fill near the bound; keep slippage at 1% |
| A forged or stale price | Owner, full verification, feed id, freshness and confidence are all checked | |
| Someone else withdraws | Owner must sign, the vault address is derived from the owner, the destination must be the owner's | A stolen everyday key can withdraw unless the hash-based key is enrolled |
| Caps bypassed | Only tracked deposits count; money in lending counts too | |
| Admin key stolen | The admin can pause, lower caps, raise the floor, hand over; no instruction moves user money; venue bounds are hard limits | Pause griefing. Fixed by a multisig with a time lock |
| Upgrade authority stolen | Nothing in the program can stop a malicious upgrade | Squads with a time lock, a verified build and Readback watching, all before mainnet |
| A look-alike lending market | Jupiter Lend's program ids and the market's derived addresses are pinned; balances are measured | |
| Room data seen by outsiders | Private rollup permissions list exactly the room's roster | Data is public once a room settles back to Solana; rooms stay on the rollup until they close |
| Balances visible on chain | Friends never see amounts in the app | Vault balances are public on Solana today; the pooled private ledger is next |
| Overflow, rounding | Checked math, overflow checks in release, conservative rounding | Not fuzzed yet |
| The stub venue reaching mainnet | Mainnet names Jupiter in `set_venue`, once | Add a build check |

## How Kashu makes money

Kashu keeps **10% of the interest** that goes into a room's prize pot. Nothing else: no fee on
saving, none on taking your money out, and none on your savings themselves.

- **The program enforces the limit.** The cut is a setting with a hard ceiling of 10% written into the
  program. Nobody, including us, can set it higher without a program upgrade, and upgrades are
  public on chain.
- **It goes down, not up.** 10% is where we start. As rooms grow we plan to lower it, and once Jupiter
  Lend's referral program pays us a share of the interest instead, we set the cut to zero. Lowering it
  is one public transaction.
- **Keep mode is free.** If you don't join a room's pot, all your interest stays with you and Kashu
  takes nothing.
- **Sponsors** can add to a prize pot. That money goes to the winner in full.

## Road to mainnet

Done and running on devnet: the vault, lending on Jupiter Lend, private rooms on MagicBlock's TEE
rollup, the weekly draw, prize pots and payouts, and a keeper that runs every saver's weekly SOL buy
and every room's harvest and draw. The app does all of it from a passkey, with no seed phrase.
The mainnet binaries come from a reproducible build.

Next, in order:

1. **Weekly buys on Jupiter.** Devnet buys go through a stand-in venue priced from Pyth. Mainnet
   routes through Jupiter, which the tests already prove against a live mainnet route.
2. **Fees through Jupiter.** Move Kashu's share to Jupiter Lend's referral program, then set the
   in-program cut to zero.
3. **Buying SOL from winnings.** A saver picks an amount a week, taken only from prizes they've won,
   never from their own savings.
4. **Before any real money:** a Squads multisig with a time lock as upgrade authority and admin,
   Readback watching the programs, fuzzing, an outside review, and a legal read of the draw.
5. **Private balances.** A pooled vault with each person's balance kept only inside the private
   rollup, so amounts stop being visible on chain.

## Legal limits for the beta

- **Fixed menu, no suggestions.** Dollars and SOL. The app never recommends a mix; recommending
  one is investment advice and needs a licence.
- **No bank links** in the beta, so no bank data is held.
- **Small money, public caps.** 50 dollars per person and 5,000 in total, enforced by the program.
- **The prize draw** is free to enter and never uses anyone's savings. Whether an interest-funded
  prize is treated as a lottery differs by country, so counsel reads it before mainnet.

Nothing in this repo is legal advice. A lawyer has not reviewed it.
