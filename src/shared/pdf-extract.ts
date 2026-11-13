/**
 * Turns a pdf.js document into plain page data for the splitter (src/shared/split-rules.ts).
 * Runs in the browser (review screen) and in Node (scripts/measure-split.ts) — callers pass in
 * the pdf.js module they loaded, so this file has no pdf.js import of its own.
 */
import type { Box, PageData, TextItem } from "./split-rules";

type Matrix = [number, number, number, number, number, number];

// Minimal slice of the pdf.js API used here.
interface PdfJs {
  OPS: Record<string, number>;
}
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
}
export interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Axis-aligned box (top-left origin, PDF points) of the rectangle [x0,y0]-[x1,y1] under `m`. */
function boxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export async function extractPage(pdfjs: PdfJs, page: PdfPage, pageNo: number): Promise<PageData> {
  const vp = page.getViewport({ scale: 1 });
  const view = vp.transform as Matrix; // user space -> top-left page points

  const items: TextItem[] = [];
  for (const raw of (await page.getTextContent()).items) {
    const it = raw as { str?: string; transform: number[]; width: number };
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]);
    const [x, y] = apply(view, t[4], t[5]);
    items.push({ str: it.str, x, y, w: it.width, h: size });
  }

  // Walk the operator list keeping the current transform, to find where images and
  // long thin rules (column separators) are drawn.
  const { OPS } = pdfjs;
  const ops = await page.getOperatorList();
  const images: Box[] = [];
  const vrules: Box[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = view;
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? view;
    else if (fn === OPS.transform) ctm = mul(ctm, args as Matrix);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const b = boxOf(ctm, 0, 0, 1, 1);
      if (b.w > 8 && b.h > 8) images.push(b);
    } else if (fn === OPS.constructPath) {
      const mm = args[args.length - 1] as ArrayLike<number> | null;
      if (!mm || mm.length < 4) return;
      const b = boxOf(ctm, mm[0], mm[1], mm[2], mm[3]);
      if (b.w < 3 && b.h > vp.height * 0.15) vrules.push(b);
    }
  });

  return { page: pageNo, width: vp.width, height: vp.height, items, images, vrules };
}

export async function extractDocument(pdfjs: PdfJs, doc: PdfDoc): Promise<PageData[]> {
  const pages: PageData[] = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push(await extractPage(pdfjs, await doc.getPage(n), n));
  return pages;
}
