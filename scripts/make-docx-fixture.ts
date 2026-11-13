// Writes tests/fixtures/fake-items.docx (fake content only) for the e2e upload test.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIXTURE, fakeDocx } from "../tests/docx-fixture";

const out = fileURLToPath(new URL("../tests/fixtures/fake-items.docx", import.meta.url));
writeFileSync(out, fakeDocx(FIXTURE));
console.log(`wrote ${out}`);
