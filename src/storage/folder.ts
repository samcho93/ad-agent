import { type CaseStore, CASE_ID_RE, assertFileName } from "./types";
import { kv } from "./idb";

/**
 * 사용자가 고른 PC 폴더에 케이스 폴더를 그대로 쓴다 (Chrome·Edge의 File System Access API).
 *   (고른 폴더)/(케이스 id)/00_case.json, 01_intake.json, 02_brief.md ...
 * 폴더 핸들은 IndexedDB에 기억하고, 다음 방문 때 권한을 다시 묻는다.
 */
type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  values?: () => AsyncIterable<FileSystemHandle>;
};

export const folderSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

const HANDLE_KEY = "folderHandle";

export async function pickFolder(): Promise<DirHandle> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  const handle = await picker({ id: "ad-agent-cases", mode: "readwrite" });
  await kv.set(HANDLE_KEY, handle);
  return handle;
}

export async function savedFolder(): Promise<DirHandle | null> {
  return (await kv.get<DirHandle>(HANDLE_KEY)) ?? null;
}

export async function forgetFolder() {
  await kv.del(HANDLE_KEY);
}

/** 권한 확인. 사용자 클릭 안에서 request=true로 부르면 권한 요청 창을 띄운다 */
export async function ensurePermission(handle: DirHandle, request: boolean): Promise<boolean> {
  const q = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (q === "granted") return true;
  if (!request) return false;
  return (await handle.requestPermission?.({ mode: "readwrite" })) === "granted";
}

export class FolderStore implements CaseStore {
  readonly kind = "folder" as const;
  constructor(private root: DirHandle) {}
  get label() {
    return `PC 폴더: ${this.root.name}`;
  }

  private async caseDir(caseId: string, create: boolean): Promise<DirHandle | null> {
    if (!CASE_ID_RE.test(caseId)) throw new Error("잘못된 케이스 id");
    try {
      return (await this.root.getDirectoryHandle(caseId, { create })) as DirHandle;
    } catch {
      return null;
    }
  }
  async listCaseIds() {
    const ids: string[] = [];
    for await (const h of this.root.values?.() ?? []) {
      if (h.kind === "directory" && CASE_ID_RE.test(h.name)) ids.push(h.name);
    }
    return ids;
  }
  async caseExists(caseId: string) {
    return (await this.read(caseId, "00_case.json")) !== null;
  }
  async listFiles(caseId: string) {
    const dir = await this.caseDir(caseId, false);
    const out: string[] = [];
    if (!dir) return out;
    for await (const h of dir.values?.() ?? []) if (h.kind === "file") out.push(h.name);
    return out;
  }
  async read(caseId: string, name: string) {
    const dir = await this.caseDir(caseId, false);
    if (!dir) return null;
    try {
      const f = await (await dir.getFileHandle(name)).getFile();
      return await f.text();
    } catch {
      return null;
    }
  }
  async write(caseId: string, name: string, content: string) {
    assertFileName(name);
    const dir = (await this.caseDir(caseId, true))!;
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(content);
    await w.close();
  }
  async append(caseId: string, name: string, content: string) {
    await this.write(caseId, name, ((await this.read(caseId, name)) ?? "") + content);
  }
  async removeCase(caseId: string) {
    await this.root.removeEntry(caseId, { recursive: true });
  }
}
