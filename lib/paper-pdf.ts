"use client";

// Opens a research paper PDF: each page as a picture to read and write on,
// and its text with positions so the tutor can point at exact sentences.

import { guessTitle, sentencesOf, type Paper, type TextRun } from "./paper";

const MAX_PAGES = 30;
const PAGE_PX = 1200;

export async function openPaper(file: File, onProgress?: (done: number, total: number) => void): Promise<Paper> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const total = Math.min(doc.numPages, MAX_PAGES);
    const pages: Paper["pages"] = [];
    let firstRuns: TextRun[] = [];
    for (let n = 1; n <= total; n++) {
      onProgress?.(n - 1, total);
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PAGE_PX / base.width });
      const c = document.createElement("canvas");
      c.width = Math.ceil(viewport.width);
      c.height = Math.ceil(viewport.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const content = await page.getTextContent();
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const tx = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
        const fontH = Math.hypot(tx[2], tx[3]);
        const w = item.width * viewport.scale;
        runs.push({
          str: item.str,
          eol: item.hasEOL,
          box: { x: tx[4] / c.width, y: (tx[5] - fontH) / c.height, w: w / c.width, h: (fontH * 1.2) / c.height },
        });
      }
      if (n === 1) firstRuns = runs;
      pages.push({ n, src: c.toDataURL("image/jpeg", 0.8), w: c.width, h: c.height, sentences: sentencesOf(runs, n, c.height / c.width) });
      page.cleanup();
    }
    onProgress?.(total, total);
    const title = (await doc.getMetadata().catch(() => null))?.info as { Title?: string } | undefined;
    const name = file.name.replace(/\.pdf$/i, "");
    return {
      id: crypto.randomUUID(),
      title: title?.Title?.trim() || guessTitle(firstRuns, name),
      pages,
      pageCount: doc.numPages,
    };
  } finally {
    await task.destroy();
  }
}
