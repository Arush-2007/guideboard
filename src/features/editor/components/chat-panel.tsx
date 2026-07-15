"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2, SendHorizontal, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/client";

type ChatMessage = { role: "user" | "assistant"; content: string };

export function ChatPanel({ workflowId }: { workflowId: string }) {
  void workflowId;

  const router = useRouter();
  const trpc = useTRPC();
  const bottomRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hi! Describe what you want to automate and I'll build it for you.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const createConversation = useMutation(
    trpc.conversations.create.mutationOptions({
      onError: (err) => {
        toast.error(err.message ?? "Failed to start chat");
      },
    }),
  );

  const chatMutation = useMutation(
    trpc.conversations.chat.mutationOptions({
      onError: (err) => {
        toast.error(err.message ?? "Failed to send message");
      },
    }),
  );

  const didCreateRef = useRef(false);
  useEffect(() => {
    if (didCreateRef.current) return;
    didCreateRef.current = true;
    createConversation.mutate(undefined, {
      onSuccess: (data) => {
        setConversationId(data.conversationId);
      },
    });
  }, [createConversation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !conversationId || isLoading) return;

    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setIsLoading(true);

    try {
      const result = await chatMutation.mutateAsync({
        conversationId,
        message: text,
      });

      setMessages((m) => [...m, { role: "assistant", content: result.reply }]);

      if (result.workflowId) {
        toast.success("Workflow created! Opening it now...");
        window.setTimeout(() => {
          router.push(`/workflows/${result.workflowId}`);
        }, 1500);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <>
      {isOpen ? (
        <div
          className={cn(
            "absolute inset-y-0 left-0 z-20 flex h-full w-[400px] flex-col",
            "border-r border-border bg-card/95 shadow-lg backdrop-blur-sm",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <div className="flex items-center gap-2 font-semibold text-foreground">
              <Sparkles className="size-4 text-primary" aria-hidden />
              <span>Guideboard AI</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => setIsOpen(false)}
              aria-label="Close chat"
            >
              <X className="size-4" />
            </Button>
          </div>

          <ScrollArea className="min-h-0 flex-1 px-3 py-3">
            <div className="flex flex-col gap-3 pr-2">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm",
                    msg.role === "user"
                      ? "ml-4 border border-border bg-muted/60 text-foreground"
                      : "mr-4 border border-primary/20 bg-primary/5 text-foreground",
                  )}
                >
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    {msg.role === "user" ? "You" : "AI"}
                  </div>
                  <p className="whitespace-pre-wrap break-words">
                    {msg.content}
                  </p>
                </div>
              ))}
              {isLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  <span>Thinking…</span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>

          <div className="border-t border-border p-3">
            <div className="flex flex-col gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  conversationId ? "Describe your automation…" : "Connecting…"
                }
                disabled={!conversationId || isLoading}
                className="min-h-[80px] resize-none bg-background text-sm"
                rows={3}
              />
              <Button
                type="button"
                className="w-full gap-2"
                disabled={!conversationId || isLoading || !input.trim()}
                onClick={() => void handleSend()}
              >
                {isLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <SendHorizontal className="size-4" />
                )}
                Send
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          className="absolute bottom-4 left-4 z-20 gap-2 rounded-full border border-border bg-card px-4 py-6 shadow-md"
          onClick={() => setIsOpen(true)}
        >
          <Sparkles className="size-4 text-primary" />
          Build with AI
        </Button>
      )}
    </>
  );
}
