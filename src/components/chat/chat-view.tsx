"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { KeyRound, Package, Plus, Sparkles, TriangleAlert } from "lucide-react";
import { Logo } from "@/components/logo";
import { WorkflowMiniCard } from "@/components/workflow-bits";
import { api } from "@/lib/api-client";
import type { Category } from "@/lib/catalog/schema";
import type { ApiError, ChatReply, StoredMessage, WorkflowRef } from "@/lib/chat-types";
import { Composer, EmptyState, ErrorCard, ThinkingIndicator, UserBubble } from "./chat-parts";
import { SelectableCard, SelectionTray } from "./selection";

interface Props {
  conversationId: string | null;
  initialMessages: StoredMessage[];
  linkedPackages: Array<{ id: string; name: string }>;
  workflowNames: Record<string, string>;
  configured: boolean;
  configProblem?: string;
  providerLabel: string;
  catalogSize: number;
  categoryCounts: Partial<Record<Category, number>>;
}

export function ChatView(props: Props) {
  const { configured, configProblem, providerLabel, catalogSize, categoryCounts, workflowNames, linkedPackages } = props;
  const router = useRouter();
  const [conversationId, setConversationId] = useState(props.conversationId);
  const [messages, setMessages] = useState<StoredMessage[]>(props.initialMessages);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (messages.length === 0 && !pending && !error) return; // keep the hero in view on an empty chat
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending, error]);

  // Every verified workflow shown in this conversation, so the tray can show names.
  const refs = new Map<string, WorkflowRef>();
  for (const m of messages) {
    for (const r of m.reply?.recommendations ?? []) refs.set(r.workflow.id, r.workflow);
    for (const w of m.reply?.workflows ?? []) refs.set(w.id, w);
  }

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = async (text: string) => {
    const content = text.trim();
    if (!content || pending) return;
    setDraft("");
    setError(null);
    setPending(true);
    setOptimistic(content);

    const path = conversationId ? `/api/conversations/${conversationId}/messages` : "/api/conversations";
    const res = await api<{ conversationId?: string; messages: StoredMessage[] }>(path, { body: { content } });
    setOptimistic(null);
    setPending(false);

    const newId = (res.ok ? res.data.conversationId : (res.body.conversationId as string | undefined)) ?? conversationId;
    if (newId && newId !== conversationId) {
      setConversationId(newId);
      // Update the address without remounting, so a reload or a shared link returns to this chat.
      window.history.replaceState(null, "", `/chat/${newId}`);
    }
    if (res.ok) {
      setMessages((m) => [...m, ...res.data.messages]);
      return;
    }
    const stored = res.body.userMessage as StoredMessage | undefined;
    if (stored) setMessages((m) => [...m, stored]);
    else setDraft(content); // nothing was saved; give the text back
    setError(res.error);
  };

  const retry = async () => {
    if (!conversationId) return;
    setError(null);
    setPending(true);
    const res = await api<{ messages: StoredMessage[] }>(`/api/conversations/${conversationId}/retry`);
    setPending(false);
    if (res.ok) setMessages((m) => [...m, ...res.data.messages]);
    else setError(res.error);
  };

  const createPackage = async () => {
    setCreating(true);
    const goal = messages.find((m) => m.role === "user")?.content ?? "";
    const res = await api<{ id: string }>("/api/packages", { body: { workflowIds: selected, conversationId, goal: goal.slice(0, 2000) } });
    if (res.ok) {
      router.push(`/packages/${res.data.id}`);
      router.refresh();
      return;
    }
    setCreating(false);
    setError(res.error);
  };

  const lastIsUnanswered = messages.length > 0 && messages[messages.length - 1].role === "user";
  const empty = messages.length === 0 && !optimistic;

  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col px-4 sm:px-8">
      <header className="flex items-center justify-between gap-3 py-5">
        <div className="flex min-w-0 items-center gap-2 text-sm text-ink-500">
          <Sparkles className="size-4 shrink-0 text-ink-700" />
          <span className="truncate">
            Guided by your own {providerLabel} key · {catalogSize} workflows in the catalog
          </span>
        </div>
        {!empty && (
          <Link
            href="/"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-hover hover:text-ink-950"
          >
            <Plus className="size-3.5" /> New chat
          </Link>
        )}
      </header>

      {!configured && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border bg-danger-tint p-4 text-sm text-coral">
          <KeyRound className="mt-0.5 size-5 shrink-0" />
          <div>
            <div className="font-semibold">Connect a model key to start chatting</div>
            <p className="mt-0.5 text-coral/80">
              {configProblem} You can still browse the{" "}
              <Link href="/library" className="font-semibold underline">
                workflow library
              </Link>
              .{" "}
              <Link href="/settings" className="font-semibold underline">
                Setup instructions →
              </Link>
            </p>
          </div>
        </div>
      )}

      {linkedPackages.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-transparent bg-volt-50/60 px-4 py-3 text-sm text-ink-950">
          <Package className="size-4 text-volt-600" />
          Packages from this chat:
          {linkedPackages.map((p) => (
            <Link key={p.id} href={`/packages/${p.id}`} className="rounded-full bg-surface px-3 py-0.5 font-semibold text-volt-600 ring-1 ring-volt-100 hover:ring-volt-400">
              {p.name}
            </Link>
          ))}
        </div>
      )}

      <div className="flex-1">
        {empty && <EmptyState categoryCounts={categoryCounts} onPick={(t) => void submit(t)} disabled={!configured} />}

        <div className="space-y-6 pb-6">
          {messages.map((m) =>
            m.role === "user" ? (
              <UserBubble key={m.id} text={m.content} />
            ) : (
              <AssistantMessage key={m.id} message={m} selected={selected} onToggle={toggle} workflowNames={workflowNames} />
            ),
          )}
          {optimistic && <UserBubble text={optimistic} />}
          {pending && <ThinkingIndicator />}
          {error && <ErrorCard error={error} onRetry={lastIsUnanswered ? retry : () => setError(null)} />}
        </div>
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 -mx-4 bg-canvas px-4 pt-6 pb-5 sm:-mx-8 sm:px-8">
        {selected.length > 0 && (
          <SelectionTray
            selected={selected.map((id) => refs.get(id)).filter((r): r is WorkflowRef => Boolean(r))}
            workflowNames={workflowNames}
            onRemove={toggle}
            onClear={() => setSelected([])}
            onCreate={createPackage}
            creating={creating}
          />
        )}
        <Composer
          inputRef={inputRef}
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submit(draft)}
          disabled={!configured}
          pending={pending}
          hero={empty}
        />
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  selected,
  onToggle,
  workflowNames,
}: {
  message: StoredMessage;
  selected: string[];
  onToggle: (id: string) => void;
  workflowNames: Record<string, string>;
}) {
  const reply: ChatReply | undefined = message.reply;
  const recommendations = reply?.recommendations ?? [];
  const mentioned = reply?.workflows ?? [];
  return (
    <div className="animate-rise flex gap-3">
      <div className="mt-1 hidden shrink-0 sm:block">
        <Logo size={32} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="rounded-[16px] rounded-tl-lg border border-line bg-surface px-5 py-4">
          <div className="prose-flow text-ink-950">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        </div>

        {recommendations.length > 0 && (
          <div className="mt-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-ink-500 uppercase">
              Recommended · tick the ones you want in a package
            </div>
            <div className="grid gap-2.5">
              {recommendations.map((r) => (
                <SelectableCard
                  key={r.workflow.id}
                  workflow={r.workflow}
                  reason={r.reason}
                  checked={selected.includes(r.workflow.id)}
                  onToggle={() => onToggle(r.workflow.id)}
                  workflowNames={workflowNames}
                />
              ))}
            </div>
          </div>
        )}

        {mentioned.length > 0 && (
          <div className="mt-3">
            <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-ink-500 uppercase">
              {recommendations.length ? "Also mentioned" : "Workflows mentioned · verified in catalog"}
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {mentioned.map((w) =>
                recommendations.length ? (
                  <WorkflowMiniCard key={w.id} workflow={w} />
                ) : (
                  <SelectableCard
                    key={w.id}
                    workflow={w}
                    checked={selected.includes(w.id)}
                    onToggle={() => onToggle(w.id)}
                    workflowNames={workflowNames}
                    compact
                  />
                ),
              )}
            </div>
          </div>
        )}

        {reply && reply.unknownWorkflowIds.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-transparent bg-warn-tint px-3.5 py-2.5 text-xs text-ink-950">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The reply referenced {reply.unknownWorkflowIds.map((id) => `“${id}”`).join(", ")}, which{" "}
              {reply.unknownWorkflowIds.length === 1 ? "is" : "are"} not in the catalog. Ignore {reply.unknownWorkflowIds.length === 1 ? "it" : "them"}.
            </span>
          </div>
        )}

        {reply?.stopped === "step_limit" && <p className="mt-2 text-xs text-ink-500">Stopped at the per-turn step limit; the answer may be incomplete.</p>}
        {reply?.stopped === "max_tokens" && <p className="mt-2 text-xs text-ink-500">The answer hit the length limit and was cut off.</p>}

        {reply && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 px-1 font-mono text-[11px] text-ink-500">
            <span>{reply.model}</span>
            <span>
              {reply.usage.modelCalls} call{reply.usage.modelCalls === 1 ? "" : "s"}
            </span>
            <span>
              {reply.usage.inputTokens.toLocaleString()} in · {reply.usage.outputTokens.toLocaleString()} out tokens
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
