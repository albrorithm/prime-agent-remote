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
  // The shell worker uses skipWaiting + clients.claim, so after a deploy the
  // first launch still runs the previous cached bundle against the new server
  // (stale schemas reject every frame). When a NEW worker takes control of a
  // page that already had one, reload once to pick up the fresh shell. A first
  // install (no prior controller) must not reload — that page came from the
  // network and is already current.
  let hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) window.location.reload();
    hadController = true;
  });
}
