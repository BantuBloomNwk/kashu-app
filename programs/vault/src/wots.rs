//! Winternitz one-time signatures with w = 16 under a Merkle tree, SHA-256 through the syscall.
//!
//! Every hash is tweaked with a public seed and its position (leaf, chain, step), the way SPHINCS+
//! does it, so a hash computed for one position is useless at any other. The message digest gives 64
//! base-16 digits and a 3-digit checksum, 67 chains in all. Signing digit d means revealing the
//! chain value d steps in; checking it means hashing the remaining 15 - d steps and landing on the
//! public chain end. The 67 ends hash to a leaf, and the leaf climbs to the root.
//!
//! client/wots.mjs holds the signer, which must stay byte-for-byte in step with this file.

use solana_sha256_hasher::hashv;

pub const W: u8 = 16;
pub const LEN1: usize = 64;
pub const LEN2: usize = 3;
pub const LEN: usize = LEN1 + LEN2;

fn tweak(seed: &[u8; 32], leaf: u32, chain: u8, step: u8, x: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"sv-chain", seed, &leaf.to_le_bytes(), &[chain, step], x]).to_bytes()
}

/// The 67 base-16 digits a message signs: the digest's nibbles, high first, then the checksum.
pub fn digits(msg: &[u8; 32]) -> [u8; LEN] {
    let mut d = [0u8; LEN];
    for (i, b) in msg.iter().enumerate() {
        d[2 * i] = b >> 4;
        d[2 * i + 1] = b & 0x0f;
    }
    let csum: u16 = d[..LEN1].iter().map(|&x| (W - 1 - x) as u16).sum();
    d[LEN1] = ((csum >> 8) & 0x0f) as u8;
    d[LEN1 + 1] = ((csum >> 4) & 0x0f) as u8;
    d[LEN1 + 2] = (csum & 0x0f) as u8;
    d
}

/// Recomputes the root a signature commits to. The caller compares it with the stored root.
pub fn root_from_signature(
    seed: &[u8; 32],
    msg: &[u8; 32],
    leaf_index: u32,
    sig: &[[u8; 32]],
    path: &[[u8; 32]],
) -> [u8; 32] {
    let d = digits(msg);
    let mut ends = [[0u8; 32]; LEN];
    for i in 0..LEN {
        let mut x = sig[i];
        for step in d[i]..(W - 1) {
            x = tweak(seed, leaf_index, i as u8, step, &x);
        }
        ends[i] = x;
    }
    let mut parts: Vec<&[u8]> = Vec::with_capacity(LEN + 3);
    let leaf_le = leaf_index.to_le_bytes();
    parts.push(b"sv-leaf");
    parts.push(seed);
    parts.push(&leaf_le);
    for e in ends.iter() {
        parts.push(e);
    }
    let mut node = hashv(&parts).to_bytes();
    let mut idx = leaf_index;
    for sib in path {
        node = if idx & 1 == 0 {
            hashv(&[b"sv-node", &node, sib]).to_bytes()
        } else {
            hashv(&[b"sv-node", sib, &node]).to_bytes()
        };
        idx >>= 1;
    }
    node
}
