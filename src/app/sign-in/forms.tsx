"use client";

import Link from "next/link";
import { useActionState, type MouseEvent, type ReactNode } from "react";
import { acceptInviteAction, confirmSignUpAction, redeemSignInLinkAction, requestResetAction, requestSignInLinkAction, resetPasswordAction, signInAction, signUpAction, type AuthState } from "./actions";

type Action = (prev: AuthState, form: FormData) => Promise<AuthState>;

function AuthForm({ action, submit, busy, children }: { action: Action; submit: string; busy: string; children: ReactNode }) {
  const [state, run, pending] = useActionState<AuthState, FormData>(action, {});
  if (state.done) return <p>{state.done}</p>;
  return (
    <form action={run} className="auth-form">
      {children}
      {state.error && (
        <p className="error small" role="alert">
          {state.error}
        </p>
      )}
      <button disabled={pending}>{pending ? busy : submit}</button>
    </form>
  );
}

const Email = ({ value }: { value?: string }) => (
  <label className="small">
    Work email
    <input name="email" type="email" autoComplete="email" defaultValue={value} readOnly={!!value} required />
  </label>
);

const NewPassword = () => (
  <label className="small">
    Password <span className="muted">(10 characters or more)</span>
    <input name="password" type="password" autoComplete="new-password" minLength={10} required />
  </label>
);

export function SignInForm({ next }: { next: string }) {
  return (
    <AuthForm action={signInAction} submit="Sign in" busy="Signing in…">
      <input type="hidden" name="next" value={next} />
      <Email />
      <label className="small">
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <Link className="link small" href="/reset">
        Forgot your password?
      </Link>
    </AuthForm>
  );
}

export function SignInLinkForm({ next }: { next: string }) {
  return (
    <AuthForm action={requestSignInLinkAction} submit="Email me a sign-in link" busy="Sending…">
      <input type="hidden" name="next" value={next} />
      <Email />
    </AuthForm>
  );
}

/** The emailed link's page: nothing happens until the button is pressed. */
export function RedeemSignInLinkForm({ token, next }: { token: string; next: string }) {
  return (
    <AuthForm action={redeemSignInLinkAction} submit="Sign in" busy="Signing in…">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="next" value={next} />
    </AuthForm>
  );
}

/**
 * "Continue with Google" on the sign-up form: sends the company and name typed so far to the
 * provider round trip (/api/auth/sso/start), which creates the company once the address is proven.
 */
function ContinueWith({ providers }: { providers: { id: string; label: string }[] }) {
  if (!providers.length) return null;
  const go = (provider: string) => (event: MouseEvent<HTMLButtonElement>) => {
    const form = event.currentTarget.form;
    if (!form) return;
    const company = form.elements.namedItem("company") as HTMLInputElement | null;
    const name = form.elements.namedItem("name") as HTMLInputElement | null;
    if (!company?.reportValidity() || !name?.reportValidity()) return;
    const out = document.createElement("form");
    out.method = "post";
    out.action = "/api/auth/sso/start";
    const fields = { provider, company: company.value, name: name.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    for (const [key, value] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      out.append(input);
    }
    document.body.append(out);
    out.submit();
  };
  return (
    <>
      {providers.map((p) => (
        <button key={p.id} type="button" className="button-link" onClick={go(p.id)}>
          Continue with {p.label}
        </button>
      ))}
      <p className="muted small center">or with a password</p>
    </>
  );
}

export function SignUpForm({ confirmByEmail, providers = [] }: { confirmByEmail: boolean; providers?: { id: string; label: string }[] }) {
  return (
    <AuthForm action={signUpAction} submit={confirmByEmail ? "Send me a confirmation link" : "Create your company"} busy={confirmByEmail ? "Sending…" : "Creating…"}>
      {/* The browser's time zone, so briefs and deadlines land at the right local time from the start. */}
      <input type="hidden" name="timezone" ref={(el) => void (el && (el.value = Intl.DateTimeFormat().resolvedOptions().timeZone))} />
      <label className="small">
        Company name
        <input name="company" autoComplete="organization" required />
      </label>
      <label className="small">
        Your name
        <input name="name" autoComplete="name" required />
      </label>
      {/* Not offered on open sign-up, where single sign-on is off. */}
      {!confirmByEmail && <ContinueWith providers={providers} />}
      <Email />
      {/* When the address has to be confirmed first, the password is chosen from the link. */}
      {!confirmByEmail && <NewPassword />}
    </AuthForm>
  );
}

export function ConfirmSignUpForm({ token }: { token: string }) {
  return (
    <AuthForm action={confirmSignUpAction} submit="Create your company" busy="Creating…">
      <input type="hidden" name="token" value={token} />
      <NewPassword />
    </AuthForm>
  );
}

export function InviteForm({ token, email }: { token: string; email: string }) {
  return (
    <AuthForm action={acceptInviteAction} submit="Join" busy="Joining…">
      <input type="hidden" name="token" value={token} />
      <Email value={email} />
      <label className="small">
        Your name
        <input name="name" autoComplete="name" required />
      </label>
      <NewPassword />
    </AuthForm>
  );
}

export function RequestResetForm() {
  return (
    <AuthForm action={requestResetAction} submit="Send me a link" busy="Sending…">
      <Email />
    </AuthForm>
  );
}

export function ResetForm({ token }: { token: string }) {
  return (
    <AuthForm action={resetPasswordAction} submit="Save and sign in" busy="Saving…">
      <input type="hidden" name="token" value={token} />
      <NewPassword />
    </AuthForm>
  );
}
