import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { GatewayProvider } from "./gateway-store";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GatewayProvider><App /></GatewayProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
