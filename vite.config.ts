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

/**
 * Cloudflare Pages 는 파일 하나가 25MiB 까지라, 25.6MiB 인 wasm 은 jsDelivr 의 같은 버전(바이트 동일)에서 받는다.
 * (로더 .mjs 는 작아서 이 사이트에 둔다. GitHub Pages 빌드는 wasm 도 이 사이트에 둔다)
 */
const ORT_VERSION: string = JSON.parse(fs.readFileSync(path.join(ORT_DIR, "..", "package.json"), "utf8")).version;
const ortCdnFor = (mode: string) => (mode === "cloudflare" ? `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/` : "");

function ortFiles(cdn: string): Plugin {
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
    generateBundle(_opts, bundle) {
      // transformers.js 가 끌어온 wasm 사본(assets/)은 쓰지 않는다 (wasmPaths 로 ort/ 를 쓰게 함)
      for (const k of Object.keys(bundle)) if (/^assets\/ort-wasm.*\.wasm$/.test(k)) delete bundle[k];
      for (const name of ORT_FILES.filter((n) => !(cdn && n.endsWith(".wasm")))) this.emitFile({ type: "asset", fileName: `ort/${name}`, source: fs.readFileSync(path.join(ORT_DIR, name)) });
    },
  };
}

/**
 * 배포본에만 콘텐츠 보안 정책(CSP)을 넣는다. 개발 서버는 인라인 스크립트를 쓰므로 제외.
 * - 스크립트는 이 사이트 것만 실행 (외부 스크립트 없음: 브라우저에 저장한 키 보호)
 * - 네트워크는 LLM API(Anthropic·OpenAI·Gemini), 로컬 브리지(127.0.0.1/localhost), Figma API·이미지,
 *   누끼 모델(Hugging Face) 만 허용
 */
function csp(extraConnect: string[]): Plugin {
  const policy = [
    "default-src 'self'",
    // wasm-unsafe-eval: 누끼 모델 실행(WebAssembly 컴파일)에 필요. 외부 스크립트는 여전히 금지
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com http://127.0.0.1:* http://localhost:* https://api.figma.com https://*.figma.com https://figma-alpha-api.s3.us-west-2.amazonaws.com https://huggingface.co https://*.huggingface.co https://*.hf.co" + extraConnect.map((u) => ` ${u}`).join(""),
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

export default defineConfig(({ mode }) => {
  const ortCdn = ortCdnFor(mode);
  return {
    // 기본은 상대 경로: Cloudflare Pages(루트), GitHub Pages(/ad-agent/), irodmas.com/<강좌>/ 어디에 올려도 동작한다 (해시 라우터라 페이지는 index.html 하나)
    base: process.env.BASE_PATH ?? "./",
    plugins: [react(), csp(ortCdn ? ["https://cdn.jsdelivr.net"] : []), ortFiles(ortCdn)],
    define: { __ORT_WASM_BASE__: JSON.stringify(ortCdn) },
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
    server: { port: 5173, strictPort: true },
    build: { outDir: "dist", sourcemap: false },
  };
});
