import { kv } from "./idb";
import { mergeSettings, type Secrets, type Settings } from "@/core/settings";

/**
 * 설정과 비밀값(API 키, 브리지 연결 코드, Figma 토큰)을 이 브라우저(IndexedDB)에만 저장한다.
 * 비밀값은 원하면 비밀번호로 암호화한다 (PBKDF2 → AES-GCM, WebCrypto).
 * 비밀번호는 저장하지 않고, 이 탭이 열려 있는 동안만 메모리에 둔다.
 */

const SETTINGS_KEY = "settings";
const SECRETS_KEY = "secrets";

interface EncryptedSecrets {
  v: 1;
  enc: "aes-gcm";
  salt: string;
  iv: string;
  data: string;
}
type StoredSecrets = { v: 1; enc: "none"; data: Secrets } | EncryptedSecrets;

export async function loadSettings(): Promise<Settings> {
  return mergeSettings(await kv.get<Partial<Settings>>(SETTINGS_KEY));
}

export async function saveSettings(s: Settings) {
  await kv.set(SETTINGS_KEY, s);
}

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 310_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type SecretsState = { status: "empty" } | { status: "plain"; secrets: Secrets } | { status: "locked" };

/** 저장된 비밀값 상태. 암호화되어 있으면 unlockSecrets 로 연다 */
export async function loadSecrets(): Promise<SecretsState> {
  const stored = await kv.get<StoredSecrets>(SECRETS_KEY);
  if (!stored) return { status: "empty" };
  if (stored.enc === "none") return { status: "plain", secrets: stored.data };
  return { status: "locked" };
}

export async function unlockSecrets(passphrase: string): Promise<Secrets> {
  const stored = await kv.get<StoredSecrets>(SECRETS_KEY);
  if (!stored || stored.enc !== "aes-gcm") throw new Error("암호화된 비밀값이 없습니다");
  const key = await deriveKey(passphrase, unb64(stored.salt));
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(stored.iv) as BufferSource }, key, unb64(stored.data) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain)) as Secrets;
  } catch {
    throw new Error("비밀번호가 맞지 않습니다");
  }
}

/** passphrase 가 있으면 암호화해서, 없으면 그대로 저장한다 */
export async function saveSecrets(secrets: Secrets, passphrase?: string) {
  const clean: Secrets = Object.fromEntries(Object.entries(secrets).filter(([, v]) => typeof v === "string" && v.trim())) as Secrets;
  if (!passphrase) {
    await kv.set(SECRETS_KEY, { v: 1, enc: "none", data: clean } satisfies StoredSecrets);
    return;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(clean)));
  await kv.set(SECRETS_KEY, { v: 1, enc: "aes-gcm", salt: b64(salt), iv: b64(iv), data: b64(data) } satisfies StoredSecrets);
}

export async function clearSecrets() {
  await kv.del(SECRETS_KEY);
}

export async function isEncrypted(): Promise<boolean> {
  return (await kv.get<StoredSecrets>(SECRETS_KEY))?.enc === "aes-gcm";
}
