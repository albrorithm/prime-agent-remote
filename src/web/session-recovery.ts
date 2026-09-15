import { SESSION_RECOVERY_DELAYS_MS } from "../protocol";
import { ApiError } from "./api";

function pause(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Only for reads whose failure explicitly identifies temporary recovery. */
export async function retrySessionRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await read(); } catch (error) {
      const delay = SESSION_RECOVERY_DELAYS_MS[attempt];
      if (!(error instanceof ApiError) || error.status !== 503
        || error.code !== "session_recovering" || delay === undefined) throw error;
      await pause(delay, signal);
    }
  }
}
