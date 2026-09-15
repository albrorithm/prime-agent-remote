import { afterEach, expect, it, vi } from "vitest";
import { SESSION_RECOVERY_DELAYS_MS } from "../protocol";
import { ApiError } from "./api";
import { retrySessionRead } from "./session-recovery";

afterEach(() => vi.useRealTimers());

it("backs off on recovery, stops on success, and leaves no timer", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValueOnce(new ApiError(503, "Recovering", "session_recovering")).mockResolvedValue("snapshot");
  const result = retrySessionRead(read, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(499);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe("snapshot");
  expect(read).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds persistent recovery and never retries generic or terminal errors", async () => {
  vi.useFakeTimers();
  const error = new ApiError(503, "Recovering", "session_recovering");
  const read = vi.fn().mockRejectedValue(error);
  const result = retrySessionRead(read, new AbortController().signal).catch((failure) => failure);
  await vi.runAllTimersAsync();
  expect(await result).toBe(error);
  expect(read).toHaveBeenCalledTimes(1 + SESSION_RECOVERY_DELAYS_MS.length);
  expect(vi.getTimerCount()).toBe(0);
  for (const failure of [new ApiError(404, "Gone"), new ApiError(503, "Unavailable"), new Error("Offline")]) {
    const request = vi.fn().mockRejectedValue(failure);
    await expect(retrySessionRead(request, new AbortController().signal)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it("cancels a sleeping read without leaving a timer or making another request", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const read = vi.fn().mockRejectedValue(new ApiError(503, "Recovering", "session_recovering"));
  const result = retrySessionRead(read, controller.signal).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  expect(vi.getTimerCount()).toBe(0);
  expect(read).toHaveBeenCalledTimes(1);
});
