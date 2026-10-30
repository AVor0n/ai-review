// Иконка приложения: значок pull request и зелёная галочка «одобрено».
// Пересобрать AppIcon.icns: swiftc -o "$TMPDIR/make-icon" assets/make-icon.swift && "$TMPDIR/make-icon" assets
import AppKit
import SwiftUI

private func rgb(_ value: UInt32) -> Color {
    Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
}

// Два узла слева на ветке, узел справа и стрелка к базовой ветке — как значок PR в Bitbucket и GitHub
private struct PullRequestGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let size = rect.width
        let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + size * x, y: rect.minY + size * y) }
        let radius = size * 0.11
        let top = point(0.25, 0.18), bottom = point(0.25, 0.82), right = point(0.75, 0.82)
        for node in [top, bottom, right] {
            path.addEllipse(in: CGRect(x: node.x - radius, y: node.y - radius, width: radius * 2, height: radius * 2))
        }
        path.move(to: CGPoint(x: top.x, y: top.y + radius))
        path.addLine(to: CGPoint(x: bottom.x, y: bottom.y - radius))
        path.move(to: CGPoint(x: right.x, y: right.y - radius))
        path.addLine(to: point(0.75, 0.42))
        path.addQuadCurve(to: point(0.59, 0.26), control: point(0.75, 0.26))
        path.addLine(to: point(0.48, 0.26))
        path.move(to: point(0.57, 0.16))
        path.addLine(to: point(0.47, 0.26))
        path.addLine(to: point(0.57, 0.36))
        return path
    }
}

private struct Checkmark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.2, y: rect.minY + rect.height * 0.52))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.42, y: rect.minY + rect.height * 0.74))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.8, y: rect.minY + rect.height * 0.3))
        return path
    }
}

// Градиент на весь холст 1024 без своей плитки, обводки и тени: macOS 26+ сама скругляет иконку,
// а иконку с прозрачными краями показывает уменьшенной на серой подложке
private struct AppIcon: View {
    var body: some View {
        ZStack {
            Rectangle()
                .fill(LinearGradient(colors: [rgb(0x4b8df8), rgb(0x1d4ed8)], startPoint: .top, endPoint: .bottom))
            PullRequestGlyph()
                .stroke(.white, style: StrokeStyle(lineWidth: 55, lineCap: .round, lineJoin: .round))
                .frame(width: 548, height: 548)
                .offset(x: -62, y: -50)
            // Смещение меньше пропорционального, чтобы бейдж не касался скруглённого угла маски
            Circle()
                .fill(LinearGradient(colors: [rgb(0x34d058), rgb(0x16a34a)], startPoint: .top, endPoint: .bottom))
                .overlay(Circle().strokeBorder(.white, lineWidth: 20))
                .overlay(
                    Checkmark()
                        .stroke(.white, style: StrokeStyle(lineWidth: 40, lineCap: .round, lineJoin: .round))
                        .frame(width: 200, height: 200)
                )
                .frame(width: 336, height: 336)
                .offset(x: 240, y: 240)
        }
        .frame(width: 1024, height: 1024)
    }
}

MainActor.assumeIsolated {
    let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".")
    let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
    try? FileManager.default.removeItem(at: iconset)
    try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
    for points in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let renderer = ImageRenderer(content: AppIcon())
            renderer.scale = CGFloat(points * scale) / 1024
            let image = renderer.cgImage!
            let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!
            let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
            try! png.write(to: iconset.appendingPathComponent(name))
        }
    }
    let iconutil = Process()
    iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    iconutil.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("AppIcon.icns").path]
    try! iconutil.run()
    iconutil.waitUntilExit()
    exit(iconutil.terminationStatus)
}
