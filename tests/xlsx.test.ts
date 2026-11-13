import { describe, expect, it } from "vitest";
import { buildXlsx, crc32 } from "../src/client/lib/xlsx";

/** Reads a stored (uncompressed) zip back via its central directory and checks every CRC. */
function unzip(buf: Uint8Array) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = buf.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true);
    const data = buf.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, new TextDecoder().decode(data));
    p += 46 + nameLen;
  }
  return out;
}

describe("xlsx writer", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes sheets with strings, numbers and escaped text into a valid zip", () => {
    const files = unzip(
      buildXlsx([
        { name: "성적", rows: [["수험번호", "점수"], ["A1", 92.5], ["<B&2>", null]] },
        { name: "a/b", rows: Array.from({ length: 2 }, () => Array.from({ length: 28 }, (_, i) => i)) },
      ]),
    );
    expect([...files.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
    const s1 = files.get("xl/worksheets/sheet1.xml")!;
    expect(s1).toContain('<c r="B2"><v>92.5</v></c>');
    expect(s1).toContain("&lt;B&amp;2&gt;");
    expect(s1).not.toContain('r="B3"');
    expect(files.get("xl/worksheets/sheet2.xml")).toContain('r="AB1"'); // 28th column
    expect(files.get("xl/workbook.xml")).toContain('name="a b"');
  });
});
