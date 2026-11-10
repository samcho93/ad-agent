/**
 * Pretendard (SIL OFL 1.1) — 사이트에서 직접 제공한다. 합성 화면을 열 때만 받는다.
 * 라이선스: /licenses/Pretendard-OFL.txt
 */
import regular from "pretendard/dist/web/static/woff2/Pretendard-Regular.woff2?url";
import semibold from "pretendard/dist/web/static/woff2/Pretendard-SemiBold.woff2?url";
import extrabold from "pretendard/dist/web/static/woff2/Pretendard-ExtraBold.woff2?url";

export const FONT_FAMILY = "Pretendard";
export const WEIGHT = { regular: 400, semibold: 600, extrabold: 800 } as const;

let loading: Promise<void> | null = null;

export function loadFonts(): Promise<void> {
  loading ??= (async () => {
    const faces = [
      new FontFace(FONT_FAMILY, `url(${regular}) format("woff2")`, { weight: "400" }),
      new FontFace(FONT_FAMILY, `url(${semibold}) format("woff2")`, { weight: "600" }),
      new FontFace(FONT_FAMILY, `url(${extrabold}) format("woff2")`, { weight: "800" }),
    ];
    for (const f of await Promise.all(faces.map((f) => f.load()))) document.fonts.add(f);
  })().catch((e) => {
    loading = null;
    throw new Error(`Pretendard 폰트를 불러오지 못했습니다: ${e instanceof Error ? e.message : e}`);
  });
  return loading;
}
