import { ChatView } from "@/components/chat/chat-view";
import { chatPageProps } from "@/lib/server/chat-page";

export default async function NewChatPage() {
  return <ChatView {...await chatPageProps()} conversationId={null} initialMessages={[]} linkedPackages={[]} />;
}
