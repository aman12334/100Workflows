import { ContextManager } from "@/components/context/context-manager";
import { FILE_LIMITS } from "@/lib/files/extract";
import { getDb } from "@/lib/server/db";
import { listContext } from "@/lib/server/db/context";
import { listFiles } from "@/lib/server/db/files";
import { currentWorkspace } from "@/lib/server/workspace";

export const dynamic = "force-dynamic";

export default function ContextPage() {
  const db = getDb();
  const ws = currentWorkspace();
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
      <div className="text-xs font-semibold tracking-[0.16em] text-volt-600 uppercase">Workspace memory</div>
      <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl">Context & files</h1>
      <p className="mt-2 max-w-2xl text-ink-700">
        Things you&apos;d otherwise paste again and again. Nothing here is sent anywhere on its own: it reaches a model only when you insert it into a workflow input and run it.
      </p>
      <ContextManager initialItems={listContext(db, ws)} initialFiles={listFiles(db, ws)} maxBytes={FILE_LIMITS.maxBytes} />
    </div>
  );
}
