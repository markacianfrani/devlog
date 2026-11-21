// Test-only fart stand-in for a secret that devlog's built-in redaction does
// not match, so a trufflehog step has something to find.
//
// It has to be a *complete* Slack webhook shape or the detector ignores it —
// and a complete Slack webhook shape is exactly what GitHub push protection
// refuses to push, fake or not. So the stand-in is assembled at test runtime
// and never appears whole in any tracked file. fixture-hygiene.test.ts guards
// that rule; don't "simplify" this back into one string literal.
export const FART_HOOK_HOST = "https://hooks.slack.com/services";
export const FART_HOOK_WORKSPACE = "T000FART0";
export const FART_HOOK_CHANNEL = "B000FART0";
// Detector wants a 24-char token body. Assertions use this constant rather
// than spelling it out, for the same reason.
export const FART_HOOK_TOKEN = "X".repeat(24);

export function fartWebhook(): string {
  return [FART_HOOK_HOST, FART_HOOK_WORKSPACE, FART_HOOK_CHANNEL, FART_HOOK_TOKEN].join("/");
}
