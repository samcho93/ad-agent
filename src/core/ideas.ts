import { z } from "zod/v4";
import type { Intake } from "./intake";
import { intakeCorpus, bannedPhrases } from "./intake";
import type { BriefDoc, ObjectiveCategory } from "./brief";
import { type Tag, renderTags, withEstimate } from "./tags";
import { type Issue, factIssues, similarity, visualTextHits } from "./validate";

/** 아이디어 방향표 (docs/architecture.md 3절) */
export const DIRECTIONS: Record<ObjectiveCategory, [string, string, string]> = {
  매출: ["혜택 (가격, 구성, 사은품)", "비교 (경쟁·대안보다 나은 점)", "지금 사야 하는 이유 (한정, 시즌)"],
  "문의·상담": ["고민 공감", "믿을 근거 (후기, 경력, 수치)", "부담 없는 첫걸음 (무료 상담, 간단 신청)"],
  회원가입: ["가입하면 받는 것", "쉬움·빠름", "이미 쓰는 사람들"],
  "방문·인지": ["감성 (분위기, 공간)", "호기심", "우리 가게다운 모습"],
};

/** 근거(후기·수치)가 있어야 성립하는 방향 */
const EVIDENCE_DIRECTIONS = ["믿을 근거", "이미 쓰는 사람들"];
export const needsEvidence = (direction: string) => EVIDENCE_DIRECTIONS.some((d) => direction.startsWith(d));

export const IdeaModelOutput = z.object({
  ideas: z
    .array(
      z.object({
        title: z.string().describe("짧은 이름"),
        concept: z.string().describe("콘셉트 한 줄"),
        headlines: z.array(z.string()).describe("헤드라인 후보 2개"),
        subCopy: z.string(),
        cta: z.string().describe("버튼 문구"),
        visual: z.object({
          scene: z.string().describe("장면. 글자·간판·로고·워터마크 없음"),
          composition: z.string().describe("구도"),
          copySpace: z.enum(["위", "아래", "왼쪽", "오른쪽"]).describe("문구와 버튼을 얹을 빈 공간 위치"),
          mood: z.string(),
        }),
        evidenceStatus: z.enum(["있음", "근거 없음", "해당 없음"]),
        evidenceSource: z.string().describe("근거가 있으면 1부 몇 번의 어떤 문구인지. 없으면 빈 문자열"),
        requestToClient: z.string().describe("근거 없음이거나 자료가 부족할 때 광고주에게 요청할 것. 없으면 빈 문자열"),
        riskNotes: z.string().describe("심의 업종일 때 위험 표현 메모. 아니면 빈 문자열"),
        estimated: z.boolean().describe("브리프의 추정 항목에 기댄 안이면 true"),
      }),
    )
    .describe("정확히 3개. 순서대로 방향 1, 2, 3"),
});
export type IdeaModelOutput = z.infer<typeof IdeaModelOutput>;

export interface Idea {
  id: "idea-1" | "idea-2" | "idea-3";
  direction: string;
  title: string;
  concept: string;
  headlines: string[];
  subCopy: string;
  cta: string;
  visual: { scene: string; composition: string; copySpace: string; mood: string };
  evidenceStatus: "있음" | "근거 없음" | "해당 없음";
  evidenceSource: string;
  requestToClient: string;
  riskNotes: string;
  productPhotoNote: string;
  tags: Tag[];
  estimated: boolean;
}

export interface IdeasDoc {
  version: 1;
  generatedAt: string;
  model: string;
  objectiveCategory: ObjectiveCategory;
  ideas: Idea[];
  issues: Issue[];
  selectedId?: Idea["id"];
}

export function buildIdeas(intake: Intake, brief: BriefDoc, out: IdeaModelOutput, model: string): IdeasDoc {
  const corpus = intakeCorpus(intake);
  const banned = bannedPhrases(intake);
  const issues: Issue[] = [];
  const dirs = DIRECTIONS[brief.objectiveCategory];

  if (out.ideas.length !== 3) issues.push({ severity: "error", where: "ideas", message: `아이디어는 3안이어야 함 (현재 ${out.ideas.length}안)` });

  const assets = intake.answers["10"].unknown ? [] : intake.answers["10"].assets;
  const productNoPhoto = brief.hasProduct && !assets.includes("제품 사진");

  const ideas: Idea[] = out.ideas.slice(0, 3).map((o, i) => {
    const id = `idea-${i + 1}` as Idea["id"];
    const direction = dirs[i];
    let evidenceStatus = o.evidenceStatus;
    let requestToClient = o.requestToClient.trim();
    if (needsEvidence(direction) && brief.evidenceStatus === "근거 없음") {
      if (evidenceStatus !== "근거 없음") {
        issues.push({ severity: "warning", where: id, message: "1부에 근거가 없어 근거 상태를 '근거 없음'으로 고침" });
        evidenceStatus = "근거 없음";
      }
      if (!requestToClient) requestToClient = "후기, 경력, 수치 등 믿을 근거 자료를 광고주에게 요청";
    }
    // 광고에 실릴 문구는 금지어·근거성 표현까지 검사하고, 콘셉트 설명은 숫자 검사만 한다
    const copyText = [o.title, ...o.headlines, o.subCopy, o.cta].join("\n");
    issues.push(...factIssues(id, copyText, corpus, banned));
    issues.push(...factIssues(id, o.concept, corpus, banned, { copy: false }));
    if (o.headlines.length < 2) issues.push({ severity: "error", where: id, message: "헤드라인 후보는 2개 이상이어야 함" });
    const vis = visualTextHits([o.visual.scene, o.visual.composition, o.visual.mood].join(" "));
    if (vis.length) issues.push({ severity: "error", where: id, message: `비주얼 묘사에 글자·로고가 들어감: ${vis.join(", ")} (이미지에 글자·로고 생성 금지)` });
    const estimated = o.estimated || brief.objectiveEstimated;
    return {
      id,
      direction,
      title: o.title.trim(),
      concept: o.concept.trim(),
      headlines: o.headlines.map((h) => h.trim()),
      subCopy: o.subCopy.trim(),
      cta: o.cta.trim(),
      visual: o.visual,
      evidenceStatus,
      evidenceSource: o.evidenceSource.trim(),
      requestToClient,
      riskNotes: o.riskNotes.trim(),
      productPhotoNote: productNoPhoto ? "제품형인데 제품 사진이 없음: 광고주 사진 요청 필요. AI로 제품을 새로 그리지 않음" : "",
      tags: withEstimate([{ kind: "ai" }], estimated),
      estimated,
    };
  });

  // 3안이 서로 겹치지 않는지
  const sig = (x: Idea) => [x.concept, ...x.headlines, x.visual.scene].join(" ");
  for (let i = 0; i < ideas.length; i++)
    for (let j = i + 1; j < ideas.length; j++) {
      const s = similarity(sig(ideas[i]), sig(ideas[j]));
      if (s > 0.45) issues.push({ severity: "warning", where: "ideas", message: `${ideas[i].id}와 ${ideas[j].id}가 많이 겹침 (유사도 ${s.toFixed(2)})` });
    }

  const seen = new Set<string>();
  const unique = issues.filter((i) => {
    const k = `${i.where}|${i.message}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { version: 1, generatedAt: new Date().toISOString(), model, objectiveCategory: brief.objectiveCategory, ideas, issues: unique };
}

export function renderIdeasMarkdown(doc: IdeasDoc, company: string): string {
  const L: string[] = [];
  L.push(`# 아이디어 3안 — ${company}`);
  L.push("");
  L.push(`> 광고 목적: ${doc.objectiveCategory} · 생성: ${doc.generatedAt} · 모델: ${doc.model}`);
  L.push(doc.selectedId ? `> 게이트 1 선택: **${doc.selectedId}**` : "> 게이트 1에서 사람이 1안을 고른다.");
  L.push("");
  for (const x of doc.ideas) {
    const chosen = doc.selectedId === x.id ? " ✅ 선택" : "";
    L.push(`## ${x.id.replace("idea-", "")}안. ${x.title} ${renderTags(x.tags)}${chosen}`);
    L.push("");
    L.push(`- 방향: ${x.direction}`);
    L.push(`- 콘셉트: ${x.concept}`);
    L.push(`- 헤드라인 후보: ${x.headlines.map((h) => `"${h}"`).join(" / ")}`);
    L.push(`- 서브카피: ${x.subCopy}`);
    L.push(`- 버튼: ${x.cta}`);
    L.push(`- 비주얼: ${x.visual.scene} / 구도: ${x.visual.composition} / 빈 공간: ${x.visual.copySpace} / 분위기: ${x.visual.mood} (글자·로고 없음, 합성 단계에서 얹음)`);
    L.push(`- 근거: ${x.evidenceStatus}${x.evidenceSource ? ` (${x.evidenceSource})` : ""}`);
    if (x.requestToClient) L.push(`- 보완 요청: ${x.requestToClient}`);
    if (x.productPhotoNote) L.push(`- 제품 사진: ${x.productPhotoNote}`);
    if (x.riskNotes) L.push(`- 위험 표현 메모: ${x.riskNotes}`);
    const iss = doc.issues.filter((i) => i.where === x.id);
    for (const i of iss) L.push(`- ⚠ 검증(${i.severity}): ${i.message}`);
    L.push("");
  }
  const general = doc.issues.filter((i) => i.where === "ideas");
  if (general.length) {
    L.push("## 검증 메모");
    for (const i of general) L.push(`- (${i.severity}) ${i.message}`);
    L.push("");
  }
  L.push("시안 A/B는 고른 1안에서 메시지·버튼 문구·버튼 색만 다르게 만든다 (그림과 배치는 같음).");
  L.push("");
  return L.join("\n");
}
