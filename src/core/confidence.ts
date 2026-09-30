import type { ConfidenceThresholds, FieldConfig, ParserConfig } from "../schema/config.js";
import type { FieldDecisions, FieldResult } from "../schema/product.js";

export type ConfidenceAction = "accept" | "tool" | "reject";

export function thresholdsFor(config: ParserConfig, fieldName: string): ConfidenceThresholds {
  return { ...config.confidence, ...(config.fields[fieldName]?.confidence ?? {}) };
}

export function confidenceAction(confidence: number, ambiguous: boolean, thresholds: ConfidenceThresholds): ConfidenceAction {
  const bounded = clamp(confidence);
  if (ambiguous) return "tool";
  if (bounded >= thresholds.autoAccept) return "accept";
  if (bounded >= thresholds.requireTool) return "tool";
  return "reject";
}

export function sanitizeFieldResult(value: unknown, fieldName: string, definition: FieldConfig | undefined, config: ParserConfig): FieldResult<unknown> {
  const candidate = value && typeof value === "object" ? value as Partial<FieldResult<unknown>> : {};
  const confidence = typeof candidate.confidence === "number" ? clamp(candidate.confidence) : 0;
  const source = isSource(candidate.source) ? candidate.source : "inferred";
  const ambiguous = candidate.ambiguous === true;
  const action = confidenceAction(confidence, ambiguous, thresholdsFor(config, fieldName));
  return {
    value: action === "reject" ? null : candidate.value ?? null,
    confidence,
    source,
    ambiguous
  };
}

export function overallConfidence(decisions: FieldDecisions): number {
  const populated = Object.values(decisions).filter((decision) => decision.value !== null && decision.value !== undefined);
  if (populated.length === 0) return 0;
  const score = populated.reduce((total, decision) => total + (decision.ambiguous ? Math.min(decision.confidence, 0.49) : decision.confidence), 0) / populated.length;
  return Number(score.toFixed(4));
}

export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isSource(value: unknown): value is FieldResult<unknown>["source"] {
  return value === "explicit" || value === "normalized" || value === "catalog" || value === "inferred" || value === "tool";
}
