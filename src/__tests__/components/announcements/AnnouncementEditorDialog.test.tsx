import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnnouncementEditorDialog } from "@/components/announcements/AnnouncementEditorDialog";

const SECTIONS = [
  { offeringId: "off-a", label: "Section A" },
  { offeringId: "off-b", label: "Section B" },
];

describe("AnnouncementEditorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the create title when no initial values", () => {
    render(
      <AnnouncementEditorDialog
        open
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText("New announcement")).toBeInTheDocument();
  });

  it("renders the edit title when initial values are provided", () => {
    render(
      <AnnouncementEditorDialog
        open
        onOpenChange={() => {}}
        initialValues={{ title: "Existing", body: "Body here" }}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText("Edit announcement")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Existing")).toBeInTheDocument();
  });

  it("validates required title and body", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AnnouncementEditorDialog
        open
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("button", { name: /post announcement/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("Title is required")).toBeInTheDocument();
  });

  it("submits trimmed values with empty offeringIds when no sections are selected", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AnnouncementEditorDialog
        open
        onOpenChange={() => {}}
        sections={SECTIONS}
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText("Title"), "  Midterm  ");
    await user.type(screen.getByLabelText("Body"), "  Be ready.  ");
    await user.click(screen.getByRole("button", { name: /post announcement/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      title: "Midterm",
      body: "Be ready.",
      offeringIds: [],
      expiresAt: null,
    });
  });

  it("includes selected offeringIds in the submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AnnouncementEditorDialog
        open
        onOpenChange={() => {}}
        sections={SECTIONS}
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText("Title"), "Targeted");
    await user.type(screen.getByLabelText("Body"), "Section A only");
    await user.click(screen.getByRole("checkbox", { name: /Target section Section A/i }));
    await user.click(screen.getByRole("button", { name: /post announcement/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      title: "Targeted",
      body: "Section A only",
      offeringIds: ["off-a"],
      expiresAt: null,
    });
  });

  it("preserves initial offeringIds when editing", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AnnouncementEditorDialog
        open
        onOpenChange={() => {}}
        sections={SECTIONS}
        initialValues={{ title: "Edit me", body: "Hello", offeringIds: ["off-b"] }}
        onSubmit={onSubmit}
      />,
    );
    expect(
      screen.getByRole("checkbox", { name: /Target section Section B/i }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      title: "Edit me",
      body: "Hello",
      offeringIds: ["off-b"],
      expiresAt: null,
    });
  });

  it("preserves an initial expiresAt and forwards it to onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const initialExpiry = "2026-05-01T23:59:59.999Z";
    render(
      <AnnouncementEditorDialog
        open
        onOpenChange={() => {}}
        initialValues={{
          title: "With expiry",
          body: "Body",
          expiresAt: initialExpiry,
        }}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      title: "With expiry",
      body: "Body",
      offeringIds: [],
      expiresAt: initialExpiry,
    });
  });

  it("clears the expiration date when the Clear button is pressed", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AnnouncementEditorDialog
        open
        onOpenChange={() => {}}
        initialValues={{
          title: "Clear me",
          body: "Body",
          expiresAt: "2026-05-01T23:59:59.999Z",
        }}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("button", { name: /clear expiration date/i }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      title: "Clear me",
      body: "Body",
      offeringIds: [],
      expiresAt: null,
    });
  });
});
