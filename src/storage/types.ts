/**
 * 케이스 저장소. 케이스 하나 = 파일 여러 개 (00_case.json, 01_intake.json, 02_brief.md, 04_images/... ).
 * 모든 구현은 사용자 PC 안에만 저장한다 (브라우저 IndexedDB, 사용자가 고른 폴더, 테스트용 메모리).
 */
export interface CaseStore {
  readonly kind: "browser" | "folder" | "memory" | "node";
  readonly label: string;
  listCaseIds(): Promise<string[]>;
  caseExists(caseId: string): Promise<boolean>;
  /** 케이스 안 모든 파일 경로 (하위 폴더는 "04_images/xxx.png" 형태) */
  listFiles(caseId: string): Promise<string[]>;
  read(caseId: string, name: string): Promise<string | null>;
  write(caseId: string, name: string, content: string): Promise<void>;
  append(caseId: string, name: string, content: string): Promise<void>;
  /** 이미지 같은 바이너리 파일 */
  readBlob(caseId: string, name: string): Promise<Blob | null>;
  writeBlob(caseId: string, name: string, blob: Blob): Promise<void>;
  removeFile(caseId: string, name: string): Promise<void>;
  removeCase(caseId: string): Promise<void>;
}

/** 파일 이름 한 조각: 정해진 문자만 (경로 조작 방지) */
export const FILE_NAME_RE = /^[0-9A-Za-z_.-]{1,64}$/;

/** 케이스 안에서 허용하는 하위 폴더 (한 단계만) */
export const SUBDIRS = ["04_images", "assets"] as const;

/** "02_brief.md" 또는 "04_images/img_01.png" 형태만 허용한다 */
export function assertFileName(name: string) {
  const parts = name.split("/");
  const ok =
    (parts.length === 1 || (parts.length === 2 && (SUBDIRS as readonly string[]).includes(parts[0]))) &&
    parts.every((p) => FILE_NAME_RE.test(p) && !p.startsWith("."));
  if (!ok) throw new Error(`잘못된 파일 이름: ${name}`);
}

export const isValidFileName = (name: string) => {
  try {
    assertFileName(name);
    return true;
  } catch {
    return false;
  }
};

/** 케이스 id: 한글·영문·숫자·_·- 만 */
export const CASE_ID_RE = /^[\p{L}\p{N}_-]{1,80}$/u;
