import { SupplierTimeoutError } from "./errors.ts";

export interface BoundedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

export function createBoundedAbortSignal(
  parentSignal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): BoundedAbortSignal {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new SupplierTimeoutError(timeoutMessage)),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", forwardAbort);
    },
  };
}
