import { z } from "zod/v4";

/** 1부 질문지. 형식의 기준은 이 파일이다 (.claude/skills/ad-intake/SKILL.md 참고). */

export const OBJECTIVES = ["매출", "문의·상담", "회원가입", "사이트·매장 방문"] as const;
export const ASSET_OPTIONS = ["제품 사진", "매장·공간 사진", "로고 파일", "없음"] as const;
export const CHANNEL_OPTIONS = ["인스타그램·페이스북", "네이버", "카카오"] as const;

export const UNKNOWN_LABEL = "모르겠음";

const unknownFlag = z.boolean().default(false);

const textAnswer = z.object({ text: z.string().default(""), unknown: unknownFlag });

export const IntakeSchema = z.object({
  version: z.literal(1),
  submittedAt: z.string(),
  consent: z.object({
    aiNotice: z.literal(true),
    privacy: z.literal(true),
    portfolio: z.boolean(),
    consentedAt: z.string(),
  }),
  contact: z.object({
    company: z.string().trim().min(1),
    contactName: z.string().trim().min(1),
    phone: z.string().trim().min(1),
  }),
  answers: z.object({
    "1": z.object({ text: z.string().trim().min(1), unknown: z.literal(false).default(false) }),
    "2": textAnswer,
    "3": z.object({ choice: z.enum(OBJECTIVES).nullable().default(null), unknown: unknownFlag }),
    "4": textAnswer,
    "5": z.object({
      competitors: z
        .array(z.object({ name: z.string().default(""), url: z.string().default("") }))
        .max(3)
        .default([]),
      unknown: unknownFlag,
    }),
    "6": textAnswer,
    "7": z.object({ must: z.string().default(""), avoid: z.string().default(""), unknown: unknownFlag }),
    "8": z.object({ likes: z.string().default(""), dislikes: z.string().default(""), unknown: unknownFlag }),
    "9": z.object({ hasProduct: z.boolean() }),
    "10": z.object({ assets: z.array(z.enum(ASSET_OPTIONS)).default([]), text: z.string().default(""), unknown: unknownFlag }),
    "11": z.object({ channels: z.array(z.enum(CHANNEL_OPTIONS)).default([]), unknown: unknownFlag }),
  }),
});

export type Intake = z.infer<typeof IntakeSchema>;
export type QuestionNo = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

/** 화면에 쓰는 질문 문구. 쉬운 말로 쓴다. */
export const QUESTIONS: { no: QuestionNo; title: string; help?: string; unknownAllowed: boolean; optional?: boolean }[] = [
  { no: 0, title: "가게(회사) 이름과 담당자, 연락처를 알려 주세요", help: "담당자 이름과 연락처는 연락용으로만 쓰고 AI에게 보내지 않아요.", unknownAllowed: false },
  { no: 1, title: "무엇을 파시나요?", help: "예) 동네에서 직접 굽는 수제 쿠키", unknownAllowed: false },
  { no: 2, title: "누구에게 팔고 싶으세요?", help: "예) 아이 간식을 고르는 30대 부모", unknownAllowed: true },
  { no: 3, title: "이번 광고로 가장 얻고 싶은 것은 무엇인가요?", help: "하나만 골라 주세요.", unknownAllowed: true },
  { no: 4, title: "지금 가장 큰 고민은 무엇인가요?", help: "예) 가게를 아는 사람이 적어요", unknownAllowed: true },
  { no: 5, title: "비슷한 경쟁 업체가 있나요? (최대 3곳)", help: "인스타그램처럼 로그인해야 보이는 곳은 화면 캡처를 따로 보내 주시면 좋아요.", unknownAllowed: true },
  { no: 6, title: "경쟁 업체보다 우리가 더 나은 점 하나는?", help: "후기, 숫자, 수상 이력이 있으면 함께 적어 주세요. 없으면 비워 두셔도 돼요.", unknownAllowed: true },
  { no: 7, title: "광고에 꼭 넣을 말과 쓰면 안 되는 말이 있나요?", unknownAllowed: true },
  { no: 8, title: "마음에 드는 광고와 싫은 광고가 있나요?", help: "선택 질문이에요. 건너뛰셔도 돼요.", unknownAllowed: true, optional: true },
  { no: 9, title: "광고에 보여 줄 제품이 있나요?", help: "쿠키, 화장품처럼 손에 잡히는 물건이면 '있음', 상담·서비스·가게 자체를 알리면 '없음'이에요.", unknownAllowed: false },
  { no: 10, title: "광고에 쓸 사진과 로고가 있나요?", help: "있는 것을 모두 골라 주세요. 파일은 다음 단계에서 받아요.", unknownAllowed: true },
  { no: 11, title: "어디에 광고하고 싶으세요?", help: "여러 개 골라도 돼요.", unknownAllowed: true },
];

/** 질문 번호별 "모르겠음" 여부 */
export function isUnknown(intake: Intake, no: QuestionNo): boolean {
  if (no === 0 || no === 1 || no === 9) return false;
  const a = intake.answers[String(no) as keyof Intake["answers"]] as { unknown?: boolean };
  return Boolean(a.unknown);
}

export function unknownQuestions(intake: Intake): QuestionNo[] {
  return QUESTIONS.map((q) => q.no).filter((no) => isUnknown(intake, no));
}

/**
 * 모델에 보내는 1부 답. 담당자 이름·연락처는 빼고 상호만 보낸다 (ad-intake 규칙 4).
 * "모르겠음"은 명시적으로 표시한다.
 */
export function intakeForModel(intake: Intake): string {
  const a = intake.answers;
  const u = (flag: boolean, v: string) => (flag ? UNKNOWN_LABEL : v.trim() || "(빈칸)");
  const lines = [
    `0번 상호: ${intake.contact.company}`,
    `1번 무엇을 파나: ${a["1"].text}`,
    `2번 타깃: ${u(a["2"].unknown, a["2"].text)}`,
    `3번 광고 목적: ${u(a["3"].unknown, a["3"].choice ?? "")}`,
    `4번 가장 큰 고민: ${u(a["4"].unknown, a["4"].text)}`,
    `5번 경쟁 업체: ${u(
      a["5"].unknown,
      a["5"].competitors.filter((c) => c.name || c.url).map((c) => `${c.name}${c.url ? ` (${c.url})` : ""}`).join(", "),
    )}`,
    `6번 더 나은 점: ${u(a["6"].unknown, a["6"].text)}`,
    `7번 꼭 넣을 말: ${u(a["7"].unknown, a["7"].must)}`,
    `7번 쓰면 안 되는 말: ${u(a["7"].unknown, a["7"].avoid)}`,
    `8번 마음에 드는 광고: ${u(a["8"].unknown, a["8"].likes)} / 싫은 광고: ${u(a["8"].unknown, a["8"].dislikes)}`,
    `9번 보여 줄 제품: ${a["9"].hasProduct ? "있음" : "없음"}`,
    `10번 사진·로고: ${u(a["10"].unknown, [...a["10"].assets, a["10"].text].filter(Boolean).join(", "))}`,
    `11번 매체: ${u(a["11"].unknown, a["11"].channels.join(", "))}`,
  ];
  return lines.join("\n");
}

/** 근거 검사용: 광고주가 직접 쓴 글 전체 (상호 포함, 담당자·연락처 제외) */
export function intakeCorpus(intake: Intake): string {
  // 질문 번호("1번") 같은 라벨은 넣지 않는다. 라벨의 숫자가 지어낸 숫자를 통과시키지 않게.
  const a = intake.answers;
  return [
    intake.contact.company,
    a["1"].text,
    a["2"].unknown ? "" : a["2"].text,
    a["3"].unknown ? "" : a["3"].choice ?? "",
    a["4"].unknown ? "" : a["4"].text,
    a["5"].unknown ? "" : a["5"].competitors.map((c) => `${c.name} ${c.url}`).join(" "),
    a["6"].unknown ? "" : a["6"].text,
    a["7"].unknown ? "" : `${a["7"].must} ${a["7"].avoid}`,
    a["8"].unknown ? "" : `${a["8"].likes} ${a["8"].dislikes}`,
    a["10"].unknown ? "" : `${a["10"].assets.join(" ")} ${a["10"].text}`,
    a["11"].unknown ? "" : a["11"].channels.join(" "),
  ].join("\n");
}

/** 7번 "쓰면 안 되는 말"을 쉼표·줄바꿈 기준으로 나눈다 */
export function bannedPhrases(intake: Intake): string[] {
  const a = intake.answers["7"];
  if (a.unknown) return [];
  return a.avoid
    .split(/[,\n、/·]|그리고/)
    .map((s) => s.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
    .filter((s) => s.length >= 2 && !/^(없음|없어요|없습니다)$/.test(s));
}
