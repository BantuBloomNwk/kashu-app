// A passkey signer for Swig that sends the browser's exact clientDataJSON (Swig's "raw" WebAuthn mode, kind 2).
// The SDK's own signer sends a template Swig rebuilds on chain, which fails whenever the browser adds a field
// (Chrome randomly adds "other_keys_can_be_added_here" so that nobody matches the JSON against a template).
// Raw mode reads the challenge out of the real JSON, so it holds every time. Same signature, same checks.
import { secp256r1DerToRawSignature } from '@swig-wallet/lib';

const RAW_CLIENT_DATA_JSON = 2;

export function rawWebAuthnSigningFn(options: Omit<PublicKeyCredentialRequestOptions, 'challenge'>) {
  return async (message: Uint8Array) => {
    const assertion = (await navigator.credentials.get({ publicKey: { ...options, challenge: message.slice() } })) as PublicKeyCredential | null;
    if (!assertion) throw new Error('No passkey answer');
    const r = assertion.response as AuthenticatorAssertionResponse;
    const authData = new Uint8Array(r.authenticatorData);
    const clientJson = new Uint8Array(r.clientDataJSON);
    if (clientJson.length > 1024) throw new Error('The passkey answer is too long');
    const prefix = new Uint8Array(2 + 2 + authData.length + 2 + clientJson.length);
    const v = new DataView(prefix.buffer);
    v.setUint16(0, RAW_CLIENT_DATA_JSON, true);
    v.setUint16(2, authData.length, true);
    prefix.set(authData, 4);
    v.setUint16(4 + authData.length, clientJson.length, true);
    prefix.set(clientJson, 6 + authData.length);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientJson));
    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData, 0); signed.set(hash, authData.length);
    return { signature: secp256r1DerToRawSignature(new Uint8Array(r.signature)), prefix, message: signed };
  };
}
