import { CircleAlert, RotateCw, WifiOff } from "lucide-react";
import { useGateway } from "../gateway-store";

export function ConnectionBanner() {
  const { connection, reconnect, error, hasReconnected } = useGateway();
  if (connection === "live" && !error) return null;
  const busy = connection === "connecting" || connection === "replaying";
  const connectingCopy = hasReconnected ? "Reconnecting…" : "Connecting…";
  // A `live` connection with an error set isn't a connectivity problem — it's
  // a failed action (e.g. "Could not end the session"). `reconnect()` would
  // do nothing for that, so only offer it when the connection itself is what
  // broke.
  const showReconnect = connection !== "live" && (connection === "offline" || !!error);
  return (
    <div className={`connection-banner ${connection}`} role="status">
      {connection === "offline" ? <WifiOff aria-hidden="true" /> : busy ? <RotateCw className="spin" aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <span>{error || (connection === "replaying" ? "Catching up…" : connection === "offline" ? "Connection lost" : connectingCopy)}</span>
      {showReconnect && <button onClick={reconnect}>{error ? "Retry" : "Reconnect"}</button>}
    </div>
  );
}
