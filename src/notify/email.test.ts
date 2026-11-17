import { afterEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn(async () => ({ messageId: "1" }));
const createTransport = vi.fn((options: unknown) => (void options, { sendMail }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

const mail = { to: "asha@acme.example", subject: "Hi", text: "Hello", html: "<p>Hello</p>" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  sendMail.mockClear();
  createTransport.mockClear();
});

describe("sendEmail", () => {
  it("sends through the mailbox's SMTP server when one is set", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.hostinger.com");
    vi.stubEnv("SMTP_USER", "hello@alro.example");
    vi.stubEnv("SMTP_PASSWORD", "secret");
    vi.stubEnv("RESEND_API_KEY", "re_key");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { emailConfigured, sendEmail } = await import("./email");
    expect(emailConfigured()).toBe(true);
    expect(await sendEmail(mail)).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.hostinger.com", port: 465, secure: true, auth: { user: "hello@alro.example", pass: "secret" } }));
    expect(sendMail).toHaveBeenCalledWith({ from: "hello@alro.example", ...mail });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses STARTTLS on port 587", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.example");
    vi.stubEnv("SMTP_PORT", "587");
    vi.stubEnv("SMTP_USER", "u");
    vi.stubEnv("SMTP_PASSWORD", "p");
    const { sendEmail } = await import("./email");
    await sendEmail(mail);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false }));
  });

  it("falls back to Resend, and to not sending at all", async () => {
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("RESEND_API_KEY", "");
    let email = await import("./email");
    expect(email.emailConfigured()).toBe(false);
    expect(await email.sendEmail(mail)).toBe(false);

    vi.resetModules();
    vi.stubEnv("RESEND_API_KEY", "re_key");
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    email = await import("./email");
    expect(await email.sendEmail(mail)).toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({ method: "POST" }));
    expect(createTransport).not.toHaveBeenCalled();
  });
});
