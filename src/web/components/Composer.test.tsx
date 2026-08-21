import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, AgentSummary } from "../../protocol";
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

describe("Composer", () => {
  it("sends trimmed text and clears the draft only after success", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
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

    await waitFor(() => expect(imageAttachmentMock.prepareImageFile).toHaveBeenCalledWith(pasted));
    expect(await screen.findByRole("img", { name: "Image attachment 1 preview" })).toHaveAttribute("src", "blob:preview-1");
    expect(document.body).not.toHaveTextContent("clipboard-name.webp");
  });

  it("prepares dropped image files", async () => {
    render(<Composer />);
    const input = screen.getByLabelText("Message Agent");
    const dropped = new File(["dropped image"], "drop.png", { type: "image/png" });

    fireEvent.drop(input.parentElement!, { dataTransfer: { files: [dropped], types: ["Files"] } });

    await waitFor(() => expect(imageAttachmentMock.prepareImageFile).toHaveBeenCalledWith(dropped));
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
});
