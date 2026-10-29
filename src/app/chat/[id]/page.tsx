import { notFound } from "next/navigation";
import { ChatView } from "@/components/chat/chat-view";
import { chatPageProps } from "@/lib/server/chat-page";
import { getDb } from "@/lib/server/db";
import { getConversation } from "@/lib/server/db/conversations";
import { packagesForConversation } from "@/lib/server/db/packages";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const stored = getConversation(db, id);
  if (!stored) notFound();
  const linkedPackages = packagesForConversation(db, id);

  return (
    <ChatView
      key={id}
      {...await chatPageProps()}
      conversationId={id}
      initialMessages={stored.messages}
      linkedPackages={linkedPackages}
    />
  );
}
