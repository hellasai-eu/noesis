import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { ChatWidget } from "@/components/chat/ChatWidget";
import { TUTOR_INPUT_CHAR_LIMIT } from "@/lib/tutor-input-limit";

/**
 * The failure these cover, end to end:
 *
 * A student writes a long answer. Nothing on screen says there is a limit, so
 * they send it. `sendMessage` writes the turn to `open_question_chats` and
 * *then* posts to the tutoring endpoint, which rejects anything over the cap
 * with a 400. The transcript is left showing the student's message with no
 * reply after it and no spinner — the tutor simply never answers — while the
 * only signal is a toast reading `message_too_long`, the machine code rather
 * than the sentence the handler wrote.
 */
describe("ChatWidget — the per-message character cap is visible before sending", () => {
  const under = "x".repeat(TUTOR_INPUT_CHAR_LIMIT - 1);
  const over = "x".repeat(TUTOR_INPUT_CHAR_LIMIT + 5);

  it("does not count characters on a message nowhere near the cap", async () => {
    const user = userEvent.setup();
    render(<ChatWidget messages={[]} onSendMessage={async () => {}} maxLength={TUTOR_INPUT_CHAR_LIMIT} />);

    await user.type(screen.getByRole("textbox"), "short answer");

    expect(screen.queryByText(new RegExp(`/ ${TUTOR_INPUT_CHAR_LIMIT}`))).toBeNull();
  });

  it("counts down once the message approaches the cap", async () => {
    render(<ChatWidget messages={[]} onSendMessage={async () => {}} maxLength={TUTOR_INPUT_CHAR_LIMIT} />);

    // Pasted rather than typed: userEvent types one key per character, and a
    // thousand of them is a slow test for no extra coverage.
    await userEvent.setup().click(screen.getByRole("textbox"));
    await userEvent.setup().paste(under);

    expect(
      screen.getByText(`${under.length} / ${TUTOR_INPUT_CHAR_LIMIT}`),
    ).toBeInTheDocument();
  });

  it("refuses to send over the cap, and says by how much", async () => {
    const onSendMessage = vi.fn(async () => {});
    render(
      <ChatWidget messages={[]} onSendMessage={onSendMessage} maxLength={TUTOR_INPUT_CHAR_LIMIT} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox"));
    await user.paste(over);

    expect(
      screen.getByText(
        `5 characters over the ${TUTOR_INPUT_CHAR_LIMIT}-character limit — shorten your message to send it.`,
      ),
    ).toBeInTheDocument();


    // The button is disabled, and pressing it does nothing — the message never
    // reaches the handler that would reject it.
    const send = screen.getByRole("button");
    expect(send).toBeDisabled();
    await user.click(send);
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("still sends a message that fits", async () => {
    const onSendMessage = vi.fn(async () => {});
    render(
      <ChatWidget messages={[]} onSendMessage={onSendMessage} maxLength={TUTOR_INPUT_CHAR_LIMIT} />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "because light scatters");
    await user.click(screen.getByRole("button"));

    expect(onSendMessage).toHaveBeenCalledWith("because light scatters");
  });

  // The cap is judged on the trimmed value, because that is what `handleSubmit`
  // sends and what the handlers measure. Gating on the raw textarea contents
  // would refuse a message the server would have accepted.
  it("ignores surrounding whitespace when applying the cap", async () => {
    const onSendMessage = vi.fn(async () => {});
    render(
      <ChatWidget
        messages={[]}
        onSendMessage={onSendMessage}
        inputType="textarea"
        maxLength={TUTOR_INPUT_CHAR_LIMIT}
      />,
    );

    const exact = "x".repeat(TUTOR_INPUT_CHAR_LIMIT);
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox"));
    await user.paste(`\n\n  ${exact}  \n\n`);

    expect(screen.queryByText(/over the/)).toBeNull();
    expect(screen.getByRole("button")).toBeEnabled();

    await user.click(screen.getByRole("button"));
    expect(onSendMessage).toHaveBeenCalledWith(exact);
  });

  it("leaves a widget with no cap unconstrained", async () => {
    const onSendMessage = vi.fn(async () => {});
    render(<ChatWidget messages={[]} onSendMessage={onSendMessage} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox"));
    await user.paste(over);
    await user.click(screen.getByRole("button"));

    expect(onSendMessage).toHaveBeenCalledWith(over);
  });
});

/**
 * Enter is overloaded in textarea mode — it sends, and Shift+Enter breaks the
 * line — and both tutor surfaces run in that mode precisely so students can
 * write long answers. An unannounced Enter-sends rule costs them a
 * half-finished turn, which is not free: it draws a tutor reply and counts
 * toward the 20-message review pause.
 */
describe("ChatWidget — the keyboard hint follows the chosen locale", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows the hint in English", () => {
    render(<ChatWidget messages={[]} onSendMessage={async () => {}} inputType="textarea" />);

    expect(screen.getByText("Enter to send · Shift+Enter for a new line")).toBeInTheDocument();
  });

  it("shows the hint in Greek when the locale is Greek", async () => {
    await i18n.changeLanguage("el");
    render(<ChatWidget messages={[]} onSendMessage={async () => {}} inputType="textarea" />);

    expect(screen.getByText("Enter για αποστολή · Shift+Enter για νέα γραμμή")).toBeInTheDocument();
  });

  it("translates the over-limit warning too", async () => {
    await i18n.changeLanguage("el");
    render(
      <ChatWidget
        messages={[]}
        onSendMessage={async () => {}}
        inputType="textarea"
        maxLength={TUTOR_INPUT_CHAR_LIMIT}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox"));
    await user.paste("x".repeat(TUTOR_INPUT_CHAR_LIMIT + 5));

    expect(
      screen.getByText(
        `5 χαρακτήρες πάνω από το όριο των ${TUTOR_INPUT_CHAR_LIMIT} χαρακτήρων — συντομεύστε το μήνυμά σας για να το στείλετε.`,
      ),
    ).toBeInTheDocument();
  });

  it("stays silent in single-line mode, where Enter is not overloaded", () => {
    render(<ChatWidget messages={[]} onSendMessage={async () => {}} inputType="input" />);

    expect(screen.queryByText(/Shift\+Enter/)).toBeNull();
  });
});
