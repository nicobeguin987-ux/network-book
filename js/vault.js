// Passphrase encryption for the optional data bundle (data/vault.json).
// PBKDF2-SHA256 key derivation + AES-256-GCM, all through the browser's Web Crypto API.
// The repo only ever contains ciphertext; the passphrase never leaves your device.

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const cryptoApi = () => (globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto : null;

async function deriveKey(passphrase, salt, iterations) {
  const c = cryptoApi();
  const base = await c.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return c.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(obj, passphrase, iterations = 600000) {
  const c = cryptoApi(); if (!c) throw new Error('This browser cannot encrypt (Web Crypto missing).');
  const salt = c.getRandomValues(new Uint8Array(16)), iv = c.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { app: 'network-book', format: 1, kdf: 'PBKDF2-SHA256', iterations, cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), data: b64(ct), createdAt: new Date().toISOString() };
}

export async function decryptJson(vault, passphrase) {
  const c = cryptoApi(); if (!c) throw new Error('This browser cannot decrypt (Web Crypto missing).');
  const key = await deriveKey(passphrase, unb64(vault.salt), vault.iterations);
  try {
    const pt = await c.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.data));
    return JSON.parse(dec.decode(pt));
  } catch (e) {
    throw Object.assign(new Error('Wrong passphrase'), { code: 'bad_passphrase' });
  }
}
