import { RotateCw, WifiOff } from "lucide-react";
import { useGateway } from "../gateway-store";

export function ConnectionBanner() {
  const { connection, reconnect, error } = useGateway();
  if (connection === "live" && !error) return null;
  return (
    <div className={`connection-banner ${connection}`} role="status">
      {connection === "offline" ? <WifiOff aria-hidden="true" /> : <RotateCw className="spin" aria-hidden="true" />}
      <span>{error || (connection === "replaying" ? "Catching up…" : connection === "offline" ? "Connection lost" : "Connecting…")}</span>
      {connection === "offline" && <button onClick={reconnect}>Reconnect</button>}
    </div>
  );
}
