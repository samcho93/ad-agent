import type { z } from "zod/v4";

export interface StructuredRequest<S extends z.ZodType> {
  purpose: string;
  system: string;
  user: string;
  schema: S;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  costUsd?: number;
}

/** LLM 연결 방식(API 키, CLI 브리지, 가짜)마다 이 모양으로 맞춘다 */
export type Generator = <S extends z.ZodType>(req: StructuredRequest<S>) => Promise<StructuredResult<z.infer<S>>>;

export class GenerationError extends Error {}
