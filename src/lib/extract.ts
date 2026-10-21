import mammoth from "mammoth";

/**
 * Text extraction for knowledge uploads: PDF, DOCX, plain text.
 */

export const ACCEPTED_UPLOAD_TYPES =
  ".pdf,.docx,.txt,.md,.markdown,.csv,.json,text/plain,application/pdf";

export async function extractFileText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const type = file.type;

  if (name.endsWith(".pdf") || type === "application/pdf") {
    return extractPdf(await file.arrayBuffer());
  }
  if (
    name.endsWith(".docx") ||
    type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  // txt / md / csv / json / anything else that is plain text
  if (
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".csv") ||
    name.endsWith(".json") ||
    type.startsWith("text/")
  ) {
    return file.text();
  }
  throw new Error(
    `Unsupported file type "${file.name}" — use PDF, DOCX, TXT, MD or CSV.`,
  );
}

async function extractPdf(buffer: ArrayBuffer): Promise<string> {
  // unpdf ships a bundled pdf.js worker — no runtime worker path resolution,
  // so it works inside bundlers (unlike pdf-parse).
  const { extractText, getDocumentProxy } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    if (!text.trim() && totalPages > 0) {
      throw new Error(
        "That PDF has no text layer (likely a scan) — paste the content instead.",
      );
    }
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/password|encrypted/i.test(msg)) {
      throw new Error("That PDF is password-protected.");
    }
    if (/no text layer/.test(msg)) throw err;
    throw new Error(`Failed to read the PDF: ${msg}`);
  }
}