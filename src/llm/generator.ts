import type { z } from "zod/v4";

/** 모델에 함께 보내는 이미지 (검수용). base64 는 data: 접두어 없이 */
export interface InputImage {
  label: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

export interface StructuredRequest<S extends z.ZodType> {
  purpose: string;
  system: string;
  user: string;
  schema: S;
  /** 이미지를 보고 판단해야 할 때만. 각 이미지 앞에 label 을 글로 붙여 보낸다 */
  images?: InputImage[];
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
