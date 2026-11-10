import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

/**
 * 누끼(Transformers.js)가 쓰는 ONNX 런타임 파일을 이 사이트에서 직접 제공한다.
 * 기본값은 외부 CDN 에서 스크립트를 받는데, CSP(외부 스크립트 금지)에 막히므로 복사해 둔다.
 */
const ORT_DIR = path.resolve(import.meta.dirname, "node_modules/onnxruntime-web/dist");
const ORT_FILES = ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];

function ortFiles(): Plugin {
  let base = "/";
  return {
    name: "ad-agent-ort-files",
    configResolved(c) {
      base = c.base;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const prefix = `${base}ort/`;
        if (!req.url?.startsWith(prefix)) return next();
        const name = req.url.slice(prefix.length).split("?")[0];
        if (!ORT_FILES.includes(name)) return next();
        res.setHeader("content-type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        fs.createReadStream(path.join(ORT_DIR, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of ORT_FILES) this.emitFile({ type: "asset", fileName: `ort/${name}`, source: fs.readFileSync(path.join(ORT_DIR, name)) });
    },
  };
}

/**
 * 배포본에만 콘텐츠 보안 정책(CSP)을 넣는다. 개발 서버는 인라인 스크립트를 쓰므로 제외.
 * - 스크립트는 이 사이트 것만 실행 (외부 스크립트 없음: 브라우저에 저장한 키 보호)
 * - 네트워크는 LLM API(Anthropic·OpenAI·Gemini), 로컬 브리지(127.0.0.1/localhost), Figma API·이미지,
 *   누끼 모델(Hugging Face) 만 허용
 */
function csp(): Plugin {
  const policy = [
    "default-src 'self'",
    // wasm-unsafe-eval: 누끼 모델 실행(WebAssembly 컴파일)에 필요. 외부 스크립트는 여전히 금지
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com http://127.0.0.1:* http://localhost:* https://api.figma.com https://*.figma.com https://figma-alpha-api.s3.us-west-2.amazonaws.com https://huggingface.co https://*.huggingface.co https://*.hf.co",
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
  plugins: [react(), csp(), ortFiles()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: false },
});
