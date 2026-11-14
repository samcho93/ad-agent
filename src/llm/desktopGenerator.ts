import { z } from "zod/v4";
import type { Effort } from "@/core/settings";
import { GenerationError, type Generator } from "./generator";
import { claudeCliResult } from "./bridgeGenerator";

/** 데스크톱 실행파일(electron/preload.cjs)이 화면에 열어 주는 창구 */
interface DesktopApi {
  version: number;
  claude: {
    check: (claudePath: string) => Promise<{ ok: true; path: string; version: string; core: string } | { ok: false; error: string }>;
    generate: (req: unknown) => Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }>;
  };
}

const api = (): DesktopApi | undefined => (globalThis as { adAgentDesktop?: DesktopApi }).adAgentDesktop;

/** 데스크톱 실행파일에서 열었는지 (웹판에서는 false) */
export const isDesktopApp = () => !!api()?.claude;

function need(): DesktopApi {
  const a = api();
  if (!a) throw new GenerationError("'이 PC의 Claude CLI'는 데스크톱 실행파일에서만 쓸 수 있습니다. 웹판에서는 Claude CLI 브리지를 쓰세요");
  return a;
}

export interface DesktopOptions {
  model: string;
  effort: Effort;
  /** 비우면 자동으로 찾는다 */
  claudePath: string;
}

/**
 * 데스크톱 실행파일: 브리지 없이 이 PC의 claude CLI 로 생성한다 (사용자의 Claude Code 로그인으로 실행).
 * 실행 코드는 브리지(bridge/bridge.mjs)와 같고, 결과도 같은 방식으로 검증한다.
 */
export function createDesktopGenerator(opts: DesktopOptions): Generator {
  return async (req) => {
    const r = await need().claude.generate({
      system: req.system,
      user: req.user,
      jsonSchema: z.toJSONSchema(req.schema, { target: "draft-7" }),
      ...(req.images?.length ? { images: req.images } : {}),
      model: opts.model,
      effort: opts.effort,
      claudePath: opts.claudePath,
    });
    if (!r.ok) throw new GenerationError(r.error);
    if (req.images?.length && r.result.images_seen !== req.images.length) throw new GenerationError("이미지를 함께 넘기지 못했습니다 (데스크톱 앱을 새 버전으로 바꿔 주세요)");
    return claudeCliResult(req, r.result, opts.model);
  };
}

/** 설정 화면의 "연결 확인" */
export async function checkDesktop(claudePath: string): Promise<string> {
  const r = await need().claude.check(claudePath);
  if (!r.ok) throw new GenerationError(r.error);
  return `연결됨 (${r.version}, ${r.path})`;
}
