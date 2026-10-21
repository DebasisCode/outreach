import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { parseToolOutput } from "@/lib/tool-outputs";

/** A readable Markdown copy of a chat (/export). */
export function chatToMarkdown(title: string, messages: UIMessage[]): string {
  const lines = [`# ${title}`, "", `_Exported ${new Date().toLocaleString()}_`, ""];
  for (const message of messages) {
    lines.push(message.role === "user" ? "## You" : "## Assistant", "");
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        lines.push(part.text.trim(), "");
      } else if (isToolUIPart(part)) {
        const name = getToolName(part);
        const input = (part.input ?? {}) as Record<string, string | undefined>;
        if (name === "composio_send_email" || name === "composio_create_draft") {
          const output = parseToolOutput<{ sent?: boolean; drafted?: boolean }>(
            part.state === "output-available" ? part.output : null,
          );
          const outcome = output?.sent
            ? "sent"
            : output?.drafted
              ? "saved to drafts"
              : part.state === "output-denied"
                ? "not sent"
                : part.state;
          lines.push(
            `> **Email to ${input.to ?? "?"}** (${outcome})`,
            `> Subject: ${input.subject ?? ""}`,
            ">",
            ...(input.body ?? "").split("\n").map((line) => `> ${line}`),
            "",
          );
        } else {
          lines.push(`> _${name.replace(/_/g, " ")}_ — ${part.state.replace(/-/g, " ")}`, "");
        }
      }
    }
  }
  return lines.join("\n");
}

export function downloadFile(filename: string, text: string, type = "text/markdown"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
