import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandCatalog } from "../../protocol";
import { ModelSheet } from "./ModelSheet";

const gatewayMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock.current }));

const agentId = "agent-1";

function catalogWith(currentModel: string, currentEffort: string): SlashCommandCatalog {
  return {
    agentId,
    agentRevision: 1,
    partial: false,
    commands: [
      {
        name: "model",
        description: "Show or select the session model",
        source: "adapter",
        availability: "available",
        takesArguments: true,
        options: [
          { value: "openai/first", label: "First model", current: currentModel === "openai/first" },
          { value: "openai/second", label: "Second model", current: currentModel === "openai/second" },
        ],
      },
      {
        name: "effort",
        description: "Show or select thinking level",
        source: "adapter",
        availability: "available",
        takesArguments: true,
        options: [
          { value: "low", label: "Low", current: currentEffort === "low" },
          { value: "high", label: "High", current: currentEffort === "high" },
        ],
      },
    ],
  };
}

beforeEach(() => {
  gatewayMock.current = {
    runSlashCommand: vi.fn().mockResolvedValue({ kind: "model", provider: "openai", modelId: "second" }),
    loadSlashCommands: vi.fn().mockResolvedValue(catalogWith("openai/second", "low")),
  };
});

function open(catalog = catalogWith("openai/first", "low"), onClose = vi.fn()) {
  const onCatalogChange = vi.fn();
  const view = render(
    <ModelSheet agentId={agentId} catalog={catalog} onCatalogChange={onCatalogChange} onClose={onClose} />,
  );
  return { view, onCatalogChange, onClose };
}

describe("ModelSheet", () => {
  it("marks the current model and thinking level from the catalog", () => {
    open(catalogWith("openai/second", "high"));
    expect(screen.getByRole("dialog", { name: "Model and effort" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("radio", { name: /Second model/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /First model/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "High" })).toBeChecked();
  });

  it("runs the model command and asks the catalog again so the check moves", async () => {
    const user = userEvent.setup();
    const { onCatalogChange } = open();

    await user.click(screen.getByRole("radio", { name: /Second model/ }));

    await waitFor(() => expect(gatewayMock.current.runSlashCommand).toHaveBeenCalledWith("model", "openai/second"));
    expect(gatewayMock.current.loadSlashCommands).toHaveBeenCalledWith(agentId);
    // The marks are the catalog's answer, never a local guess about what the
    // session became.
    await waitFor(() => expect(onCatalogChange).toHaveBeenCalledWith(catalogWith("openai/second", "low")));
  });

  it("runs the effort command from the segmented row", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("radio", { name: "High" }));
    await waitFor(() => expect(gatewayMock.current.runSlashCommand).toHaveBeenCalledWith("effort", "high"));
  });

  it("says which row is being applied and ignores a second tap until it settles", async () => {
    let finish!: () => void;
    gatewayMock.current.runSlashCommand = vi.fn(() => new Promise((resolve) => {
      finish = () => resolve({ kind: "model", provider: "openai", modelId: "second" });
    }));
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("radio", { name: /Second model/ }));
    const applying = await screen.findByText("Applying…");
    expect(applying).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /First model/ }));
    expect(gatewayMock.current.runSlashCommand).toHaveBeenCalledTimes(1);

    finish();
    await waitFor(() => expect(screen.queryByText("Applying…")).not.toBeInTheDocument());
  });

  it("stays open when the command fails, because the banner is about what is on screen", async () => {
    gatewayMock.current.runSlashCommand = vi.fn().mockRejectedValue(new Error("adapter refused"));
    const user = userEvent.setup();
    const { onClose } = open();

    await user.click(screen.getByRole("radio", { name: /Second model/ }));
    await waitFor(() => expect(gatewayMock.current.runSlashCommand).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Model and effort" })).toBeInTheDocument();
    // The failed pick must not leave the sheet inert.
    await waitFor(() => expect(screen.queryByText("Applying…")).not.toBeInTheDocument());
  });

  it("closes on Escape, on the backdrop, and from the Close button", async () => {
    const user = userEvent.setup();

    const escape = open();
    await user.keyboard("{Escape}");
    expect(escape.onClose).toHaveBeenCalledTimes(1);
    escape.view.unmount();

    const close = open();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(close.onClose).toHaveBeenCalledTimes(1);
    close.view.unmount();

    const backdrop = open();
    await user.click(document.querySelector(".model-sheet-scrim")!);
    expect(backdrop.onClose).toHaveBeenCalledTimes(1);
    // A tap inside the sheet is not a tap on the backdrop.
    await user.click(screen.getByRole("radiogroup", { name: "Model" }));
    expect(backdrop.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows only the lists the session actually offers", () => {
    open({ ...catalogWith("openai/first", "low"), commands: [] });
    expect(screen.queryByRole("radiogroup", { name: "Model" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Thinking level" })).not.toBeInTheDocument();
    expect(screen.getByText(/does not offer a model/)).toBeInTheDocument();
  });

  it("treats an unavailable command as no options at all", () => {
    const catalog = catalogWith("openai/first", "low");
    catalog.commands[1].availability = "unavailable";
    open(catalog);
    expect(screen.getByRole("radiogroup", { name: "Model" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Thinking level" })).not.toBeInTheDocument();
  });
});
