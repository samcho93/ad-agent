/** 빌드할 때 vite.config.ts 가 넣는 버전 정보 (테스트 등 빌드 밖에서는 기본값) */
declare const __BUILD_INFO__: { version: string; builtAt: string; commit: string } | undefined;

export const BUILD = typeof __BUILD_INFO__ !== "undefined" && __BUILD_INFO__ ? __BUILD_INFO__ : { version: "dev", builtAt: "", commit: "" };

/** 제목 옆 표시: v0.6.0 · 2026-11-14 01:30 · bb184bc */
export const buildLabel = () => [`v${BUILD.version}`, BUILD.builtAt, BUILD.commit].filter(Boolean).join(" · ");
