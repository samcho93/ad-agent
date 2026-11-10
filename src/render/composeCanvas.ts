import { type ComposeDoc, type Fit, type SizeKey, type Variant, fitText, layoutFor } from "@/core/compose";
import { FONT_FAMILY, WEIGHT } from "./fonts";

/**
 * 합성 엔진 (브라우저 캔버스, 템플릿 banner-square-v1).
 * 그리는 순서: 배경 → 문구 쪽 그라데이션 → 제품 누끼(원본 그대로) → 헤드라인·서브 → 버튼 → 로고(원본 파일).
 * 이미지 안에 글자를 AI로 만들지 않는다. 글자는 여기서 폰트로 그린다 (절대 규칙 3).
 */
export interface Sources {
  scene: CanvasImageSource & { width: number; height: number };
  product?: CanvasImageSource & { width: number; height: number };
  logo?: CanvasImageSource & { width: number; height: number };
}

export interface RenderCheck {
  variant: Variant;
  size: SizeKey;
  severity: "error" | "warning";
  message: string;
}

const font = (weight: number, size: number) => `${weight} ${size}px "${FONT_FAMILY}", sans-serif`;

function drawCover(ctx: CanvasRenderingContext2D, img: Sources["scene"], W: number, H: number) {
  const s = Math.max(W / img.width, H / img.height);
  const w = img.width * s;
  const h = img.height * s;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

function drawContain(ctx: CanvasRenderingContext2D, img: NonNullable<Sources["product"]>, box: { x: number; y: number; w: number; h: number }, scale: number, dx: number, dy: number) {
  if (box.w <= 0 || box.h <= 0) return;
  const s = Math.min(box.w / img.width, box.h / img.height) * scale;
  const w = img.width * s;
  const h = img.height * s;
  const cx = box.x + box.w / 2 + dx * box.w;
  const cy = box.y + box.h / 2 + dy * box.h;
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
}

function overlay(ctx: CanvasRenderingContext2D, W: number, H: number, side: string, strength: number, dark: boolean) {
  if (strength <= 0) return;
  const [x0, y0, x1, y1] =
    side === "위" ? [0, 0, 0, H * 0.75] : side === "아래" ? [0, H, 0, H * 0.25] : side === "오른쪽" ? [W, 0, W * 0.25, 0] : [0, 0, W * 0.75, 0];
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  const c = dark ? "0,0,0" : "255,255,255";
  g.addColorStop(0, `rgba(${c},${Math.min(0.9, strength)})`);
  g.addColorStop(1, `rgba(${c},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 한 시안·한 사이즈를 그린다 */
export function renderBanner(doc: ComposeDoc, variant: Variant, size: SizeKey, src: Sources, canvas: HTMLCanvasElement): RenderCheck[] {
  const L = layoutFor(size, doc.shared.copySpace);
  const copy = doc.variants[variant];
  canvas.width = L.W;
  canvas.height = L.H;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, L.W, L.H);
  ctx.textBaseline = "top";
  const checks: RenderCheck[] = [];
  const note = (severity: RenderCheck["severity"], message: string) => checks.push({ variant, size, severity, message });

  drawCover(ctx, src.scene, L.W, L.H);
  overlay(ctx, L.W, L.H, L.overlaySide, doc.shared.overlay, doc.shared.textColor === "#ffffff");
  if (src.product && doc.shared.product) drawContain(ctx, src.product, L.product, doc.shared.product.scale, doc.shared.product.dx, doc.shared.product.dy);

  const measure = (weight: number) => (t: string, s: number) => {
    ctx.font = font(weight, s);
    return ctx.measureText(t).width;
  };
  const center = size === "1080x1080" && (doc.shared.copySpace === "위" || doc.shared.copySpace === "아래");
  ctx.textAlign = center ? "center" : "left";
  const tx = center ? L.text.x + L.text.w / 2 : L.text.x;

  // 버튼 크기 (띠 배너는 오른쪽에 따로)
  ctx.font = font(WEIGHT.semibold, L.cta.size);
  const ctaW = ctx.measureText(copy.cta).width + L.cta.padX * 2;
  const ctaH = L.cta.size + L.cta.padY * 2;
  const textBox = L.buttonInline ? { ...L.text, w: L.text.w } : { ...L.text, h: L.text.h - ctaH - L.cta.size };

  const head: Fit = fitText(copy.headline, textBox, { ...L.headline, lineHeight: 1.22 }, measure(WEIGHT.extrabold));
  const subBox = { w: textBox.w, h: Math.max(0, textBox.h - head.lines.length * head.size * 1.22 - head.size * 0.4) };
  const sub: Fit | null = L.showSub && copy.sub.trim() ? fitText(copy.sub, subBox, { ...L.sub, lineHeight: 1.35 }, measure(WEIGHT.regular)) : null;
  if (head.overflow) note("error", "헤드라인이 영역을 넘칩니다 (문구 잘림). 더 짧게 쓰세요");
  else if (head.brokeWord) note("warning", "헤드라인 어절이 중간에서 줄바꿈됩니다");
  if (sub?.overflow) note("error", "서브카피가 영역을 넘칩니다 (문구 잘림)");

  // 글자 덩어리 전체 높이를 구해 영역 안에서 세로 정렬 (위·왼쪽은 위부터, 아래는 아래부터)
  const blockH = head.lines.length * head.size * 1.22 + (sub ? head.size * 0.4 + sub.lines.length * sub.size * 1.35 : 0) + (L.buttonInline ? 0 : L.cta.size + ctaH);
  let y = L.buttonInline ? L.text.y + (L.text.h - head.lines.length * head.size * 1.22) / 2 : doc.shared.copySpace === "아래" && size === "1080x1080" ? L.text.y + L.text.h - blockH : L.text.y;

  ctx.fillStyle = doc.shared.textColor;
  ctx.shadowColor = doc.shared.textColor === "#ffffff" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.35)";
  ctx.shadowBlur = Math.round(head.size * 0.12);
  ctx.font = font(WEIGHT.extrabold, head.size);
  for (const line of head.lines) {
    ctx.fillText(line, tx, y);
    y += head.size * 1.22;
  }
  if (sub) {
    y += head.size * 0.4;
    ctx.font = font(WEIGHT.regular, sub.size);
    for (const line of sub.lines) {
      ctx.fillText(line, tx, y);
      y += sub.size * 1.35;
    }
  }
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";

  // 버튼
  const bx = L.buttonInline ? L.W - 10 - ctaW : center ? L.text.x + (L.text.w - ctaW) / 2 : L.text.x;
  const by = L.buttonInline ? (L.H - ctaH) / 2 : y + L.cta.size;
  if (L.buttonInline && ctaW > L.W * 0.36) note("error", "버튼 문구가 너무 깁니다 (띠 배너)");
  if (!L.buttonInline && ctaW > L.text.w) note("error", "버튼 문구가 영역을 넘칩니다");
  if (!L.buttonInline && by + ctaH > L.H - 4) note("error", "버튼이 배너 아래로 넘칩니다 (문구를 줄이세요)");
  ctx.fillStyle = copy.buttonBg;
  roundRect(ctx, bx, by, ctaW, ctaH, Math.round(ctaH * 0.28));
  ctx.fill();
  ctx.fillStyle = copy.buttonFg;
  ctx.font = font(WEIGHT.semibold, L.cta.size);
  ctx.textAlign = "center";
  ctx.fillText(copy.cta, bx + ctaW / 2, by + L.cta.padY);

  // 로고 (원본 파일 그대로)
  if (src.logo && doc.shared.logo && L.logo.h > 0) {
    const h = L.logo.h * doc.shared.logo.scale;
    const w = (src.logo.width / src.logo.height) * h;
    const c = doc.shared.logo.corner;
    const lx = c.endsWith("l") ? L.logo.margin : L.W - L.logo.margin - w;
    const ly = c.startsWith("t") ? L.logo.margin : L.H - L.logo.margin - h;
    ctx.drawImage(src.logo, lx, ly, w, h);
  }
  return checks;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG로 만들지 못했습니다"))), "image/png"));
}

/** 저장소 Blob → 그릴 수 있는 이미지 (SVG 로고 포함) */
export function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 열지 못했습니다"));
    };
    img.src = url;
  });
}
