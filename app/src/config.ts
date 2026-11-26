// Which Solana network this build talks to (VITE_CLUSTER=mainnet for the beta; devnet otherwise). Everything that
// differs between the two reads from here, so a build can't mix networks.
export const CLUSTER = ((import.meta.env.VITE_CLUSTER as string | undefined) ?? 'devnet') as 'devnet' | 'mainnet';
export const MAINNET = CLUSTER === 'mainnet';
export const explorer = (kind: 'tx' | 'address', id: string) => `https://explorer.solana.com/${kind}/${id}${MAINNET ? '' : '?cluster=devnet'}`;
export const DEFAULT_USDC = MAINNET ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const DEFAULT_TEE = MAINNET ? 'https://mainnet-tee.magicblock.app' : 'https://devnet-tee-as.magicblock.app';
export const POCKET_CLUSTER = MAINNET ? 'mainnet-private' : 'devnet-private';

/**
 * The passkey domain. On the test network Kashu's passkeys were made on kashu-preview.netlify.app; getkashu.com
 * keeps using them through WebAuthn related origins (kashu-preview publishes /.well-known/webauthn naming
 * getkashu.com). Mainnet passkeys belong to getkashu.com itself.
 */
export const RP_ID = MAINNET ? 'getkashu.com' : 'kashu-preview.netlify.app';
