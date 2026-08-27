import { describe, expect, it } from "vitest";
import { isPrimeWebGatewayResponse } from "./gateway-identity.js";

const REAL_BODY = { type: "about:blank", title: "Authentication required", status: 401 };

describe("isPrimeWebGatewayResponse", () => {
  it("recognises the gateway's own unauthenticated bootstrap response", () => {
    expect(isPrimeWebGatewayResponse(401, "application/json; charset=utf-8", REAL_BODY)).toBe(true);
  });

  it("rejects a 200, even with the same body", () => {
    expect(isPrimeWebGatewayResponse(200, "application/json; charset=utf-8", REAL_BODY)).toBe(false);
  });

  it("rejects a non-JSON content type", () => {
    expect(isPrimeWebGatewayResponse(401, "text/plain", REAL_BODY)).toBe(false);
  });

  it("rejects a missing content type", () => {
    expect(isPrimeWebGatewayResponse(401, null, REAL_BODY)).toBe(false);
  });

  it("rejects a body some other server might plausibly send", () => {
    expect(isPrimeWebGatewayResponse(401, "application/json", { message: "Unauthorized" })).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(isPrimeWebGatewayResponse(401, "application/json", "Unauthorized")).toBe(false);
    expect(isPrimeWebGatewayResponse(401, "application/json", null)).toBe(false);
  });
});
