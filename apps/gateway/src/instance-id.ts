/**
 * ADR-0343 — one id per gateway process, so N replicas can be told apart.
 *
 * Used as the OpenTelemetry `service.instance.id` resource attribute (without it, N replicas' cumulative series
 * collide at the collector) and as the scheduler's lease owner. A random UUID per process, as the OpenTelemetry
 * semantic conventions recommend: a restart is a new instance, which is exactly what a cumulative counter needs.
 * It names no host, pod or person.
 */
import { randomUUID } from "node:crypto";

export const PROCESS_INSTANCE_ID: string = randomUUID();
