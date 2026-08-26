/**
 * How the gateway is reachable, and what that costs.
 *
 * The gateway itself only knows a bind address and an origin allowlist. The
 * decision of *which* to use is here, in one place, because it is the decision
 * that carries the security consequences and they should be stated once rather
 * than re-derived at each call site.
 */
export type ExposureMode = "tailscale" | "loopback" | "lan";

export interface ExposureInput {
  mode: ExposureMode;
  port: number;
  /** The tailnet DNS name, without the trailing dot. */
  tailscaleHost?: string;
  /** The mDNS name a phone can resolve on the same network, e.g. `host.local`. */
  localHostname?: string;
  /** True when the operator supplied a certificate a device already trusts. */
  tlsConfigured?: boolean;
}

export interface Exposure {
  mode: ExposureMode;
  /** What the gateway binds. Loopback unless LAN was asked for explicitly. */
  host: string;
  origins: string[];
  secureCookie: boolean;
  /** What to open on the phone. */
  url: string;
  /**
   * Things the operator must know and would otherwise discover as silent
   * breakage. Printed, never swallowed.
   */
  warnings: string[];
}

export class ExposureError extends Error {}

/**
 * A secure context is what the service worker, installability, push and the
 * app badge all depend on. `localhost` gets an exemption from browsers; a
 * private IP or an mDNS name over plain HTTP does not, so a LAN deployment
 * without a trusted certificate silently loses about half the product.
 */
const INSECURE_CONTEXT_WARNING =
  "Plain HTTP outside localhost is not a secure context: no installable app, no service worker, "
  + "no notifications, and no app badge. Supply a certificate the device already trusts to get them back.";

export function resolveExposure(input: ExposureInput): Exposure {
  const { mode, port } = input;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ExposureError(`Port must be between 1 and 65535, not ${port}`);
  }

  if (mode === "tailscale") {
    const host = input.tailscaleHost?.replace(/\.$/u, "");
    if (!host) {
      throw new ExposureError(
        "Tailscale did not report a name for this machine. Start Tailscale, or choose --loopback or --lan.",
      );
    }
    // Tailscale terminates TLS and forwards to loopback, so the gateway must
    // not bind anything wider: binding the tailnet interface as well would
    // expose the plain-HTTP port beside the HTTPS one.
    return {
      mode,
      host: "127.0.0.1",
      origins: [`https://${host}`],
      secureCookie: true,
      url: `https://${host}`,
      warnings: [],
    };
  }

  if (mode === "loopback") {
    return {
      mode,
      host: "127.0.0.1",
      origins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
      secureCookie: false,
      url: `http://127.0.0.1:${port}`,
      warnings: ["Reachable only from this machine. A phone on the same network cannot open it."],
    };
  }

  const localHostname = input.localHostname?.replace(/\.$/u, "");
  if (!localHostname) {
    throw new ExposureError("LAN mode needs a hostname this network can resolve. Could not determine one.");
  }
  const scheme = input.tlsConfigured ? "https" : "http";
  const url = `${scheme}://${localHostname}:${port}`;
  const warnings = [
    "LAN mode is experimental.",
    // An address is not an authorisation, and this is the one mode where the
    // gateway is reachable by anything that can route to it.
    "The gateway is reachable by every device on this network. The setup token is what stops them.",
  ];
  if (!input.tlsConfigured) warnings.push(INSECURE_CONTEXT_WARNING);
  return {
    mode,
    host: "0.0.0.0",
    // A name, not an address: a DHCP lease change rewrites the address and
    // would silently invalidate an origin allowlist pinned to it.
    origins: [url],
    secureCookie: Boolean(input.tlsConfigured),
    url,
    warnings,
  };
}

/**
 * Chooses a default when the operator did not. Tailscale first because it is
 * the only mode that is both reachable from a phone and a secure context
 * without anyone installing a certificate.
 */
export function defaultExposureMode(available: { tailscale: boolean }): ExposureMode {
  return available.tailscale ? "tailscale" : "loopback";
}
