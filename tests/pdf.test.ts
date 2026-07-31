import assert from "node:assert/strict";

import { CliError } from "../src/errors.js";
import { pdfToMarkdown } from "../src/pdf.js";
import { textPdf } from "./pdf-fixture.js";

export async function test_pdf_to_markdown_preserves_page_text_without_external_tools(): Promise<void> {
  const result = await pdfToMarkdown(textPdf(["Hello agent", "Second line"]), "FIT9999 P1 Task Sheet");
  assert.deepEqual(result, {
    pages: 1,
    markdown: "# FIT9999 P1 Task Sheet\n\nHello agent Second line\n",
  });
}

export async function test_pdf_to_markdown_rejects_malformed_and_textless_documents(): Promise<void> {
  await assert.rejects(
    pdfToMarkdown(new TextEncoder().encode("%PDF-not-a-document"), "Broken"),
    (error) => error instanceof CliError && error.category === "upstream_contract" && /could not be converted/i.test(error.message),
  );
  await assert.rejects(
    pdfToMarkdown(textPdf([]), "Blank"),
    (error) => error instanceof CliError && error.category === "upstream_contract" && /no extractable text/i.test(error.message),
  );
}

export async function test_pdf_to_markdown_rejects_oversized_documents_before_reading_pages(): Promise<void> {
  let readPages = false;
  let cleanupCalls = 0;
  let destroyCalls = 0;
  await assert.rejects(
    pdfToMarkdown(new Uint8Array(), "Too long", async (_bytes, callbacks) => {
      callbacks.documentParsed({
        numPages: 201,
        cleanup: () => { cleanupCalls += 1; },
        destroy: () => { destroyCalls += 1; },
      });
      readPages = true;
      return "Too late";
    }),
    (error) => error instanceof CliError && error.category === "upstream_contract" && /between 1 and 200/i.test(error.message),
  );
  assert.equal(readPages, false);
  assert.equal(cleanupCalls, 1);
  assert.equal(destroyCalls, 1);
}

export async function test_pdf_to_markdown_removes_c1_terminal_controls(): Promise<void> {
  const result = await pdfToMarkdown(textPdf(["Readable"]), "Safe\u009b31m title");
  assert.equal(result.markdown, "# Safe31m title\n\nReadable\n");
}
