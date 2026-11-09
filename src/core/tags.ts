/** 출처 태그. 렌더 형식: [1부 답 n번] / [AI 초안] / [사용자 결정] / [추정] */
export type Tag =
  | { kind: "intake"; qs: number[] }
  | { kind: "ai"; basedOn?: number[] }
  | { kind: "user" }
  | { kind: "estimate" };

export function renderTag(t: Tag): string {
  switch (t.kind) {
    case "intake":
      return `[1부 답 ${t.qs.join(", ")}번]`;
    case "ai":
      return t.basedOn && t.basedOn.length ? `[AI 초안, 1부 ${t.basedOn.join(", ")}번 기반]` : "[AI 초안]";
    case "user":
      return "[사용자 결정]";
    case "estimate":
      return "[추정]";
  }
}

export function renderTags(tags: Tag[]): string {
  return tags.map(renderTag).join(" ");
}

export function hasTag(tags: Tag[], kind: Tag["kind"]): boolean {
  return tags.some((t) => t.kind === kind);
}

export function withEstimate(tags: Tag[], estimated: boolean): Tag[] {
  if (!estimated || hasTag(tags, "estimate")) return tags;
  return [...tags, { kind: "estimate" }];
}

export const ESTIMATE_PREFIX = "추정: ";

export function markEstimated(content: string, estimated: boolean): string {
  if (!estimated) return content;
  return content.includes("추정") ? content : ESTIMATE_PREFIX + content;
}
