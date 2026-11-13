import { type CaseStore, CASE_ID_RE, SUBDIRS, assertFileName, isValidFileName } from "./types";
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
    // 케이스가 쓴 파일만 (사용자가 폴더에 넣어 둔 내보내기 파일, desktop.ini 등은 케이스 파일이 아님)
    for await (const h of dir.values?.() ?? []) {
      if (h.kind === "file") out.push(h.name);
      else if ((SUBDIRS as readonly string[]).includes(h.name)) {
        for await (const f of (h as DirHandle).values?.() ?? []) if (f.kind === "file") out.push(`${h.name}/${f.name}`);
      }
    }
    return out.filter(isValidFileName);
  }
  /** "04_images/a.png" → (04_images 폴더 핸들, "a.png") */
  private async locate(caseId: string, name: string, create: boolean): Promise<[FileSystemDirectoryHandle, string] | null> {
    const dir = await this.caseDir(caseId, create);
    if (!dir) return null;
    const parts = name.split("/");
    if (parts.length === 1) return [dir, name];
    try {
      return [await dir.getDirectoryHandle(parts[0], { create }), parts[1]];
    } catch {
      return null;
    }
  }
  private async file(caseId: string, name: string): Promise<File | null> {
    const loc = await this.locate(caseId, name, false);
    if (!loc) return null;
    try {
      return await (await loc[0].getFileHandle(loc[1])).getFile();
    } catch {
      return null;
    }
  }
  async read(caseId: string, name: string) {
    const f = await this.file(caseId, name);
    return f ? await f.text() : null;
  }
  async readBlob(caseId: string, name: string) {
    return this.file(caseId, name);
  }
  private async put(caseId: string, name: string, data: string | Blob) {
    assertFileName(name);
    const [dir, file] = (await this.locate(caseId, name, true))!;
    const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }
  async write(caseId: string, name: string, content: string) {
    await this.put(caseId, name, content);
  }
  async writeBlob(caseId: string, name: string, blob: Blob) {
    await this.put(caseId, name, blob);
  }
  async removeFile(caseId: string, name: string) {
    const loc = await this.locate(caseId, name, false);
    if (loc) await loc[0].removeEntry(loc[1]).catch(() => {});
  }
  async append(caseId: string, name: string, content: string) {
    await this.write(caseId, name, ((await this.read(caseId, name)) ?? "") + content);
  }
  async removeCase(caseId: string) {
    await this.root.removeEntry(caseId, { recursive: true });
  }
}
