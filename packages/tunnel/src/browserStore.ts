// What a browser remembers about its pairing, in IndexedDB. The device key is a
// non-extractable CryptoKey where the browser supports X25519 in WebCrypto, so
// page script can use it and can't read it out. Older browsers fall back to raw
// bytes, which is weaker and is reported as such.
import { generateKeyPair, staticKeyFrom, type StaticKey } from './noise.js';

export interface Pairing {
  site: string;
  /** Noise static key of the server, base64url. */
  server: string;
  previousServer?: string | null;
  device: string;
  keyKind: 'webcrypto' | 'raw';
  publicKey: Uint8Array;
  key: CryptoKey | Uint8Array;
}

const DB = 'josi-tunnel', STORE = 'kv', RECORD = 'pairing';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => { db.close(); resolve(request.result); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export const loadPairing = (): Promise<Pairing | undefined> => run('readonly', store => store.get(RECORD) as IDBRequest<Pairing | undefined>);
export const savePairing = (pairing: Pairing): Promise<IDBValidKey> => run('readwrite', store => store.put(pairing, RECORD));
export const clearPairing = (): Promise<undefined> => run('readwrite', store => store.delete(RECORD));

export async function newBrowserKey(): Promise<Pick<Pairing, 'keyKind' | 'publicKey' | 'key'>> {
  try {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { keyKind: 'webcrypto', publicKey, key: pair.privateKey };
  } catch {
    const { privateKey, publicKey } = generateKeyPair();
    return { keyKind: 'raw', publicKey, key: privateKey };
  }
}

export function staticKeyOf(pairing: Pick<Pairing, 'keyKind' | 'publicKey' | 'key'>): StaticKey {
  if (pairing.keyKind === 'raw') return staticKeyFrom(pairing.key as Uint8Array);
  return {
    publicKey: pairing.publicKey,
    dh: async remote => {
      const peer = await crypto.subtle.importKey('raw', remote as Uint8Array<ArrayBuffer>, { name: 'X25519' }, false, []);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, pairing.key as CryptoKey, 256));
    },
  };
}
