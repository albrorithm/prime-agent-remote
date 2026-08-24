import { Command, Image, Plus, Send, Square, Wrench } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useGateway } from "../gateway-store";
import { commandEntry, formatSlashCommandResult, parseSlashCommandInput } from "../slash-commands";
import { MAX_DRAFT_LENGTH, useComposerDrafts } from "../hooks/useComposerDrafts";
import { useImageAttachments } from "../hooks/useImageAttachments";
import { useOptionsMenu } from "../hooks/useOptionsMenu";
import { experimentalCommandNotice, useSlashCommandMenu } from "../hooks/useSlashCommandMenu";
import { SwitchHapticButton } from "./SwitchHapticButton";

export function Composer() {
  const { selectedAgent, selectedSnapshot, send, loadSlashCommands, runSlashCommand, abort } = useGateway();
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  const retryRequestRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const submissionVersionRef = useRef(0);
  const id = selectedAgent?.id ?? "";
  const activeAgentIdRef = useRef(id);
  activeAgentIdRef.current = id;

  const { draft, setDrafts } = useComposerDrafts(id);
  const optionsMenu = useOptionsMenu(id, composerRef, textareaRef);
  const wakeOnSend = Boolean(selectedAgent?.capabilities.resume && !selectedAgent.capabilities.send);
  const canCompose = Boolean(selectedAgent?.capabilities.send || selectedAgent?.capabilities.resume);
  const canAttachImages = Boolean(selectedAgent?.capabilities.send && selectedAgent.capabilities.images);

  const attachments = useImageAttachments(id, canAttachImages, submittingRef, optionsMenu.closeOptions);
  const slashMenu = useSlashCommandMenu({
    id,
    draft,
    canSend: Boolean(selectedAgent?.capabilities.send),
    optionsOpen: optionsMenu.optionsOpen,
    sending,
    loadSlashCommands,
    setDrafts,
    setAttachmentStatus: attachments.setAttachmentStatus,
    textareaRef,
    closeOptions: optionsMenu.closeOptions,
  });

  const streaming = selectedSnapshot?.messages.some((message) => message.state === "streaming") ?? false;
  const visibleImages = attachments.imageOwnerRef.current === id ? attachments.images : [];
  const hasComposerContent = Boolean(draft.trim() || visibleImages.length);

  useEffect(() => {
    submissionVersionRef.current += 1;
    submittingRef.current = false;
    retryRequestRef.current = null;
    setSending(false);
    setStopping(false);

    return () => {
      submissionVersionRef.current += 1;
      submittingRef.current = false;
    };
  }, [id]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(152, Math.max(44, textarea.scrollHeight))}px`;
  }, [draft]);

  async function submit() {
    const text = draft.trim();
    const selectedImages = attachments.imageOwnerRef.current === id ? attachments.imagesRef.current : [];
    if (!id || !canCompose || (selectedImages.length > 0 && !canAttachImages) || (!text && !selectedImages.length)) return;
    if (submittingRef.current || attachments.preparingRef.current) return;
    if (wakeOnSend && text.startsWith("/")) {
      attachments.setAttachmentStatus("Send a message to wake this thread before running commands.");
      return;
    }
    if (text.startsWith("/") && !slashMenu.slashCatalogReady) {
      attachments.setAttachmentStatus("Command catalog unavailable. Reload after the gateway restarts.");
      return;
    }
    const slashCommand = text.startsWith("/") ? parseSlashCommandInput(text, slashMenu.slashCatalog) : null;
    if (text.startsWith("/") && !slashCommand) {
      const detected = commandEntry(text, slashMenu.slashCatalog);
      attachments.setAttachmentStatus(detected?.availability === "unavailable"
        ? "This command was detected but is unavailable in the mobile UI."
        : "Unknown or invalid slash command.");
      return;
    }
    if (slashCommand && selectedImages.length > 0) {
      attachments.setAttachmentStatus("Remove image attachments before running a command.");
      return;
    }

    const agentId = id;
    const fingerprint = JSON.stringify([agentId, text, ...selectedImages.map((image) => image.previewUrl)]);
    const requestId = retryRequestRef.current?.fingerprint === fingerprint
      ? retryRequestRef.current.requestId
      : crypto.randomUUID();
    retryRequestRef.current = { fingerprint, requestId };
    const submissionVersion = ++submissionVersionRef.current;
    submittingRef.current = true;
    setSending(true);
    optionsMenu.closeOptions(false);
    try {
      let resultStatus = "";
      if (slashCommand) {
        const commandResult = await runSlashCommand(slashCommand.name, slashCommand.args, requestId);
        resultStatus = formatSlashCommandResult(commandResult);
        if (commandResult.kind !== "session_accepted" && typeof loadSlashCommands === "function") {
          void loadSlashCommands(agentId).then((catalog) => {
            if (activeAgentIdRef.current === agentId && catalog.agentId === agentId) slashMenu.setSlashCatalog(catalog);
          }).catch(() => {});
        }
      } else if (selectedImages.length) await send(text, selectedImages, requestId);
      else await send(text, undefined, requestId);
      if (activeAgentIdRef.current === agentId && submissionVersion === submissionVersionRef.current) {
        setDrafts((current) => ({ ...current, [agentId]: "" }));
        attachments.finishSuccessfulSubmit(selectedImages);
        attachments.setAttachmentStatus(resultStatus);
        retryRequestRef.current = null;
      }
    } catch {
      // The gateway store exposes the error. Keep the draft and images for retry.
    } finally {
      if (submissionVersion === submissionVersionRef.current) {
        submittingRef.current = false;
        setSending(false);
      }
    }
  }

  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await abort();
    } catch {
      // The gateway store exposes the error.
    } finally {
      setStopping(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (slashMenu.commandDraft && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && optionsMenu.optionsOpen) {
      event.preventDefault();
      optionsMenu.closeOptions(true);
      return;
    }
    if (slashMenu.handleTextareaKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  if (!selectedAgent) return null;
  return (
    <div ref={composerRef} className="composer" data-gesture-exclusion>
      <input
        ref={attachments.imageInputRef}
        type="file"
        hidden
        multiple
        accept="image/jpeg,image/png,image/webp"
        aria-label="Add image attachments"
        disabled={!canAttachImages || attachments.preparing || sending}
        onChange={attachments.onImageSelection}
      />
      {slashMenu.slashMenuOpen && (
        <div className="slash-command-menu" id="slash-command-options" role="listbox" aria-label="Slash commands">
          {slashMenu.slashCommands.map((suggestion, index) => {
            const unavailable = !slashMenu.slashCatalogReady || suggestion.command.availability === "unavailable";
            return (
              <button
                key={suggestion.key}
                id={`slash-command-${index}`}
                type="button"
                role="option"
                aria-selected={index === slashMenu.activeSlashCommandIndex}
                aria-disabled={unavailable}
                data-availability={suggestion.command.availability}
                onClick={() => slashMenu.selectSlashCommand(suggestion)}
              >
                <span>
                  <strong>{suggestion.display}</strong>
                  {suggestion.argumentValue === undefined && <code>{suggestion.command.argumentHint}</code>}
                </span>
                <small>
                  {suggestion.command.availability === "experimental" ? (
                    <em
                      className="slash-command-experimental-label"
                      aria-label={experimentalCommandNotice(suggestion.command)}
                      title={experimentalCommandNotice(suggestion.command)}
                    >EXPERIMENTAL ACCESS</em>
                  ) : (
                    <span>{unavailable ? "Detected, unavailable on mobile" : suggestion.description}</span>
                  )}
                </small>
              </button>
            );
          })}
        </div>
      )}
      {optionsMenu.optionsOpen && (
        <div
          ref={optionsMenu.optionsMenuRef}
          className="composer-menu"
          id="composer-options"
          role="menu"
          aria-label="Composer options"
          onKeyDown={optionsMenu.onOptionsMenuKeyDown}
        >
          <button role="menuitem" data-menu-index="0" tabIndex={optionsMenu.optionsMenuIndex === 0 ? 0 : -1} onFocus={() => optionsMenu.setOptionsMenuIndex(0)} onClick={slashMenu.startSlashCommand}><Command /><span><strong>Slash command</strong><small>Run a supported command</small></span></button>
          <button role="menuitem" data-menu-index="1" tabIndex={optionsMenu.optionsMenuIndex === 1 ? 0 : -1} onFocus={() => optionsMenu.setOptionsMenuIndex(1)} onClick={attachments.chooseImages} disabled={!canAttachImages || attachments.preparing || sending}><Image /><span><strong>Image</strong><small>{canAttachImages ? "Attach up to three images" : "Image attachments unavailable"}</small></span></button>
          <button role="menuitem" data-menu-index="2" tabIndex={-1} disabled><Wrench /><span><strong>Tools and plugins</strong><small>Capability projection required</small></span></button>
        </div>
      )}
      <SwitchHapticButton
        className="composer-options-control"
        buttonClassName="composer-options-trigger"
        label="Composer options"
        ariaExpanded={optionsMenu.optionsOpen}
        ariaControls="composer-options"
        disabled={!selectedAgent.capabilities.send}
        onActivate={optionsMenu.toggleOptions}
        preserveFocus
      ><Plus aria-hidden="true" /></SwitchHapticButton>
      <div className="composer-input" onDragOver={attachments.onDragOver} onDrop={attachments.onDrop}>
        {visibleImages.length > 0 && (
          <div
            className={`composer-attachments message-images ${visibleImages.length === 1 ? "single" : "multiple"}`}
            role="list"
            aria-label="Image attachments"
          >
            {visibleImages.map((image, index) => (
              <div role="listitem" key={`${image.previewUrl}:${index}`}>
                <img src={image.previewUrl} alt={`Image attachment ${index + 1} preview`} />
                <button
                  type="button"
                  onClick={() => attachments.removeImage(index)}
                  disabled={attachments.preparing || sending}
                  aria-label={`Remove image ${index + 1}`}
                >Remove</button>
              </div>
            ))}
          </div>
        )}
        <label htmlFor="message-composer" className="sr-only">Message {selectedAgent.name}</label>
        <textarea
          ref={textareaRef}
          id="message-composer"
          value={draft}
          onChange={(event) => {
            setDrafts((current) => ({ ...current, [id]: event.target.value }));
            attachments.setAttachmentStatus("");
          }}
          onKeyDown={onKeyDown}
          onPaste={attachments.onPaste}
          rows={1}
          maxLength={MAX_DRAFT_LENGTH}
          aria-autocomplete="list"
          aria-controls={slashMenu.slashMenuOpen ? "slash-command-options" : undefined}
          aria-activedescendant={slashMenu.slashMenuOpen && slashMenu.activeSlashCommand && slashMenu.selectableSlashIndexes.length ? `slash-command-${slashMenu.activeSlashCommandIndex}` : undefined}
          placeholder={wakeOnSend ? "Send a message to wake" : "Send a message"}
          disabled={!canCompose}
        />
        {attachments.attachmentStatus && (
          <span className="composer-attachment-status" role="status" aria-live="polite">{attachments.attachmentStatus}</span>
        )}
        {slashMenu.experimentalCommandDraft && slashMenu.draftCommandEntry && (
          <span
            className="composer-experimental-label"
            role="status"
            aria-live="polite"
            aria-label={experimentalCommandNotice(slashMenu.draftCommandEntry)}
            title={experimentalCommandNotice(slashMenu.draftCommandEntry)}
          >EXPERIMENTAL ACCESS</span>
        )}
      </div>
      {streaming && selectedAgent.capabilities.abort && !hasComposerContent ? (
        <button className="composer-action stop" onClick={() => void stop()} disabled={stopping} aria-label="Stop agent"><Square /></button>
      ) : (
        <SwitchHapticButton
          buttonClassName="composer-action send"
          onActivate={() => void submit()}
          disabled={!canCompose || (!draft.trim() && !visibleImages.length) || attachments.preparing || sending}
          label={wakeOnSend ? "Wake thread and send message" : slashMenu.experimentalCommandDraft ? "Run experimental command" : slashMenu.commandDraft ? "Run command" : "Send message"}
        ><Send aria-hidden="true" /></SwitchHapticButton>
      )}
    </div>
  );
}
