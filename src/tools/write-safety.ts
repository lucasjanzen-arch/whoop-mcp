import { randomUUID } from "node:crypto";

/**
 * Preview of a write operation that has NOT been executed.
 *
 * Returned when a write tool is called with `confirm: false`. The caller (an AI
 * assistant) can show the human exactly what would be written and ask for
 * confirmation before re-calling with `confirm: true` and the same
 * `idempotency_key`.
 */
export interface WritePreview<P> {
  readonly preview: true;
  /** UUID v4 echoed back on confirm to make retries idempotent. */
  readonly idempotency_key: string;
  /** Human-readable description of what would be written. */
  readonly summary: string;
  /** The exact payload that would be sent to the write endpoint. */
  readonly payload: P;
}

/**
 * Receipt for a write operation that HAS been executed.
 *
 * Returned when a write tool is called with `confirm: true`.
 */
export interface WriteReceipt<R> {
  readonly preview: false;
  /** Same key as the preview — lets the server dedupe retried writes. */
  readonly idempotency_key: string;
  /** The result returned by the underlying write operation. */
  readonly result: R;
}

/** Discriminated union over the `preview` flag. */
export type WriteResult<P, R> = WritePreview<P> | WriteReceipt<R>;

/** Options for {@link withPreview}. */
export interface WithPreviewOptions<P, R> {
  /** When `false`, return a preview; when `true`, execute the write. */
  confirm: boolean;
  /** Human-readable description of the write, surfaced in the preview. */
  summary: string;
  /** The payload that will be written. */
  payload: P;
  /** Performs the actual write. Receives the payload and the idempotency key. */
  write: (payload: P, idempotencyKey: string) => Promise<R>;
  /**
   * Reuse an existing idempotency key (e.g. the one from a prior preview) so a
   * retried confirm does not create a duplicate record. Generated when omitted.
   */
  idempotencyKey?: string;
}

/**
 * Wrap a write operation in a two-phase preview/confirm flow.
 *
 * - `confirm: false` → returns a {@link WritePreview} with a freshly generated
 *   `idempotency_key`. The write function is never invoked.
 * - `confirm: true` → invokes the write function and returns a
 *   {@link WriteReceipt} carrying the same `idempotency_key`.
 *
 * This is a generic utility, not a registered tool. It future-proofs the server
 * for WHOOP write endpoints without committing to any specific mutation today.
 */
export async function withPreview<P, R>(
  options: WithPreviewOptions<P, R>
): Promise<WriteResult<P, R>> {
  const idempotency_key = options.idempotencyKey ?? randomUUID();

  if (!options.confirm) {
    return {
      preview: true,
      idempotency_key,
      summary: options.summary,
      payload: options.payload,
    };
  }

  const result = await options.write(options.payload, idempotency_key);
  return {
    preview: false,
    idempotency_key,
    result,
  };
}
