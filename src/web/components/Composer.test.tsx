import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, AgentSummary, SlashCommandCatalog } from "../../protocol";
import { Composer } from "./Composer";

const gatewayMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const imageAttachmentMock = vi.hoisted(() => ({ prepareImageFile: vi.fn() }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock.current }));
vi.mock("../image-attachments", () => ({
  MAX_IMAGE_ATTACHMENTS: 3,
  prepareImageFile: imageAttachmentMock.prepareImageFile,
}));

const agent: AgentSummary = {
  id: "agent-1",
  rootId: "agent-1",
  parentId: null,
  depth: 0,
  name: "Agent",
  lifecycle: "live",
  activity: "idle",
  attention: null,
  unreadCount: 0,
  childCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  capabilities: { send: true, abort: true, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: true, images: true },
};
const snapshot: AgentSnapshot = { revision: 1, agentId: agent.id, messages: [], activity: [], attention: [] };
const slashCatalog: SlashCommandCatalog = {
  agentId: agent.id,
  agentRevision: snapshot.revision,
  partial: false,
  commands: [
    { name: "compact", description: "Compact session context", argumentHint: "[instructions]", source: "session", availability: "available", takesArguments: true },
    { name: "refine", description: "Refine continual harness", argumentHint: "[instructions]", source: "session", availability: "available", takesArguments: true },
    { name: "goal", description: "Manage persistent goal", argumentHint: "[objective]", source: "session", availability: "available", takesArguments: true },
    { name: "autonomous", description: "Manage autonomous mode", argumentHint: "[status|on|off]", source: "session", availability: "available", takesArguments: true },
    {
      name: "model",
      description: "Show or select the session model",
      argumentHint: "[provider/model]",
      source: "adapter",
      availability: "available",
      takesArguments: true,
      options: [{ value: "openai/example", label: "Example", current: true }],
    },
    { name: "effort", description: "Show or select thinking level", argumentHint: "[level]", source: "adapter", availability: "available", takesArguments: true },
    { name: "name", description: "Show or set session name", argumentHint: "[name]", source: "adapter", availability: "available", takesArguments: true },
    { name: "context", description: "Show context usage", source: "adapter", availability: "available", takesArguments: false },
    { name: "heartbeat", description: "Manage heartbeat", argumentHint: "[status]", source: "adapter", availability: "available", takesArguments: true },
    {
      name: "deploy",
      description: "Extension command",
      source: "extension",
      availability: "experimental",
      takesArguments: true,
    },
    {
      name: "future",
      description: "Unavailable adapter command",
      source: "adapter",
      availability: "unavailable",
      unavailableReason: "adapter_missing",
      takesArguments: false,
    },
  ],
};

let preparedImageCount = 0;

beforeEach(() => {
  preparedImageCount = 0;
  imageAttachmentMock.prepareImageFile.mockReset();
  imageAttachmentMock.prepareImageFile.mockImplementation(async (file: File) => ({
    type: "image",
    mimeType: file.type,
    data: `prepared-${++preparedImageCount}`,
    previewUrl: `blob:preview-${preparedImageCount}`,
    previewBlob: file.slice(0, file.size, file.type),
  }));
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  gatewayMock.current = {
    selectedAgent: agent,
    selectedSnapshot: snapshot,
    send: vi.fn().mockResolvedValue(undefined),
    loadSlashCommands: vi.fn().mockResolvedValue(slashCatalog),
    runSlashCommand: vi.fn().mockResolvedValue({ kind: "session_accepted" }),
    abort: vi.fn().mockResolvedValue(undefined),
  };
});

async function uploadImage(user: ReturnType<typeof userEvent.setup>, name = "photo.png") {
  await user.click(screen.getByRole("button", { name: "Composer options" }));
  await user.click(screen.getByRole("menuitem", { name: /^Image/ }));
  const file = new File(["image"], name, { type: "image/png" });
  await user.upload(screen.getByLabelText("Add image attachments"), file);
  await screen.findByRole("list", { name: "Image attachments" });
  return file;
}

function hapticSwitchFor(button: HTMLElement): HTMLInputElement {
  const input = button.parentElement?.querySelector<HTMLInputElement>(".switch-haptic-input");
  expect(input).not.toBeNull();
  return input!;
}

describe("Composer", () => {
  it("uses directly tappable native switches for composer options and send", async () => {
    const user = userEvent.setup();
    render(<Composer />);

    const optionsButton = screen.getByRole("button", { name: "Composer options" });
    const optionsSwitch = hapticSwitchFor(optionsButton);
    const sendButton = screen.getByRole("button", { name: "Send message" });
    const sendSwitch = hapticSwitchFor(sendButton);
    expect(optionsSwitch).toHaveAttribute("switch", "");
    expect(optionsSwitch).toBeEnabled();
    expect(sendSwitch).toHaveAttribute("switch", "");
    expect(sendSwitch).toBeDisabled();

    const composerInput = screen.getByRole("textbox", { name: "Message Agent" });
    composerInput.focus();
    expect(composerInput).toHaveFocus();
    await user.click(optionsSwitch);
    expect(composerInput).toHaveFocus();
    expect(screen.getByRole("menu", { name: "Composer options" })).toBeInTheDocument();
    await user.click(optionsSwitch);
    expect(screen.queryByRole("menu", { name: "Composer options" })).not.toBeInTheDocument();

    await user.type(composerInput, "hello");
    expect(sendSwitch).toBeEnabled();
    await user.click(sendSwitch);
    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledWith("hello", undefined, expect.any(String)));
  });

  it("dismisses composer options when a pointer starts outside the menu", async () => {
    const user = userEvent.setup();
    render(<Composer />);

    await user.click(screen.getByRole("button", { name: "Composer options" }));
    const menu = screen.getByRole("menu", { name: "Composer options" });
    fireEvent.pointerDown(menu);
    expect(menu).toBeInTheDocument();

    const composerInput = screen.getByRole("textbox", { name: "Message Agent" });
    await user.click(composerInput);
    expect(screen.queryByRole("menu", { name: "Composer options" })).not.toBeInTheDocument();
    expect(composerInput).toHaveFocus();
  });

  it("lets a message wake an inactive thread", async () => {
    gatewayMock.current.selectedAgent = {
      ...agent,
      lifecycle: "inactive",
      capabilities: { ...agent.capabilities, send: false, abort: false, resume: true, respond: false },
    };
    const user = userEvent.setup();
    render(<Composer />);

    const input = screen.getByRole("textbox", { name: "Message Agent" });
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("placeholder", "Send a message to wake");
    expect(screen.getByRole("button", { name: "Composer options" })).toBeDisabled();
    await user.type(input, "continue this thread");
    await user.click(screen.getByRole("button", { name: "Wake thread and send message" }));

    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledWith("continue this thread", undefined, expect.any(String)));
    expect(gatewayMock.current.loadSlashCommands).not.toHaveBeenCalled();
  });

  it("sends trimmed text and clears the draft only after success", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    expect(input).toHaveAttribute("placeholder", "Send a message");
    await user.type(input, "  hello  ");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledWith("hello", undefined, expect.any(String)));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("keeps a failed draft available for retry", async () => {
    gatewayMock.current.send = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "try again");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("try again");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
  });

  it("sends on Enter and keeps Shift+Enter for a newline", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "first line");
    await user.keyboard("{Shift>}{Enter}{/Shift}second line");
    expect(input).toHaveValue("first line\nsecond line");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledWith("first line\nsecond line", undefined, expect.any(String)));
  });

  it("starts a slash command from the extensible composer menu", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await user.click(screen.getByRole("button", { name: "Composer options" }));
    await user.click(screen.getByRole("menuitem", { name: /Slash command/ }));
    expect(screen.getByRole("textbox", { name: "Message Agent" })).toHaveValue("/");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("completes and runs a supported session slash command", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });

    await user.click(screen.getByRole("button", { name: "Composer options" }));
    await user.click(screen.getByRole("menuitem", { name: /^Slash command/ }));
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(11);
    await user.click(screen.getByRole("option", { name: /^\/goal/ }));
    expect(input).toHaveValue("/goal ");

    await user.type(input, "status");
    await user.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() => expect(gatewayMock.current.runSlashCommand).toHaveBeenCalledWith("goal", "status", expect.any(String)));
    expect(gatewayMock.current.send).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("uses catalog argument suggestions for direct adapter commands", async () => {
    gatewayMock.current.runSlashCommand = vi.fn().mockResolvedValue({
      kind: "model",
      provider: "openai",
      modelId: "example",
    });
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });

    await user.type(input, "/model ");
    await user.click(await screen.findByRole("option", { name: /Example.*Current/ }));
    expect(input).toHaveValue("/model openai/example");
    await user.click(screen.getByRole("button", { name: "Run command" }));

    await waitFor(() => expect(gatewayMock.current.runSlashCommand)
      .toHaveBeenCalledWith("model", "openai/example", expect.any(String)));
    expect(await screen.findByRole("status")).toHaveTextContent("Model: openai/example");
  });

  it("runs cataloged experimental commands with explicit warnings", async () => {
    gatewayMock.current.runSlashCommand = vi.fn().mockResolvedValue({
      kind: "experimental_accepted",
      source: "extension",
    });
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });

    await user.type(input, "/dep");
    const detected = await screen.findByRole("option", { name: /deploy.*Experimental extension command/ });
    expect(input).toHaveAttribute("aria-controls", "slash-command-options");
    expect(input).toHaveAttribute("aria-activedescendant", detected.id);
    expect(detected).toHaveAttribute("aria-disabled", "false");
    expect(detected).toHaveAttribute("data-availability", "experimental");
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(input).toHaveValue("/deploy ");
    expect(screen.getByRole("status")).toHaveAccessibleName("Experimental extension command. May run local extension code.");
    expect(screen.getByRole("status")).toHaveTextContent("EXPERIMENTAL ACCESS");

    await user.type(input, "target");
    await user.click(screen.getByRole("button", { name: "Run experimental command" }));
    await waitFor(() => expect(gatewayMock.current.runSlashCommand)
      .toHaveBeenCalledWith("deploy", "target", expect.any(String)));
    expect(gatewayMock.current.send).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Extension command accepted");
  });

  it("keeps unavailable commands readable without trapping Tab or submitting", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "/fut");
    const unavailable = await screen.findByRole("option", { name: /future.*Detected, unavailable on mobile/ });
    expect(input).toHaveAttribute("aria-activedescendant", unavailable.id);
    expect(unavailable).toHaveAttribute("aria-disabled", "true");
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
    await user.click(unavailable);
    expect(gatewayMock.current.runSlashCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("detected but is unavailable");
  });

  it("fails closed while the command catalog is unavailable", async () => {
    gatewayMock.current.loadSlashCommands = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "/goal status");
    await user.click(screen.getByRole("button", { name: "Run command" }));
    expect(gatewayMock.current.runSlashCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Command catalog unavailable");
  });

  it("completes no-argument commands without adding a space", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "/con");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("/context");
  });

  it("keeps a failed command for retry with the same request id", async () => {
    gatewayMock.current.runSlashCommand = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ kind: "session_accepted" });
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });

    await user.type(input, "/goal status");
    await user.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() => expect(gatewayMock.current.runSlashCommand).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("/goal status");
    const requestId = (gatewayMock.current.runSlashCommand as ReturnType<typeof vi.fn>).mock.calls[0][2];

    await user.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() => expect(gatewayMock.current.runSlashCommand).toHaveBeenCalledTimes(2));
    expect((gatewayMock.current.runSlashCommand as ReturnType<typeof vi.fn>).mock.calls[1][2]).toBe(requestId);
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("supports keyboard completion and blocks unknown or multiline commands", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });

    await user.type(input, "/go");
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(input).toHaveValue("/goal ");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(input).toHaveValue("/goal ");
    await user.clear(input);
    await user.type(input, "/settings");
    await user.click(screen.getByRole("button", { name: "Run command" }));
    expect(gatewayMock.current.runSlashCommand).not.toHaveBeenCalled();
    expect(gatewayMock.current.send).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Unknown or invalid slash command.");
  });

  it("selects, previews, and removes images without exposing their filenames", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await uploadImage(user, "private-local-name.png");

    expect(imageAttachmentMock.prepareImageFile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Image attachment 1 preview" })).toHaveAttribute("src", "blob:preview-1");
    expect(document.body).not.toHaveTextContent("private-local-name.png");

    await user.click(screen.getByRole("button", { name: "Remove image 1" }));
    expect(screen.queryByRole("list", { name: "Image attachments" })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  });

  it("allows an image-only send and clears the preview on success", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await uploadImage(user);
    const prepared = await imageAttachmentMock.prepareImageFile.mock.results[0].value;

    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(sendButton).toBeEnabled();
    await user.click(sendButton);

    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledWith("", [prepared], expect.any(String)));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Image attachments" })).not.toBeInTheDocument());
  });

  it("enables image selection only when send and image capabilities are present", async () => {
    gatewayMock.current.selectedAgent = {
      ...agent,
      capabilities: { ...agent.capabilities, images: false },
    };
    const user = userEvent.setup();
    const view = render(<Composer />);
    await user.click(screen.getByRole("button", { name: "Composer options" }));
    expect(screen.queryByRole("menuitem", { name: /Camera/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Image/ })).toBeDisabled();

    gatewayMock.current.selectedAgent = {
      ...agent,
      capabilities: { ...agent.capabilities, send: false, images: true },
    };
    view.rerender(<Composer />);
    expect(screen.getByRole("menuitem", { name: /^Image/ })).toBeDisabled();

    gatewayMock.current.selectedAgent = agent;
    view.rerender(<Composer />);
    expect(screen.getByRole("menuitem", { name: /^Image/ })).toBeEnabled();
  });

  it("does not carry attachment previews across agent switches", async () => {
    const user = userEvent.setup();
    const view = render(<Composer />);
    await uploadImage(user);

    gatewayMock.current.selectedAgent = { ...agent, id: "agent-2", name: "Agent 2" };
    gatewayMock.current.selectedSnapshot = { ...snapshot, agentId: "agent-2" };
    view.rerender(<Composer />);

    expect(screen.queryByRole("list", { name: "Image attachments" })).not.toBeInTheDocument();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1"));
  });

  it("prepares image files pasted into the textarea", async () => {
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    const pasted = new File(["pasted image"], "clipboard-name.webp", { type: "image/webp" });

    fireEvent.paste(input, { clipboardData: { files: [pasted] } });

    await waitFor(() => expect(imageAttachmentMock.prepareImageFile).toHaveBeenCalledWith(pasted, expect.any(AbortSignal)));
    expect(await screen.findByRole("img", { name: "Image attachment 1 preview" })).toHaveAttribute("src", "blob:preview-1");
    expect(document.body).not.toHaveTextContent("clipboard-name.webp");
  });

  it("prepares dropped image files", async () => {
    render(<Composer />);
    const input = screen.getByLabelText("Message Agent");
    const dropped = new File(["dropped image"], "drop.png", { type: "image/png" });

    fireEvent.drop(input.parentElement!, { dataTransfer: { files: [dropped], types: ["Files"] } });

    await waitFor(() => expect(imageAttachmentMock.prepareImageFile).toHaveBeenCalledWith(dropped, expect.any(AbortSignal)));
  });

  it("preserves text and images after a failed send for a successful retry", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    gatewayMock.current.send = send;
    const user = userEvent.setup();
    render(<Composer />);
    await uploadImage(user);
    const prepared = await imageAttachmentMock.prepareImageFile.mock.results[0].value;
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "try with image");

    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("try with image");
    expect(screen.getByRole("img", { name: "Image attachment 1 preview" })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenNthCalledWith(1, "try with image", [prepared], expect.any(String));
    expect(send).toHaveBeenNthCalledWith(2, "try with image", [prepared], expect.any(String));
    expect(send.mock.calls[1]?.[2]).toBe(send.mock.calls[0]?.[2]);
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("surfaces preparation errors without adding a filename to the status", async () => {
    imageAttachmentMock.prepareImageFile.mockRejectedValueOnce(new Error("Could not decode the image file."));
    const user = userEvent.setup();
    render(<Composer />);
    await user.click(screen.getByRole("button", { name: "Composer options" }));
    await user.click(screen.getByRole("menuitem", { name: /^Image/ }));
    await user.upload(
      screen.getByLabelText("Add image attachments"),
      new File(["bad"], "local-secret.png", { type: "image/png" }),
    );

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not decode the image file."));
    expect(document.body).not.toHaveTextContent("local-secret.png");
  });

  it("sends a steering prompt instead of stopping when a streaming composer has content", async () => {
    gatewayMock.current.selectedSnapshot = {
      ...snapshot,
      messages: [{ id: "stream", role: "assistant", text: "Working", state: "streaming", createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    const user = userEvent.setup();
    render(<Composer />);

    expect(screen.getByRole("button", { name: "Stop agent" })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "change direction");

    expect(screen.queryByRole("button", { name: "Stop agent" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledWith("change direction", undefined, expect.any(String)));
    expect(gatewayMock.current.abort).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop agent" })).toBeInTheDocument());
  });

  it("prevents duplicate stop requests while one is pending", async () => {
    let finish!: () => void;
    gatewayMock.current.selectedSnapshot = {
      ...snapshot,
      messages: [{ id: "stream", role: "assistant", text: "", state: "streaming", createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    gatewayMock.current.abort = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<Composer />);
    const stop = screen.getByRole("button", { name: "Stop agent" });
    await user.click(stop);
    await user.click(stop);
    expect(gatewayMock.current.abort).toHaveBeenCalledTimes(1);
    expect(stop).toBeDisabled();
    finish();
    await waitFor(() => expect(stop).toBeEnabled());
  });

  it("persists drafts to session storage for reload recovery", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await user.type(screen.getByRole("textbox", { name: "Message Agent" }), "survives reload");
    expect(sessionStorage.getItem("prime-web-drafts")).toContain("survives reload");
  });
  it("prevents unsupported file drops and announces the validation error", () => {
    render(<Composer />);
    const input = screen.getByLabelText("Message Agent");
    const pdf = new File(["document"], "private.pdf", { type: "application/pdf" });
    const accepted = fireEvent.drop(input.parentElement!, {
      dataTransfer: { files: [pdf], types: ["Files"] },
    });
    expect(accepted).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("Only JPEG, PNG, or WebP image files");
    expect(imageAttachmentMock.prepareImageFile).not.toHaveBeenCalled();
  });

  it("supports menu arrow keys and restores focus with Escape", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const trigger = screen.getByRole("button", { name: "Composer options" });
    await user.click(trigger);
    const slash = screen.getByRole("menuitem", { name: /^Slash command/ });
    const image = screen.getByRole("menuitem", { name: /^Image/ });
    await waitFor(() => expect(slash).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(image).toHaveFocus();
    await user.keyboard("{Home}");
    expect(slash).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Composer options" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("validates stored draft values before using them", () => {
    sessionStorage.setItem("prime-web-drafts", JSON.stringify({
      "agent-1": 42,
      "other-agent": "valid draft",
      "__proto__": "ignored",
    }));
    const view = render(<Composer />);
    expect(screen.getByRole("textbox", { name: "Message Agent" })).toHaveValue("");

    gatewayMock.current.selectedAgent = { ...agent, id: "other-agent", name: "Other" };
    gatewayMock.current.selectedSnapshot = { ...snapshot, agentId: "other-agent" };
    view.rerender(<Composer />);
    expect(screen.getByRole("textbox", { name: "Message Other" })).toHaveValue("valid draft");
  });

  it("cancels in-progress image preparation on unmount", async () => {
    imageAttachmentMock.prepareImageFile.mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<Composer />);
    const file = new File(["image"], "image.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Add image attachments"), { target: { files: [file] } });
    await waitFor(() => expect(imageAttachmentMock.prepareImageFile).toHaveBeenCalled());
    const signal = imageAttachmentMock.prepareImageFile.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

});
