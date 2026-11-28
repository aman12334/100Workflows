import { ChatView } from "@/components/chat/chat-view";
import { chatPageProps } from "@/lib/server/chat-page";

/** A new conversation with the assistant (linked from the sidebar as "Ask the assistant"). */
export default async function NewChatPage() {
  return <ChatView {...await chatPageProps()} conversationId={null} initialMessages={[]} linkedPackages={[]} />;
}
