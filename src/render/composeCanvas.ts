import { type Box, type ComposeDoc, type Fit, type Placed, type SizeKey, type Variant, fitText, layoutFor, overlapIssues, sceneOf, sizeShape } from "@/core/compose";
import { FONT_FAMILY, WEIGHT } from "./fonts";
import { type ProductFx, applyColor, colorIsNeutral, colorStats, featherAlpha, fxOf, matchColor, rotatedBounds } from "@/core/productFx";

/**
 * 합성 엔진 (브라우저 캔버스, 템플릿 banner-square-v1).
 * 그리는 순서: 배경 → 문구 쪽 그라데이션 → 글자 뒤 띠 → 제품 그림자 → 제품 누끼(원본 사진, 사람이 정한 보정만) → 헤드라인·서브 → 버튼 → 로고(원본 파일).
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

/** 배경을 꽉 채운다. zoom(1~2)으로 확대하고, dx·dy(-0.5~0.5)로 남는 부분 안에서 옮긴다 (양수 = 그림을 왼쪽·위로) */
function drawCover(ctx: CanvasRenderingContext2D, img: Sources["scene"], W: number, H: number, zoom = 1, dx = 0, dy = 0) {
  const s = Math.max(W / img.width, H / img.height) * Math.max(1, Math.min(2, zoom));
  const w = img.width * s;
  const h = img.height * s;
  const cx = Math.max(-0.5, Math.min(0.5, dx));
  const cy = Math.max(-0.5, Math.min(0.5, dy));
  ctx.drawImage(img, -(w - W) * (0.5 + cx), -(h - H) * (0.5 + cy), w, h);
}

type Img = NonNullable<Sources["product"]>;

/** 그린 제품의 자리 (미리보기에서 끌어 옮길 때 씀). 캔버스마다 마지막 값 */
export const productFrames = new WeakMap<HTMLCanvasElement, { box: Box; area: Box }>();

/** 보정(색·가장자리)을 적용한 제품 그림. 같은 크기·같은 값이면 다시 만들지 않는다 */
const layerCache = new WeakMap<object, Map<string, HTMLCanvasElement>>();
function productLayer(img: Img, w: number, h: number, fx: ProductFx): CanvasImageSource {
  if (colorIsNeutral(fx.color) && fx.feather <= 0) return img;
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const key = `${W}x${H}|${JSON.stringify(fx.color)}|${fx.feather}`;
  let m = layerCache.get(img);
  if (!m) layerCache.set(img, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, W, H);
  try {
    const d = g.getImageData(0, 0, W, H);
    applyColor(d.data, fx.color);
    featherAlpha(d.data, W, H, fx.feather * Math.min(W, H));
    g.putImageData(d, 0, 0);
  } catch {
    /* 픽셀을 읽을 수 없으면 보정 없이 */
  }
  if (m.size > 12) m.clear();
  m.set(key, c);
  return c;
}

/** 제품을 (그림자 → 보정한 제품 순으로) 그리고, 실제로 보이는 부분의 사각형을 돌려준다 */
function drawProduct(ctx: CanvasRenderingContext2D, img: Img, area: Box, p: { scale: number; dx: number; dy: number; fx?: Partial<ProductFx> }): Box | null {
  if (area.w <= 0 || area.h <= 0) return null;
  const fx = fxOf(p);
  const s = Math.min(area.w / img.width, area.h / img.height) * p.scale;
  const w = img.width * s;
  const h = img.height * s;
  const cx = area.x + area.w / 2 + p.dx * area.w;
  const cy = area.y + area.h / 2 + p.dy * area.h;
  const a = alphaBounds(img);
  // 보이는 부분 (반전·회전 반영)
  const ax = fx.flip ? 1 - a.x - a.w : a.x;
  const vis = rotatedBounds({ x: cx - w / 2 + ax * w, y: cy - h / 2 + a.y * h, w: a.w * w, h: a.h * h }, cx, cy, fx.rotate);
  const layer = productLayer(img, w, h, fx);
  const sh = fx.shadow;
  const unit = vis.h;

  // 바닥 그림자: 보이는 부분 아래에 납작한 타원 (방향만큼 옆으로 밀림)
  if (sh.kind === "ground" && sh.opacity > 0) {
    const t = (sh.angle * Math.PI) / 180;
    const rx = vis.w * 0.5 * (1 + sh.blur);
    const ry = Math.max(2, vis.h * (0.035 + sh.blur * 0.25));
    const gx = vis.x + vis.w / 2 + Math.cos(t) * sh.distance * unit;
    const gy = vis.y + vis.h - ry * 0.35 + Math.max(0, Math.sin(t)) * sh.distance * unit * 0.3;
    ctx.save();
    ctx.translate(gx, gy);
    ctx.scale(1, ry / rx);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, `rgba(0,0,0,${sh.opacity})`);
    grad.addColorStop(0.55, `rgba(0,0,0,${sh.opacity * 0.45})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (sh.kind === "drop" && sh.opacity > 0) {
    const t = (sh.angle * Math.PI) / 180;
    ctx.shadowColor = `rgba(0,0,0,${sh.opacity})`;
    ctx.shadowBlur = sh.blur * unit;
    ctx.shadowOffsetX = Math.cos(t) * sh.distance * unit;
    ctx.shadowOffsetY = Math.sin(t) * sh.distance * unit;
  }
  ctx.translate(cx, cy);
  if (fx.rotate) ctx.rotate((fx.rotate * Math.PI) / 180);
  if (fx.flip) ctx.scale(-1, 1);
  ctx.drawImage(layer, -w / 2, -h / 2, w, h);
  ctx.restore();
  return vis;
}

/**
 * 배경에 자동 맞춤: 제품이 놓인 자리의 배경 색과 제품 색을 비교해 색 보정값을 낸다 (절반만 당김).
 * 반환값을 슬라이더에 넣고 사람이 더 고친다.
 */
export function matchProductColor(doc: ComposeDoc, size: SizeKey, src: Sources, strength = 0.5): ProductFx["color"] | null {
  if (!src.product || !doc.shared.product) return null;
  const L = layoutFor(size, doc.shared.copySpace);
  if (L.product.w <= 0) return null;
  try {
    const c = document.createElement("canvas");
    c.width = L.W;
    c.height = L.H;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    const sc = sceneOf(doc.shared);
    drawCover(g, src.scene, L.W, L.H, sc.zoom, sc.dx, sc.dy);
    const box = drawProduct(document.createElement("canvas").getContext("2d")!, src.product, L.product, { ...doc.shared.product, fx: undefined });
    const b = box ?? L.product;
    const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
    const w = Math.max(1, Math.min(L.W - x, Math.ceil(b.w))), h = Math.max(1, Math.min(L.H - y, Math.ceil(b.h)));
    const scene = colorStats(g.getImageData(x, y, w, h).data);
    const k = Math.min(1, 256 / Math.max(src.product.width, src.product.height));
    const pc = document.createElement("canvas");
    pc.width = Math.max(1, Math.round(src.product.width * k));
    pc.height = Math.max(1, Math.round(src.product.height * k));
    const pg = pc.getContext("2d", { willReadFrequently: true })!;
    pg.drawImage(src.product, 0, 0, pc.width, pc.height);
    const prod = colorStats(pg.getImageData(0, 0, pc.width, pc.height).data);
    return matchColor(prod, scene, strength);
  } catch {
    return null;
  }
}

/** 누끼 이미지에서 투명하지 않은 부분의 범위 (0~1 비율). 계산할 수 없으면 전체 */
const alphaCache = new WeakMap<object, Box>();
function alphaBounds(img: NonNullable<Sources["product"]>): Box {
  const hit = alphaCache.get(img);
  if (hit) return hit;
  let out: Box = { x: 0, y: 0, w: 1, h: 1 };
  try {
    const k = Math.min(1, 256 / Math.max(img.width, img.height));
    const cw = Math.max(1, Math.round(img.width * k));
    const ch = Math.max(1, Math.round(img.height * k));
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, cw, ch);
    const d = g.getImageData(0, 0, cw, ch).data;
    let minX = cw, minY = ch, maxX = -1, maxY = -1;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      if (d[(y * cw + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX >= minX && maxY >= minY) out = { x: minX / cw, y: minY / ch, w: (maxX - minX + 1) / cw, h: (maxY - minY + 1) / ch };
  } catch {
    /* 읽을 수 없는 이미지면 전체 범위로 본다 */
  }
  alphaCache.set(img, out);
  return out;
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

  const sc = sceneOf(doc.shared);
  drawCover(ctx, src.scene, L.W, L.H, sc.zoom, sc.dx, sc.dy);
  overlay(ctx, L.W, L.H, L.overlaySide, doc.shared.overlay, doc.shared.textColor === "#ffffff");
  // 제품 누끼는 글자 뒤 띠 위에 그리도록 글자 위치를 정한 뒤에 그린다
  let productBox: Box | null = null;

  const measure = (weight: number) => (t: string, s: number) => {
    ctx.font = font(weight, s);
    return ctx.measureText(t).width;
  };
  const square = sizeShape(size) === "square";
  const center = square && (doc.shared.copySpace === "위" || doc.shared.copySpace === "아래");
  ctx.textAlign = center ? "center" : "left";
  const tx = center ? L.text.x + L.text.w / 2 : L.text.x;
  /** 글자 한 줄이 차지하는 사각형 (겹침 점검용) */
  const lineBox = (t: string, weight: number, s: number, y: number, lh: number): Box => {
    const w = measure(weight)(t, s);
    return { x: center ? tx - w / 2 : tx, y, w, h: s * lh };
  };
  const placed: Placed[] = [];

  // 버튼 크기 (띠 배너는 오른쪽에 따로). 화살표를 켜면 문구 뒤에 붙인다
  const ctaLabel = copy.ctaArrow ? `${copy.cta}  ›` : copy.cta;
  ctx.font = font(WEIGHT.semibold, L.cta.size);
  const ctaW = ctx.measureText(ctaLabel).width + L.cta.padX * 2;
  const ctaH = L.cta.size + L.cta.padY * 2;
  const textBox = L.buttonInline ? { ...L.text, w: L.text.w } : { ...L.text, h: L.text.h - ctaH - L.cta.size };

  // 리드 문구: 헤드라인 위 작은 한 줄 (띠 배너에는 넣지 않음)
  const leadText = !L.buttonInline && L.showSub ? (copy.lead ?? "").trim() : "";
  const lead: Fit | null = leadText ? fitText(leadText, textBox, { maxLines: 1, start: L.sub.start, min: L.sub.min, lineHeight: 1.3 }, measure(WEIGHT.semibold)) : null;
  if (lead?.overflow) note("error", "리드 문구가 한 줄을 넘칩니다 (더 짧게)");
  const leadH = lead ? lead.size * 1.3 + lead.size * 0.35 : 0;
  const headBox = { ...textBox, h: Math.max(0, textBox.h - leadH) };

  const head: Fit = fitText(copy.headline, headBox, { ...L.headline, lineHeight: 1.22 }, measure(WEIGHT.extrabold));
  const subBox = { w: textBox.w, h: Math.max(0, headBox.h - head.lines.length * head.size * 1.22 - head.size * 0.4) };
  const sub: Fit | null = L.showSub && copy.sub.trim() ? fitText(copy.sub, subBox, { ...L.sub, lineHeight: 1.35 }, measure(WEIGHT.regular)) : null;
  if (head.overflow) note("error", "헤드라인이 영역을 넘칩니다 (문구 잘림). 더 짧게 쓰세요");
  else if (head.brokeWord) note("warning", "헤드라인 어절이 중간에서 줄바꿈됩니다");
  if (sub?.overflow) note("error", "서브카피가 영역을 넘칩니다 (문구 잘림)");

  // 글자 덩어리 전체 높이를 구해 영역 안에서 세로 정렬 (위·왼쪽은 위부터, 아래는 아래부터)
  const blockH = leadH + head.lines.length * head.size * 1.22 + (sub ? head.size * 0.4 + sub.lines.length * sub.size * 1.35 : 0) + (L.buttonInline ? 0 : L.cta.size + ctaH);
  let y = L.buttonInline ? L.text.y + (L.text.h - head.lines.length * head.size * 1.22) / 2 : doc.shared.copySpace === "아래" && square ? L.text.y + L.text.h - blockH : L.text.y;

  // 글자 뒤 띠: 글자 덩어리가 있는 쪽 가장자리까지 덮는다 (띠 배너는 너무 작아 쓰지 않음)
  const band = Math.max(0, Math.min(0.9, doc.shared.band ?? 0));
  if (band > 0 && !L.buttonInline) {
    const pad = Math.round(Math.min(L.W, L.H) * 0.04);
    ctx.fillStyle = doc.shared.textColor === "#ffffff" ? `rgba(0,0,0,${band})` : `rgba(255,255,255,${band})`;
    const side = L.overlaySide;
    if (side === "아래") ctx.fillRect(0, Math.max(0, y - pad), L.W, L.H);
    else if (side === "위") ctx.fillRect(0, 0, L.W, Math.min(L.H, y + blockH + pad));
    else if (side === "왼쪽") ctx.fillRect(0, 0, Math.min(L.W, L.text.x + L.text.w + pad), L.H);
    else ctx.fillRect(Math.max(0, L.text.x - pad), 0, L.W, L.H);
  }
  productBox = src.product && doc.shared.product ? drawProduct(ctx, src.product, L.product, doc.shared.product) : null;
  if (productBox) productFrames.set(canvas, { box: productBox, area: L.product });
  else productFrames.delete(canvas);

  ctx.fillStyle = doc.shared.textColor;
  ctx.shadowColor = doc.shared.textColor === "#ffffff" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.35)";
  ctx.shadowBlur = Math.round(head.size * 0.12);
  if (lead) {
    ctx.font = font(WEIGHT.semibold, lead.size);
    ctx.fillText(lead.lines[0] ?? "", tx, y);
    placed.push({ what: "리드 문구", box: lineBox(lead.lines[0] ?? "", WEIGHT.semibold, lead.size, y, 1.3) });
    y += leadH;
  }
  ctx.font = font(WEIGHT.extrabold, head.size);
  for (const line of head.lines) {
    ctx.font = font(WEIGHT.extrabold, head.size);
    ctx.fillText(line, tx, y);
    placed.push({ what: "헤드라인", box: lineBox(line, WEIGHT.extrabold, head.size, y, 1.22) });
    y += head.size * 1.22;
  }
  if (sub) {
    y += head.size * 0.4;
    ctx.fillStyle = copy.subColor || doc.shared.textColor;
    for (const line of sub.lines) {
      ctx.font = font(WEIGHT.regular, sub.size);
      ctx.fillText(line, tx, y);
      placed.push({ what: "서브카피", box: lineBox(line, WEIGHT.regular, sub.size, y, 1.35) });
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
  ctx.fillText(ctaLabel, bx + ctaW / 2, by + L.cta.padY);
  placed.push({ what: "버튼", box: { x: bx, y: by, w: ctaW, h: ctaH } });

  // 로고 (원본 파일 그대로)
  if (src.logo && doc.shared.logo && L.logo.h > 0) {
    const h = L.logo.h * doc.shared.logo.scale;
    const w = (src.logo.width / src.logo.height) * h;
    const c = doc.shared.logo.corner;
    const lx = c.endsWith("l") ? L.logo.margin : L.W - L.logo.margin - w;
    const ly = c.startsWith("t") ? L.logo.margin : L.H - L.logo.margin - h;
    ctx.drawImage(src.logo, lx, ly, w, h);
    placed.push({ what: "로고", box: { x: lx, y: ly, w, h } });
  }

  // 겹침: 제품이 문구·버튼·로고를 가리거나, 로고가 문구에 닿는지 (디자인 판단은 사람이 하고 여기서는 알려만 준다)
  for (const o of overlapIssues(productBox, placed)) note("warning", o);
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

/** 합성에 쓰는 이미지(배경·누끼·로고)를 저장소에서 읽는다. 로고를 못 읽으면 로고 없이 */
export async function loadComposeSources(readBlob: (file: string) => Promise<Blob | null>, doc: ComposeDoc): Promise<Sources> {
  const img = async (f: string) => {
    const b = await readBlob(f);
    if (!b) throw new Error(`파일이 없습니다: ${f}`);
    return blobToImage(b);
  };
  return {
    scene: await img(doc.shared.image),
    product: doc.shared.product ? await img(doc.shared.product.file) : undefined,
    logo: doc.shared.logo ? await img(doc.shared.logo.file).catch(() => undefined) : undefined,
  };
}
