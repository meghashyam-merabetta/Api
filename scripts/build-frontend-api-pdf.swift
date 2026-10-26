import Foundation
import CoreGraphics
import CoreText
import PDFKit
import ImageIO
import UniformTypeIdentifiers

// Dependency-free macOS PDF renderer for the frontend handoff Markdown.
let input = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "docs/frontend-api-handoff.md"
let output = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "docs/frontend-api-handoff.pdf"
let source = try String(contentsOfFile: input, encoding: .utf8)
let width: CGFloat = 595.28, height: CGFloat = 841.89, margin: CGFloat = 44
let contentWidth = width - 2 * margin
var mediaBox = CGRect(x: 0, y: 0, width: width, height: height)
let consumer = CGDataConsumer(url: URL(fileURLWithPath: output) as CFURL)!
let context = CGContext(consumer: consumer, mediaBox: &mediaBox, [
    kCGPDFContextTitle: "Frontend API Handoff - Product Catalog and Checkout",
    kCGPDFContextAuthor: "API 3 Backend",
    kCGPDFContextSubject: "Product, category, brand, variant, image, catalog and checkout endpoint contracts"
] as CFDictionary)!
let ink = CGColor(red: 0.12, green: 0.17, blue: 0.25, alpha: 1)
let muted = CGColor(red: 0.38, green: 0.43, blue: 0.49, alpha: 1)
let accent = CGColor(red: 0.03, green: 0.38, blue: 0.45, alpha: 1)
let pale = CGColor(red: 0.94, green: 0.96, blue: 0.97, alpha: 1)
var pageNumber = 0
var y: CGFloat = 0
var open = false
var bookmarks: [(String, Int)] = []

func attributed(_ text: String, size: CGFloat = 10, bold: Bool = false, mono: Bool = false, color: CGColor = ink) -> NSAttributedString {
    let font = CTFontCreateWithName((mono ? "Menlo-Regular" : bold ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
    var spacing: CGFloat = mono ? 3 : 4
    let style = withUnsafePointer(to: &spacing) { ptr in
        let settings = [CTParagraphStyleSetting(spec: .lineSpacingAdjustment, valueSize: MemoryLayout<CGFloat>.size, value: ptr)]
        return CTParagraphStyleCreate(settings, settings.count)
    }
    return NSAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        NSAttributedString.Key(kCTParagraphStyleAttributeName as String): style
    ])
}
func measured(_ text: NSAttributedString, width: CGFloat) -> CGFloat {
    let setter = CTFramesetterCreateWithAttributedString(text)
    let size = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(location: 0, length: 0), nil, CGSize(width: width, height: 100000), nil)
    return ceil(size.height) + 3
}
func paint(_ text: NSAttributedString, x: CGFloat, top: CGFloat, width: CGFloat, height boxHeight: CGFloat) {
    let setter = CTFramesetterCreateWithAttributedString(text)
    let rect = CGRect(x: x, y: height - top - boxHeight, width: width, height: boxHeight)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: rect, transform: nil), nil)
    context.textMatrix = .identity
    CTFrameDraw(frame, context)
}
func newPage() {
    if open { context.endPDFPage() }
    context.beginPDFPage(nil)
    open = true
    pageNumber += 1
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(mediaBox)
    context.setFillColor(accent)
    context.fill(CGRect(x: 0, y: height - 8, width: width, height: 8))
    paint(attributed("MERABETTA  /  FRONTEND API HANDOFF", size: 8, bold: true, color: accent), x: margin, top: 25, width: contentWidth, height: 16)
    context.setStrokeColor(CGColor(gray: 0.85, alpha: 1))
    context.setLineWidth(0.5)
    context.move(to: CGPoint(x: margin, y: 42)); context.addLine(to: CGPoint(x: width - margin, y: 42)); context.strokePath()
    paint(attributed("26 OCT 2026   |   CURRENT WORKSPACE CONTRACT", size: 7.2, color: muted), x: margin, top: height - 33, width: contentWidth - 60, height: 14)
    paint(attributed("Page \(pageNumber)", size: 7.5, color: muted), x: width - margin - 48, top: height - 33, width: 48, height: 14)
    y = 59
}
func ensure(_ space: CGFloat) {
    if y + space > height - 57 { newPage() }
}
func paragraph(_ value: String, size: CGFloat = 10, bold: Bool = false, color: CGColor = ink, gap: CGFloat = 10) {
    let text = attributed(value, size: size, bold: bold, color: color)
    let h = measured(text, width: contentWidth)
    ensure(h)
    paint(text, x: margin, top: y, width: contentWidth, height: h)
    y += h + gap
}
func code(_ lines: [String]) {
    let blockHeight = lines.reduce(CGFloat(0)) { partial, line in
        partial + max(13, measured(attributed(line.isEmpty ? " " : line, size: 8.1, mono: true), width: contentWidth - 18)) + 2
    } + 11
    if blockHeight <= height - 116 { ensure(blockHeight) }
    for line in lines {
        let text = attributed(line.isEmpty ? " " : line, size: 8.1, mono: true)
        let h = max(13, measured(text, width: contentWidth - 18))
        ensure(h + 4)
        context.setFillColor(pale)
        context.fill(CGRect(x: margin, y: height - y - h - 2, width: contentWidth, height: h + 2))
        paint(text, x: margin + 9, top: y, width: contentWidth - 18, height: h)
        y += h + 2
    }
    y += 11
}
func table(_ rows: [[String]]) {
    guard let head = rows.first else { return }
    let count = head.count
    let widths: [CGFloat]
    if count == 3 && head[0] == "Method" {
        widths = [48, 293, contentWidth - 341]
    } else if count == 3 {
        widths = [151, 116, contentWidth - 267]
    } else if count == 2 { widths = [126, contentWidth - 126] }
    else { widths = Array(repeating: contentWidth / CGFloat(count), count: count) }
    func row(_ cells: [String], header: Bool) {
        let texts = (0..<count).map { attributed($0 < cells.count ? cells[$0] : "", size: header ? 8.2 : 8.4, bold: header, color: header ? CGColor(gray: 1, alpha: 1) : ink) }
        let h = max(25, zip(texts, widths).map { measured($0.0, width: $0.1 - 14) + 11 }.max() ?? 25)
        if y + h > height - 57 {
            newPage()
            if !header { row(head, header: true) }
        }
        context.setFillColor(header ? accent : pale)
        context.fill(CGRect(x: margin, y: height - y - h, width: contentWidth, height: h))
        var x = margin
        for i in 0..<count {
            paint(texts[i], x: x + 7, top: y + 5, width: widths[i] - 14, height: h - 8)
            x += widths[i]
        }
        context.setStrokeColor(CGColor(gray: 1, alpha: 1))
        context.setLineWidth(1)
        context.move(to: CGPoint(x: margin, y: height - y - h)); context.addLine(to: CGPoint(x: width - margin, y: height - y - h)); context.strokePath()
        y += h
    }
    ensure(55)
    row(head, header: true)
    for cells in rows.dropFirst() { row(cells, header: false) }
    y += 13
}
newPage()
let lines = source.components(separatedBy: .newlines)
var i = 0
while i < lines.count {
    let line = lines[i]
    if line.trimmingCharacters(in: .whitespaces).isEmpty { i += 1; continue }
    if line.hasPrefix("# ") {
        y += 25
        paragraph(String(line.dropFirst(2)), size: 32, bold: true, color: accent, gap: 12)
        i += 1
    } else if line.hasPrefix("## ") {
        newPage()
        let title = String(line.dropFirst(3))
        bookmarks.append((title, pageNumber - 1))
        paragraph(title, size: 22, bold: true, color: accent, gap: 16)
        i += 1
    } else if line.hasPrefix("### ") {
        ensure(80)
        paragraph(String(line.dropFirst(4)), size: 13, bold: true, color: accent, gap: 8)
        i += 1
    } else if line.hasPrefix("```") {
        i += 1
        var block: [String] = []
        while i < lines.count && !lines[i].hasPrefix("```") { block.append(lines[i]); i += 1 }
        code(block)
        i += 1
    } else if line.hasPrefix("|") {
        var rows: [[String]] = []
        while i < lines.count && lines[i].hasPrefix("|") {
            let cells = lines[i].split(separator: "|", omittingEmptySubsequences: false).dropFirst().dropLast().map { $0.trimmingCharacters(in: .whitespaces) }
            if !cells.allSatisfy({ $0.replacingOccurrences(of: "-", with: "").replacingOccurrences(of: ":", with: "").isEmpty }) { rows.append(cells) }
            i += 1
        }
        table(rows)
    } else {
        var parts = [line]
        i += 1
        while i < lines.count && !lines[i].isEmpty && !lines[i].hasPrefix("#") && !lines[i].hasPrefix("|") && !lines[i].hasPrefix("```") { parts.append(lines[i]); i += 1 }
        paragraph(parts.joined(separator: " "))
    }
}
if open { context.endPDFPage() }
context.closePDF()
let document = PDFDocument(url: URL(fileURLWithPath: output))!
let root = PDFOutline()
for (title, index) in bookmarks {
    if let page = document.page(at: index) {
        let item = PDFOutline()
        item.label = title
        item.destination = PDFDestination(page: page, at: CGPoint(x: 0, y: height))
        root.insertChild(item, at: root.numberOfChildren)
    }
}
document.outlineRoot = root
document.write(to: URL(fileURLWithPath: output))
let extracted = (0..<document.pageCount).compactMap { document.page(at: $0)?.string }.joined(separator: "\n\n")
try extracted.write(toFile: "/tmp/frontend-api-handoff-extracted.txt", atomically: true, encoding: .utf8)
print("Created \(output): \(document.pageCount) pages, \(bookmarks.count) outline sections, \(extracted.count) extracted characters")

let pdf = CGPDFDocument(URL(fileURLWithPath: output) as CFURL)!
let thumbWidth = 330, thumbHeight = 467
let sheetWidth = thumbWidth * 3, sheetHeight = thumbHeight * 2
let bitmap = CGContext(data: nil, width: sheetWidth, height: sheetHeight, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
bitmap.setFillColor(CGColor(gray: 0.8, alpha: 1)); bitmap.fill(CGRect(x: 0, y: 0, width: sheetWidth, height: sheetHeight))
for index in 0..<min(6, pdf.numberOfPages) {
    let target = CGRect(x: (index % 3) * thumbWidth + 5, y: sheetHeight - (index / 3 + 1) * thumbHeight + 5, width: thumbWidth - 10, height: thumbHeight - 10)
    let page = pdf.page(at: index + 1)!
    bitmap.saveGState(); bitmap.concatenate(page.getDrawingTransform(.mediaBox, rect: target, rotate: 0, preserveAspectRatio: true)); bitmap.drawPDFPage(page); bitmap.restoreGState()
}
let image = bitmap.makeImage()!
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "/tmp/frontend-api-handoff-preview.png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, image, nil); CGImageDestinationFinalize(destination)
