// The signer for programs/vault/src/wots.rs: Winternitz w = 16, 67 chains, SHA-256 with position
// tweaks, under a Merkle tree. Must stay byte-for-byte in step with the Rust side.
import { createHash, randomBytes } from 'crypto';

const W = 16, LEN1 = 64, LEN = 67;
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

export function digits(msg) {
  const d = [];
  for (const b of msg) d.push(b >> 4, b & 0x0f);
  const csum = d.slice(0, LEN1).reduce((a, x) => a + (W - 1 - x), 0);
  d.push((csum >> 8) & 0x0f, (csum >> 4) & 0x0f, csum & 0x0f);
  return d;
}

/** A key tree of 2^height one-time keys, all derived from one 32-byte master secret. */
export function keyTree(height, master = randomBytes(32), seed = randomBytes(32)) {
  const tweak = (leaf, i, s, x) => sha(Buffer.from('sv-chain'), seed, u32(leaf), Buffer.from([i, s]), x);
  const chain = (leaf, i, x, from, to) => { for (let s = from; s < to; s++) x = tweak(leaf, i, s, x); return x; };
  const sk = (leaf, i) => sha(Buffer.from('sv-sk'), master, u32(leaf), Buffer.from([i]));
  let level = [];
  for (let leaf = 0; leaf < 1 << height; leaf++) {
    const ends = []; for (let i = 0; i < LEN; i++) ends.push(chain(leaf, i, sk(leaf, i), 0, W - 1));
    level.push(sha(Buffer.from('sv-leaf'), seed, u32(leaf), ...ends));
  }
  const tree = [level];
  while (level.length > 1) { const up = []; for (let i = 0; i < level.length; i += 2) up.push(sha(Buffer.from('sv-node'), level[i], level[i + 1])); tree.push(up); level = up; }
  return {
    seed, root: level[0], leaves: 1 << height,
    sign(leaf, msg) {
      const sig = digits(msg).map((di, i) => chain(leaf, i, sk(leaf, i), 0, di));
      const path = []; let idx = leaf;
      for (let h = 0; h < height; h++) { path.push(tree[h][idx ^ 1]); idx >>= 1; }
      return { sig, path };
    },
  };
}

export { sha, u32 };
