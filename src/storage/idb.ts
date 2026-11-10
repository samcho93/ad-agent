import { type CaseStore, assertFileName } from "./types";

/**
 * IndexedDB: 설정·비밀값(kv)과 케이스 파일(files)을 이 브라우저에만 저장한다.
 * 라이브러리 없이 최소한으로 감쌌다.
 */
const DB_NAME = "ad-agent";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: "kv" | "files", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const kv = {
  get: <T>(key: string) => tx<T | undefined>("kv", "readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
  set: (key: string, value: unknown) => tx("kv", "readwrite", (s) => s.put(value, key)).then(() => undefined),
  del: (key: string) => tx("kv", "readwrite", (s) => s.delete(key)).then(() => undefined),
};

const fileKey = (caseId: string, name: string) => `${caseId}/${name}`;

export class IdbStore implements CaseStore {
  readonly kind = "browser" as const;
  readonly label = "이 브라우저 (IndexedDB)";

  private async allKeys(): Promise<string[]> {
    return (await tx("files", "readonly", (s) => s.getAllKeys())).map(String);
  }
  async listCaseIds() {
    return [...new Set((await this.allKeys()).map((k) => k.split("/")[0]))];
  }
  async caseExists(caseId: string) {
    return (await this.read(caseId, "00_case.json")) !== null;
  }
  async listFiles(caseId: string) {
    const prefix = `${caseId}/`;
    return (await this.allKeys()).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
  async read(caseId: string, name: string) {
    const v = await tx<string | undefined>("files", "readonly", (s) => s.get(fileKey(caseId, name)) as IDBRequest<string | undefined>);
    return v ?? null;
  }
  async write(caseId: string, name: string, content: string) {
    assertFileName(name);
    await tx("files", "readwrite", (s) => s.put(content, fileKey(caseId, name)));
  }
  async append(caseId: string, name: string, content: string) {
    await this.write(caseId, name, ((await this.read(caseId, name)) ?? "") + content);
  }
  async removeCase(caseId: string) {
    for (const f of await this.listFiles(caseId)) await tx("files", "readwrite", (s) => s.delete(fileKey(caseId, f)));
  }
}
