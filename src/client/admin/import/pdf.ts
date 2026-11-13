// pdf.js in the browser: load the original from our admin API, render pages, cut pictures out.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractDocument, type PdfDoc } from "../../../shared/pdf-extract";
import type { ImageRef, PageData } from "../../../shared/split-rules";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadPdf(sourceId: number) {
  const doc = await pdfjs.getDocument({ url: `/api/admin/source-files/${sourceId}/file`, withCredentials: true }).promise;
  return doc;
}

export const extractPages = (doc: PDFDocumentProxy): Promise<PageData[]> =>
  extractDocument(pdfjs as never, doc as unknown as PdfDoc);

/** Renders a page into a new canvas at `scale` (PDF points × scale = canvas pixels). */
export async function renderPage(doc: PDFDocumentProxy, pageNo: number, scale: number) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

/** Cuts `ref` out of a page rendered at CROP_SCALE and returns it as PNG. */
export const CROP_SCALE = 2.5;
export async function cropToPng(pageCanvas: HTMLCanvasElement, ref: ImageRef): Promise<Blob> {
  const { x, y, w, h } = ref.box;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * CROP_SCALE));
  c.height = Math.max(1, Math.round(h * CROP_SCALE));
  c.getContext("2d")!.drawImage(pageCanvas, x * CROP_SCALE, y * CROP_SCALE, w * CROP_SCALE, h * CROP_SCALE, 0, 0, c.width, c.height);
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("이미지를 만들지 못했습니다."))), "image/png"));
}

export { uploadMedia } from "@/lib/api";
