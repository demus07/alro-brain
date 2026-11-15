import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { officeKind, officeText } from "./office";

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("officeText", () => {
  it("reads a Word document's paragraphs, tabs and line breaks", () => {
    const docx = zip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
        <w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Quote for </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Acme &amp; Co</w:t></w:r></w:p>
        <w:p><w:r><w:t>Total</w:t><w:tab/><w:t>₹4,20,000</w:t><w:br/><w:t>Due 1 Dec</w:t></w:r><w:del><w:r><w:delText>old text</w:delText></w:r></w:del></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell &lt;1&gt;</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:p/>
      </w:body></w:document>`,
    });
    expect(officeText(docx, "Quote.docx")).toBe("Quote for Acme & Co\nTotal\t₹4,20,000\nDue 1 Dec\nCell <1>");
    expect(officeText(docx, DOCX_MIME)).toBe(officeText(docx, "Quote.docx"));
  });

  it("reads a deck's slide text in presentation order, not file order", () => {
    const slide = (lines: string[]) => `<p:sld><p:cSld><p:spTree>${lines.map((l) => `<p:sp><p:txBody><a:p><a:r><a:t>${l}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`;
    const pptx = zip({
      "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Type="slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="slide" Target="/ppt/slides/slide2.xml"/></Relationships>`,
      "ppt/slides/slide1.xml": slide(["Ask: ₹2 Cr", "Close by March"]),
      "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Seed round</a:t></a:r><a:br/><a:r><a:t>ALRO</a:t></a:r></a:p></p:sld>`,
      "ppt/notesSlides/notesSlide1.xml": slide(["speaker notes are not read"]),
    });
    expect(officeText(pptx, "pitch.pptx")).toBe("Seed round\nALRO\n\nAsk: ₹2 Cr\nClose by March");
  });

  it("falls back to slide number order without a presentation part", () => {
    const pptx = zip({
      "ppt/slides/slide10.xml": "<a:p><a:r><a:t>ten</a:t></a:r></a:p>",
      "ppt/slides/slide2.xml": "<a:p><a:r><a:t>two</a:t></a:r></a:p>",
    });
    expect(officeText(pptx, "deck.PPTX")).toBe("two\n\nten");
  });

  it("reads each sheet's rows tab-separated, with shared, inline and boolean cells", () => {
    const xlsx = zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Pipeline" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/><sheet name="Q&amp;A" sheetId="3" r:id="rId3"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Deal</t></si><si><t>Amount</t></si><si><r><t>Acme </t></r><r><rPr><b/></rPr><t>Corp</t></r><rPh><t>アクメ</t></rPh></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><cols><col min="1" max="3"/></cols><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Won?</t></is></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="3"><v>420000</v></c><c r="C2" s="1"/><c r="D2" t="b"><v>1</v></c></row>
        <row r="3"><c r="A3" s="1"/></row>
      </sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>",
      "xl/worksheets/sheet3.xml": `<worksheet><sheetData><row r="1"><c r="B1" t="str"><f>A1</f><v>x &lt; y</v></c></row></sheetData></worksheet>`,
    });
    expect(officeText(xlsx, "pipeline.xlsx")).toBe("Pipeline\nDeal\tAmount\t\tWon?\nAcme Corp\t420000\t\tTRUE\n\nQ&A\n\tx < y");
  });

  it("caps a large spreadsheet's text", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>row ${i} ${"x".repeat(20)}</t></is></c></row>`).join("");
    const xlsx = zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Big" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
    });
    const text = officeText(xlsx, "big.xlsx")!;
    expect(text.startsWith("Big\nrow 0 ")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(300_000);
    expect(text.length).toBeGreaterThan(250_000);
  });

  it("returns undefined for other files and for broken zips", () => {
    expect(officeText(zip({ "a.txt": "hi" }), "notes.txt")).toBeUndefined();
    expect(officeText(strToU8("not a zip"), "report.docx")).toBeUndefined();
    expect(officeText(zip({ "other.xml": "<x/>" }), "report.docx")).toBeUndefined();
    expect(officeKind("application/pdf")).toBeUndefined();
    expect(officeKind("Budget.XLSM")).toBe("xlsx");
    expect(officeKind("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("pptx");
  });
});
