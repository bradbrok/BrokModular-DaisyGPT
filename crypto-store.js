// crypto-store.js — AES-256-GCM encryption for localStorage values
// Encryption key stored as non-extractable CryptoKey in IndexedDB,
// separate from the encrypted ciphertext in localStorage.

const DB_NAME = 'daisy-gpt-crypto';
const STORE_NAME = 'keys';
const KEY_ID = 'master';

const HAS_CRYPTO = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';

let masterKey = null;

// ─── IndexedDB helpers ──────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── Base64 helpers ─────────────────────────────────────────────────

function toBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ─── Public API ─────────────────────────────────────────────────────

export async function initCryptoStore() {
  if (!HAS_CRYPTO) {
    console.warn('[crypto-store] Web Crypto API unavailable — keys will be stored in plaintext');
    return;
  }

  try {
    const db = await openDB();
    masterKey = await idbGet(db, KEY_ID);

    if (!masterKey) {
      masterKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,              // non-extractable
        ['encrypt', 'decrypt']
      );
      await idbPut(db, KEY_ID, masterKey);
    }

    db.close();
  } catch (err) {
    console.warn('[crypto-store] Failed to initialise — falling back to plaintext', err);
    masterKey = null;
  }
}

export async function encryptValue(plaintext) {
  if (!masterKey) return plaintext;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, masterKey, encoded);

  return JSON.stringify({
    v: 1,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct))
  });
}

export async function decryptValue(stored) {
  if (!masterKey) return stored;

  const envelope = JSON.parse(stored);
  const iv = fromBase64(envelope.iv);
  const ct = fromBase64(envelope.ct);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, masterKey, ct);

  return new TextDecoder().decode(plain);
}

export function isEncryptedEnvelope(value) {
  if (!value || value[0] !== '{') return false;
  try {
    const obj = JSON.parse(value);
    return obj.v === 1 && typeof obj.ct === 'string';
  } catch {
    return false;
  }
}
