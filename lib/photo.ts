"use client";

// Turns a photo, screenshot or PDF into page images the student can write on
// and the tutor can read. Images are shrunk and re-encoded so a page stays
// small enough to save.

export type PageImage = { id: string; src: string; x: number; y: number; w: number; h: number };
export type Picture = { src: string; w: number; h: number };

const MAX_SIDE = 1600;
const MAX_PAGES = 4;

function encode(source: CanvasImageSource, w: number, h: number): Picture {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return { src: c.toDataURL("image/jpeg", 0.82), w: c.width, h: c.height };
}

async function fromImage(file: File): Promise<Picture[]> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return [encode(bitmap, bitmap.width, bitmap.height)];
  } finally {
    bitmap.close();
  }
}

async function fromPdf(file: File): Promise<Picture[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const out: Picture[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1400 / base.width) });
      const c = document.createElement("canvas");
      c.width = Math.ceil(viewport.width);
      c.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: c.getContext("2d")!, viewport }).promise;
      out.push(encode(c, c.width, c.height));
    }
    return out;
  } finally {
    await task.destroy();
  }
}

export async function picturesFrom(file: File): Promise<Picture[]> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return fromPdf(file);
  if (file.type.startsWith("image/")) return fromImage(file);
  throw new Error("Choose a photo, screenshot or PDF.");
}
