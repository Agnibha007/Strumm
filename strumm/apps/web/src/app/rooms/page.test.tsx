import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

const authFetch = vi.fn();
vi.mock("web/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

vi.mock("web/components/SongArtwork", () => ({ default: () => null }));

import RoomsPage from "./page";
import { useAuthStore } from "web/store/useAuthStore";

const USER = { id: "u1", username: "host", email: "host@example.com" };

function jsonResponse(body: unknown) {
  return { json: async () => body };
}

function wireBackend(options: {
  rooms?: unknown;
  roomsFail?: boolean;
  create?: unknown;
} = {}) {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/social/rooms/suggestions")) {
      return jsonResponse({ success: true, data: [] });
    }
    if (String(url).includes("/social/rooms/search")) {
      return jsonResponse({ success: true, data: [] });
    }
    if (init?.method === "POST") {
      return jsonResponse(options.create ?? { success: false });
    }
    if (options.roomsFail) throw new Error("network down");
    return jsonResponse({ success: true, data: options.rooms ?? [] });
  });
}

async function renderRooms() {
  await act(async () => {
    render(<RoomsPage />);
  });
}

describe("rooms lobby", () => {
  beforeEach(() => {
    push.mockReset();
    authFetch.mockReset();
    useAuthStore.setState({ user: USER as any, token: "jwt" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the create sheet open, preserves the name, and shows the error", async () => {
    wireBackend({ create: { success: false, error: "Room name already taken." } });
    await renderRooms();

    fireEvent.click(screen.getAllByRole("button", { name: /start a room/i })[0]);

    const nameInput = screen.getByPlaceholderText(/late night chill/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Friday Night" } });

    fireEvent.click(screen.getByRole("button", { name: /open room/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Room name already taken.");

    // The sheet is still open with what the user typed.
    expect(screen.getByPlaceholderText(/late night chill/i)).toHaveProperty(
      "value",
      "Friday Night",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("navigates into the room on success", async () => {
    wireBackend({ create: { success: true, data: { id: "room-9" } } });
    await renderRooms();

    fireEvent.click(screen.getAllByRole("button", { name: /start a room/i })[0]);
    fireEvent.change(screen.getByPlaceholderText(/late night chill/i), {
      target: { value: "Friday Night" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open room/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms/room-9"));
  });

  it("surfaces a lobby load failure instead of pretending the lobby is empty", async () => {
    wireBackend({ roomsFail: true });
    await renderRooms();

    // Regression: the error was written to state that nothing rendered, so an
    // outage looked exactly like "no rooms yet".
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load rooms");
    expect(screen.queryByText("No live rooms right now")).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("still shows the genuine empty state when the lobby really is empty", async () => {
    wireBackend({ rooms: [] });
    await renderRooms();

    expect(await screen.findByText("No live rooms right now")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes the sheet with Escape", async () => {
    wireBackend();
    await renderRooms();

    fireEvent.click(screen.getAllByRole("button", { name: /start a room/i })[0]);
    expect(screen.getByPlaceholderText(/late night chill/i)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/late night chill/i)).toBeNull();
    });
  });
});
