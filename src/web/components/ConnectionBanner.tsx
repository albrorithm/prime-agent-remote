import { CircleAlert, RotateCw, WifiOff } from "lucide-react";
import { useGateway } from "../gateway-store";

export function ConnectionBanner() {
  const { connection, reconnect, error } = useGateway();
  if (connection === "live" && !error) return null;
  const busy = connection === "connecting" || connection === "replaying";
  return (
    <div className={`connection-banner ${connection}`} role="status">
      {connection === "offline" ? <WifiOff aria-hidden="true" /> : busy ? <RotateCw className="spin" aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <span>{error || (connection === "replaying" ? "Catching up…" : connection === "offline" ? "Connection lost" : "Connecting…")}</span>
      {connection === "offline" && <button onClick={reconnect}>Reconnect</button>}
    </div>
  );
}
