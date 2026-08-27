import { useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { humanizeError } from "../api";
import { useGateway } from "../gateway-store";

export function Login() {
  const { pair, hadSession } = useGateway();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await pair(token);
      setToken("");
    } catch (cause) {
      setError(humanizeError(cause, "Pairing failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark"><KeyRound aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">Prime Agent</p>
          <h1>{hadSession ? "Session expired" : "Pair this device"}</h1>
          <p className="muted">
            {hadSession
              ? "Your pairing session ended. Enter the pairing token shown by the local gateway to continue."
              : "Enter the pairing token shown by the local gateway."}
          </p>
        </div>
        <label htmlFor="pairing-token">Pairing token</label>
        <input
          id="pairing-token"
          type="password"
          autoComplete="one-time-code"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy || !token.trim()}>
          {busy && <LoaderCircle className="spin" aria-hidden="true" />}
          Pair device
        </button>
      </form>
    </main>
  );
}
