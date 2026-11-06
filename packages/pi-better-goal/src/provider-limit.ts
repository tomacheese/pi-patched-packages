/**
 * Milliseconds until the provider limit resets, read from a hint such as
 * "Resets in ~125h" or "Resets in ~30m" in an error message; undefined when the
 * message carries none.
 */
export function providerLimitResetMs(message: unknown): number | undefined {
  if (typeof message !== "string") return undefined;
  const match = /resets?\s+in\s+(?:~\s*)?(\d+(?:\.\d+)?)\s*(h|m)(?![a-z])/i.exec(message);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value * (match[2]?.toLowerCase() === "h" ? 3_600_000 : 60_000);
}

/**
 * True when an error message reports that the login was rejected (a revoked or
 * expired OAuth token, HTTP 401). Retrying cannot succeed until the user logs in again.
 */
export function isAuthFailureMessage(message: unknown): boolean {
  return typeof message === "string" &&
    /invalidated oauth token|token_revoked|\b(?:http|status(?: code)?)[ :]*401\b|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|authentication (?:failed|error)|please (?:log ?in|sign ?in) again/i.test(message);
}
