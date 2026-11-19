import AppKit
import SwiftUI

// Снимок вида целиком, без прокрутки: PNG 2× в текущей теме, в «Загрузки», затем файл открывается
enum ImageExport {
    @MainActor
    static func save<Content: View>(_ content: Content, width: CGFloat, name: String, model: AppModel, colorScheme: ColorScheme) {
        let view = content
            .frame(width: width)
            .background(Theme.background)
            .environmentObject(model)
            .environment(\.colorScheme, colorScheme)
            .environment(\.locale, Locale(identifier: "ru_RU"))
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        // Адаптивные цвета Theme выбирают вариант по текущему NSAppearance в момент отрисовки
        var image: CGImage?
        NSApp.effectiveAppearance.performAsCurrentDrawingAppearance { image = renderer.cgImage }
        guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmm"
        let url = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("\(name)-\(formatter.string(from: Date())).png")
        guard (try? png.write(to: url)) != nil else { return }
        NSWorkspace.shared.open(url)
    }
}

// Кнопка-камера рядом с фильтрами и действиями: одна на статистику и отчёт архитектурного ревью
struct ImageExportButton: View {
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "camera")
                .font(.system(size: 12))
                .foregroundStyle(.primary)
                .frame(width: 28, height: 28)
                .background(Theme.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
