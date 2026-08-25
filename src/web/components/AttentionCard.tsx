import { CircleAlert, HelpCircle, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { AttentionRequest } from "../../protocol";
import { useGateway } from "../gateway-store";

export function AttentionCard({ request }: { request: AttentionRequest }) {
  const { respond } = useGateway();
  const [responding, setResponding] = useState(false);
  const Icon = request.kind === "dialog" ? ShieldAlert : request.kind === "question" ? HelpCircle : CircleAlert;
  async function choose(optionId: string) {
    if (responding) return;
    setResponding(true);
    try {
      await respond(request.id, request.revision, optionId);
    } catch {
      // The gateway store exposes the error and keeps the request available.
    } finally {
      setResponding(false);
    }
  }

  return (
    <section className="attention-card" aria-labelledby={`attention-${request.id}`}>
      <div className="attention-heading">
        <Icon aria-hidden="true" />
        <div>
          <p className="eyebrow">{request.kind === "dialog" ? "Extension dialog" : "Needs attention"}</p>
          <h3 id={`attention-${request.id}`}>{request.title}</h3>
        </div>
      </div>
      {request.detail && <p>{request.detail}</p>}
      <div className="attention-actions">
        {request.options.map((option) => (
          <button
            key={option.id}
            className={`attention-action ${option.tone}`}
            onClick={() => void choose(option.id)}
            disabled={responding}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
