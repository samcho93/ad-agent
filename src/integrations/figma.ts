import { parseFigmaLink } from "@/core/images";

/**
 * Figma REST API로 프레임을 PNG로 받는다 (읽기 전용, 사용자 개인 토큰).
 * api.figma.com 은 브라우저 요청(CORS)을 허용한다. 렌더링된 이미지는 임시 주소로 오며 바로 받아 저장해야 한다.
 */
export class FigmaError extends Error {}

export async function fetchFigmaFramePng(token: string, link: string, scale = 2): Promise<{ blob: Blob; fileKey: string; nodeId: string }> {
  if (!token) throw new FigmaError("Figma 개인 액세스 토큰이 없습니다. 설정 > 외부 디자인 도구에서 입력하세요");
  const { fileKey, nodeId } = parseFigmaLink(link);
  const url = `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-Figma-Token": token } });
  } catch {
    throw new FigmaError("Figma API에 연결하지 못했습니다 (네트워크 확인)");
  }
  if (res.status === 403) throw new FigmaError("Figma 토큰이 올바르지 않거나 이 파일을 볼 권한이 없습니다");
  if (res.status === 404) throw new FigmaError("Figma 파일을 찾을 수 없습니다 (링크 확인)");
  if (res.status === 429) throw new FigmaError("Figma 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요");
  const j = (await res.json().catch(() => ({}))) as { err?: string | null; images?: Record<string, string | null> };
  if (!res.ok || j.err) throw new FigmaError(`Figma 오류 (${res.status}): ${j.err ?? "알 수 없음"}`);
  const imgUrl = j.images?.[nodeId];
  if (!imgUrl) throw new FigmaError("이 프레임을 이미지로 만들 수 없습니다 (빈 프레임이거나 보이지 않는 레이어)");
  let img: Response;
  try {
    img = await fetch(imgUrl);
  } catch {
    throw new FigmaError("Figma가 만든 이미지를 받지 못했습니다. Figma에서 PNG로 내보낸 뒤 '직접 올리기'를 쓰세요");
  }
  if (!img.ok) throw new FigmaError(`Figma 이미지 다운로드 실패 (${img.status})`);
  const blob = await img.blob();
  return { blob: blob.type ? blob : new Blob([blob], { type: "image/png" }), fileKey, nodeId };
}
