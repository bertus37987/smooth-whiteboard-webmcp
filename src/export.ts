function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

export interface PdfImagePage { jpeg: Uint8Array; pixelWidth: number; pixelHeight: number }

/** Build a standards-compatible A4 PDF containing one JPEG per page. */
export function buildMultiPageImagePdf(pages: PdfImagePage[]): Uint8Array {
  if (pages.length === 0) throw new Error("PDF benötigt mindestens eine Seite");
  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  const objects: Uint8Array[] = [
    encode("<< /Type /Catalog /Pages 2 0 R >>"),
    encode(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  ];
  for (const [index, page] of pages.entries()) {
    const pageId = 3 + index * 3; const imageId = pageId + 1; const contentId = pageId + 2;
    objects.push(encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    objects.push(concatBytes([encode(`<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`), page.jpeg, encode("\nendstream")]));
    const stream = encode(`q\n595.28 0 0 841.89 0 0 cm\n/Im${index} Do\nQ\n`);
    objects.push(concatBytes([encode(`<< /Length ${stream.length} >>\nstream\n`), stream, encode("endstream")]));
  }
  const parts: Uint8Array[] = [encode("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets = [0];
  let length = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const wrapped = concatBytes([encode(`${index + 1} 0 obj\n`), object, encode("\nendobj\n")]);
    parts.push(wrapped); length += wrapped.length;
  }
  const xrefOffset = length;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets.slice(1)) xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
  xref.push("trailer", `<< /Size ${objects.length + 1} /Root 1 0 R >>`, "startxref", String(xrefOffset), "%%EOF", "");
  parts.push(encode(xref.join("\n")));
  return concatBytes(parts);
}

export function buildImagePdf(jpeg: Uint8Array, pixelWidth: number, pixelHeight: number): Uint8Array {
  return buildMultiPageImagePdf([{ jpeg, pixelWidth, pixelHeight }]);
}

export function dataUrlBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",", 2)[1] ?? "";
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
