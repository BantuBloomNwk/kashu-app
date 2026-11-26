#!/usr/bin/env bash
# Kashu: devnet to mainnet in one command. A dry run by default (checks everything, changes nothing);
# --for-real does it. Every step is safe to run again: it skips what's already done.
#
#   bash scripts/go-mainnet.sh                 # dry run: preflight only
#   bash scripts/go-mainnet.sh --for-real      # deploy
#
# Settings (environment):
#   DEPLOY_KEY      the mainnet deploy wallet's keypair file (yours; default ~/.kashu-mainnet-deployer.json)
#   SQUADS_VAULT    your Squads multisig's vault address: the programs' upgrade key moves there (strongly expected)
#   NETLIFY_SITE    the Netlify site id for the mainnet beta app
#   BETA_SITE       its public address, e.g. https://kashu-beta.netlify.app
#   INVITES         how many invite codes to make at the end (default 10, up to 5 people each)
#   HEADROOM        program account size over today's build, for upgrades (default 1.25)
set -euo pipefail
cd "$(dirname "$0")/.."
REAL=no; [ "${1:-}" = "--for-real" ] && REAL=yes
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.kashu-mainnet-deployer.json}"
BETA_SITE="${BETA_SITE:-https://kashu-beta.netlify.app}"
# room for upgrades in the program accounts: 1.25 = a quarter more than today's build (they can be extended later)
HEADROOM="${HEADROOM:-1.25}"
RPC="https://mainnet.helius-rpc.com/?api-key=$(cat ~/.helius-main)"
hide() { sed 's/api-key=[A-Za-z0-9-]*/<hidden>/g'; }
say() { printf '\n== %s\n' "$*"; }
stop() { printf '\nSTOP: %s\n' "$*"; exit 1; }
source scripts/env.sh >/dev/null 2>&1

say "Preflight"
grep -q '^CONFIRMED="yes"' SECURITY_TXT.env || stop "confirm the on-chain security details in SECURITY_TXT.env (site, contact, policy, source), then set CONFIRMED=\"yes\""
[ -f "$DEPLOY_KEY" ] || stop "no deploy key at $DEPLOY_KEY"
PAYER=$(solana-keygen pubkey "$DEPLOY_KEY"); echo "deploy wallet  $PAYER"
BAL=$(solana balance "$PAYER" -u "$RPC" 2>/dev/null | awk '{print $1}'); echo "balance        $BAL SOL"
npm run build >/dev/null 2>&1 || stop "the programs don't build"
need=0
for p in vault rooms; do
  sz=$(stat -c %s target/deploy/$p.so)
  if solana program show "$(solana-keygen pubkey target/deploy/$p-keypair.json)" -u "$RPC" >/dev/null 2>&1; then echo "$p           already on mainnet (an upgrade needs a buffer of $sz bytes)"; fi
  len=$(python3 -c "print(int($sz * $HEADROOM))")
  rent=$(solana rent "$len" -u "$RPC" 2>/dev/null | awk '/Rent-exempt minimum/{print $3}')
  echo "$p           $sz bytes, about $rent SOL held as rent (room for $len bytes)"
  need=$(python3 -c "print($need + ${rent:-0})")
done
# while deploying, the program sits in a temporary buffer whose rent comes back once it's in place: the largest one counts
buf=$(solana rent "$(stat -c %s target/deploy/vault.so)" -u "$RPC" 2>/dev/null | awk '/Rent-exempt minimum/{print $3}')
echo "buffer         about $buf SOL more while deploying, returned after"
need=$(python3 -c "print(round($need + ${buf:-0} + 1.6, 2))")   # + sponsor 0.6, keeper 0.6, fees and the vault's own accounts
echo "needed         about $need SOL"
python3 -c "import sys; sys.exit(0 if float('${BAL:-0}') >= $need else 1)" || stop "the deploy wallet needs about $need SOL (has ${BAL:-0})"
for p in vault rooms; do strings target/deploy/$p.so | grep -q "BEGIN SECURITY.TXT" || stop "$p has no security.txt in its build"; done
echo "security.txt   in both builds: $(grep '^KASHU_SITE' SECURITY_TXT.env | cut -d'"' -f2)"
for t in vault rooms prize lend review jupiter interest; do timeout 900 node tests/$t.mjs 2>&1 | tail -1 | grep -q ' 0 failed' || stop "tests/$t.mjs is failing"; done
echo "tests          all seven suites pass"
[ -n "${SQUADS_VAULT:-}" ] && echo "upgrade key -> Squads vault $SQUADS_VAULT" || echo "upgrade key    stays with the deploy wallet for now (set SQUADS_VAULT to move it: needed before invites go out)"
# the binaries that go on chain come from the reproducible Docker build, so anyone can rebuild the repo and
# match them byte for byte (and explorers can show "verified" once the repo is public)
for p in vault rooms; do
  solana-verify build --base-image solanafoundation/solana-verifiable-build:4.3.0 --arch v3 --library-name $p >/dev/null 2>&1 || stop "the reproducible build of $p failed"
  echo "$p hash     $(solana-verify get-executable-hash target/deploy/$p.so)"
done
[ "$REAL" = yes ] || { say "Dry run done: everything above is ready. Run with --for-real to deploy."; exit 0; }

say "1. Programs"
for p in vault rooms; do
  id=$(solana-keygen pubkey target/deploy/$p-keypair.json)
  solana program deploy target/deploy/$p.so --program-id target/deploy/$p-keypair.json --keypair "$DEPLOY_KEY" --upgrade-authority "$DEPLOY_KEY" \
    --max-len $(python3 -c "print(int($(stat -c %s target/deploy/$p.so) * $HEADROOM))") -u "$RPC" --with-compute-unit-price 100000 --max-sign-attempts 50 2>&1 | hide | grep -E "Program Id|Signature|rror" | head -2
  echo "$p is $id"
done

say "2. Vault config and prize"
DEPLOY_KEY="$DEPLOY_KEY" node scripts/mainnet-init.mjs

if [ -n "${SQUADS_VAULT:-}" ]; then
  say "3. Upgrade key to your Squads multisig"
  for p in vault rooms; do
    solana program set-upgrade-authority "$(solana-keygen pubkey target/deploy/$p-keypair.json)" --new-upgrade-authority "$SQUADS_VAULT" \
      --skip-new-upgrade-authority-signer-check --keypair "$DEPLOY_KEY" -u "$RPC" 2>&1 | hide | tail -1
  done
fi

say "4. Mainnet relay, keeper and agent"
ALLOW_ORIGIN="$BETA_SITE" bash scripts/deploy-mainnet.sh | tail -2
NETWORK=mainnet ALLOW_ORIGIN="$BETA_SITE" bash scripts/deploy-agent.sh | tail -1
H=$(curl -s https://kashu-main.161-97-74-212.sslip.io/health)
for who in sponsor keeper; do
  a=$(echo "$H" | python3 -c "import json,sys; print(json.load(sys.stdin)['$who'] or '')")
  [ -n "$a" ] && solana transfer "$a" 0.6 --keypair "$DEPLOY_KEY" --allow-unfunded-recipient -u "$RPC" 2>&1 | hide | grep -E "Signature|rror" | head -1 && echo "funded $who $a"
done

if [ -n "${NETLIFY_SITE:-}" ]; then
  say "5. The mainnet app"
  (cd app && VITE_CLUSTER=mainnet VITE_RELAY=https://kashu-main.161-97-74-212.sslip.io npx vite build >/dev/null && \
    sed -i "s|https://kashu-relay.161-97-74-212.sslip.io https://devnet-tee-as.magicblock.app|https://kashu-main.161-97-74-212.sslip.io https://mainnet-tee.magicblock.app|; s|img-src 'self' data: blob: https://kashu-relay.161-97-74-212.sslip.io|img-src 'self' data: blob: https://kashu-main.161-97-74-212.sslip.io|" dist/_headers && \
    netlify deploy --no-build --prod --dir dist --site "$NETLIFY_SITE" | grep -iE "deploy is live|error" | head -1)
fi

say "6. Invites"
bash scripts/make-invites.sh "${INVITES:-10}" 5

say "Done. Mainnet beta is up at $BETA_SITE (invite-only, \$50 a saver, \$5,000 in all)."
