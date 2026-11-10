/**
 * 케이스 저장소. 케이스 하나 = 파일 여러 개 (00_case.json, 01_intake.json, 02_brief.md ...).
 * 모든 구현은 사용자 PC 안에만 저장한다 (브라우저 IndexedDB, 사용자가 고른 폴더, 테스트용 메모리).
 */
export interface CaseStore {
  readonly kind: "browser" | "folder" | "memory" | "node";
  readonly label: string;
  listCaseIds(): Promise<string[]>;
  caseExists(caseId: string): Promise<boolean>;
  listFiles(caseId: string): Promise<string[]>;
  read(caseId: string, name: string): Promise<string | null>;
  write(caseId: string, name: string, content: string): Promise<void>;
  append(caseId: string, name: string, content: string): Promise<void>;
  removeCase(caseId: string): Promise<void>;
}

/** 케이스 안 파일 이름: 하위 폴더 없이 정해진 형식만 (경로 조작 방지) */
export const FILE_NAME_RE = /^[0-9A-Za-z_.-]{1,64}$/;

export function assertFileName(name: string) {
  if (!FILE_NAME_RE.test(name) || name.startsWith(".")) throw new Error(`잘못된 파일 이름: ${name}`);
}

/** 케이스 id: 한글·영문·숫자·_·- 만 */
export const CASE_ID_RE = /^[\p{L}\p{N}_-]{1,80}$/u;
