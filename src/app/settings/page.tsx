import { CheckCircle2, CircleDashed, Cpu, EyeOff, Globe, HardDrive, Lock, Network, ScanSearch, Terminal } from "lucide-react";
import { webSearchEnabled } from "@/lib/runtime/executors/market-research";
import { ConnectionCheck } from "@/components/connection-check";
import { PROVIDERS } from "@/lib/providers";
import { getModelConfig } from "@/lib/server/config";
import { actionsLive, connectionStatus } from "@/lib/integrations/registry";
import { accessToken, tokenTooShort } from "@/lib/auth";
import { getDb } from "@/lib/server/db";
import { listAudit } from "@/lib/server/db/audit";
import { currentWorkspace } from "@/lib/server/workspace";

export default function SettingsPage() {
  const config = getModelConfig();
  const provider = PROVIDERS[config.provider];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
      <div className="text-xs font-semibold tracking-[0.16em] text-volt-600 uppercase">Model & keys</div>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">Bring your own key</h1>
      <p className="mt-2 max-w-2xl text-ink-700">
        100 Workflows calls the model with your own API key, so usage is billed to your own Anthropic or OpenAI account. The key stays on
        this computer, in the local server process.
      </p>

      <section className="mt-8 overflow-hidden rounded-3xl border border-line bg-surface">
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center">
          <div
            className={`grid size-14 shrink-0 place-items-center rounded-2xl ${config.configured ? "bg-lime-glow/40 text-[#3b5200]" : "bg-[#ffe9e9] text-coral"}`}
          >
            {config.configured ? <CheckCircle2 className="size-7" /> : <CircleDashed className="size-7" />}
          </div>
          <div className="flex-1">
            <div className="font-display text-lg font-bold text-ink-950">
              {config.configured ? "A key is configured" : "No usable key configured"}
            </div>
            <p className="text-sm text-ink-700">
              {config.configured
                ? `Run the check to confirm ${provider.label} accepts it. The check uses the free models endpoint and spends no credits.`
                : config.problem}
            </p>
          </div>
        </div>
        <dl className="grid border-t border-line text-sm sm:grid-cols-3">
          <Fact icon={Cpu} label="Provider" value={provider.label} />
          <Fact icon={Cpu} label="Model" value={config.model} mono />
          <Fact icon={HardDrive} label="Key location" value={`.env.local · ${config.keyVar}`} mono />
        </dl>
        {config.configured && (
          <div className="border-t border-line bg-canvas/60 p-5">
            <ConnectionCheck />
          </div>
        )}
      </section>

      <section className="mt-8 rounded-3xl border border-line bg-surface p-6">
        <h2 className="font-display text-lg font-bold text-ink-950">Workflow tools</h2>
        <p className="mt-1 text-sm text-ink-700">Tools that cost extra are off until you turn them on in <code className="font-mono">.env.local</code> (restart afterwards).</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ToolRow
            icon={Globe}
            name="Web search"
            on={provider.webSearch && webSearchEnabled(process.env)}
            setting="WORKFLOWS_WEB_SEARCH=on"
            note={
              provider.webSearch
                ? "Anthropic's web search tool, used by Market Research to find real sources (up to 5 searches per run). Searches are billed by Anthropic on top of tokens."
                : `Only available with the Anthropic provider for now. With ${provider.label}, Market Research is skipped.`
            }
          />
          <ToolRow
            icon={ScanSearch}
            name="Model review"
            on={process.env.WORKFLOWS_MODEL_REVIEW !== "off"}
            setting="WORKFLOWS_MODEL_REVIEW=off"
            settingLabel="to turn off"
            note="One extra low-effort call per attempt grades the output against a rubric. Rule-based checks run either way."
          />
        </div>
      </section>

      <IntegrationsSection />

      <SecuritySection />

      <section className="mt-8 grid gap-6 md:grid-cols-2">
        <div className="rounded-3xl border border-line bg-surface p-6">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold text-ink-950">
            <Terminal className="size-5 text-volt-500" /> Add or change your key
          </h2>
          <ol className="mt-4 space-y-4 text-sm text-ink-700">
            <Step n={1}>
              Create a key with <span className="font-semibold text-ink-950">Anthropic</span> (console.anthropic.com → Settings → API keys) or{" "}
              <span className="font-semibold text-ink-950">OpenAI</span> (platform.openai.com → API keys).
            </Step>
            <Step n={2}>
              For Anthropic, run
              <Code>npm run setup</Code>
              and paste the key when asked (input is hidden). For OpenAI, add this line to <code className="font-mono">.env.local</code>:
              <Code>OPENAI_API_KEY=sk-...</Code>
              With both keys set, choose with <code className="font-mono">WORKFLOWS_PROVIDER=openai</code> or <code className="font-mono">anthropic</code>.
            </Step>
            <Step n={3}>
              Restart the app: stop <code className="font-mono">npm run dev</code> and start it again. Environment files are read at
              startup.
            </Step>
          </ol>
          <p className="mt-4 text-xs text-ink-500">
            Prefer to do it by hand? Copy <code className="font-mono">.env.example</code> to <code className="font-mono">.env.local</code> and set{" "}
            <code className="font-mono">ANTHROPIC_API_KEY</code> or <code className="font-mono">OPENAI_API_KEY</code>. To verify from the terminal:{" "}
            <code className="font-mono">npm run check:config</code>.
          </p>
        </div>

        <div className="rounded-3xl bg-ink-950 p-6 text-white">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold">
            <Lock className="size-5 text-lime-glow" /> How your key is protected
          </h2>
          <ul className="mt-4 space-y-3.5 text-sm text-ink-300">
            <Guard icon={EyeOff}>The browser never receives the key. This page only knows whether one is set.</Guard>
            <Guard icon={HardDrive}>
              <code className="font-mono text-white">.env.local</code> is git-ignored, so the key can&apos;t be committed by accident.
            </Guard>
            <Guard icon={Network}>
              The server binds to <code className="font-mono text-white">127.0.0.1</code>. API routes reject requests with a non-local Host or a
              foreign Origin.
            </Guard>
            <Guard icon={Lock}>Server logs redact anything that looks like a key or auth header.</Guard>
          </ul>
        </div>
      </section>
    </div>
  );
}

function Fact({ icon: Icon, label, value, mono }: { icon: typeof Cpu; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-line px-6 py-4 sm:border-r sm:last:border-r-0">
      <Icon className="size-4 text-ink-300" />
      <div className="min-w-0">
        <dt className="text-[11px] tracking-wider text-ink-500 uppercase">{label}</dt>
        <dd className={`truncate font-semibold text-ink-950 ${mono ? "font-mono text-[13px]" : ""}`}>{value}</dd>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-volt-500 text-xs font-bold text-white">{n}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <pre className="my-2 overflow-x-auto rounded-xl bg-ink-950 px-3.5 py-2.5 font-mono text-[13px] text-lime-glow">{children}</pre>;
}

function Guard({ icon: Icon, children }: { icon: typeof Cpu; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-volt-400" />
      <span>{children}</span>
    </li>
  );
}

function ToolRow({
  icon: Icon,
  name,
  on,
  setting,
  settingLabel = "to turn on",
  note,
}: {
  icon: typeof Cpu;
  name: string;
  on: boolean;
  setting: string;
  settingLabel?: string;
  note: string;
}) {
  return (
    <div className="rounded-2xl border border-line p-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4.5 text-volt-500" />
        <span className="font-semibold text-ink-950">{name}</span>
        <span className={`ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${on ? "bg-lime-glow/30 text-[#3b5200]" : "bg-canvas text-ink-700"}`}>
          {on ? "On" : "Off"}
        </span>
      </div>
      <p className="mt-2 text-xs text-ink-700">{note}</p>
      <p className="mt-2 text-xs text-ink-500">
        <code className="font-mono text-ink-800">{setting}</code> {settingLabel}
      </p>
    </div>
  );
}

/** Provider connections. Shows which settings are missing by name; values are never read into the page. */
function IntegrationsSection() {
  const providers = connectionStatus(process.env);
  const live = actionsLive(process.env);
  return (
    <section className="mt-8 rounded-3xl border border-line bg-surface p-6" id="integrations">
      <h2 className="font-display text-lg font-bold text-ink-950">Integrations</h2>
      <p className="mt-1 text-sm text-ink-700">
        Workflows that act on other services read with your own credentials, set in <code className="font-mono">.env.local</code>, and only <em>propose</em> changes. Every
        send, post or update waits for your approval of its exact payload.{" "}
        {live ? (
          <strong className="text-rose-700">Actions are live (WORKFLOWS_ACTIONS=live): approving performs the action.</strong>
        ) : (
          <strong>Actions are in dry-run mode: approvals are recorded but nothing is sent. Set WORKFLOWS_ACTIONS=live to allow real actions.</strong>
        )}
      </p>
      <p className="mt-1 text-xs text-ink-500">&ldquo;Settings present&rdquo; means the values exist, not that the provider accepted them: the first real call proves the credentials.</p>
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {providers.map((p) => (
          <li key={p.id} className="rounded-2xl border border-line p-4">
            <div className="flex items-center gap-2">
              {p.configured ? <CheckCircle2 className="size-4 text-[#3b5200]" /> : <CircleDashed className="size-4 text-coral" />}
              <span className="font-semibold text-ink-950">{p.name}</span>
              <span className="text-xs text-ink-500">{p.configured ? "settings present" : "not connected"}</span>
            </div>
            {!p.configured && (
              <p className="mt-1 text-xs text-ink-700">
                Set <span className="font-mono">{p.missing.join(", ")}</span>
              </p>
            )}
            <p className="mt-2 text-xs text-ink-700">{p.setup}</p>
            {p.scopes.length > 0 && <p className="mt-1 text-xs text-ink-500">Permissions: {p.scopes.join(", ")}</p>}
            <ul className="mt-2 space-y-0.5 text-xs text-ink-700">
              {p.actions.map((a) => (
                <li key={a.ref}>
                  <span className="font-mono">{a.ref}</span> · {a.sideEffect.replace(/_/g, " ")}
                  {a.approval ? " · needs approval" : ""}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SecuritySection() {
  const events = listAudit(getDb(), currentWorkspace(), 20);
  const token = accessToken(process.env);
  const hosts = process.env.WORKFLOWS_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  const rows: Array<[string, string]> = [
    ["Sign-in", token ? (tokenTooShort(process.env) ? "misconfigured: token shorter than 24 characters (everything is locked)" : "on (WORKFLOWS_ACCESS_TOKEN)") : "off: anyone who can reach this server can use it"],
    ["Reachable at", hosts.length ? `localhost and ${hosts.join(", ")}` : "localhost only"],
    ["External actions", actionsLive(process.env) ? "live after approval" : "dry run (nothing is sent)"],
    ["Approver name in audit log", process.env.WORKFLOWS_OPERATOR?.trim() || "local user"],
  ];
  return (
    <section className="mt-8 rounded-3xl border border-line bg-surface p-6" id="security">
      <h2 className="font-display text-lg font-bold text-ink-950">Security</h2>
      <p className="mt-1 text-sm text-ink-700">
        Single-user and local by design: there are no user accounts or roles. Keep it on localhost, or set WORKFLOWS_ACCESS_TOKEN before exposing it to anyone else. See docs/security.md.
      </p>
      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="rounded-2xl bg-canvas/60 p-3">
            <dt className="text-xs font-semibold text-ink-500">{k}</dt>
            <dd className="text-ink-950">{v}</dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-5 text-sm font-semibold text-ink-950">Recent security events</h3>
      {events.length === 0 ? (
        <p className="mt-1 text-xs text-ink-500">None yet. Sign-ins, uploads, deletions and builder saves appear here; approvals are logged on each action.</p>
      ) : (
        <ul className="mt-2 space-y-1 font-mono text-[11px] text-ink-700">
          {events.map((e, i) => (
            <li key={i}>
              {e.createdAt.replace("T", " ").slice(0, 19)} · {e.event} · {e.actor}
              {e.detail ? ` · ${e.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
