import { type CaseStore, assertFileName } from "./types";

/** 테스트·가짜 모드용 */
export class MemoryStore implements CaseStore {
  readonly kind = "memory" as const;
  readonly label = "메모리 (새로고침하면 사라짐)";
  private cases = new Map<string, Map<string, string>>();

  async listCaseIds() {
    return [...this.cases.keys()];
  }
  async caseExists(caseId: string) {
    return this.cases.get(caseId)?.has("00_case.json") ?? false;
  }
  async listFiles(caseId: string) {
    return [...(this.cases.get(caseId)?.keys() ?? [])];
  }
  async read(caseId: string, name: string) {
    return this.cases.get(caseId)?.get(name) ?? null;
  }
  async write(caseId: string, name: string, content: string) {
    assertFileName(name);
    if (!this.cases.has(caseId)) this.cases.set(caseId, new Map());
    this.cases.get(caseId)!.set(name, content);
  }
  async append(caseId: string, name: string, content: string) {
    await this.write(caseId, name, ((await this.read(caseId, name)) ?? "") + content);
  }
  async removeCase(caseId: string) {
    this.cases.delete(caseId);
  }
}
