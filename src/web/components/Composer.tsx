import { Command, Image, Plus, Send, Square, Wrench } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
} from "react";
import { useGateway } from "../gateway-store";
import { MAX_IMAGE_ATTACHMENTS, prepareImageFile, type PreparedImage } from "../image-attachments";
import {
  commandEntry,
  FALLBACK_SLASH_COMMAND_CATALOG,
  formatSlashCommandResult,
  matchingSlashCommandSuggestions,
  parseSlashCommandInput,
  type SlashCommandSuggestion,
} from "../slash-commands";
import { SwitchHapticButton } from "./SwitchHapticButton";

const DRAFTS_KEY = "prime-web-drafts";
const SUCCESS_PREVIEW_REVOKE_DELAY_MS = 2_000;

function loadDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function isObjectPreviewUrl(url: string): boolean {
  return url.startsWith("blob:");
}

function revokePreviewUrl(url: string): void {
  if (!isObjectPreviewUrl(url) || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

const SAFE_PREPARATION_ERROR_PREFIXES = [
  "Unsupported image type.",
  "The source image is too large.",
  "Could not read the image file.",
  "Reading the image file was cancelled.",
  "The browser returned invalid image data.",
  "This browser cannot",
  "The image has invalid dimensions.",
  "Could not decode the image file.",
  "The image could not be compressed",
] as const;

function preparationErrorMessage(error: unknown): string {
  if (error instanceof Error && SAFE_PREPARATION_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix))) {
    return error.message.slice(0, 240);
  }
  return "Could not prepare one of the selected images.";
}

function experimentalCommandNotice(command: SlashCommandSuggestion["command"]): string {
  return command.source === "extension"
    ? "Experimental extension command. May run local extension code."
    : "Experimental command. Sends a model prompt.";
}

export function Composer() {
  const { selectedAgent, selectedSnapshot, send, loadSlashCommands, runSlashCommand, abort } = useGateway();
  const [drafts, setDraftsState] = useState<Record<string, string>>(loadDrafts);
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [slashCommandIndex, setSlashCommandIndex] = useState(0);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState("");
  const [slashCatalog, setSlashCatalog] = useState(FALLBACK_SLASH_COMMAND_CATALOG);
  const [slashCatalogReady, setSlashCatalogReady] = useState(false);
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<PreparedImage[]>([]);
  const imageOwnerRef = useRef("");
  const inProgressImagesRef = useRef<PreparedImage[]>([]);
  const preparingRef = useRef(false);
  const submittingRef = useRef(false);
  const retryRequestRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const preparationVersionRef = useRef(0);
  const submissionVersionRef = useRef(0);
  const delayedRevocationsRef = useRef(new Map<string, number>());
  const id = selectedAgent?.id ?? "";
  const activeAgentIdRef = useRef(id);
  activeAgentIdRef.current = id;
  const draft = drafts[id] ?? "";
  const wakeOnSend = Boolean(selectedAgent?.capabilities.resume && !selectedAgent.capabilities.send);
  const canCompose = Boolean(selectedAgent?.capabilities.send || selectedAgent?.capabilities.resume);
  const commandDraft = draft.trimStart().startsWith("/");
  const draftCommandEntry = commandDraft ? commandEntry(draft.trim(), slashCatalog) : undefined;
  const experimentalCommandDraft = draftCommandEntry?.availability === "experimental";
  const slashCommands = matchingSlashCommandSuggestions(draft, slashCatalog);
  const selectableSlashIndexes = slashCatalogReady ? slashCommands.map((_, index) => index) : [];
  const slashMenuOpen = slashCommands.length > 0
    && dismissedSlashDraft !== draft
    && !optionsOpen
    && !sending
    && Boolean(selectedAgent?.capabilities.send);
  const activeSlashCommandIndex = selectableSlashIndexes.includes(slashCommandIndex)
    ? slashCommandIndex
    : selectableSlashIndexes[0] ?? 0;
  const activeSlashCommand = slashCommands[activeSlashCommandIndex];
  const streaming = selectedSnapshot?.messages.some((message) => message.state === "streaming") ?? false;
  const canAttachImages = Boolean(selectedAgent?.capabilities.send && selectedAgent.capabilities.images);
  const visibleImages = imageOwnerRef.current === id ? images : [];

  function setDrafts(update: (current: Record<string, string>) => Record<string, string>) {
    setDraftsState((current) => {
      const next = update(current);
      try {
        sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
      } catch {
        // Storage may be unavailable; drafts still work in memory.
      }
      return next;
    });
  }

  function revokeImages(items: PreparedImage[]) {
    for (const image of items) revokePreviewUrl(image.previewUrl);
  }

  function flushDelayedRevocations() {
    for (const [url, timer] of delayedRevocationsRef.current) {
      window.clearTimeout(timer);
      revokePreviewUrl(url);
    }
    delayedRevocationsRef.current.clear();
  }

  function delaySuccessfulRevocation(items: PreparedImage[]) {
    for (const image of items) {
      const url = image.previewUrl;
      if (!isObjectPreviewUrl(url)) continue;
      const existingTimer = delayedRevocationsRef.current.get(url);
      if (existingTimer != null) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        delayedRevocationsRef.current.delete(url);
        revokePreviewUrl(url);
      }, SUCCESS_PREVIEW_REVOKE_DELAY_MS);
      delayedRevocationsRef.current.set(url, timer);
    }
  }

  function clearImages(revoke = true) {
    const current = imagesRef.current;
    imagesRef.current = [];
    imageOwnerRef.current = "";
    setImages([]);
    if (revoke) revokeImages(current);
  }

  useEffect(() => {
    preparationVersionRef.current += 1;
    submissionVersionRef.current += 1;
    preparingRef.current = false;
    submittingRef.current = false;
    retryRequestRef.current = null;
    setPreparing(false);
    setSending(false);
    setStopping(false);
    setOptionsOpen(false);
    setSlashCommandIndex(0);
    setDismissedSlashDraft("");
    setAttachmentStatus("");
    if (imageInputRef.current) imageInputRef.current.value = "";
    clearImages();
    flushDelayedRevocations();

    return () => {
      preparationVersionRef.current += 1;
      submissionVersionRef.current += 1;
      preparingRef.current = false;
      submittingRef.current = false;
      revokeImages(imagesRef.current);
      imagesRef.current = [];
      revokeImages(inProgressImagesRef.current);
      inProgressImagesRef.current.length = 0;
      inProgressImagesRef.current = [];
      flushDelayedRevocations();
    };
  }, [id]);

  useEffect(() => {
    let current = true;
    setSlashCatalog(FALLBACK_SLASH_COMMAND_CATALOG);
    setSlashCatalogReady(false);
    if (!id || !selectedAgent?.capabilities.send) return () => { current = false; };
    if (typeof loadSlashCommands !== "function") {
      setSlashCatalogReady(true);
      return () => { current = false; };
    }
    void loadSlashCommands(id).then((catalog) => {
      if (!current || activeAgentIdRef.current !== id || catalog.agentId !== id) return;
      setSlashCatalog(catalog);
      setSlashCatalogReady(true);
    }).catch(() => {
      if (!current || activeAgentIdRef.current !== id) return;
      setSlashCatalogReady(false);
    });
    return () => { current = false; };
  }, [id, selectedAgent?.capabilities.send, loadSlashCommands]);

  useEffect(() => {
    if (canAttachImages) return;
    preparationVersionRef.current += 1;
    preparingRef.current = false;
    setPreparing(false);
    setAttachmentStatus("");
    if (imageInputRef.current) imageInputRef.current.value = "";
    clearImages();
    revokeImages(inProgressImagesRef.current);
    inProgressImagesRef.current.length = 0;
    inProgressImagesRef.current = [];
  }, [id, canAttachImages]);

  useEffect(() => {
    if (!optionsOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (optionsMenuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".composer-options-control")) return;
      setOptionsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [optionsOpen]);

  useEffect(() => {
    setSlashCommandIndex(0);
  }, [draft]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(152, Math.max(44, textarea.scrollHeight))}px`;
  }, [draft]);

  async function prepareSelectedFiles(files: File[]) {
    if (!files.length || !canAttachImages) return;
    if (preparingRef.current || submittingRef.current) {
      setAttachmentStatus("Wait for the current images or message to finish.");
      return;
    }

    const available = MAX_IMAGE_ATTACHMENTS - imagesRef.current.length;
    if (available <= 0) {
      setAttachmentStatus(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
      return;
    }

    const selected = files.slice(0, available);
    const reachedLimit = files.length > available;
    const version = ++preparationVersionRef.current;
    const agentId = id;
    const prepared: PreparedImage[] = [];
    const errors: string[] = [];
    inProgressImagesRef.current = prepared;
    preparingRef.current = true;
    setPreparing(true);
    setAttachmentStatus("Preparing images…");

    try {
      for (const file of selected) {
        if (version !== preparationVersionRef.current || activeAgentIdRef.current !== agentId) break;
        try {
          const image = await prepareImageFile(file);
          if (version !== preparationVersionRef.current || activeAgentIdRef.current !== agentId) {
            revokePreviewUrl(image.previewUrl);
            break;
          }
          prepared.push(image);
        } catch (error) {
          if (version !== preparationVersionRef.current || activeAgentIdRef.current !== agentId) break;
          errors.push(preparationErrorMessage(error));
        }
      }

      if (version !== preparationVersionRef.current || activeAgentIdRef.current !== agentId) {
        revokeImages(prepared);
        prepared.length = 0;
        return;
      }

      if (prepared.length) {
        const next = [...imagesRef.current, ...prepared];
        imagesRef.current = next;
        imageOwnerRef.current = agentId;
        setImages(next);
      }
      inProgressImagesRef.current = [];

      if (errors.length) {
        setAttachmentStatus(errors.length === 1
          ? errors[0]
          : `${errors.length} images could not be prepared. ${errors.at(-1)}`);
      } else if (reachedLimit) {
        setAttachmentStatus(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
      } else {
        setAttachmentStatus("");
      }
    } finally {
      if (inProgressImagesRef.current === prepared) inProgressImagesRef.current = [];
      if (version === preparationVersionRef.current) {
        preparingRef.current = false;
        setPreparing(false);
      }
    }
  }

  function chooseImages() {
    if (!canAttachImages || preparingRef.current || submittingRef.current) return;
    setOptionsOpen(false);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
      imageInputRef.current.click();
    }
  }

  function onImageSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void prepareSelectedFiles(files);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (!canAttachImages) {
      setAttachmentStatus("Image attachments are not available for this agent.");
      return;
    }
    void prepareSelectedFiles(files);
  }

  function onDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (canAttachImages && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
  }

  function onDrop(event: ReactDragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (!canAttachImages) {
      setAttachmentStatus("Image attachments are not available for this agent.");
      return;
    }
    void prepareSelectedFiles(files);
  }

  function removeImage(index: number) {
    if (preparingRef.current || submittingRef.current) return;
    const current = imagesRef.current;
    const removed = current[index];
    if (!removed) return;
    const next = current.filter((_, imageIndex) => imageIndex !== index);
    imagesRef.current = next;
    setImages(next);
    revokePreviewUrl(removed.previewUrl);
    setAttachmentStatus("");
  }

  async function submit() {
    const text = draft.trim();
    const selectedImages = imageOwnerRef.current === id ? imagesRef.current : [];
    if (!id || !canCompose || (selectedImages.length > 0 && !canAttachImages) || (!text && !selectedImages.length)) return;
    if (submittingRef.current || preparingRef.current) return;
    if (wakeOnSend && text.startsWith("/")) {
      setAttachmentStatus("Send a message to wake this thread before running commands.");
      return;
    }
    if (text.startsWith("/") && !slashCatalogReady) {
      setAttachmentStatus("Command catalog unavailable. Reload after the gateway restarts.");
      return;
    }
    const slashCommand = text.startsWith("/") ? parseSlashCommandInput(text, slashCatalog) : null;
    if (text.startsWith("/") && !slashCommand) {
      const detected = commandEntry(text, slashCatalog);
      setAttachmentStatus(detected?.availability === "unavailable"
        ? "This command was detected but is unavailable in the mobile UI."
        : "Unknown or invalid slash command.");
      return;
    }
    if (slashCommand && selectedImages.length > 0) {
      setAttachmentStatus("Remove image attachments before running a command.");
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
    setOptionsOpen(false);
    try {
      let resultStatus = "";
      if (slashCommand) {
        const commandResult = await runSlashCommand(slashCommand.name, slashCommand.args, requestId);
        resultStatus = formatSlashCommandResult(commandResult);
        if (commandResult.kind !== "session_accepted" && typeof loadSlashCommands === "function") {
          void loadSlashCommands(agentId).then((catalog) => {
            if (activeAgentIdRef.current === agentId && catalog.agentId === agentId) setSlashCatalog(catalog);
          }).catch(() => {});
        }
      } else if (selectedImages.length) await send(text, selectedImages, requestId);
      else await send(text, undefined, requestId);
      if (activeAgentIdRef.current === agentId && submissionVersion === submissionVersionRef.current) {
        setDrafts((current) => ({ ...current, [agentId]: "" }));
        imagesRef.current = [];
        imageOwnerRef.current = "";
        setImages([]);
        setAttachmentStatus(resultStatus);
        retryRequestRef.current = null;
        delaySuccessfulRevocation(selectedImages);
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

  function selectSlashCommand(suggestion: SlashCommandSuggestion) {
    if (!slashCatalogReady || suggestion.command.availability === "unavailable") {
      setAttachmentStatus("This command was detected but is unavailable in the mobile UI.");
      return;
    }
    setDrafts((current) => ({ ...current, [id]: suggestion.completion }));
    setAttachmentStatus("");
    setSlashCommandIndex(0);
    setDismissedSlashDraft("");
    queueMicrotask(() => textareaRef.current?.focus());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (commandDraft && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && optionsOpen) {
      event.preventDefault();
      setOptionsOpen(false);
      return;
    }
    if (event.key === "Escape" && slashMenuOpen) {
      event.preventDefault();
      setDismissedSlashDraft(draft);
      return;
    }
    if (slashMenuOpen && activeSlashCommand && selectableSlashIndexes.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const position = Math.max(0, selectableSlashIndexes.indexOf(activeSlashCommandIndex));
        const next = (position + direction + selectableSlashIndexes.length) % selectableSlashIndexes.length;
        setSlashCommandIndex(selectableSlashIndexes[next]);
        return;
      }
      if (event.key === "Tab" && activeSlashCommand.command.availability !== "unavailable") {
        event.preventDefault();
        selectSlashCommand(activeSlashCommand);
        return;
      }
      const exactCommand = activeSlashCommand.argumentValue === undefined
        && draft === `/${activeSlashCommand.command.name}`;
      if (event.key === "Enter" && !event.shiftKey && !exactCommand) {
        event.preventDefault();
        selectSlashCommand(activeSlashCommand);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function startSlashCommand() {
    setDrafts((current) => ({ ...current, [id]: current[id]?.trim() ? current[id] : "/" }));
    setOptionsOpen(false);
    setDismissedSlashDraft("");
    queueMicrotask(() => textareaRef.current?.focus());
  }

  if (!selectedAgent) return null;
  return (
    <div className="composer" data-gesture-exclusion>
      <input
        ref={imageInputRef}
        type="file"
        hidden
        multiple
        accept="image/jpeg,image/png,image/webp"
        aria-label="Add image attachments"
        disabled={!canAttachImages || preparing || sending}
        onChange={onImageSelection}
      />
      {slashMenuOpen && (
        <div className="slash-command-menu" id="slash-command-options" role="listbox" aria-label="Slash commands">
          {slashCommands.map((suggestion, index) => {
            const unavailable = !slashCatalogReady || suggestion.command.availability === "unavailable";
            return (
              <button
                key={suggestion.key}
                id={`slash-command-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeSlashCommandIndex}
                aria-disabled={unavailable}
                data-availability={suggestion.command.availability}
                onClick={() => selectSlashCommand(suggestion)}
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
      {optionsOpen && (
        <div ref={optionsMenuRef} className="composer-menu" id="composer-options" role="menu" aria-label="Composer options">
          <button role="menuitem" onClick={startSlashCommand}><Command /><span><strong>Slash command</strong><small>Run a supported command</small></span></button>
          <button role="menuitem" onClick={chooseImages} disabled={!canAttachImages || preparing || sending}><Image /><span><strong>Image</strong><small>{canAttachImages ? "Attach up to three images" : "Image attachments unavailable"}</small></span></button>
          <button role="menuitem" disabled><Wrench /><span><strong>Tools and plugins</strong><small>Capability projection required</small></span></button>
        </div>
      )}
      <SwitchHapticButton
        className="composer-options-control"
        buttonClassName="composer-options-trigger"
        label="Composer options"
        ariaExpanded={optionsOpen}
        ariaControls="composer-options"
        disabled={!selectedAgent.capabilities.send}
        onActivate={() => setOptionsOpen((open) => !open)}
        preserveFocus
      ><Plus aria-hidden="true" /></SwitchHapticButton>
      <div className="composer-input" onDragOver={onDragOver} onDrop={onDrop}>
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
                  onClick={() => removeImage(index)}
                  disabled={preparing || sending}
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
            setAttachmentStatus("");
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          aria-autocomplete="list"
          aria-expanded={slashMenuOpen}
          aria-controls={slashMenuOpen ? "slash-command-options" : undefined}
          aria-activedescendant={slashMenuOpen && activeSlashCommand && selectableSlashIndexes.length ? `slash-command-${activeSlashCommandIndex}` : undefined}
          placeholder={wakeOnSend ? "Send a message to wake" : "Send a message"}
          disabled={!canCompose}
        />
        {attachmentStatus && (
          <span className="composer-attachment-status" role="status" aria-live="polite">{attachmentStatus}</span>
        )}
        {experimentalCommandDraft && draftCommandEntry && (
          <span
            className="composer-experimental-label"
            role="status"
            aria-live="polite"
            aria-label={experimentalCommandNotice(draftCommandEntry)}
            title={experimentalCommandNotice(draftCommandEntry)}
          >EXPERIMENTAL ACCESS</span>
        )}
      </div>
      {streaming && selectedAgent.capabilities.abort ? (
        <button className="composer-action stop" onClick={() => void stop()} disabled={stopping} aria-label="Stop agent"><Square /></button>
      ) : (
        <SwitchHapticButton
          buttonClassName="composer-action send"
          onActivate={() => void submit()}
          disabled={!canCompose || (!draft.trim() && !visibleImages.length) || preparing || sending}
          label={wakeOnSend ? "Wake thread and send message" : experimentalCommandDraft ? "Run experimental command" : commandDraft ? "Run command" : "Send message"}
        ><Send aria-hidden="true" /></SwitchHapticButton>
      )}
    </div>
  );
}
