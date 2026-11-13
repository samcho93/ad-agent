import type { CaseService } from "./caseService";
import { CaseError, reached } from "./caseService";
import {
  type Asset,
  type AssetKind,
  type ImageItem,
  type ImagePrompt,
  type ImagesDoc,
  type ImageSource,
  type ImageRoute,
  type ImageMethod,
  PHOTO_ROUTES,
  ROUTE_LABEL,
  applicableCriteria,
  buildPolicy,
  emptyImagesDoc,
  itemReady,
  renderPolicyMarkdown,
} from "./images";

const DOC = "04_images/images.json";
const POLICY_MD = "04_images/policy.md";
const LOG = "04_images/log.jsonl";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };

const newId = (prefix: string) => `${prefix}_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * MVP 3단계: 이미지. 게이트 1 승인 뒤에만 열린다.
 * 모든 이미지는 받는 즉시 저장하고 도구·프롬프트·날짜를 기록한다 (절대 규칙 7).
 */
export class ImageService {
  constructor(private svc: CaseService) {}

  private get store() {
    return this.svc.store;
  }

  async assertOpen(id: string) {
    const meta = await this.svc.getMeta(id);
    if (!reached(meta.status, "gate1_approved")) throw new CaseError("게이트 1 승인 뒤에 이미지 단계를 진행할 수 있습니다");
    // 게이트 2를 통과한 시안은 잠근다. 고치려면 광고주 수정 요청(또는 수정 시작)으로 되돌린다
    if (reached(meta.status, "gate2_approved")) throw new CaseError("게이트 2를 통과한 시안은 바꿀 수 없습니다. 수정 요청을 기록하면 다시 열립니다");
    return meta;
  }

  async getDoc(id: string): Promise<ImagesDoc> {
    const raw = await this.store.read(id, DOC);
    return raw ? (JSON.parse(raw) as ImagesDoc) : emptyImagesDoc();
  }

  private async saveDoc(id: string, doc: ImagesDoc) {
    await this.store.write(id, DOC, JSON.stringify(doc, null, 2) + "\n");
    // 이미지를 바꾸면 "이미지 확정"(과 그 뒤 합성 완료)을 풀어 다시 확인하게 한다
    const meta = await this.svc.getMeta(id);
    if (reached(meta.status, "images_selected")) await this.svc.setStatus(id, "gate1_approved");
  }

  async log(id: string, entry: Record<string, unknown>) {
    await this.store.append(id, LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  }

  async readLog(id: string): Promise<Record<string, unknown>[]> {
    const raw = (await this.store.read(id, LOG)) ?? "";
    return raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l)) : [];
  }

  /** 방침을 지금 자료 기준으로 다시 정하고 policy.md 를 쓴다 */
  async refreshPolicy(id: string) {
    const meta = await this.assertOpen(id);
    const brief = await this.svc.getBrief(id);
    if (!brief) throw new CaseError("브리프가 없습니다");
    const doc = await this.getDoc(id);
    doc.policy = buildPolicy(await this.svc.getIntake(id), brief, doc.assets, doc.routeOverride);
    await this.store.write(id, POLICY_MD, renderPolicyMarkdown(doc.policy, meta.company));
    await this.store.write(id, DOC, JSON.stringify(doc, null, 2) + "\n");
    return doc;
  }

  /**
   * 제품 사진 상태(경로)를 바꾼다. 예: "광고주에게 사진 요청 중" → 사진을 받아 "누끼".
   * 브리프는 게이트 1 뒤 잠기므로 이미지 문서에 남기고, 승인 기록과 policy.md 에 적는다.
   */
  async setRoute(id: string, route: ImageRoute, by: string, note = "") {
    await this.assertOpen(id);
    const who = by.trim();
    if (!who) throw new CaseError("바꾼 사람 이름이 필요합니다");
    const brief = await this.svc.getBrief(id);
    if (!brief) throw new CaseError("브리프가 없습니다");
    const allowed = PHOTO_ROUTES[brief.hasProduct ? "product" : "intangible"].map((r) => r.route);
    if (!allowed.includes(route)) throw new CaseError("이 광고(제품 유무)에는 고를 수 없는 경로입니다");
    const doc = await this.getDoc(id);
    const before = doc.policy?.route ?? null;
    if (before === route) return doc;
    doc.routeOverride = { route, by: who, at: new Date().toISOString(), note: note.trim() };
    await this.saveDoc(id, doc);
    await this.log(id, { event: "route_changed", from: before, to: route, note: note.trim(), by: who });
    await this.svc.recordApproval(id, "이미지 방침 변경", who, `${before ? ROUTE_LABEL[before] : "없음"} → ${ROUTE_LABEL[route]}${note.trim() ? `. ${note.trim()}` : ""}`);
    return this.refreshPolicy(id);
  }

  /* ---------------- 자료 (제품 사진·매장 사진·로고) ---------------- */

  async addAsset(id: string, blob: Blob, originalName: string, kind: AssetKind, by: string): Promise<Asset> {
    await this.assertOpen(id);
    const ext = EXT[blob.type];
    if (!ext) throw new CaseError("PNG, JPG, WEBP, SVG 이미지만 올릴 수 있습니다");
    if (blob.size > MAX_IMAGE_BYTES) throw new CaseError("이미지가 너무 큽니다 (25MB 이하)");
    const assetId = newId("asset");
    const asset: Asset = { id: assetId, kind, file: `assets/${assetId}.${ext}`, originalName: originalName.slice(0, 120), mime: blob.type, addedAt: new Date().toISOString(), addedBy: by.trim() || "?" };
    await this.store.writeBlob(id, asset.file, blob);
    const doc = await this.getDoc(id);
    doc.assets.push(asset);
    await this.saveDoc(id, doc);
    await this.log(id, { event: "asset_added", asset: asset.id, kind, originalName: asset.originalName, by: asset.addedBy });
    await this.refreshPolicy(id);
    return asset;
  }

  async removeAsset(id: string, assetId: string, by: string) {
    await this.assertOpen(id);
    const doc = await this.getDoc(id);
    const a = doc.assets.find((x) => x.id === assetId);
    if (!a) throw new CaseError("자료가 없습니다");
    if (doc.items.some((i) => i.fromAssetId === assetId && i.status !== "discarded")) throw new CaseError("이 사진으로 만든 누끼가 있어 지울 수 없습니다. 누끼를 먼저 버리세요");
    doc.assets = doc.assets.filter((x) => x.id !== assetId);
    await this.store.removeFile(id, a.file);
    await this.saveDoc(id, doc);
    await this.log(id, { event: "asset_removed", asset: assetId, by });
    await this.refreshPolicy(id);
  }

  /* ---------------- 프롬프트 ---------------- */

  async addPrompt(id: string, prompt: ImagePrompt) {
    const doc = await this.getDoc(id);
    doc.prompts.push(prompt);
    await this.saveDoc(id, doc);
    await this.log(id, { event: "prompt_created", prompt: prompt.id, idea: prompt.ideaId, model: prompt.model, promptEn: prompt.promptEn, issues: prompt.issues.map((i) => i.message) });
  }

  /* ---------------- 이미지 ---------------- */

  /** 받은 이미지를 바로 저장하고 기록한다 */
  async addImage(
    id: string,
    blob: Blob,
    info: { source: ImageSource; role: ImageItem["role"]; tool: string; promptId?: string; figma?: ImageItem["figma"]; fromAssetId?: string; method?: ImageMethod; referenceAssetIds?: string[] },
    by: string,
  ): Promise<ImageItem> {
    await this.assertOpen(id);
    const ext = EXT[blob.type];
    if (!ext || ext === "svg") throw new CaseError("PNG, JPG, WEBP 이미지만 쓸 수 있습니다");
    if (info.method === "product_reference") {
      const known = new Set((await this.getDoc(id)).assets.filter((a) => a.kind === "product").map((a) => a.id));
      if (!info.referenceAssetIds?.length || info.referenceAssetIds.some((a) => !known.has(a))) throw new CaseError("참조로 넣은 제품 사진을 고르세요 (자료에 올린 제품 사진)");
    }
    if (blob.size > MAX_IMAGE_BYTES) throw new CaseError("이미지가 너무 큽니다 (25MB 이하)");
    const itemId = newId(info.role === "cutout" ? "cutout" : "img");
    const item: ImageItem = {
      id: itemId,
      file: `04_images/${itemId}.${ext}`,
      source: info.source,
      role: info.role,
      tool: info.tool,
      promptId: info.promptId,
      figma: info.figma,
      fromAssetId: info.fromAssetId,
      method: info.role === "scene" ? info.method : undefined,
      referenceAssetIds: info.role === "scene" && info.method === "product_reference" ? info.referenceAssetIds ?? [] : undefined,
      createdAt: new Date().toISOString(),
      createdBy: by.trim() || "?",
      commercialUseChecked: false,
      checks: {},
      status: "candidate",
      note: "",
    };
    await this.store.writeBlob(id, item.file, blob); // 즉시 저장
    const doc = await this.getDoc(id);
    doc.items.push(item);
    await this.saveDoc(id, doc);
    const prompt = doc.prompts.find((p) => p.id === info.promptId);
    await this.log(id, {
      event: "image_saved",
      image: item.id,
      file: item.file,
      source: item.source,
      role: item.role,
      tool: item.tool,
      prompt: prompt ? { id: prompt.id, en: prompt.promptEn } : null,
      figma: item.figma ?? null,
      fromAsset: item.fromAssetId ?? null,
      method: item.method ?? null,
      referenceAssets: item.referenceAssetIds ?? null,
      bytes: blob.size,
      by: item.createdBy,
    });
    return item;
  }

  async updateImage(id: string, itemId: string, patch: Partial<Pick<ImageItem, "status" | "commercialUseChecked" | "checks" | "note">>, by: string) {
    await this.assertOpen(id);
    if (!by.trim()) throw new CaseError("확인한 사람 이름이 필요합니다");
    const doc = await this.getDoc(id);
    const item = doc.items.find((x) => x.id === itemId);
    if (!item) throw new CaseError("이미지가 없습니다");
    if (patch.status === "picked") {
      const r = itemReady({ ...item, ...patch, checks: { ...item.checks, ...(patch.checks ?? {}) } }, doc.policy);
      if (!r.ok) throw new CaseError(`고르기 전에 확인할 것: ${r.missing.join(" / ")}`);
    }
    Object.assign(item, { ...patch, checks: { ...item.checks, ...(patch.checks ?? {}) } });
    await this.saveDoc(id, doc);
    await this.log(id, { event: "image_updated", image: itemId, patch, by: by.trim() });
    return item;
  }

  /* ---------------- 이미지 확정 ---------------- */

  async readiness(id: string): Promise<{ ok: boolean; blockers: string[] }> {
    const doc = await this.getDoc(id);
    const blockers: string[] = [];
    if (!doc.policy) blockers.push("이미지 방침을 먼저 정하세요");
    else blockers.push(...doc.policy.blockers);
    const picked = doc.items.filter((i) => i.status === "picked");
    if (!picked.some((i) => i.role === "scene")) blockers.push("배경·장면 이미지를 1장 이상 고르세요");
    if (doc.policy?.route === "product_cutout" && !picked.some((i) => i.role === "cutout")) blockers.push("제품 누끼를 1장 이상 고르세요");
    for (const p of picked) {
      const r = itemReady(p, doc.policy);
      if (!r.ok) blockers.push(`${p.id}: ${r.missing.join(", ")}`);
    }
    return { ok: blockers.length === 0, blockers };
  }

  async complete(id: string, by: string) {
    await this.assertOpen(id);
    if (!by.trim()) throw new CaseError("확정한 사람 이름이 필요합니다");
    const r = await this.readiness(id);
    if (!r.ok) throw new CaseError(`이미지를 확정할 수 없습니다: ${r.blockers.join(" / ")}`);
    const doc = await this.getDoc(id);
    const picked = doc.items.filter((i) => i.status === "picked");
    await this.svc.setStatus(id, "images_selected");
    await this.svc.recordApproval(id, "이미지 확정", by, `선택 ${picked.length}장 (${picked.map((p) => `${p.id}·${p.tool}`).join(", ")})`);
    await this.log(id, { event: "images_completed", picked: picked.map((p) => p.id), by: by.trim() });
  }

  /** 화면 표시용: 검수 기준 목록 */
  criteriaFor(item: ImageItem, doc: ImagesDoc) {
    return applicableCriteria(item, doc.policy);
  }
}
