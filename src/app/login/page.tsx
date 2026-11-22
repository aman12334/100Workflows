import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink-950">Sign in</h1>
      <p className="mt-2 text-sm text-ink-700">This installation is protected by an access token (WORKFLOWS_ACCESS_TOKEN). Ask the person who runs it.</p>
      <LoginForm />
    </div>
  );
}
