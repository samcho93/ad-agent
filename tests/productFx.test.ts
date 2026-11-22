import { describe, expect, it } from "vitest";
import { DEFAULT_FX, applyColor, colorStats, featherAlpha, fxOf, fxSummary, matchColor, rotatedBounds } from "@/core/productFx";
import { toComposeSpec, type ComposeDoc } from "@/core/compose";

const px = (...rgba: number[]) => new Uint8ClampedArray(rgba);

describe("제품 누끼 합성 보정", () => {
  it("예전 명세(보정 없음)는 기본값으로 읽고, 요약은 비어 있다", () => {
    const fx = fxOf({ file: "x", dx: 0, dy: 0, scale: 1 } as never);
    expect(fx).toEqual(DEFAULT_FX);
    expect(fxSummary(fx)).toBe("");
    expect(fxOf({ fx: { shadow: { kind: "ground" } } } as never).shadow.opacity).toBe(DEFAULT_FX.shadow.opacity);
  });

  it("색 보정: 0이면 그대로, 밝기·색온도는 방향대로, 투명 픽셀은 건드리지 않는다", () => {
    const d = px(100, 100, 100, 255, 10, 20, 30, 0);
    applyColor(d, { brightness: 0, contrast: 0, saturation: 0, warmth: 0 });
    expect([...d]).toEqual([100, 100, 100, 255, 10, 20, 30, 0]);
    applyColor(d, { brightness: 50, contrast: 0, saturation: 0, warmth: 0 });
    expect([...d.slice(0, 3)]).toEqual([150, 150, 150]);
    expect([...d.slice(4)]).toEqual([10, 20, 30, 0]);
    const w = px(100, 100, 100, 255);
    applyColor(w, { brightness: 0, contrast: 0, saturation: 0, warmth: 50 });
    expect(w[0]).toBeGreaterThan(100);
    expect(w[2]).toBeLessThan(100);
    // 제한 없음: 끝값도 받아들이고 0~255 안에서 자른다
    const g = px(200, 50, 50, 255);
    applyColor(g, { brightness: 100, contrast: 100, saturation: -100, warmth: 100 });
    expect([...g].every((v) => v >= 0 && v <= 255)).toBe(true);
  });

  it("가장자리 부드럽게: 안쪽 가운데는 불투명, 가장자리는 옅어지고, 바깥으로 번지지 않는다", () => {
    const w = 21, h = 21;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 5; y < 16; y++) for (let x = 5; x < 16; x++) d[(y * w + x) * 4 + 3] = 255;
    featherAlpha(d, w, h, 2);
    const a = (x: number, y: number) => d[(y * w + x) * 4 + 3];
    expect(a(10, 10)).toBe(255);
    expect(a(5, 10)).toBeLessThan(255);
    expect(a(5, 10)).toBeGreaterThan(0);
    expect(a(3, 10)).toBe(0);
  });

  it("배경에 자동 맞춤: 배경이 더 어둡고 따뜻하면 제품을 어둡고 따뜻하게 (절반만)", () => {
    const prod = colorStats(px(200, 200, 200, 255, 0, 0, 0, 0));
    expect(prod.n).toBe(1);
    const scene = { lum: 100, sat: 0, warm: 40, n: 1 };
    const c = matchColor(prod, scene);
    expect(c.brightness).toBe(-25);
    expect(c.warmth).toBe(25);
    expect(c.contrast).toBe(0);
    expect(matchColor(prod, scene, 1).brightness).toBe(-50);
  });

  it("회전한 제품의 겹침 점검 범위는 회전을 반영한다", () => {
    const b = rotatedBounds({ x: 0, y: 0, w: 100, h: 10 }, 50, 5, 90);
    expect(Math.round(b.w)).toBe(10);
    expect(Math.round(b.h)).toBe(100);
  });

  it("명세(compose_spec)와 요약에 적용한 보정이 남는다", () => {
    const doc = {
      shared: { product: { file: "p.png", dx: 0, dy: 0, scale: 1, fx: { ...DEFAULT_FX, flip: true, color: { ...DEFAULT_FX.color, warmth: 20 }, shadow: { ...DEFAULT_FX.shadow, kind: "ground" } } } },
      variants: { A: { headline: "", sub: "", cta: "", buttonBg: "", buttonFg: "" } },
    } as unknown as ComposeDoc;
    const spec = toComposeSpec("c", doc, "A");
    expect(spec.product?.fx.flip).toBe(true);
    expect(fxSummary(fxOf(doc.shared.product))).toBe("색온도 따뜻하게 +20, 좌우 반전, 바닥 그림자");
  });
});
