import type { ChatMessage } from "../../../shared/ipc";
import { messageText } from "../../../shared/ipc";
import { MessageFrame } from "./chat/MessageFrame";

export function MessageItem({
  t, message, isLatest, onQuote,
}: {
  t: (key: string) => string;
  message: ChatMessage;
  isLatest: boolean;
  onQuote: (text: string) => void;
}): React.JSX.Element {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[4px] bg-(--color-app-bubble) px-4 py-2.5 text-sm leading-relaxed">
          {messageText(message.parts)}
        </div>
      </div>
    );
  }
  return <MessageFrame parts={message.parts} streaming={message.streaming === true} isLatest={isLatest} t={t} onQuote={onQuote} />;
}
