/**
 * Gemini 이미지 생성 (Google "나노바나나" 계열 이미지 모델).
 * 사용자 본인의 Gemini API 키로 브라우저에서 직접 호출하고, 받은 이미지를 Blob 으로 돌려준다.
 * - 프롬프트는 이미지 단계에서 만든 영어 프롬프트 그대로다 ("글자·로고 금지", 빈 공간, 누끼 경로의 "제품 그리지 않기"가 이미 붙어 있음).
 * - 참조 이미지(제품 사진)는 사람이 "제품 사진을 참조로 넣어 생성"을 고른 경우에만 보낸다.
 * - 키와 이미지 데이터는 어디에도 기록하지 않는다 (절대 규칙 6). 기록은 ImageService 가 출처·모델·프롬프트만 남긴다.
 * - 모델 이름은 코드에 넣지 않고, 연결 확인에서 받은 목록에서 고른다.
 */

export interface ImageRef {
  mime: string;
  base64: string;
}

export interface ImageGenRequest {
  prompt: string;
  /** 프롬프트의 권장 비율 ("1:1", "16:9", "1.91:1") */
  aspect: string;
  references: ImageRef[];
}

export interface ImageGenResult {
  blob: Blob;
  model: string;
  /** 모델이 이미지와 함께 돌려준 짧은 글 (있으면 화면에만 보여 줌) */
  note?: string;
}

export type ImageGenerator = (req: ImageGenRequest) => Promise<ImageGenResult>;

export class ImageGenError extends Error {}

/** Gemini 가 받는 비율로 바꾼다. 1.91:1(1200x628)은 가장 가까운 16:9로 만들고 합성에서 잘라 맞춘다 */
export function geminiAspect(aspect: string): string {
  const a = aspect.trim();
  if (a === "1.91:1") return "16:9";
  return ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"].includes(a) ? a : "1:1";
}

/** 이미지 생성 모델만 (이름에 image 가 들어간 Gemini 모델) */
export function isGeminiImageModel(id: string): boolean {
  return /^gemini/.test(id) && /image/.test(id);
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function blobToRef(blob: Blob): Promise<ImageRef> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime: blob.type || "image/png", base64: btoa(s) };
}

function wrap(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number }).status;
  if (status === 400 && /API key/i.test(msg)) throw new ImageGenError("Gemini API 키가 올바르지 않습니다 (설정에서 확인)");
  if (status === 400 && /billing|paid|free tier/i.test(msg)) throw new ImageGenError("이 이미지 모델은 결제(빌링)가 켜진 키가 필요합니다 (Google AI Studio에서 확인)");
  if (status === 401 || status === 403) throw new ImageGenError("Gemini API 키가 올바르지 않거나 이 모델을 쓸 권한이 없습니다");
  if (status === 404) throw new ImageGenError("이미지 모델을 찾을 수 없습니다 (설정에서 이미지 모델을 다시 고르세요)");
  if (status === 429) throw new ImageGenError("Gemini 사용량 한도에 걸렸습니다. 결제 설정·한도를 확인하거나 잠시 후 다시 시도하세요");
  if (/fetch|network/i.test(msg)) throw new ImageGenError("Gemini API에 연결하지 못했습니다 (네트워크 확인)");
  throw new ImageGenError(`Gemini 이미지 생성 오류${status ? ` (${status})` : ""}: ${msg.slice(0, 300)}`);
}

interface GenPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

/** 응답에서 이미지 한 장과 글을 꺼낸다 (테스트에서도 씀) */
export function pickImage(res: {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: GenPart[] } }[];
}): { mime: string; base64: string; note: string } {
  if (res.promptFeedback?.blockReason) throw new ImageGenError(`모델이 요청을 거절했습니다 (${res.promptFeedback.blockReason}). 프롬프트를 바꿔 보세요`);
  const cand = res.candidates?.[0];
  const parts = (cand?.content?.parts ?? []).filter((p) => !p.thought);
  const img = parts.find((p) => p.inlineData?.data && /^image\//.test(p.inlineData.mimeType ?? ""));
  const note = parts.map((p) => p.text ?? "").join(" ").trim();
  if (!img) {
    const why = cand?.finishReason && cand.finishReason !== "STOP" ? ` (${cand.finishReason})` : "";
    throw new ImageGenError(`이미지를 받지 못했습니다${why}. 안전 필터에 걸렸거나 모델이 글만 돌려줬습니다${note ? `: ${note.slice(0, 200)}` : ""}`);
  }
  return { mime: img.inlineData!.mimeType!, base64: img.inlineData!.data!, note };
}

export function createGeminiImageGenerator(apiKey: string, model: string): ImageGenerator {
  if (!apiKey) throw new ImageGenError("Gemini API 키가 없습니다. 설정 → 이미지 생성에서 키를 넣으세요");
  if (!model) throw new ImageGenError("설정 → 이미지 생성에서 이미지 모델을 고르세요");
  let ai: Promise<import("@google/genai").GoogleGenAI> | null = null;
  const client = () => (ai ??= import("@google/genai").then((m) => new m.GoogleGenAI({ apiKey })));

  return async (req) => {
    let res;
    try {
      res = await (await client()).models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [...req.references.map((r) => ({ inlineData: { mimeType: r.mime, data: r.base64 } })), { text: req.prompt }],
          },
        ],
        config: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: geminiAspect(req.aspect) } },
      });
    } catch (e) {
      wrap(e);
    }
    const out = pickImage(res as Parameters<typeof pickImage>[0]);
    return { blob: base64ToBlob(out.base64, out.mime), model: res.modelVersion ?? model, note: out.note || undefined };
  };
}

/** 연결 확인: 이 키로 쓸 수 있는 이미지 모델 목록 */
export async function listGeminiImageModels(apiKey: string): Promise<string[]> {
  if (!apiKey) throw new ImageGenError("Gemini API 키를 입력하세요");
  const { GoogleGenAI } = await import("@google/genai");
  try {
    const ids: string[] = [];
    for await (const m of await new GoogleGenAI({ apiKey }).models.list()) {
      const id = (m.name ?? "").replace(/^models\//, "");
      if (isGeminiImageModel(id) && (m.supportedActions ?? ["generateContent"]).includes("generateContent")) ids.push(id);
    }
    return ids.sort();
  } catch (e) {
    wrap(e);
  }
}

/** 개발·시험용 가짜 이미지 (키 없이 화면 시험). 실제 광고주 케이스에는 쓰지 않는다 */
export function fakeImageGenerator(): ImageGenerator {
  let n = 0;
  return async (req) => {
    n++;
    const [w, h] = geminiAspect(req.aspect) === "16:9" ? [1344, 768] : [1024, 1024];
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${(n * 47) % 360} 55% 82%)`);
    grad.addColorStop(1, `hsl(${(n * 47 + 40) % 360} 45% 62%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,.35)";
    g.beginPath();
    g.ellipse(w * 0.62, h * 0.7, w * 0.22, h * 0.07, 0, 0, Math.PI * 2);
    g.fill();
    const blob = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new ImageGenError("가짜 이미지를 만들지 못했습니다"))), "image/png"));
    return { blob, model: "fake-image-model", note: req.references.length ? `참조 ${req.references.length}장 받음 (가짜)` : undefined };
  };
}

export const FAKE_IMAGE_MODEL = "fake-image-model";

/** 설정에 맞는 이미지 생성기. 가짜 모델 모드(화면 시험)에서는 가짜 이미지를 쓴다 */
export function createImageGenerator(settings: { llm: { provider: string }; imageGen: { model: string } }, secrets: { geminiApiKey?: string }): ImageGenerator {
  const model = settings.imageGen.model.trim();
  if (model === FAKE_IMAGE_MODEL || (!model && settings.llm.provider === "fake")) return fakeImageGenerator();
  return createGeminiImageGenerator(secrets.geminiApiKey ?? "", model);
}

/** 기록에 남길 도구 이름 */
export const imageToolName = (model: string) => (model === FAKE_IMAGE_MODEL ? "가짜 이미지 모델 (시험용)" : `Google Gemini 이미지 생성 (${model}, 앱에서 직접)`);
