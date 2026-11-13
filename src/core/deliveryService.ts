import { zipSync, strToU8 } from "fflate";
import type { CaseService } from "./caseService";
import { CaseError, blobToBase64, reached } from "./caseService";
import { ComposeService, renderFile } from "./composeService";
import { type SizeKey, type Variant, sizeOf } from "./compose";
import { parseSizeText } from "./intake";
import { pngSize } from "./qa";
import {
  type AnswerRecord,
  type DeliveryDoc,
  type ExtraSize,
  MAX_EXTRA_SIZES,
  type FinalReview,
  type ProofFile,
  type RevisionKind,
  type RevisionRecord,
  PROOF_NOTE,
  ProofAnswerSchema,
  deliveryReadme,
  emptyDelivery,
  renderRevisionLine,
  reopenStage,
  revisionType,
} from "./delivery";

const DOC = "delivery.json";

export interface DeliveryReadiness {
  ok: boolean;
  blockers: string[];
  /** 심의 업종이라 완성본 심의 기록이 필요한지 */
  reviewRequired: boolean;
}

/**
 * 게이트 2 뒤: 광고주 시안 확인 → (심의 업종이면 완성본 심의) → 납품.
 * 수정 요청이 오면 합성(또는 이미지) 단계로 되돌리고 revisions.md 에 남긴다.
 */
export class DeliveryService {
  private compose: ComposeService;
  constructor(private svc: CaseService) {
    this.compose = new ComposeService(svc);
  }
  private get store() {
    return this.svc.store;
  }

  async getDoc(id: string): Promise<DeliveryDoc> {
    const raw = await this.store.read(id, DOC);
    return raw ? (JSON.parse(raw) as DeliveryDoc) : emptyDelivery();
  }
  private async save(id: string, doc: DeliveryDoc) {
    await this.store.write(id, DOC, JSON.stringify(doc, null, 2) + "\n");
  }
  private async reviewRequired(id: string) {
    const brief = await this.svc.getBrief(id);
    return !!brief && brief.reviewStatus !== "비대상";
  }
  private who(by: string) {
    const w = by.trim();
    if (!w) throw new CaseError("작업자 이름이 필요합니다");
    return w;
  }

  /* ---------------- 시안 확인 파일 ---------------- */

  /** 광고주에게 보낼 시안 확인 파일을 만든다 (게이트 2 통과 뒤) */
  async makeProof(id: string, by: string): Promise<ProofFile> {
    const meta = await this.svc.getMeta(id);
    if (meta.status !== "gate2_approved") throw new CaseError(reached(meta.status, "client_selected") ? "광고주가 이미 시안을 골랐습니다" : "게이트 2를 통과한 뒤에 광고주에게 보낼 수 있습니다");
    const who = this.who(by);
    const cdoc = await this.compose.getDoc(id);
    if (!cdoc) throw new CaseError("합성 명세가 없습니다");
    const doc = await this.getDoc(id);
    // 답을 받기 전 같은 시안을 다시 받으면 같은 파일(같은 id)을 다시 만든다
    const last = doc.proofs.at(-1);
    const reuse = last && !doc.answers.some((a) => a.proofId === last.id) && last.composeUpdatedAt === cdoc.updatedAt ? last : null;
    const round = reuse ? reuse.round : doc.proofs.length + 1;
    const proofId = reuse ? reuse.id : `proof_${round}_${Date.now().toString(36)}`;
    const variants = {} as ProofFile["variants"];
    for (const v of ["A", "B"] as const) {
      const images: Record<string, string> = {};
      for (const size of cdoc.shared.sizes) {
        const blob = await this.store.readBlob(id, renderFile(v, size));
        if (!blob) throw new CaseError(`시안 ${v} ${size} 이미지가 없습니다`);
        images[size] = `data:image/png;base64,${await blobToBase64(blob)}`;
      }
      const c = cdoc.variants[v];
      variants[v] = { headline: c.headline, sub: c.sub, cta: c.cta, images };
    }
    const file: ProofFile = { format: "ad-agent-proof", version: 1, proofId, caseId: id, company: meta.company, round, createdAt: reuse?.createdAt ?? new Date().toISOString(), note: PROOF_NOTE, variants };
    if (!reuse) {
      doc.proofs.push({ id: proofId, round, createdAt: file.createdAt, createdBy: who, composeUpdatedAt: cdoc.updatedAt });
      await this.save(id, doc);
      await this.svc.recordApproval(id, "광고주 확인 요청", who, `${round}차 시안 확인 파일 발송 (${proofId})`);
    }
    return file;
  }

  /** 광고주 답변 파일을 기록한다 */
  async importAnswer(id: string, raw: unknown, by: string): Promise<AnswerRecord> {
    const who = this.who(by);
    const meta = await this.svc.getMeta(id);
    const parsed = ProofAnswerSchema.safeParse(raw);
    if (!parsed.success) throw new CaseError(`답변 파일 형식이 아닙니다: ${parsed.error.issues.slice(0, 2).map((i) => i.message).join("; ")}`);
    const a = parsed.data;
    const doc = await this.getDoc(id);
    const latest = doc.proofs.at(-1);
    if (!latest) throw new CaseError("이 케이스는 아직 시안 확인 파일을 보내지 않았습니다");
    if (a.proofId !== latest.id) {
      throw new CaseError(doc.proofs.some((p) => p.id === a.proofId) ? "예전에 보낸 시안에 대한 답변입니다. 가장 최근 시안 확인 파일로 다시 받으세요" : "이 케이스에서 보낸 시안 확인 파일의 답변이 아닙니다");
    }
    if (doc.answers.some((x) => x.proofId === a.proofId)) throw new CaseError("이 시안에 대한 답변은 이미 기록했습니다");
    if (meta.status !== "gate2_approved") throw new CaseError("지금 단계에서는 답변을 기록할 수 없습니다 (게이트 2 통과 후 발송한 시안만)");

    const rec: AnswerRecord = { proofId: a.proofId, importedAt: new Date().toISOString(), importedBy: who, answeredAt: a.answeredAt, decision: a.decision, variant: a.variant, requests: a.requests, comment: a.comment };
    doc.answers.push(rec);
    await this.save(id, doc);
    if (a.decision === "confirm") {
      doc.selectedVariant = a.variant;
      await this.save(id, doc);
      await this.svc.recordApproval(id, "광고주 확정", `광고주 (기록: ${who})`, `${latest.round}차 시안 ${a.variant} 확정${a.comment.trim() ? `. 의견: ${a.comment.trim()}` : ""}`);
      await this.svc.setStatus(id, "client_selected");
    } else {
      const kinds = [...new Set(a.requests.map((r) => r.kind))];
      const detail = [...a.requests.map((r) => `${r.kind}: ${r.detail}`), a.comment.trim() ? `의견: ${a.comment.trim()}` : ""].filter(Boolean).join(" / ");
      await this.requestRevision(id, { source: "광고주", kinds, detail, basedOn: a.variant }, who);
    }
    return rec;
  }

  /* ---------------- 수정 ---------------- */

  /**
   * 수정 요청을 기록하고 단계를 되돌린다.
   * 글자·색·위치·크기 → 합성 단계, 이미지 교체·콘셉트 변경 → 이미지 단계.
   * 콘셉트 변경은 수정이 아니라 새 시안으로 분류한다.
   */
  async requestRevision(id: string, req: { source: RevisionRecord["source"]; kinds: RevisionKind[]; detail: string; basedOn?: Variant | null }, by: string): Promise<RevisionRecord> {
    const who = this.who(by);
    const meta = await this.svc.getMeta(id);
    if (!reached(meta.status, "gate2_approved") || meta.status === "delivered") throw new CaseError("게이트 2 통과 후 납품 전까지만 수정 요청을 기록할 수 있습니다");
    if (!req.kinds.length) throw new CaseError("수정 종류를 하나 이상 고르세요");
    const doc = await this.getDoc(id);
    const type = revisionType(req.kinds);
    const rec: RevisionRecord = {
      at: new Date().toISOString(),
      by: who,
      round: Math.max(1, doc.proofs.length),
      source: req.source,
      kinds: req.kinds,
      detail: `${req.basedOn ? `시안 ${req.basedOn} 기준. ` : ""}${req.detail.trim()}`,
      type,
      // 광고주 수정은 포함 횟수에 넣는다. 내부 수정은 넣지 않는다. 심의 때문에 고치는 것을 넣을지는 미정
      counted: type === "새 시안" || req.source === "내부" ? false : req.source === "광고주" ? true : null,
    };
    doc.revisions.push(rec);
    doc.selectedVariant = null;
    doc.finalReview = null;
    // 시안이 바뀌므로 변형 사이즈는 목록만 남기고 다시 저장·확인하게 한다
    for (const x of doc.extraSizes ?? []) Object.assign(x, { savedAt: null, kb: null, checkedBy: null });
    await this.save(id, doc);
    await this.store.append(id, "revisions.md", renderRevisionLine(rec, this.svc.currentSettings.revision.includedCount));
    await this.svc.setStatus(id, reopenStage(req.kinds) === "images" ? "gate1_approved" : "images_selected");
    return rec;
  }

  /* ---------------- 완성본 심의 ---------------- */

  async recordFinalReview(id: string, review: { result: FinalReview["result"]; date: string; memo: string; kinds?: RevisionKind[] }, by: string) {
    const who = this.who(by);
    const meta = await this.svc.getMeta(id);
    if (meta.status !== "client_selected") throw new CaseError("광고주가 시안을 고른 뒤에 완성본 심의 결과를 기록할 수 있습니다");
    if (!(await this.reviewRequired(id))) throw new CaseError("심의 업종이 아닙니다");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(review.date)) throw new CaseError("심의 날짜를 입력하세요");
    const doc = await this.getDoc(id);
    doc.finalReview = { result: review.result, date: review.date, memo: review.memo.trim(), by: who, at: new Date().toISOString() };
    await this.save(id, doc);
    await this.svc.recordApproval(id, "완성본 심의", who, `시안 ${doc.selectedVariant} ${review.result} (${review.date})${review.memo.trim() ? `. ${review.memo.trim()}` : ""}`);
    if (review.result === "수정 필요") {
      await this.requestRevision(id, { source: "심의", kinds: review.kinds?.length ? review.kinds : ["글자"], detail: `완성본 심의 수정 필요: ${review.memo}`, basedOn: doc.selectedVariant }, who);
    }
  }

  /* ---------------- 납품 ---------------- */

  /* ---------------- 변형 단계 (사이즈 추가) ---------------- */

  private async assertVariantStage(id: string) {
    const meta = await this.svc.getMeta(id);
    if (meta.status !== "client_selected") throw new CaseError("광고주가 시안을 확정한 뒤, 납품 전에 사이즈를 더할 수 있습니다");
    const doc = await this.getDoc(id);
    if (!doc.selectedVariant) throw new CaseError("광고주가 고른 시안이 없습니다");
    doc.extraSizes ??= [];
    return doc;
  }

  /** 고른 시안을 다른 사이즈로 더 만든다 (예: 1080x1350). 기본 3종은 이미 있다 */
  async addExtraSize(id: string, sizeText: string, note: string, by: string): Promise<ExtraSize> {
    const who = this.who(by);
    const doc = await this.assertVariantStage(id);
    const parsed = parseSizeText(sizeText);
    if (!parsed) throw new CaseError("사이즈는 가로x세로 픽셀로 적어 주세요 (예: 1080x1350, 50~4000)");
    const size = `${parsed.w}x${parsed.h}` as SizeKey;
    const cdoc = (await this.compose.getDoc(id))!;
    if ((cdoc.shared.sizes as string[]).includes(size) || doc.extraSizes!.some((x) => x.size === size)) throw new CaseError(`${size} 는 이미 있습니다`);
    if (doc.extraSizes!.length >= MAX_EXTRA_SIZES) throw new CaseError(`추가 사이즈는 ${MAX_EXTRA_SIZES}개까지입니다`);
    const x: ExtraSize = { size, note: note.trim(), addedBy: who, addedAt: new Date().toISOString(), savedAt: null, kb: null, checkedBy: null };
    doc.extraSizes!.push(x);
    await this.save(id, doc);
    return x;
  }

  async removeExtraSize(id: string, size: string, by: string) {
    this.who(by);
    const doc = await this.assertVariantStage(id);
    const x = doc.extraSizes!.find((e) => e.size === size);
    if (!x) throw new CaseError("없는 사이즈입니다");
    doc.extraSizes = doc.extraSizes!.filter((e) => e !== x);
    await this.store.removeFile(id, renderFile(doc.selectedVariant!, x.size)).catch(() => {});
    await this.save(id, doc);
  }

  /** 추가 사이즈 PNG 저장. 렌더 오류(문구 잘림 등)가 있으면 막는다 */
  async saveExtraRenders(id: string, renders: { size: string; blob: Blob }[], renderErrors: string[], by: string) {
    const who = this.who(by);
    const doc = await this.assertVariantStage(id);
    if (renderErrors.length) throw new CaseError(`저장할 수 없습니다: ${renderErrors.join(" / ")}`);
    const v = doc.selectedVariant!;
    for (const r of renders) {
      const x = doc.extraSizes!.find((e) => e.size === r.size);
      if (!x) throw new CaseError(`추가하지 않은 사이즈입니다: ${r.size}`);
      const dim = pngSize(new Uint8Array(await r.blob.arrayBuffer()));
      const want = sizeOf(x.size);
      if (!dim || dim.w !== want.w || dim.h !== want.h) throw new CaseError(`${x.size}: PNG 크기가 맞지 않습니다`);
      await this.store.writeBlob(id, renderFile(v, x.size), r.blob);
      Object.assign(x, { savedAt: new Date().toISOString(), kb: Math.round((r.blob.size / 1024) * 10) / 10, checkedBy: null });
    }
    await this.save(id, doc);
    await this.svc.recordApproval(id, "변형 사이즈 저장", who, `시안 ${v} × ${renders.map((r) => r.size).join(", ")}`);
  }

  /** 추가 사이즈를 사람이 확인했다 (잘림·겹침·가독성) */
  async checkExtraSize(id: string, size: string, checked: boolean, by: string) {
    const who = this.who(by);
    const doc = await this.assertVariantStage(id);
    const x = doc.extraSizes!.find((e) => e.size === size);
    if (!x) throw new CaseError("없는 사이즈입니다");
    if (checked && !x.savedAt) throw new CaseError("PNG를 먼저 저장하세요");
    x.checkedBy = checked ? who : null;
    await this.save(id, doc);
  }

  async readiness(id: string): Promise<DeliveryReadiness> {
    const meta = await this.svc.getMeta(id);
    const doc = await this.getDoc(id);
    const reviewRequired = await this.reviewRequired(id);
    const blockers: string[] = [];
    if (meta.status === "delivered") blockers.push("이미 납품했습니다");
    else if (meta.status !== "client_selected" || !doc.selectedVariant) blockers.push("광고주가 시안을 확정해야 합니다");
    if (reviewRequired && doc.finalReview?.result !== "통과") blockers.push("완성본 심의 통과 기록이 필요합니다 (심의 업종)");
    for (const x of doc.extraSizes ?? []) {
      if (!x.savedAt) blockers.push(`추가 사이즈 ${x.size}: PNG를 저장하세요`);
      else if (!x.checkedBy) blockers.push(`추가 사이즈 ${x.size}: 잘림·겹침·가독성을 사람이 확인하세요`);
    }
    return { ok: blockers.length === 0, blockers, reviewRequired };
  }

  /**
   * 고른 시안의 사이즈별 PNG, 합성 명세, 검수 보고서, 승인·수정 기록을 ZIP 하나로 묶는다.
   * 처음 받을 때 납품 완료로 기록하고, 그 뒤에는 같은 내용을 다시 받을 수 있다.
   */
  async exportZip(id: string, by: string): Promise<{ name: string; bytes: Uint8Array }> {
    const who = this.who(by);
    const meta = await this.svc.getMeta(id);
    const doc = await this.getDoc(id);
    const again = meta.status === "delivered" && !!doc.delivered;
    const r = await this.readiness(id);
    if (!again && !r.ok) throw new CaseError(`납품할 수 없습니다: ${r.blockers.join(" / ")}`);
    const cdoc = (await this.compose.getDoc(id))!;
    const v = again ? doc.delivered!.variant : doc.selectedVariant!;
    const files: Record<string, Uint8Array> = {};
    for (const size of [...cdoc.shared.sizes, ...(doc.extraSizes ?? []).map((x) => x.size)]) {
      const blob = await this.store.readBlob(id, renderFile(v, size));
      if (!blob) throw new CaseError(`시안 ${v} ${size} 이미지가 없습니다`);
      files[`${v}_${size}.png`] = new Uint8Array(await blob.arrayBuffer());
    }
    // 납품 기록을 먼저 남겨 approvals.md 에 들어가게 한다
    if (!again) await this.svc.recordApproval(id, "납품", who, `시안 ${v} × ${cdoc.shared.sizes.join(", ")}`);
    const text = async (name: string, as = name) => {
      const c = await this.store.read(id, name);
      if (c !== null) files[as] = strToU8(c);
    };
    await text(`05_compose/compose_spec_${v}.json`, `compose_spec_${v}.json`);
    await text("qa_report.md");
    await text("approvals.md");
    await text("revisions.md");
    await text("02_brief.md");
    files["README.txt"] = strToU8(deliveryReadme(meta.company, v, [...Object.keys(files), "README.txt"], r.reviewRequired, doc.finalReview, doc.extraSizes ?? []));
    const bytes = zipSync(files, { level: 6 });
    if (!again) {
      doc.delivered = { at: new Date().toISOString(), by: who, variant: v, files: Object.keys(files) };
      await this.save(id, doc);
      await this.svc.setStatus(id, "delivered");
    }
    return { name: `${id}_시안${v}_납품.zip`, bytes };
  }
}
