import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

const authFetch = vi.fn();
vi.mock("web/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

import RoomsPage from "./page";
import { useAuthStore } from "web/store/useAuthStore";

const response = (data: unknown) => ({
  ok: true,
  json: async () => ({ success: true, data }),
});

describe("new rooms lobby", () => {
  beforeEach(() => {
    push.mockReset();
    authFetch.mockReset();
    useAuthStore.setState({ user: { id: "host-1" } as any, token: "jwt" });
  });

  it("creates a room and navigates to it", async () => {
    authFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return response({ id: "room-1" });
      return response([]);
    });

    render(<RoomsPage />);
    fireEvent.change(screen.getByLabelText("Room name"), { target: { value: "Friday Night" } });
    fireEvent.click(screen.getByRole("button", { name: /create room/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms/room-1"));
    expect(authFetch).toHaveBeenCalledWith("/proxy/social/rooms", expect.objectContaining({ method: "POST" }));
  });

  it("resolves a code, joins the room, and navigates", async () => {
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/by-code/")) return response({ id: "room-2" });
      if (String(url).endsWith("/join") && init?.method === "POST") return response({ id: "room-2" });
      return response([]);
    });

    render(<RoomsPage />);
    fireEvent.change(screen.getByLabelText("Room code"), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: /join room/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms/room-2"));
  });
});
