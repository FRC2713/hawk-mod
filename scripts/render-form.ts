/**
 * Renders a Markdown form to a print-ready HTML page and a PDF.
 *
 * One source, two outputs: parents read the HTML on a phone and sign the PDF,
 * so the two can never drift. Nothing here knows about Slack or the database —
 * it is a document build, and it must keep running with no credentials present.
 *
 *   npm run render:form                       # docs/consent-form.md
 *   npm run render:form -- docs/other.md      # anything else
 *
 * Chromium is not installed by `npm ci --ignore-scripts`. If this fails to
 * launch a browser, run: npx puppeteer browsers install chrome
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import MarkdownIt from "markdown-it";
import puppeteer from "puppeteer";

const OUT_DIR = "out/forms";

/**
 * The form version is the identity of what a family signed — it is recorded on
 * every consent row — so it belongs in the filename and the page footer rather
 * than only in the prose. Parsed from the document so there is one place to
 * change it.
 */
function formVersion(markdown: string): string | null {
  return markdown.match(/\*\*Form version ([^\s·*]+)/)?.[1] ?? null;
}

function title(markdown: string): string {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Form";
}

/**
 * Signature lines are dot leaders in the source, so the Markdown stays readable
 * on its own. On the page they should be rules: keep the dots for width, make
 * them invisible, and underline the cell.
 */
function ruleSignatureLines(html: string): string {
  return html.replace(/\.{5,}/g, '<span class="rule">$&</span>');
}

const CSS = `
  @page { size: letter; margin: 0.85in 0.9in 0.95in; }
  :root { color-scheme: light; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font: 11.5pt/1.55 Georgia, "Times New Roman", serif;
    color: #14171a; background: #fff;
    max-width: 7in; margin: 2rem auto; padding: 0 1rem;
  }
  h1 { font-size: 20pt; line-height: 1.2; margin: 0 0 .35rem; }
  h2 {
    font-size: 13pt; margin: 1.9rem 0 .5rem;
    padding-bottom: .25rem; border-bottom: 1px solid #d8dce0;
    break-after: avoid; page-break-after: avoid;
  }
  p, li { orphans: 3; widows: 3; }
  strong { color: #000; }
  hr { border: 0; border-top: 1px solid #d8dce0; margin: 1.75rem 0; }
  ul, ol { padding-left: 1.35rem; }
  li { margin: .3rem 0; }
  small { font-size: 8.5pt; color: #5b6470; }

  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  td { padding: .55rem .5rem .55rem 0; vertical-align: bottom; }
  td:first-child { width: 12em; white-space: nowrap; color: #3d454e; }
  .rule {
    display: inline-block; width: 100%;
    color: transparent; border-bottom: 1px solid #40474f;
  }

  /* A signature must never be stranded from what it signs. */
  h2, h2 + p, table { break-inside: avoid; page-break-inside: avoid; }

  @media screen and (max-width: 34em) {
    body { font-size: 12.5pt; padding: 0 1.1rem; }
    td { display: block; padding: .1rem 0; }
    td:first-child { width: auto; padding-top: .7rem; }
  }
`;

function page(bodyHtml: string, docTitle: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${docTitle}</title>
<style>${CSS}</style>
</head><body>${bodyHtml}</body></html>`;
}

const source = process.argv[2] ?? "docs/consent-form.md";
const markdown = await readFile(source, "utf8");
const version = formVersion(markdown);
const docTitle = title(markdown);

// `html: true` passes the maintainer comment through as a real HTML comment,
// which is exactly why it is a comment: it never reaches the page.
const md = new MarkdownIt({ html: true, typographer: false });
const html = page(ruleSignatureLines(md.render(markdown)), docTitle);

const stem = basename(source, ".md") + (version ? `-${version}` : "");
await mkdir(OUT_DIR, { recursive: true });
const htmlPath = resolve(OUT_DIR, `${stem}.html`);
const pdfPath = resolve(OUT_DIR, `${stem}.pdf`);
await writeFile(htmlPath, html);

const browser = await puppeteer.launch();
try {
  const tab = await browser.newPage();
  await tab.setContent(html, { waitUntil: "load" });
  await tab.pdf({
    path: pdfPath,
    format: "letter",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      `<div style="width:100%;margin:0 0.9in;font:8pt Georgia,serif;color:#5b6470;` +
      `display:flex;justify-content:space-between">` +
      `<span>${version ? `Form version ${version}` : ""}</span>` +
      `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>` +
      `</div>`,
    margin: { top: "0.85in", right: "0.9in", bottom: "0.95in", left: "0.9in" },
  });
} finally {
  await browser.close();
}

console.error(`${htmlPath}\n${pdfPath}`);
