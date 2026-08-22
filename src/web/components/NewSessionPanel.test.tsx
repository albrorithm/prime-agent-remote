import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryListing } from "../../protocol";
import { NewSessionPanel } from "./NewSessionPanel";

const gatewayMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock.current }));

const apiMock = vi.hoisted(() => ({
  listDirectories: vi.fn(),
  createSession: vi.fn(),
}));
vi.mock("../api", () => ({
  listDirectories: (...args: Parameters<typeof apiMock.listDirectories>) => apiMock.listDirectories(...args),
  createSession: (...args: Parameters<typeof apiMock.createSession>) => apiMock.createSession(...args),
}));

const homeListing: DirectoryListing = {
  path: "/home/dev",
  home: "/home/dev",
  crumbs: [
    { name: "/", path: "/", hidden: false },
    { name: "home", path: "/home", hidden: false },
    { name: "dev", path: "/home/dev", hidden: false },
  ],
  entries: [
    { name: "projects", path: "/home/dev/projects", hidden: false },
    { name: ".secrets", path: "/home/dev/.secrets", hidden: true },
  ],
  truncated: false,
};

beforeEach(() => {
  apiMock.listDirectories.mockReset().mockResolvedValue(homeListing);
  apiMock.createSession.mockReset().mockResolvedValue({ requestId: "r", agentId: "agent_new" });
  gatewayMock.current = {
    csrfToken: "token-1",
    createSession: vi.fn().mockResolvedValue("agent_new"),
    selectedAgent: { id: "agent_1", name: "Current", cwd: "/home/dev/projects/current" },
  };
});

describe("NewSessionPanel", () => {
  it("starts browsing at the current session's working directory", async () => {
    render(<NewSessionPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(apiMock.listDirectories).toHaveBeenCalledWith("/home/dev/projects/current"));
  });

  it("falls back to home when the current session has no cwd", async () => {
    gatewayMock.current.selectedAgent = { id: "agent_1", name: "Current" };
    render(<NewSessionPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(apiMock.listDirectories).toHaveBeenCalledWith(undefined));
  });

  it("lists directories, hides dotfiles by default, and toggles them", async () => {
    const user = userEvent.setup();
    render(<NewSessionPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /projects/ })).toBeDefined());
    expect(screen.queryByRole("button", { name: /\.secrets/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show hidden folders" }));
    expect(screen.getByRole("button", { name: /\.secrets/ })).toBeDefined();
  });

  it("descends into a directory and navigates via crumbs", async () => {
    const user = userEvent.setup();
    render(<NewSessionPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /projects/ })).toBeDefined());
    await user.click(screen.getByRole("button", { name: /projects/ }));
    expect(apiMock.listDirectories).toHaveBeenLastCalledWith("/home/dev/projects");
    await user.click(screen.getByRole("button", { name: /home$/ }));
    expect(apiMock.listDirectories).toHaveBeenLastCalledWith("/home");
  });

  it("creates a session for the selected directory and reports completion", async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewSessionPanel onClose={vi.fn()} onCreated={onCreated} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Session name" })).toBeDefined());
    await user.type(screen.getByRole("textbox", { name: "Session name" }), "My session");
    await user.click(screen.getByRole("button", { name: /Start session here/ }));
    expect(gatewayMock.current.createSession).toHaveBeenCalledWith("/home/dev", "My session");
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
  it("keeps the latest directory request when responses arrive out of order", async () => {
    const user = userEvent.setup();
    render(<NewSessionPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole("button", { name: /projects/ });

    let resolveProjects!: (listing: DirectoryListing) => void;
    let resolveHome!: (listing: DirectoryListing) => void;
    apiMock.listDirectories.mockImplementation((path?: string) => new Promise<DirectoryListing>((resolve) => {
      if (path === "/home/dev/projects") resolveProjects = resolve;
      else if (path === "/home") resolveHome = resolve;
    }));

    await user.click(screen.getByRole("button", { name: /projects/ }));
    expect(screen.getByRole("button", { name: /Start session here/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^home$/ }));

    const home: DirectoryListing = { ...homeListing, path: "/home", entries: [] };
    const projects: DirectoryListing = { ...homeListing, path: "/home/dev/projects", entries: [] };
    await act(async () => { resolveHome(home); });
    expect(screen.getByText("/home")).toBeInTheDocument();
    await act(async () => { resolveProjects(projects); });
    expect(screen.getByText("/home")).toBeInTheDocument();
    expect(screen.queryByText("/home/dev/projects")).not.toBeInTheDocument();
  });

  it("disables session creation while loading and after a directory error", async () => {
    let rejectLoad!: (error: Error) => void;
    apiMock.listDirectories.mockReturnValue(new Promise<DirectoryListing>((_resolve, reject) => { rejectLoad = reject; }));
    render(<NewSessionPanel onClose={vi.fn()} onCreated={vi.fn()} />);
    const submit = screen.getByRole("button", { name: /Start session here/ });
    expect(submit).toBeDisabled();
    await act(async () => { rejectLoad(new Error("Directory unavailable")); });
    expect(screen.getByText("Directory unavailable")).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it("does not finish async work after unmount", async () => {
    let resolveLoad!: (listing: DirectoryListing) => void;
    apiMock.listDirectories.mockReturnValue(new Promise<DirectoryListing>((resolve) => { resolveLoad = resolve; }));
    const onCreated = vi.fn();
    const view = render(<NewSessionPanel onClose={vi.fn()} onCreated={onCreated} />);
    view.unmount();
    await act(async () => { resolveLoad(homeListing); });
    expect(onCreated).not.toHaveBeenCalled();
  });


  it("does not report a created session after the panel unmounts", async () => {
    let resolveCreate!: () => void;
    gatewayMock.current.createSession = vi.fn(() => new Promise<void>((resolve) => { resolveCreate = resolve; }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    const view = render(<NewSessionPanel onClose={vi.fn()} onCreated={onCreated} />);
    await screen.findByRole("button", { name: /projects/ });
    await user.click(screen.getByRole("button", { name: /Start session here/ }));
    view.unmount();
    await act(async () => { resolveCreate(); });
    expect(onCreated).not.toHaveBeenCalled();
  });

});
