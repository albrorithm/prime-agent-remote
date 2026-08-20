import { ActivityPanel } from "./components/ActivityPanel";
import { AgentsPanel } from "./components/AgentsPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { Login } from "./components/Login";
import { MobileTabs } from "./components/MobileTabs";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { useGateway } from "./gateway-store";

export function App() {
  const { authRequired, connection, mobileView, backend } = useGateway();
  if (authRequired) return <Login />;
  if (connection === "checking") return <main className="splash"><img src="/prime-mark.svg" alt="" /><p>Opening Prime Agent…</p></main>;

  return (
    <main className="app-shell" data-mobile-view={mobileView}>
      <ConnectionBanner />
      {backend === "demo" && <div className="demo-badge">Demo backend</div>}
      <div className="panel-grid">
        <div id="panel-agents" className="panel-slot agents-slot" role="tabpanel" aria-labelledby="mobile-tab-agents"><AgentsPanel /></div>
        <div id="panel-current" className="panel-slot current-slot" role="tabpanel" aria-labelledby="mobile-tab-current"><TranscriptPanel /></div>
        <div id="panel-activity" className="panel-slot activity-slot" role="tabpanel" aria-labelledby="mobile-tab-activity"><ActivityPanel /></div>
      </div>
      <MobileTabs />
    </main>
  );
}
