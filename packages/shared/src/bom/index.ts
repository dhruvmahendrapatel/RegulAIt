/**
 * ADR-0189 (batch 6 item 2) — the Decision BOM and AI BOM (shared). See contract.ts.
 */
export * from "./contract.js";
export * from "./finality.js";
export * from "./settings.js";
// slice B4 API contract (frozen for B6; B4 implements it exactly)
export * from "./contract-b4.js";
// slice B3: the AI BOM record set, builder, CycloneDX renderer and validator
export * from "./ai-bom-records.js";
export * from "./ai-bom-cyclonedx.js";
export * from "./ai-bom-cyclonedx-schema.js";
export * from "./ai-bom-builder.js";
