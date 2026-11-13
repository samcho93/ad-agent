import { readSkill } from "@/core/skills";
import { CaseError, type CaseService } from "@/core/caseService";
import { effectiveValue } from "@/core/brief";
import { bannedPhrases, intakeCorpus } from "@/core/intake";
import { matchRule, ruleForPrompt } from "@/core/productRules";
import type { ComposeDoc } from "@/core/compose";
import type { DeliveryDoc, RevisionRecord } from "@/core/delivery";
import { RevisionModelOutput, buildRevisionDraft, type RevisionDraft } from "@/core/revision";
import type { Generator } from "./generator";

const DRAFT_FILE = "05_compose/revision_draft.json";

/** 마지막 시안 발송 뒤에 들어온 수정 요청 (아직 다시 보내지 않은 것) */
export function openRevision(d: DeliveryDoc): RevisionRecord | null {
  const rev = d.revisions.at(-1);
  if (!rev) return null;
  const lastProof = d.proofs.at(-1)?.createdAt ?? "";
  return rev.at > lastProof ? rev : null;
}

export async function readRevisionDraft(svc: CaseService, caseId: string): Promise<RevisionDraft | null> {
  const raw = await svc.store.read(caseId, DRAFT_FILE);
  return raw ? (JSON.parse(raw) as RevisionDraft) : null;
}

/**
 * 수정 요청으로 AI 수정안(문구 후보, 배치·색 조정값)을 만든다 (ad-revise).
 * 지금 화면의 합성 명세를 기준으로 하고, 결과는 05_compose/revision_draft.json 에 남긴다. 적용은 사람이 한다.
 */
export async function generateRevisionDraft(svc: CaseService, caseId: string, gen: Generator, doc: ComposeDoc, rev: RevisionRecord): Promise<RevisionDraft> {
  const brief = await svc.getBrief(caseId);
  if (!brief) throw new CaseError("브리프가 없습니다");
  const intake = await svc.getIntake(caseId);
  const banned = bannedPhrases(intake);
  const v = doc.variants;
  const sh = doc.shared;
  const system = [readSkill("ad-revise"), "## 이 시스템에서의 출력 방법", "- 지정된 JSON 스키마로만 답한다.", "- 헤드라인 줄바꿈은 \\n 으로 쓴다."].join("\n");
  const user = [
    "<수정_요청>",
    `- 요청한 쪽: ${rev.source} / 분류: ${rev.type}`,
    `- 종류: ${rev.kinds.join(", ")}`,
    `- 내용: ${rev.detail}`,
    "</수정_요청>",
    "<지금_시안>",
    ...(["A", "B"] as const).map(
      (k) => `- 시안 ${k}: 리드 "${v[k].lead ?? ""}" / 헤드라인 "${v[k].headline.replace(/\n/g, "\\n")}" / 서브 "${v[k].sub}" / 버튼 "${v[k].cta}" / 버튼 색 ${v[k].buttonBg} 글자 ${v[k].buttonFg} / 서브카피 색 ${v[k].subColor ?? "글자 색과 같음"}`,
    ),
    `- 공통: 문구 위치 ${sh.copySpace}, 글자 색 ${sh.textColor}, 그라데이션 ${sh.overlay} (0~0.9)` +
      (sh.product ? `, 제품 크기 ${sh.product.scale} (0.3~1.6), 좌우 ${sh.product.dx} 위아래 ${sh.product.dy} (-0.5~0.5)` : ", 제품 없음") +
      (sh.logo ? `, 로고 ${sh.logo.corner} (tl/tr/bl/br) 크기 ${sh.logo.scale} (0.5~2)` : ", 로고 없음"),
    "</지금_시안>",
    "<브리프>",
    `- 핵심 메시지: ${effectiveValue(brief, "keyMessage")}`,
    `- 원하는 행동(CTA): ${effectiveValue(brief, "cta")}`,
    `- 근거: ${brief.evidenceStatus}${brief.evidenceQuotes.length ? ` — ${brief.evidenceQuotes.join(" / ")}` : ""}`,
    `- 쓰면 안 되는 말: ${banned.join(", ") || "없음"}`,
    "</브리프>",
    ruleForPrompt(matchRule(svc.currentSettings.productRules, intake)),
  ]
    .filter(Boolean)
    .join("\n");

  const res = await gen({ purpose: "revision", system, user, schema: RevisionModelOutput });
  const draft = buildRevisionDraft(res.data, doc, rev, intakeCorpus(intake), banned, res.model);
  await svc.log(caseId, {
    purpose: "revision_draft",
    model: res.model,
    usage: res.usage,
    costUsd: res.costUsd,
    copyOptions: draft.copyOptions.length,
    layout: draft.layout.length,
    dropped: draft.dropped.length,
    issues: draft.copyOptions.flatMap((o) => o.issues.map((i) => i.message)),
  });
  await svc.store.write(caseId, DRAFT_FILE, JSON.stringify(draft, null, 2) + "\n");
  return draft;
}
