/**
 * 제품 누끼 합성 보정 (값만 저장하는 비파괴 방식. 원본 사진 파일은 바꾸지 않는다).
 * 배경과 제품이 따로 놀아 보일 때: 그림자, 색·밝기 맞춤, 가장자리 부드럽게, 회전·반전.
 * 색 보정 범위는 제한하지 않는다 (사용자 결정 2026-11-22). 적용한 값은 검수 자료에 남긴다.
 * 여기 함수는 DOM 없이 픽셀 배열만 다룬다 (테스트 가능).
 */

export type ShadowKind = "none" | "ground" | "drop";

export interface ProductFx {
  /** 회전 (도, -180~180) */
  rotate: number;
  /** 좌우 반전 */
  flip: boolean;
  shadow: {
    kind: ShadowKind;
    /** 그림자 방향 (도. 0 = 오른쪽, 90 = 아래) */
    angle: number;
    /** 거리 (제품 높이 대비 0~0.5) */
    distance: number;
    /** 흐림 (제품 높이 대비 0~0.3) */
    blur: number;
    /** 진하기 0~1 */
    opacity: number;
  };
  /** 색 보정 (각 -100~100, 0 = 그대로) */
  color: { brightness: number; contrast: number; saturation: number; warmth: number };
  /** 가장자리 부드럽게 (제품 짧은 변 대비 0~0.1) */
  feather: number;
}

export const DEFAULT_FX: ProductFx = {
  rotate: 0,
  flip: false,
  shadow: { kind: "none", angle: 90, distance: 0.04, blur: 0.06, opacity: 0.45 },
  color: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
  feather: 0,
};

/** 예전 명세(보정 없음)도 읽는다 */
export function fxOf(p: { fx?: Partial<ProductFx> } | null | undefined): ProductFx {
  const f = p?.fx ?? {};
  return {
    rotate: f.rotate ?? 0,
    flip: !!f.flip,
    shadow: { ...DEFAULT_FX.shadow, ...(f.shadow ?? {}) },
    color: { ...DEFAULT_FX.color, ...(f.color ?? {}) },
    feather: f.feather ?? 0,
  };
}

export const colorIsNeutral = (c: ProductFx["color"]) => !c.brightness && !c.contrast && !c.saturation && !c.warmth;

/** 사람이 읽는 보정 요약 (검수 자료·명세용). 보정이 없으면 빈 문자열 */
export function fxSummary(fx: ProductFx): string {
  const out: string[] = [];
  const c = fx.color;
  const sign = (n: number) => (n > 0 ? `+${Math.round(n)}` : `${Math.round(n)}`);
  if (c.brightness) out.push(`밝기 ${sign(c.brightness)}`);
  if (c.contrast) out.push(`대비 ${sign(c.contrast)}`);
  if (c.saturation) out.push(`채도 ${sign(c.saturation)}`);
  if (c.warmth) out.push(`색온도 ${c.warmth > 0 ? "따뜻하게" : "차갑게"} ${sign(c.warmth)}`);
  if (fx.rotate) out.push(`회전 ${Math.round(fx.rotate)}°`);
  if (fx.flip) out.push("좌우 반전");
  if (fx.feather > 0) out.push("가장자리 부드럽게");
  if (fx.shadow.kind !== "none") out.push(fx.shadow.kind === "ground" ? "바닥 그림자" : "드롭 그림자");
  return out.join(", ");
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** RGBA 픽셀에 색 보정을 그대로 적용한다 (알파는 건드리지 않음) */
export function applyColor(data: Uint8ClampedArray, c: ProductFx["color"]): void {
  if (colorIsNeutral(c)) return;
  const b = 1 + c.brightness / 100;
  const k = 1 + c.contrast / 100;
  const s = 1 + c.saturation / 100;
  const w = c.warmth * 0.4;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    let r = data[i] * b;
    let g = data[i + 1] * b;
    let bl = data[i + 2] * b;
    r = (r - 128) * k + 128;
    g = (g - 128) * k + 128;
    bl = (bl - 128) * k + 128;
    const l = 0.299 * r + 0.587 * g + 0.114 * bl;
    r = l + (r - l) * s + w;
    g = l + (g - l) * s;
    bl = l + (bl - l) * s - w;
    data[i] = clamp255(r);
    data[i + 1] = clamp255(g);
    data[i + 2] = clamp255(bl);
  }
}

/** 알파를 안쪽으로 부드럽게: 흐린 알파와 원래 알파를 곱한다 (바깥으로 번지지 않음) */
export function featherAlpha(data: Uint8ClampedArray, w: number, h: number, radius: number): void {
  const r = Math.round(radius);
  if (r < 1) return;
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = data[i * 4 + 3];
  const tmp = new Float32Array(w * h);
  // 가로·세로 상자 흐림 두 번 (가우스에 가깝게)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const row = y * w;
      for (let x = 0; x <= r && x < w; x++) sum += a[row + x];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / (2 * r + 1);
        const out = x - r;
        const inn = x + r + 1;
        if (out >= 0) sum -= a[row + out];
        if (inn < w) sum += a[row + inn];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = 0; y <= r && y < h; y++) sum += tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / (2 * r + 1);
        const out = y - r;
        const inn = y + r + 1;
        if (out >= 0) sum -= tmp[out * w + x];
        if (inn < h) sum += tmp[inn * w + x];
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    // 가장자리에서 안쪽으로 radius 만큼 서서히 투명해진다 (바깥은 원래 0이라 번지지 않음)
    const m = Math.min(1, a[i] / 255);
    data[i * 4 + 3] = Math.round(data[i * 4 + 3] * m);
  }
}

export interface ColorStats {
  /** 평균 밝기 0~255 */
  lum: number;
  /** 평균 채도 (최대-최소) 0~255 */
  sat: number;
  /** 평균 (빨강 - 파랑) */
  warm: number;
  n: number;
}

/** 불투명한 픽셀의 평균 색 통계 */
export function colorStats(data: Uint8ClampedArray): ColorStats {
  let lum = 0, sat = 0, warm = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    lum += 0.299 * r + 0.587 * g + 0.114 * b;
    sat += Math.max(r, g, b) - Math.min(r, g, b);
    warm += r - b;
    n++;
  }
  return n ? { lum: lum / n, sat: sat / n, warm: warm / n, n } : { lum: 128, sat: 0, warm: 0, n: 0 };
}

/**
 * 배경에 자동 맞춤: 제품 통계를 배경(제품이 놓인 자리) 쪽으로 strength 만큼 당기는 보정값.
 * 제품을 알아볼 수 있게 기본은 절반만 당긴다. 결과는 슬라이더에 넣고 사람이 더 고친다.
 */
export function matchColor(product: ColorStats, scene: ColorStats, strength = 0.5): ProductFx["color"] {
  const r = (n: number) => Math.round(n);
  const brightness = product.lum > 1 ? ((scene.lum / product.lum) - 1) * 100 * strength : 0;
  const saturation = product.sat > 1 ? ((scene.sat / product.sat) - 1) * 100 * strength : 0;
  const warmth = ((scene.warm - product.warm) * strength) / 0.8;
  const lim = (n: number) => Math.max(-100, Math.min(100, n));
  return { brightness: r(lim(brightness)), contrast: 0, saturation: r(lim(saturation)), warmth: r(lim(warmth)) };
}

/** 회전한 사각형을 감싸는 사각형 */
export function rotatedBounds(b: { x: number; y: number; w: number; h: number }, cx: number, cy: number, deg: number) {
  if (!deg) return b;
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t);
  const pts = [
    [b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
  ].map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
