import { parseFigmaLink } from "@/core/images";

/**
 * Figma REST API로 프레임을 PNG로 받는다 (읽기 전용, 사용자 개인 토큰).
 * api.figma.com 은 브라우저 요청(CORS)을 허용한다. 렌더링된 이미지는 임시 주소로 오며 바로 받아 저장해야 한다.
 *
 * 이미지 렌더링(GET image)은 가장 엄격한 Tier 1 한도에 묶인다. Starter(무료) 플랜의 View·Collab 좌석은
 * 한 달 몇 회 수준이라, 한도에 걸리면 "PNG로 복사해 붙여넣기 / 내보내 직접 올리기"를 안내한다.
 * https://developers.figma.com/docs/rest-api/rate-limits
 */
export class FigmaError extends Error {}

const ALTERNATIVE = "Figma에서 프레임을 고르고 Ctrl+Shift+C(PNG로 복사) 후 아래 붙여넣기 칸에 Ctrl+V 하거나, PNG로 내보내 '직접 올리기'를 쓰세요. 이 방법은 API 한도를 쓰지 않습니다.";

function humanDuration(sec: number): string {
  if (sec >= 86400) return `약 ${Math.ceil(sec / 86400)}일`;
  if (sec >= 3600) return `약 ${Math.ceil(sec / 3600)}시간`;
  if (sec >= 60) return `약 ${Math.ceil(sec / 60)}분`;
  return `${Math.max(1, Math.ceil(sec))}초`;
}

/** 429 응답의 헤더(Retry-After, X-Figma-*)로 정확한 안내 문구를 만든다 */
export function describeFigmaRateLimit(headers: Headers): string {
  const retry = Number(headers.get("retry-after"));
  const type = headers.get("x-figma-rate-limit-type"); // Figma가 알려 주는 한도 종류 (값은 그대로 보여 준다)
  const tier = headers.get("x-figma-plan-tier"); // Figma가 알려 주는 플랜 등급
  const upgrade = headers.get("x-figma-upgrade-link");
  const parts: string[] = [];
  const longWait = Number.isFinite(retry) && retry >= 3600;
  if (longWait) parts.push(`Figma 이미지 API 한도를 다 썼습니다. ${humanDuration(retry)} 뒤에 다시 쓸 수 있습니다`);
  else if (Number.isFinite(retry) && retry > 0) parts.push(`Figma 요청 한도에 걸렸습니다. ${humanDuration(retry)} 뒤에 다시 시도하세요`);
  else parts.push("Figma 요청 한도에 걸렸습니다");
  const info = [tier && `플랜: ${tier}`, type && `한도 종류: ${type}`].filter(Boolean);
  if (info.length) parts.push(`(${info.join(", ")})`);
  parts.push(ALTERNATIVE);
  if (upgrade && longWait) parts.push(`한도를 늘리려면: ${upgrade}`);
  return parts.join(" ");
}

export async function fetchFigmaFramePng(token: string, link: string, scale = 2): Promise<{ blob: Blob; fileKey: string; nodeId: string }> {
  // 링크부터 확인한다 (네트워크 없이 바로 알려 줄 수 있는 문제)
  const { fileKey, nodeId } = parseFigmaLink(link);
  if (!token) throw new FigmaError(`Figma 개인 액세스 토큰이 없습니다. 설정 > 외부 디자인 도구에서 입력하세요. 토큰 없이 쓰려면: ${ALTERNATIVE}`);
  const url = `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-Figma-Token": token } });
  } catch {
    throw new FigmaError("Figma API에 연결하지 못했습니다 (네트워크 확인)");
  }
  if (res.status === 429) throw new FigmaError(describeFigmaRateLimit(res.headers));
  if (res.status === 403) throw new FigmaError("Figma 토큰이 올바르지 않거나 이 파일을 볼 권한이 없습니다");
  if (res.status === 404) throw new FigmaError("Figma 파일을 찾을 수 없습니다 (링크 확인)");
  const j = (await res.json().catch(() => ({}))) as { err?: string | null; images?: Record<string, string | null> };
  if (!res.ok || j.err) throw new FigmaError(`Figma 오류 (${res.status}): ${j.err ?? "알 수 없음"}`);
  const imgUrl = j.images?.[nodeId];
  if (!imgUrl) throw new FigmaError("이 프레임을 이미지로 만들 수 없습니다 (빈 프레임이거나 보이지 않는 레이어)");
  let img: Response;
  try {
    img = await fetch(imgUrl);
  } catch {
    throw new FigmaError(`Figma가 만든 이미지를 받지 못했습니다. ${ALTERNATIVE}`);
  }
  if (!img.ok) throw new FigmaError(`Figma 이미지 다운로드 실패 (${img.status})`);
  const blob = await img.blob();
  return { blob: blob.type ? blob : new Blob([blob], { type: "image/png" }), fileKey, nodeId };
}
