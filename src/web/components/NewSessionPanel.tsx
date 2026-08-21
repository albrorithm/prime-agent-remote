import { ChevronRight, Eye, EyeOff, Folder, FolderPlus, Home, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DirectoryListing } from "../../protocol";
import * as api from "../api";
import { useGateway } from "../gateway-store";

interface NewSessionPanelProps {
  onClose: () => void;
  onCreated: () => void;
}

export function NewSessionPanel({ onClose, onCreated }: NewSessionPanelProps) {
  const { createSession, selectedAgent } = useGateway();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await api.listDirectories(path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not list that directory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(selectedAgent?.cwd || undefined);
    // The starting directory is fixed when the panel opens; later selection
    // changes should not yank the browser to a different tree.
  }, [load]);

  async function submit() {
    if (!listing || creating) return;
    setCreating(true);
    try {
      await createSession(listing.path, name.trim() || undefined);
      onCreated();
    } catch {
      // The gateway store exposes the error.
    } finally {
      setCreating(false);
    }
  }

  const visibleEntries = listing?.entries.filter((entry) => showHidden || !entry.hidden) ?? [];

  return (
    <section className="panel new-session-panel" aria-labelledby="new-session-heading">
      <header className="drawer-header">
        <div className="drawer-title">
          <FolderPlus aria-hidden="true" />
          <div><p className="eyebrow">Prime Agent</p><h2 id="new-session-heading">New session</h2></div>
        </div>
        <button className="icon-button drawer-close" onClick={onClose} aria-label="Close new session"><X /></button>
      </header>

      <nav className="directory-crumbs" aria-label="Directory ancestry">
        {listing?.crumbs.map((crumb, index) => (
          <span className="crumb-item" key={crumb.path}>
            {index > 0 && <ChevronRight className="crumb-separator" aria-hidden="true" />}
            <button
              onClick={() => void load(crumb.path)}
              title={crumb.path}
              className={index === (listing.crumbs.length - 1) ? "current" : ""}
            >
              {index === 0 ? <Home aria-hidden="true" /> : null}
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="panel-scroll directory-scroll">
        {loading ? (
          <div className="loading-state"><LoaderCircle className="spin" /> Loading…</div>
        ) : error ? (
          <p className="empty-state">{error}</p>
        ) : (
          <div className="directory-list">
            {visibleEntries.map((entry) => (
              <button key={entry.path} className={`directory-row ${entry.hidden ? "hidden-entry" : ""}`} onClick={() => void load(entry.path)}>
                <Folder aria-hidden="true" />
                <span>{entry.name}</span>
              </button>
            ))}
            {!visibleEntries.length && <p className="empty-state">No subdirectories here.</p>}
            {listing?.truncated && <p className="empty-state">Showing the first {listing.entries.length} directories.</p>}
          </div>
        )}
      </div>

      <div className="new-session-form" data-gesture-exclusion>
        <div className="new-session-path">
          <code>{listing?.path ?? "…"}</code>
          <button
            className="icon-button"
            onClick={() => setShowHidden((value) => !value)}
            aria-label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            aria-pressed={showHidden}
          >
            {showHidden ? <EyeOff /> : <Eye />}
          </button>
        </div>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Session name (optional)"
          aria-label="Session name"
          maxLength={200}
        />
        <button className="primary-button" disabled={!listing || creating} onClick={() => void submit()}>
          {creating && <LoaderCircle className="spin" aria-hidden="true" />}
          Start session here
        </button>
      </div>
    </section>
  );
}
