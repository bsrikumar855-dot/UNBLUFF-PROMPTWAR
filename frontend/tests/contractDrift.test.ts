// The frontend keeps its own copy of the shared types because Vercel builds this
// folder alone and cannot reach backend/. This test is the frontend half of the
// drift guard (the backend half is backend/tests/unit/contract.test.ts).
import contractMd from "../../CONTRACT.md?raw";
import contractTs from "../src/types/contract.ts?raw";

describe("contract drift guard", () => {
  it("src/types/contract.ts is copied exactly from CONTRACT.md §4", () => {
    const md = contractMd.replace(/\r\n/g, "\n");
    const fenced = /```ts\n([\s\S]*?)```/.exec(md.slice(md.indexOf("## 4.")))?.[1];
    expect(fenced).toBeDefined();
    expect(contractTs.replace(/\r\n/g, "\n")).toBe(fenced);
  });
});
