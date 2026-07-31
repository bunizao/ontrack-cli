import pdf2mdModule from "@opendocsg/pdf2md";

import { CliError } from "./errors.js";

const MAX_PAGES = 200;
const MAX_MARKDOWN_BYTES = 4 * 1_024 * 1_024;

interface ParsedPdfDocument {
  readonly numPages: number;
  cleanup?: (keepLoadedFonts?: boolean) => void | Promise<void>;
  destroy?: () => void | Promise<void>;
}

type Pdf2Md = (
  bytes: Uint8Array,
  callbacks: { readonly documentParsed: (document: ParsedPdfDocument) => void },
) => Promise<string>;

const convertPdf = pdf2mdModule as unknown as Pdf2Md;

export interface PdfMarkdown {
  readonly pages: number;
  readonly markdown: string;
}

function cleanText(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .trim();
}

function pageCountError(): CliError {
  return new CliError("upstream_contract", `Task sheet page count must be between 1 and ${MAX_PAGES}`);
}

async function releasePdf(document: ParsedPdfDocument): Promise<void> {
  try {
    await document.cleanup?.(false);
  } catch {}
  try {
    await document.destroy?.();
  } catch {}
}

export async function pdfToMarkdown(bytes: Uint8Array, title: string, converter: Pdf2Md = convertPdf): Promise<PdfMarkdown> {
  let pages = 0;
  let body: string;
  let parsedDocument: ParsedPdfDocument | undefined;
  try {
    body = await converter(bytes, {
      documentParsed: (document) => {
        parsedDocument = document;
        pages = document.numPages;
        if (pages <= 0 || pages > MAX_PAGES) throw pageCountError();
      },
    });
  } catch (error) {
    if (parsedDocument) await releasePdf(parsedDocument);
    if (error instanceof CliError) throw error;
    throw new CliError("upstream_contract", "OnTrack returned a task sheet that could not be converted to Markdown");
  }
  if (pages <= 0 || pages > MAX_PAGES) throw pageCountError();
  const cleanBody = cleanText(body);
  if (!cleanBody) throw new CliError("upstream_contract", "Task sheet contains no extractable text");
  const heading = cleanText(title).replace(/\s+/gu, " ");
  const markdown = `# ${heading}\n\n${cleanBody}\n`;
  if (new TextEncoder().encode(markdown).length > MAX_MARKDOWN_BYTES) {
    throw new CliError("upstream_contract", "Task sheet Markdown exceeds the 4 MiB output limit");
  }
  return { pages, markdown };
}
