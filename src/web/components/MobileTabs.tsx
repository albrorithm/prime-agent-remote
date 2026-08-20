import { Bot, ListTree, MessagesSquare } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useGateway, type MobileView } from "../gateway-store";

const tabs: Array<{ id: MobileView; label: string; icon: typeof Bot }> = [
  { id: "agents", label: "Agents", icon: Bot },
  { id: "current", label: "Current", icon: MessagesSquare },
  { id: "activity", label: "Activity", icon: ListTree },
];

export function MobileTabs() {
  const { mobileView, setMobileView, selectedAgent } = useGateway();
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setMobileView(tabs[next].id);
    document.getElementById(`mobile-tab-${tabs[next].id}`)?.focus();
  }
  return (
    <nav className="mobile-tabs" role="tablist" aria-label="Primary views">
      {tabs.map((tab, index) => {
        const Icon = tab.icon;
        const disabled = tab.id !== "agents" && !selectedAgent;
        return (
          <button
            id={`mobile-tab-${tab.id}`}
            key={tab.id}
            role="tab"
            aria-selected={mobileView === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={mobileView === tab.id ? 0 : -1}
            disabled={disabled}
            onClick={() => setMobileView(tab.id)}
            onKeyDown={(event) => keyDown(event, index)}
          ><Icon aria-hidden="true" /><span>{tab.label}</span></button>
        );
      })}
    </nav>
  );
}
