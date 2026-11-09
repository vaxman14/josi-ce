// The browser's half of a passkey. WebAuthn takes and gives binary, the API talks
// JSON, and this is the conversion between them.
import { api } from './api';

const toBytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const fromBytes = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface SignInMethods { passkey: boolean; passkeyOrigin: string | null; emailCode: boolean; appleUrl: string | null }

/** The server can do it, this browser can do it, and this is the address the
 * passkeys belong to. Reached any other way, a passkey could not work. */
export function canUsePasskeys(origin: string | null | undefined): boolean {
  return !!origin && origin === window.location.origin && window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
}

/** Says what happened in a sentence, for an error WebAuthn only gives a name. */
export function passkeyMessage(err: unknown, fallback: string): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return 'That passkey request was cancelled or timed out.';
    if (err.name === 'InvalidStateError') return 'This device already has a passkey for your account.';
    return fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

interface CredentialOptions { challenge: string; user?: { id: string; name: string; displayName: string }; excludeCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }> }

export async function createPasskey(password: string, name: string): Promise<void> {
  const { options } = await api.post<{ options: CredentialOptions & Record<string, unknown> }>('/auth/passkeys/options', { password });
  const credential = await navigator.credentials.create({ publicKey: {
    ...options,
    challenge: toBytes(options.challenge),
    user: { ...options.user!, id: toBytes(options.user!.id) },
    excludeCredentials: options.excludeCredentials?.map(key => ({ ...key, id: toBytes(key.id) })),
  } as unknown as PublicKeyCredentialCreationOptions }) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was created.');
  const response = credential.response as AuthenticatorAttestationResponse;
  await api.post('/auth/passkeys', {
    name,
    clientDataJSON: fromBytes(response.clientDataJSON),
    attestationObject: fromBytes(response.attestationObject),
    transports: response.getTransports?.() ?? [],
  });
}

export async function signInWithPasskey(): Promise<void> {
  const { options } = await api.post<{ options: { challenge: string } & Record<string, unknown> }>('/auth/passkey/options');
  const credential = await navigator.credentials.get({ publicKey: { ...options, challenge: toBytes(options.challenge) } as unknown as PublicKeyCredentialRequestOptions }) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was chosen.');
  const response = credential.response as AuthenticatorAssertionResponse;
  await api.post('/auth/passkey/verify', {
    credentialId: fromBytes(credential.rawId),
    clientDataJSON: fromBytes(response.clientDataJSON),
    authenticatorData: fromBytes(response.authenticatorData),
    signature: fromBytes(response.signature),
    userHandle: response.userHandle ? fromBytes(response.userHandle) : null,
  });
}
