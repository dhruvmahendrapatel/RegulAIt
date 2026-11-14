/**
 * ADR-0302 decision 2 — decoding an OTLP/HTTP logs export (protobuf or OTLP/JSON) for the DefenseClaw ingest.
 *
 * The protobuf decoder is `protobufjs` (BSD-3-Clause, exact-pinned) over the OpenTelemetry project's own `.proto`
 * files, vendored verbatim in `otlp-logs-proto.ts` (Apache-2.0, tag v1.9.0) and parsed once at first use: nothing is
 * fetched, so an air-gapped gateway decodes exports. The mapping from a decoded request to records is the pure
 * `otlpLogsRequestToJsonl` in `@regulait/shared`, which hands every record to the JSONL parser, so the OTLP path has
 * exactly the JSONL path's validation, bounds and minimisation.
 */
import protobuf from "protobufjs";
import { ThirdPartyBatchRefused } from "@regulait/shared";
import { OTLP_LOGS_PROTO_FILES } from "./otlp-logs-proto.js";

export const OTLP_CONTENT_TYPES = { protobuf: "application/x-protobuf", json: "application/json" } as const;
export type OtlpEncoding = keyof typeof OTLP_CONTENT_TYPES;

let types: { request: protobuf.Type; response: protobuf.Type } | null = null;
function otlpTypes() {
  if (!types) {
    const root = new protobuf.Root();
    for (const [, src] of OTLP_LOGS_PROTO_FILES) protobuf.parse(src, root, { keepCase: false });
    root.resolveAll();
    types = {
      request: root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest"),
      response: root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse"),
    };
  }
  return types;
}

/** the request's encoding from its content type (parameters ignored), or null when it is neither OTLP encoding */
export function otlpEncodingOf(contentType: string | undefined): OtlpEncoding | null {
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (base === OTLP_CONTENT_TYPES.protobuf) return "protobuf";
  if (base === OTLP_CONTENT_TYPES.json) return "json";
  return null;
}

/** decode an `ExportLogsServiceRequest`; an undecodable body is refused as `invalid_encoding` */
export function decodeOtlpLogsRequest(body: Uint8Array, encoding: OtlpEncoding): unknown {
  try {
    if (encoding === "json") return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    const { request } = otlpTypes();
    return request.toObject(request.decode(body), { longs: String, enums: String, bytes: String, defaults: false });
  } catch {
    throw new ThirdPartyBatchRefused("invalid_encoding");
  }
}

/** the `ExportLogsServiceResponse` an OTLP exporter expects, in the request's encoding (partial success when any record was rejected) */
export function encodeOtlpLogsResponse(encoding: OtlpEncoding, rejected: number, message: string): { contentType: string; body: Buffer | string } {
  const payload = rejected > 0 ? { partialSuccess: { rejectedLogRecords: String(rejected), errorMessage: message.slice(0, 500) } } : {};
  if (encoding === "json") return { contentType: OTLP_CONTENT_TYPES.json, body: JSON.stringify(payload) };
  const { response } = otlpTypes();
  return { contentType: OTLP_CONTENT_TYPES.protobuf, body: Buffer.from(response.encode(response.fromObject(payload)).finish()) };
}

/** test helper and documentation of the wire shape: encode a request object as OTLP protobuf */
export function encodeOtlpLogsRequestForTest(request: Record<string, unknown>): Uint8Array {
  const { request: T } = otlpTypes();
  return T.encode(T.fromObject(request)).finish();
}

/** test helper: decode a protobuf `ExportLogsServiceResponse` */
export function decodeOtlpLogsResponseForTest(body: Uint8Array): Record<string, unknown> {
  const { response } = otlpTypes();
  return response.toObject(response.decode(body), { longs: String, defaults: false });
}
