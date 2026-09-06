import { useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { humanizeError } from "../api";
import { useGateway } from "../gateway-store";

// The gateway puts this exact title on a 401 for a code past its ten-minute
// window (see the pairing handler in the gateway). humanizeError only
// forwards whatever title it's given, so this string is the one place its
// meaning is known on this side.
const EXPIRED_PAIRING_TITLE = "Pairing link expired";

export function Login() {
  const { pair, hadSession, linkError } = useGateway();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await pair(code);
      setCode("");
    } catch (cause) {
      setError(humanizeError(cause, "Pairing failed"));
    } finally {
      setBusy(false);
    }
  }

  const shownError = error || linkError;
  const expired = shownError === EXPIRED_PAIRING_TITLE;

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark"><KeyRound aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">Prime Agent</p>
          <h1>{hadSession ? "Session expired" : "Pair this device"}</h1>
          <p className="muted">
            {hadSession ? "Your session ended. Enter a new pairing code." : "Scan the gateway's code, or type it here."}
          </p>
        </div>
        <label htmlFor="pairing-code">Pairing code</label>
        <input
          id="pairing-code"
          type="password"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
        {/* A link that failed is the reason this screen is up at all, so it
            is shown until the user's own attempt has something to say. */}
        {shownError && <p className="form-error" role="alert">{shownError}</p>}
        {/* A code lapsing on its own ten-minute clock is not a typo, so it
            gets a line of its own naming that instead of leaving the person
            to guess whether retyping the same code will work this time. */}
        {expired && (
          <p className="form-error-hint">
            That code has expired. Run <code className="inline-code">prime-agent-remote token</code> for a new one.
          </p>
        )}
        <button className="primary-button" disabled={busy || !code.trim()}>
          {busy && <LoaderCircle className="spin" aria-hidden="true" />}
          Pair device
        </button>
      </form>
    </main>
  );
}
