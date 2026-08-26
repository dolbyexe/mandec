import {
  AlignmentType,
  Document,
  Footer,
  Header,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertMillimetersToTwip,
} from 'docx';
import { needsReview } from './types';
import type { GenerateRequest } from './types';

const FONT = 'Arial';
const SIZE = 21; // half-points, i.e. 10.5pt
const TITLE_SIZE = 28; // 14pt
const RED = 'FF0000';

/** Sits above the signature block until the supplier has checked the content. */
const REVIEW_NOTICE =
  '**** Please remove this statement once the above information has been reviewed and verified ****';

const run = (
  text: string,
  opts: { bold?: boolean; size?: number; italics?: boolean; color?: string } = {},
) =>
  new TextRun({
    text,
    font: FONT,
    size: opts.size ?? SIZE,
    bold: opts.bold,
    italics: opts.italics,
    color: opts.color,
  });

const para = (
  children: TextRun[],
  opts: { after?: number; before?: number; indent?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; keepNext?: boolean } = {},
) =>
  new Paragraph({
    children,
    alignment: opts.align,
    keepNext: opts.keepNext,
    indent: opts.indent ? { left: convertMillimetersToTwip(opts.indent) } : undefined,
    spacing: { after: (opts.after ?? 4) * 20, before: (opts.before ?? 0) * 20 },
  });

const blank = (points = 6) => para([run('')], { after: points });

/**
 * Letterhead + title + consignment link, repeated on every page via the header.
 * The template requires the company name AND address on each page.
 */
function buildHeader(req: GenerateRequest): Header {
  const letterhead = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            margins: {
              top: convertMillimetersToTwip(2),
              bottom: convertMillimetersToTwip(2),
              left: convertMillimetersToTwip(3),
              right: convertMillimetersToTwip(3),
            },
            children: [
              para([run(req.supplier.name, { bold: true, size: TITLE_SIZE })], {
                align: AlignmentType.CENTER,
                after: 2,
              }),
              ...req.supplier.addressLines.map((line) =>
                para([run(line)], { align: AlignmentType.CENTER, after: 2 }),
              ),
            ],
          }),
        ],
      }),
    ],
  });

  return new Header({
    children: [
      letterhead,
      para([run("MANUFACTURER'S DECLARATION", { bold: true, size: TITLE_SIZE })], {
        align: AlignmentType.CENTER,
        before: 8,
        after: 6,
      }),
      para([run(`Consignment Link: ${req.consignmentLink}`, { bold: true })], { after: 8 }),
    ],
  });
}

function buildFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({ text: 'Page ', font: FONT, size: 16 }),
          new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16 }),
          new TextRun({ text: ' of ', font: FONT, size: 16 }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 16 }),
        ],
      }),
    ],
  });
}

function buildItem(item: GenerateRequest['items'][number]): Paragraph[] {
  const out: Paragraph[] = [];

  out.push(
    para([run(`${item.linesLabel}  |  ${item.entryDescription}`, { bold: true })], {
      after: 1,
      keepNext: true,
    }),
  );

  out.push(
    para([run('Item: ', { bold: true }), run(item.description)], {
      after: 2,
      indent: 6,
      keepNext: true,
    }),
  );

  if (item.components.length) {
    out.push(
      para([run('Comprising: ', { bold: true }), run(item.components.join('; ') + '.')], {
        after: 2,
        indent: 6,
        keepNext: true,
      }),
    );
  }

  // Matched items carry a list consolidated from the catalogue; anything still
  // in "Needs your attention" was supplied by hand, so it prints as a plain list.
  out.push(
    para(
      [
        run(needsReview(item.confidence) ? 'Ingredients: ' : 'Consolidated ingredients: ', {
          bold: true,
        }),
        run(item.ingredients || '[TO BE CONFIRMED]'),
      ],
      { after: item.notes.length ? 2 : 9, indent: 6 },
    ),
  );

  item.notes.forEach((note, i) => {
    out.push(
      para([run(note, { italics: true })], {
        after: i === item.notes.length - 1 ? 9 : 2,
        indent: 6,
      }),
    );
  });

  return out;
}

export async function buildDeclaration(req: GenerateRequest): Promise<Buffer> {
  const productCount = req.items.length;

  const body: Paragraph[] = [
    para([
      run(
        'The goods in this shipment are commercially prepared in retail packages, ready for human consumption only.',
      ),
    ]),
    para(
      [
        run(
          `This consignment comprises ${req.totalLines} invoice ${req.totalLines === 1 ? 'line' : 'lines'} ` +
            `covering ${productCount} distinct ${productCount === 1 ? 'product' : 'products'}. The declaration below is set out by ` +
            'invoice line number; where a product appears on more than one line, all of those lines are of ' +
            'identical composition.',
        ),
      ],
      { after: 12 },
    ),
    ...req.items.flatMap(buildItem),
    blank(6),
    para([run(REVIEW_NOTICE, { bold: true, color: RED })], { after: 18 }),
    para([run('I certify that the information given above is true and correct.')], { after: 18 }),
    para([run('Signed: ............................................................')], { after: 18 }),
    para([run('Printed name: ..................................................')], { after: 18 }),
    para([run('Title: .................................................................')], { after: 0 }),
    para([run('(Company representative)', { italics: true, size: 18 })], { after: 18, indent: 12 }),
    para([run('Date of issue: ..........................................')], { after: 6 }),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
    sections: [
      {
        properties: {
          page: {
            margin: {
              // Top margin clears the repeating letterhead block in the header.
              top: convertMillimetersToTwip(47),
              bottom: convertMillimetersToTwip(18),
              left: convertMillimetersToTwip(22),
              right: convertMillimetersToTwip(22),
              header: convertMillimetersToTwip(10),
            },
          },
        },
        headers: { default: buildHeader(req) },
        footers: { default: buildFooter() },
        children: body,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/** Safe, descriptive filename for the download. */
export function declarationFilename(consignmentLink: string): string {
  const ref = consignmentLink.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `Manufacturers_Declaration_${ref || 'consignment'}.docx`;
}
