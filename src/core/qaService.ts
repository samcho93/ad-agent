import type { CaseService } from "./caseService";
import { CaseError, reached } from "./caseService";
import { ComposeService, renderFile } from "./composeService";
import { ImageService } from "./imageService";
import type { ComposeDoc, Variant } from "./compose";
import { type QaCheck, type QaDoc, type RenderInfo, gate2Readiness, humanChecklist, openErrors, renderQaMarkdown, ruleChecks } from "./qa";

const DOC = "qa.json";
const REPORT = "qa_report.md";

/** 이미지 검수에 넘기는 자료 */
export interface ImageQaInput {
  caseId: string;
  doc: ComposeDoc;
  renders: { file: string; variant: Variant; size: string; blob: Blob }[];
  original: { file: string; blob: Blob } | null;
  review: boolean;
  reviewNote: string;
}

export interface ImageQaResult {
  status: QaDoc["llm"]["status"];
  model?: string;
  note: string;
  overall?: string;
  files: string[];
  checks: QaCheck[];
}

/** LLM 이미지 검수 함수 (src/llm/qaPipeline.ts). 없으면 사람이 확인한다 */
export type ImageQaFn = (input: ImageQaInput) => Promise<ImageQaResult>;

/**
 * 검수와 게이트 2. 합성 완료(compose_done) 뒤에 열린다.
 * 검수를 마치면 qa_done, 게이트 2를 승인하면 gate2_approved.
 */
export class QaService {
  private compose: ComposeService;
  private images: ImageService;
  constructor(private svc: CaseService) {
    this.compose = new ComposeService(svc);
    this.images = new ImageService(svc);
  }
  private get store() {
    return this.svc.store;
  }

  async getDoc(id: string): Promise<QaDoc | null> {
    const raw = await this.store.read(id, DOC);
    return raw ? (JSON.parse(raw) as QaDoc) : null;
  }

  private async save(id: string, qa: QaDoc) {
    const meta = await this.svc.getMeta(id);
    await this.store.write(id, DOC, JSON.stringify(qa, null, 2) + "\n");
    await this.store.write(id, REPORT, renderQaMarkdown(qa, meta.company));
  }

  private async assertOpen(id: string) {
    const meta = await this.svc.getMeta(id);
    if (!reached(meta.status, "compose_done")) throw new CaseError("합성 PNG를 저장한 뒤에 검수할 수 있습니다");
    if (reached(meta.status, "gate2_approved")) throw new CaseError("게이트 2를 통과했습니다. 다시 검수하려면 수정 요청을 기록하세요");
    return meta;
  }

  /** 검수 결과가 지금 합성과 맞는지 */
  async isFresh(id: string, qa: QaDoc | null): Promise<boolean> {
    if (!qa) return false;
    const meta = await this.svc.getMeta(id);
    const doc = await this.compose.getDoc(id);
    return reached(meta.status, "qa_done") && doc?.updatedAt === qa.composeUpdatedAt;
  }

  /** 규칙 검사 + (있으면) LLM 이미지 검수를 하고 qa.json, qa_report.md 를 쓴다 */
  async run(id: string, by: string, imageQa?: ImageQaFn): Promise<QaDoc> {
    await this.assertOpen(id);
    const who = by.trim();
    if (!who) throw new CaseError("작업자 이름이 필요합니다");
    const doc = await this.compose.getDoc(id);
    if (!doc) throw new CaseError("합성 명세가 없습니다");
    const brief = await this.svc.getBrief(id);
    const review = !!brief && brief.reviewStatus !== "비대상";
    const imagesDoc = await this.images.getDoc(id);

    const renders: (RenderInfo & { blob: Blob | null })[] = [];
    for (const variant of ["A", "B"] as const) {
      for (const size of doc.shared.sizes) {
        const file = renderFile(variant, size);
        const blob = await this.store.readBlob(id, file);
        renders.push({ variant, size, file, blob, bytes: blob ? new Uint8Array(await blob.arrayBuffer()) : null });
      }
    }
    const readSpec = async (v: Variant) => {
      const raw = await this.store.read(id, `05_compose/compose_spec_${v}.json`);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    };
    const intakeKB = (await this.svc.getIntake(id)).answers["11"].maxKB;
    const checks = ruleChecks({
      doc,
      renders,
      copyIssues: await this.compose.copyIssues(id, doc),
      hasLogoAsset: imagesDoc.assets.some((a) => a.kind === "logo"),
      specs: { A: await readSpec("A"), B: await readSpec("B") },
      // 광고주가 질문지 11번에 적은 용량 한도가 있으면 그것을, 없으면 설정값("확인 필요")
      maxFileKB: intakeKB ?? this.svc.currentSettings.qa.maxFileKB,
      maxFileKBSource: intakeKB ? "질문지 11번" : "설정",
    });

    // 누끼를 썼으면 원본 제품 사진을 비교 기준으로 함께 보낸다
    const cut = imagesDoc.items.find((i) => i.status === "picked" && i.role === "cutout" && i.fromAssetId);
    const asset = cut ? imagesDoc.assets.find((a) => a.id === cut.fromAssetId) : undefined;
    const originalBlob = asset ? await this.store.readBlob(id, asset.file) : null;
    const original = asset && originalBlob ? { file: asset.file, blob: originalBlob } : null;

    let llm: QaDoc["llm"] = { status: "skipped", note: "LLM 이미지 검수를 하지 않았습니다", files: [] };
    if (imageQa) {
      const r = await imageQa({
        caseId: id,
        doc,
        renders: renders.filter((x) => x.blob).map((x) => ({ file: x.file, variant: x.variant, size: x.size, blob: x.blob! })),
        original,
        review,
        reviewNote: brief ? `심의 ${brief.reviewStatus}` : "",
      });
      llm = { status: r.status, model: r.model, note: r.note, overall: r.overall, files: r.files };
      checks.push(...r.checks);
    }

    // 같은 합성을 다시 검수하면 넘김 사유와 사람 확인은 유지한다 (같은 항목만)
    const prev = await this.getDoc(id);
    const same = prev?.composeUpdatedAt === doc.updatedAt;
    const ids = new Set(checks.map((c) => c.id));
    const qa: QaDoc = {
      version: 1,
      ranAt: new Date().toISOString(),
      ranBy: who,
      composeUpdatedAt: doc.updatedAt,
      review,
      checks,
      llm,
      overrides: same ? Object.fromEntries(Object.entries(prev!.overrides).filter(([k]) => ids.has(k))) : {},
      human: same ? prev!.human : {},
    };
    await this.save(id, qa);
    await this.svc.log(id, {
      purpose: "qa",
      by: who,
      rules: checks.filter((c) => c.source === "rule" && c.severity !== "info").length,
      llmStatus: llm.status,
      model: llm.model,
      errors: checks.filter((c) => c.severity === "error").length,
    });
    await this.svc.setStatus(id, "qa_done");
    return qa;
  }

  /** 자동 검수 오류를 사유를 적고 넘긴다 (사유를 비우면 넘김 취소) */
  async setOverride(id: string, checkId: string, reason: string, by: string): Promise<QaDoc> {
    await this.assertOpen(id);
    const qa = await this.getDoc(id);
    if (!qa) throw new CaseError("검수 결과가 없습니다");
    const c = qa.checks.find((x) => x.id === checkId);
    if (!c || c.severity !== "error") throw new CaseError("넘길 수 있는 오류가 아닙니다");
    if (!by.trim()) throw new CaseError("작업자 이름이 필요합니다");
    if (reason.trim()) qa.overrides[checkId] = { reason: reason.trim(), by: by.trim(), at: new Date().toISOString() };
    else delete qa.overrides[checkId];
    await this.save(id, qa);
    return qa;
  }

  /** 게이트 2 사람 확인 항목 체크 */
  async setHuman(id: string, item: string, checked: boolean, by: string): Promise<QaDoc> {
    await this.assertOpen(id);
    const qa = await this.getDoc(id);
    if (!qa) throw new CaseError("검수 결과가 없습니다");
    if (!humanChecklist(qa).includes(item)) throw new CaseError("확인 항목이 아닙니다");
    if (!by.trim()) throw new CaseError("작업자 이름이 필요합니다");
    if (checked) qa.human[item] = { by: by.trim(), at: new Date().toISOString() };
    else delete qa.human[item];
    await this.save(id, qa);
    return qa;
  }

  async readiness(id: string) {
    const qa = await this.getDoc(id);
    return gate2Readiness(qa, await this.isFresh(id, qa));
  }

  /** 게이트 2 (디자이너 최종 검수) 승인 */
  async approveGate2(id: string, approver: string, note = "") {
    await this.assertOpen(id);
    if (!approver.trim()) throw new CaseError("승인자 이름이 필요합니다");
    const r = await this.readiness(id);
    if (!r.ok) throw new CaseError(`게이트 2를 통과할 수 없습니다: ${r.blockers.join(" / ")}`);
    const qa = (await this.getDoc(id))!;
    const overridden = Object.keys(qa.overrides).length;
    const what = [
      "시안 A/B 최종 검수 통과",
      `이미지 검수 ${qa.llm.status === "done" ? "LLM 완료" : "사람 확인"}`,
      overridden ? `오류 ${overridden}개 사유 적고 넘김` : "",
      qa.review ? "카피 사전 점검 완료" : "",
      note.trim() ? `메모: ${note.trim()}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    await this.svc.recordApproval(id, "게이트 2", approver, what);
    await this.svc.setStatus(id, "gate2_approved");
    return openErrors(qa);
  }
}
