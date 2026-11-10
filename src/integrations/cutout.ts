/**
 * 브라우저 안에서 배경 제거(누끼). 사진은 이 PC 밖으로 나가지 않는다.
 * - 라이브러리: Transformers.js (Apache-2.0)
 * - 모델: GPU(WebGPU)면 BiRefNet-lite (MIT), CPU면 IS-Net 일반용 (imgly/isnet-general-onnx, MIT).
 *   BiRefNet-lite는 CPU(WebAssembly) 메모리 한도를 넘어(실측: std::bad_alloc) CPU에서는 더 가벼운 IS-Net을 쓴다.
 *   처음 쓸 때 Hugging Face에서 받고 브라우저에 캐시한다.
 * - ONNX 런타임 파일(wasm)은 이 사이트에서 직접 제공한다 (외부 CDN 스크립트 금지, CSP).
 * 모델은 "알파(투명도)"만 계산하고 원본 픽셀은 그대로 둔다. 그래서 제품의 글자·색은 바뀌지 않는다.
 */
export const CUTOUT_TOOL = "브라우저 누끼 (Transformers.js)";

type Progress = (msg: string) => void;
type RawImageLike = { toBlob: (type?: string) => Promise<Blob> };
type Segmenter = ((img: unknown) => Promise<RawImageLike | RawImageLike[]>) & { dispose?: () => Promise<void> };

interface Attempt {
  device: "webgpu" | "wasm";
  dtype: "fp16" | "fp32";
  model: string;
  /** 기록용 이름 (절대 규칙 7: 사용 도구) */
  label: string;
}

const GPU_ATTEMPT: Attempt = { device: "webgpu", dtype: "fp16", model: "onnx-community/BiRefNet_lite-ONNX", label: "GPU · BiRefNet-lite (MIT)" };
const CPU_ATTEMPT: Attempt = { device: "wasm", dtype: "fp32", model: "imgly/isnet-general-onnx", label: "CPU · IS-Net 일반용 (MIT)" };

const GPU_FAILED_KEY = "ad-agent:cutout-gpu-failed";

function gpuFailedBefore(): boolean {
  try {
    return localStorage.getItem(GPU_FAILED_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberGpuFailed() {
  try {
    localStorage.setItem(GPU_FAILED_KEY, "1");
  } catch {
    /* 기억 못 해도 동작 */
  }
}

const firstLine = (e: unknown) => String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 160);

/**
 * GPU로 돌릴 수 있는지 미리 본다. 이 모델은 셰이더당 저장 버퍼가 17개 이상 필요하다
 * (실측: 한도 16인 GPU에서 "Too many storage buffers in shader. Current: 17, Max is 16").
 * 한 번 정한 실행 방식은 페이지를 새로 열 때까지 바뀌지 않아서 처음에 골라야 한다.
 */
async function pickAttempt(): Promise<Attempt> {
  const cpu = CPU_ATTEMPT;
  if (gpuFailedBefore() || typeof navigator === "undefined" || !("gpu" in navigator)) return cpu;
  try {
    const gpu = (navigator as unknown as { gpu: { requestAdapter: () => Promise<{ limits: { maxStorageBuffersPerShaderStage: number } } | null> } }).gpu;
    const adapter = await gpu.requestAdapter();
    if (!adapter || adapter.limits.maxStorageBuffersPerShaderStage < 17) return cpu;
  } catch {
    return cpu;
  }
  return GPU_ATTEMPT;
}

/** 빌드할 때 정해진다: "" 이면 이 사이트의 ort/, 아니면 그 주소 */
declare const __ORT_WASM_BASE__: string;

/** 한 번 준비한 모델은 이 탭에서 계속 쓴다 */
let working: { seg: Segmenter; attempt: Attempt } | null = null;

async function configure() {
  const tf = await import("@huggingface/transformers");
  // 상대 경로 배포("./")에서도 워커가 찾을 수 있게 절대 주소로 바꾼다
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  // 런타임 파일은 이 사이트의 /ort/ 에서 (vite.config.ts 가 빌드에 복사)
  const onnx = tf.env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
  // Cloudflare 빌드는 25MiB 한도 때문에 wasm 만 jsDelivr 의 같은 버전에서 받는다 (vite.config.ts)
  const wasmBase = __ORT_WASM_BASE__ || `${base}ort/`;
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: `${base}ort/ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${wasmBase}ort-wasm-simd-threaded.asyncify.wasm` };
  (tf.env as { useWasmCache?: boolean }).useWasmCache = false;
  tf.env.allowLocalModels = false;
  return tf;
}

async function load(a: Attempt, onProgress: Progress): Promise<Segmenter> {
  const tf = await configure();
  return (await tf.pipeline("background-removal", a.model, {
    device: a.device,
    dtype: a.dtype,
    progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status === "progress" && p.file && typeof p.progress === "number") onProgress(`모델 받는 중 (${p.file.split("/").pop()}) ${Math.round(p.progress)}%`);
    },
  })) as unknown as Segmenter;
}

async function runOnce(seg: Segmenter, photo: Blob): Promise<Blob> {
  const tf = await import("@huggingface/transformers");
  const input = await tf.RawImage.fromBlob(photo);
  const out = await seg(input);
  const img = Array.isArray(out) ? out[0] : out;
  return img.toBlob("image/png");
}

/** 사진(Blob) → 배경이 투명한 PNG(Blob) */
export async function removeBackground(photo: Blob, onProgress: Progress = () => {}): Promise<{ blob: Blob; device: string }> {
  if (!working) {
    const a = await pickAttempt();
    onProgress(`모델 준비 중 (${a.label})`);
    try {
      working = { seg: await load(a, onProgress), attempt: a };
    } catch (e) {
      if (a.device === "webgpu") rememberGpuFailed();
      const hint = a.device === "webgpu" ? " (GPU). 페이지를 새로고침한 뒤 다시 누르면 CPU로 처리합니다" : "";
      throw new Error(`누끼 모델을 준비하지 못했습니다${hint}: ${firstLine(e)}`);
    }
  }
  const { seg, attempt } = working;
  onProgress(`누끼 계산 중 (${attempt.label}${attempt.device === "wasm" ? ", 1~2분 걸릴 수 있음" : ""})`);
  try {
    const blob = await runOnce(seg, photo);
    onProgress("완료");
    return { blob, device: attempt.label };
  } catch (e) {
    if (attempt.device === "webgpu") {
      rememberGpuFailed();
      working = null;
      throw new Error(`이 PC의 GPU로는 누끼를 계산하지 못했습니다. 페이지를 새로고침한 뒤 다시 누르면 CPU로 처리합니다. (${firstLine(e)})`);
    }
    throw new Error(`누끼에 실패했습니다. 누끼 PNG를 직접 올려 주세요. (${firstLine(e)})`);
  }
}
