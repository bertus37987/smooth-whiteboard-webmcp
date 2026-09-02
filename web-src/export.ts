import { PageElement, elementBounds } from "../src/document";
import { TEXT_LINE_HEIGHT, arrowHeadPoints, cachedImage, drawBoardElement, isSketchShape, sketchOutline, sketchShapeClosed, textFontFamilies } from "../src/rendering";
import { measureTextBlock } from "./measure";
import { WhiteboardDocument, boardBounds } from "./model";

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type ExportPage = { name: string; bounds: Bounds; elements: PageElement[] };

const escapeXml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character]!));
const download = (blob: Blob, name: string): void => { const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1200); };

function containedElements(document: WhiteboardDocument, artboardId: string): PageElement[] {
  const ids = new Set([artboardId]); let changed = true;
  while (changed) { changed = false; for (const element of document.elements) if (element.parentId && ids.has(element.parentId) && !ids.has(element.id)) { ids.add(element.id); changed = true; } }
  return document.elements.filter((element) => ids.has(element.id));
}

export function exportPages(document: WhiteboardDocument, selectedIds: string[] = []): ExportPage[] {
  const selectedArtboards = document.artboardIds.filter((id) => selectedIds.includes(id)); const artboardIds = selectedArtboards.length ? selectedArtboards : document.artboardIds;
  if (artboardIds.length) return artboardIds.map((id, index) => { const artboard = document.elements.find((element) => element.id === id)!; return { name: artboard.name || `Artboard ${index + 1}`, bounds: elementBounds(artboard), elements: containedElements(document, id) }; });
  const selected = selectedIds.length ? document.elements.filter((element) => selectedIds.includes(element.id)) : document.elements; const bounds = boardBounds(selected) ?? { minX: 0, minY: 0, maxX: 1200, maxY: 800 };
  return [{ name: "Whiteboard", bounds, elements: selected }];
}

async function renderPage(page: ExportPage, scale: number, background = "#ffffff"): Promise<HTMLCanvasElement> {
  const padding = 24; const width = Math.max(1, page.bounds.maxX - page.bounds.minX); const height = Math.max(1, page.bounds.maxY - page.bounds.minY); const limitedScale = Math.min(scale, 8192 / Math.max(width + padding * 2, height + padding * 2));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil((width + padding * 2) * limitedScale)); canvas.height = Math.max(1, Math.ceil((height + padding * 2) * limitedScale)); const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas export unavailable");
  context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height); context.scale(limitedScale, limitedScale); context.translate(-page.bounds.minX + padding, -page.bounds.minY + padding);
  const imagePromises: Promise<void>[] = [];
  for (const element of page.elements) {
    if (element.type === "image") imagePromises.push(new Promise<void>((resolve) => { const image = cachedImage(element, () => resolve()); if (image.complete && image.naturalWidth > 0) resolve(); }).then(() => { const image = cachedImage(element, () => undefined); context.drawImage(image, element.x, element.y, element.width, element.height); }));
    else { context.save(); context.globalAlpha = element.opacity ?? 1; drawBoardElement(context, element); context.restore(); }
  }
  await Promise.all(imagePromises); return canvas;
}

function svgForElement(element: PageElement, offsetX: number, offsetY: number): string {
  const opacity = element.opacity ?? 1; const translate = `translate(${-offsetX} ${-offsetY})`;
  if (element.type === "image") return `<image transform="${translate}" x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" href="${escapeXml(element.dataUrl)}" opacity="${opacity}"/>`;
  if (element.type === "text") {
    const measured = measureTextBlock(element);
    const lineHeight = element.fontSize * TEXT_LINE_HEIGHT;
    const anchor = element.textAlign === "center" ? "middle" : element.textAlign === "right" ? "end" : "start";
    const x = element.textAlign === "center" ? element.x + element.width / 2 : element.textAlign === "right" ? element.x + element.width : element.x;
    const lineLeft = (index: number): number => element.textAlign === "center" ? x - measured.lineWidths[index] / 2 : element.textAlign === "right" ? x - measured.lineWidths[index] : x;
    const weight = element.fontWeight ?? (element.blockStyle?.startsWith("heading") ? 700 : 400);
    const marks = element.highlightColor
      ? measured.lines.map((_, index) => `<rect x="${lineLeft(index) - 4}" y="${element.baseline + index * lineHeight - element.fontSize}" width="${measured.lineWidths[index] + 8}" height="${element.fontSize * 1.18}" fill="${escapeXml(element.highlightColor ?? "#ffd84d")}" opacity="0.24"/>`).join("")
      : "";
    const decoration = element.textDecoration && element.textDecoration !== "none"
      ? measured.lines.map((_, index) => { const baseline = element.baseline + index * lineHeight; const y = element.textDecoration === "line-through" ? baseline - element.fontSize * .32 : baseline + element.fontSize * .09; return `<line x1="${lineLeft(index)}" y1="${y}" x2="${lineLeft(index) + measured.lineWidths[index]}" y2="${y}" stroke="${escapeXml(element.color)}" stroke-width="${Math.max(1, element.fontSize * .055)}"/>`; }).join("")
      : "";
    const tspans = measured.lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}" xml:space="preserve">${escapeXml(line)}</tspan>`).join("");
    return `<g transform="${translate}" opacity="${opacity}">${marks}<text x="${x}" y="${element.baseline}" fill="${escapeXml(element.color)}" font-family="${escapeXml(textFontFamilies[element.fontFamily ?? "sans"])}" font-size="${element.fontSize}" font-weight="${weight}" font-style="${element.fontStyle ?? "normal"}" text-anchor="${anchor}">${tspans}</text>${decoration}</g>`;
  }
  if (element.type === "highlight") { const points = element.points?.length ? element.points.map((point) => `${point.x},${point.y}`).join(" ") : `${element.x1},${element.y} ${element.x2},${element.y}`; return `<polyline transform="${translate}" points="${points}" fill="none" stroke="${escapeXml(element.color)}" stroke-width="${element.size}" stroke-linecap="round" stroke-linejoin="round" opacity="${element.opacity}"/>`; }
  const points = element.points.map((point) => `${point.x},${point.y}`).join(" ");
  if (element.type === "stroke") return `<polyline transform="${translate}" points="${points}" fill="none" stroke="${escapeXml(element.color)}" stroke-width="${element.size}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`;
  const fill = element.fillOpacity ? element.fillColor ?? "#ffffff" : "none"; const fillOpacity = element.fillOpacity ?? 0; const dash = element.lineStyle === "dashed" ? `${element.size * 3} ${element.size * 2}` : element.lineStyle === "dotted" ? `${element.size} ${element.size * 2}` : "";
  if (element.kind === "arrow" && element.points.length >= 2) {
    const head = (tail: typeof element.points[number], tip: typeof element.points[number]): string => {
      const barbs = arrowHeadPoints(tail, tip, element.size);
      return `<polyline points="${barbs.left.x},${barbs.left.y} ${tip.x},${tip.y} ${barbs.right.x},${barbs.right.y}" fill="none" stroke="${escapeXml(element.color)}" stroke-width="${element.size}" stroke-linecap="round" stroke-linejoin="round"/>`;
    };
    const start = element.points[0]; const end = element.points.at(-1)!; const heads = `${element.startArrow ? head(end, start) : ""}${element.endArrow !== false ? head(start, end) : ""}`;
    return `<g transform="${translate}" opacity="${opacity}"><polyline points="${points}" fill="none" stroke="${escapeXml(element.color)}" stroke-width="${element.size}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}"/>${heads}</g>`;
  }
  if (isSketchShape(element)) {
    // Same seeded geometry as the canvas, so an SVG export matches what the human saw.
    const closed = sketchShapeClosed(element); const trace = (pass: number): string => sketchOutline(element, pass).map((point) => `${point.x},${point.y}`).join(" ");
    const tag = closed ? "polygon" : "polyline";
    return `<g transform="${translate}" opacity="${opacity}"><${tag} points="${trace(0)}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${escapeXml(element.color)}" stroke-width="${element.size}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}"/><${tag} points="${trace(1)}" fill="none" stroke="${escapeXml(element.color)}" stroke-width="${Math.max(.6, element.size * .75)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/></g>`;
  }
  if ((element.kind === "rectangle" || element.kind === "ellipse") && element.points.length >= 2) { const box = elementBounds(element); if (element.kind === "ellipse") return `<ellipse transform="${translate}" cx="${(box.minX + box.maxX) / 2}" cy="${(box.minY + box.maxY) / 2}" rx="${(box.maxX - box.minX) / 2}" ry="${(box.maxY - box.minY) / 2}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${escapeXml(element.color)}" stroke-width="${element.size}" stroke-dasharray="${dash}" opacity="${opacity}"/>`; return `<rect transform="${translate}" x="${box.minX}" y="${box.minY}" width="${box.maxX - box.minX}" height="${box.maxY - box.minY}" rx="${element.radius ?? 0}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${escapeXml(element.color)}" stroke-width="${element.size}" stroke-dasharray="${dash}" opacity="${opacity}"/>`; }
  return `<${element.closed ? "polygon" : "polyline"} transform="${translate}" points="${points}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${escapeXml(element.color)}" stroke-width="${element.size}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}" opacity="${opacity}"/>`;
}

const FONT_FILES: Record<string, { family: string; file: string }> = {
  sans: { family: "Inter", file: "./fonts/inter-latin.woff2" },
  handwriting: { family: "Caveat", file: "./fonts/caveat-latin.woff2" }
};
const embeddedFonts = new Map<string, string | null>();

/** woff2 bytes as a data URL, fetched once; a failure just leaves the SVG referencing font names. */
async function embeddedFont(key: string): Promise<string | null> {
  if (embeddedFonts.has(key)) return embeddedFonts.get(key) ?? null;
  let encoded: string | null = null;
  try {
    const response = await fetch(FONT_FILES[key].file);
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
      encoded = btoa(binary);
    }
  } catch { encoded = null; }
  embeddedFonts.set(key, encoded);
  return encoded;
}

async function fontStyle(page: ExportPage): Promise<string> {
  const used = new Set(page.elements.filter((element) => element.type === "text").map((element) => element.type === "text" ? element.fontFamily ?? "sans" : "sans"));
  const faces: string[] = [];
  for (const key of Object.keys(FONT_FILES)) {
    if (!used.has(key as "sans" | "handwriting")) continue;
    const data = await embeddedFont(key);
    if (data) faces.push(`@font-face{font-family:"${FONT_FILES[key].family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:400 700}`);
  }
  return faces.length ? `<defs><style>${faces.join("")}</style></defs>` : "";
}

export function makeSvg(page: ExportPage, fonts = ""): string { const width = page.bounds.maxX - page.bounds.minX; const height = page.bounds.maxY - page.bounds.minY; return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/>${fonts}${page.elements.map((element) => svgForElement(element, page.bounds.minX, page.bounds.minY)).join("")}</svg>`; }

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const concat = (parts: Uint8Array[]): Uint8Array => { const length = parts.reduce((sum, part) => sum + part.length, 0); const output = new Uint8Array(length); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; };
function dataUrlBytes(dataUrl: string): Uint8Array { const binary = atob(dataUrl.split(",")[1]); const output = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index); return output; }

async function makePdf(pages: ExportPage[]): Promise<Uint8Array> {
  const rendered = await Promise.all(pages.map((page) => renderPage(page, 1.5))); const jpeg = rendered.map((canvas) => dataUrlBytes(canvas.toDataURL("image/jpeg", .9))); const objectCount = 2 + pages.length * 3; const objects = new Map<number, Uint8Array>();
  objects.set(1, bytes("<< /Type /Catalog /Pages 2 0 R >>")); const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" "); objects.set(2, bytes(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
  pages.forEach((page, index) => { const pageId = 3 + index * 3; const imageId = pageId + 1; const contentId = pageId + 2; const canvas = rendered[index]; const width = Math.max(72, (page.bounds.maxX - page.bounds.minX) * .75); const height = Math.max(72, (page.bounds.maxY - page.bounds.minY) * .75); const content = bytes(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`); objects.set(pageId, bytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)); objects.set(imageId, concat([bytes(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg[index].length} >>\nstream\n`), jpeg[index], bytes("\nendstream")])); objects.set(contentId, concat([bytes(`<< /Length ${content.length} >>\nstream\n`), content, bytes("\nendstream")])); });
  const parts: Uint8Array[] = [bytes("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n")]; const offsets = [0]; let offset = parts[0].length; for (let id = 1; id <= objectCount; id += 1) { offsets[id] = offset; const object = concat([bytes(`${id} 0 obj\n`), objects.get(id)!, bytes("\nendobj\n")]); parts.push(object); offset += object.length; }
  const xref = offset; const rows = offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join(""); parts.push(bytes(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)); return concat(parts);
}

export async function downloadExport(format: "png" | "svg" | "pdf" | "json", document: WhiteboardDocument, selectedIds: string[]): Promise<void> {
  if (format === "json") { download(new Blob([JSON.stringify(document, null, 2)], { type: "application/json" }), "shared-whiteboard.json"); return; }
  const pages = exportPages(document, selectedIds); if (format === "png") { const canvas = await renderPage(pages[0], 2); await new Promise<void>((resolve, reject) => canvas.toBlob((blob) => { if (!blob) { reject(new Error("PNG export failed")); return; } download(blob, `${pages[0].name.replace(/[^a-z0-9_-]+/gi, "-") || "whiteboard"}.png`); resolve(); }, "image/png")); return; }
  if (format === "svg") { download(new Blob([makeSvg(pages[0], await fontStyle(pages[0]))], { type: "image/svg+xml" }), `${pages[0].name.replace(/[^a-z0-9_-]+/gi, "-") || "whiteboard"}.svg`); return; }
  const pdf = await makePdf(pages); const buffer = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer; download(new Blob([buffer], { type: "application/pdf" }), "shared-whiteboard-artboards.pdf");
}
