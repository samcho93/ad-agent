import type { CaseService } from "./caseService";
import { CaseError, reached } from "./caseService";
import { ImageService } from "./imageService";
import { type ComposeDoc, type SizeKey, type Variant, copyIssues, defaultComposeDoc, toComposeSpec } from "./compose";
import { bannedPhrases, intakeCorpus } from "./intake";
import type { Issue } from "./validate";

const DOC = "05_compose/compose.json";
const LOG = "05_compose/log.jsonl";
export const renderFile = (v: Variant, size: SizeKey) => `05_compose/${v}_${size}.png`;

/**
 * MVP 2단계: 합성. 이미지 확정 뒤에 열린다.
 * A/B 가 같이 쓰는 그림·배치(shared)와 시안별 문구·버튼(variants)을 한 파일에 두고,
 * 저장할 때 도구 중립 명세(compose_spec_A/B.json)를 함께 쓴다.
 */
export class ComposeService {
  private images: ImageService;
  constructor(private svc: CaseService) {
    this.images = new ImageService(svc);
  }
  private get store() {
    return this.svc.store;
  }

  async assertOpen(id: string) {
    const meta = await this.svc.getMeta(id);
    if (!reached(meta.status, "images_selected")) throw new CaseError("이미지를 확정한 뒤에 합성할 수 있습니다");
    if (reached(meta.status, "gate2_approved")) throw new CaseError("게이트 2를 통과한 시안은 바꿀 수 없습니다. 수정 요청을 기록하면 다시 열립니다");
    return meta;
  }

  async getDoc(id: string): Promise<ComposeDoc | null> {
    const raw = await this.store.read(id, DOC);
    return raw ? (JSON.parse(raw) as ComposeDoc) : null;
  }

  /** 없으면 고른 아이디어·이미지로 첫 명세를 만든다 */
  async ensureDoc(id: string, by: string): Promise<ComposeDoc> {
    // 이미 있으면 (게이트 2 뒤 잠긴 상태라도) 보기용으로 돌려준다
    const existing = await this.getDoc(id);
    if (existing && reached((await this.svc.getMeta(id)).status, "images_selected")) return existing;
    await this.assertOpen(id);
    const ideas = await this.svc.getIdeas(id);
    const idea = ideas?.ideas.find((x) => x.id === ideas.selectedId);
    const brief = await this.svc.getBrief(id);
    if (!idea || !brief) throw new CaseError("게이트 1에서 고른 아이디어가 없습니다");
    const doc = defaultComposeDoc(idea, brief, await this.images.getDoc(id), by.trim() || "?");
    await this.write(id, doc);
    await this.log(id, { event: "compose_created", by: doc.updatedBy });
    return doc;
  }

  private async write(id: string, doc: ComposeDoc) {
    await this.store.write(id, DOC, JSON.stringify(doc, null, 2) + "\n");
    for (const v of ["A", "B"] as const) await this.store.write(id, `05_compose/compose_spec_${v}.json`, JSON.stringify(toComposeSpec(id, doc, v), null, 2) + "\n");
  }

  async log(id: string, entry: Record<string, unknown>) {
    await this.store.append(id, LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  }

  /** 수정 저장. 이미 합성을 마쳤다면 다시 저장하라고 상태를 되돌린다 */
  async update(id: string, doc: ComposeDoc, by: string): Promise<ComposeDoc> {
    const meta = await this.assertOpen(id);
    if (!by.trim()) throw new CaseError("작업자 이름이 필요합니다");
    const prev = await this.getDoc(id);
    // A/B 는 그림·배치가 같아야 한다: shared 는 하나뿐이라 구조상 보장된다
    const next: ComposeDoc = { ...doc, version: 1, updatedAt: new Date().toISOString(), updatedBy: by.trim() };
    await this.write(id, next);
    // 합성 완료·검수 완료 뒤에 고치면 다시 저장·검수하게 되돌린다
    if (meta.status !== "images_selected" && JSON.stringify(prev?.variants) + JSON.stringify(prev?.shared) !== JSON.stringify(next.variants) + JSON.stringify(next.shared)) {
      await this.svc.setStatus(id, "images_selected");
    }
    return next;
  }

  async copyIssues(id: string, doc: ComposeDoc): Promise<Issue[]> {
    const intake = await this.svc.getIntake(id);
    return copyIssues(doc, intakeCorpus(intake), bannedPhrases(intake));
  }

  /** 렌더 결과 6장을 저장하고 합성 완료로 표시한다 */
  async saveRenders(id: string, renders: { variant: Variant; size: SizeKey; blob: Blob }[], renderErrors: string[], by: string) {
    await this.assertOpen(id);
    if (!by.trim()) throw new CaseError("작업자 이름이 필요합니다");
    const doc = await this.getDoc(id);
    if (!doc) throw new CaseError("합성 명세가 없습니다");
    const blockers = [...renderErrors, ...(await this.copyIssues(id, doc)).filter((i) => i.severity === "error").map((i) => `${i.where}: ${i.message}`)];
    if (blockers.length) throw new CaseError(`저장할 수 없습니다: ${blockers.join(" / ")}`);
    const expected = doc.shared.sizes.length * 2;
    if (renders.length !== expected) throw new CaseError(`시안 이미지가 ${expected}장이어야 합니다 (현재 ${renders.length}장)`);
    for (const r of renders) await this.store.writeBlob(id, renderFile(r.variant, r.size), r.blob);
    await this.log(id, {
      event: "renders_saved",
      files: renders.map((r) => renderFile(r.variant, r.size)),
      engine: "browser-canvas",
      font: "Pretendard (SIL OFL 1.1)",
      spec: { A: toComposeSpec(id, doc, "A"), B: toComposeSpec(id, doc, "B") },
      by: by.trim(),
    });
    await this.svc.setStatus(id, "compose_done");
    await this.svc.recordApproval(id, "합성 완료", by, `시안 A/B × ${doc.shared.sizes.join(", ")} 저장 (05_compose/)`);
  }
}
