/** 빌드할 때 vite.config.ts 가 넣는 버전 정보 (테스트 등 빌드 밖에서는 기본값) */
declare const __BUILD_INFO__: { version: string; builtAt: string; commit: string } | undefined;

export const BUILD = typeof __BUILD_INFO__ !== "undefined" && __BUILD_INFO__ ? __BUILD_INFO__ : { version: "dev", builtAt: "", commit: "" };

/** 제목 옆 표시: v0.6.0 · 2026-11-14 01:30 · bb184bc */
/** 제목 옆에 보이는 짧은 표시: 버전만 */
export const buildLabel = () => `v${BUILD.version}`;
/** 자세한 빌드 정보 (마우스를 올렸을 때, 도움말 화면): 버전 · 빌드 시각 · 커밋 */
export const buildDetail = () => [`v${BUILD.version}`, BUILD.builtAt, BUILD.commit].filter(Boolean).join(" · ");
