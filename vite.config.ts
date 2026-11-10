import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * 배포본에만 콘텐츠 보안 정책(CSP)을 넣는다. 개발 서버는 인라인 스크립트를 쓰므로 제외.
 * - 스크립트는 이 사이트 것만 실행 (외부 스크립트 없음: 브라우저에 저장한 키 보호)
 * - 네트워크는 Anthropic API, 로컬 브리지(127.0.0.1/localhost), Figma API 만 허용
 */
function csp(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.anthropic.com http://127.0.0.1:* http://localhost:* https://api.figma.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "ad-agent-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig({
  // GitHub Pages(프로젝트 페이지)는 /<저장소 이름>/ 아래에 올라간다
  base: process.env.BASE_PATH ?? "/",
  plugins: [react(), csp()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: false },
});
