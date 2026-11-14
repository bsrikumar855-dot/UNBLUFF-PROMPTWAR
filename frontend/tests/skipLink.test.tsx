import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "@/App";
import { AuthProvider } from "@/auth/AuthContext";
import { AppShell } from "@/components/shell/AppShell";
import type { AuthClient } from "@/auth/types";

vi.mock("@/api/endpoints", () => ({ api: { getHealth: vi.fn(async () => ({ status: "ok" })) } }));

const signedOut: AuthClient = {
  configured: true,
  onChange(cb) {
    queueMicrotask(() => cb(null));
    return () => undefined;
  },
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(async () => undefined),
  sendPasswordReset: vi.fn(),
  getIdToken: vi.fn(async () => null),
};

describe("skip link and focus on navigation", () => {
  it("leaves focus at the start on a fresh load, so the skip link is the first stop, and moves focus to the page on navigation", async () => {
    render(
      <AuthProvider client={signedOut}>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell>
            <AppRoutes />
          </AppShell>
        </MemoryRouter>
      </AuthProvider>
    );
    const skip = await screen.findByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main");
    // the skip link is the first focusable element in the document
    const first = document.querySelector('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
    expect(first).toBe(skip);
    // a fresh load does not move focus into the page (that would make the first Tab skip the skip link)
    expect(document.activeElement).not.toBe(document.getElementById("main"));

    // navigating inside the app moves focus to the new page's main landmark
    fireEvent.click(screen.getAllByRole("link", { name: /privacy/i })[0]!);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("main")));
  });
});
