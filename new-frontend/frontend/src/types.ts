export type ChatRole = "player" | "dm";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: number;
}
