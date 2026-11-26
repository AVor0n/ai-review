// Значок трея приложения на Tauri до первого кадра из вебвью: пузырь с галочкой, чёрный на прозрачном (шаблон для строки меню macOS).
// Остальные состояния вебвью рисует сам из product/design/web (app/src/trayIcon.ts).
// Свой рисунок, а не SF Symbols: значки нужны и на Windows. Запуск: swift assets/make-tray-icons.swift app/src-tauri/icons/tray
import AppKit

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let size: CGFloat = 44

func bubble(in ctx: CGContext) {
    let body = CGRect(x: 4, y: 11, width: 36, height: 28)
    let path = CGMutablePath()
    path.addRoundedRect(in: body, cornerWidth: 9, cornerHeight: 9)
    // хвостик снизу слева
    path.move(to: CGPoint(x: 11, y: 12))
    path.addLine(to: CGPoint(x: 8, y: 4))
    path.addLine(to: CGPoint(x: 19, y: 12))
    ctx.addPath(path)
    ctx.setLineWidth(3.2)
    ctx.setLineJoin(.round)
    ctx.strokePath()
}

func draw(_ name: String, mark: (CGContext) -> Void) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.setStrokeColor(NSColor.black.cgColor)
    ctx.setFillColor(NSColor.black.cgColor)
    ctx.setLineCap(.round)
    mark(ctx)
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
}

draw("idle") { ctx in
    bubble(in: ctx)
    ctx.setLineWidth(3.4)
    ctx.move(to: CGPoint(x: 14, y: 25))
    ctx.addLine(to: CGPoint(x: 20, y: 19))
    ctx.addLine(to: CGPoint(x: 30, y: 31))
    ctx.strokePath()
}
