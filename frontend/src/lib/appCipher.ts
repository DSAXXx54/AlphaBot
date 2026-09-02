const KEY_MATERIAL = process.env.NEXT_PUBLIC_APP_CIPHER_KEY_MATERIAL;

export type EncryptedClientPayload = {
  payload: string;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function payloadParts(payload: string): { iv: ArrayBuffer; ciphertext: ArrayBuffer } {
  if (!payload.startsWith('v1.')) throw new Error('Unsupported encrypted payload');
  const encoded = payload.slice(3).replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  if (bytes.byteLength <= 12) throw new Error('Invalid encrypted payload');
  return { iv: toArrayBuffer(bytes.slice(0, 12)), ciphertext: toArrayBuffer(bytes.slice(12)) };
}

async function clientKey(): Promise<CryptoKey> {
  if (!KEY_MATERIAL) throw new Error('NEXT_PUBLIC_APP_CIPHER_KEY_MATERIAL is not configured');
  const material = toArrayBuffer(new TextEncoder().encode(KEY_MATERIAL));
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt']);
}

/** Browser-decryptable payloads are obfuscated, not secret. */
export async function decryptClientPayload<T>(payload: EncryptedClientPayload, aad: string): Promise<T> {
  const { iv, ciphertext } = payloadParts(payload.payload);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    await clientKey(),
    ciphertext
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
