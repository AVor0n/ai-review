import SwiftUI

// Цвета в духе iOS: сгруппированный фон (systemGroupedBackground) и карточки секций поверх него
enum Theme {
    static func adaptive(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light })
    }

    static let background = adaptive(light: NSColor(red: 0.949, green: 0.949, blue: 0.969, alpha: 1), dark: NSColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1))
    static let card = adaptive(light: .white, dark: NSColor(red: 0.11, green: 0.11, blue: 0.118, alpha: 1))
    static let track = adaptive(light: NSColor(red: 0.463, green: 0.463, blue: 0.502, alpha: 0.12), dark: NSColor(red: 0.463, green: 0.463, blue: 0.502, alpha: 0.24))
    static let thumb = adaptive(light: .white, dark: NSColor(red: 0.39, green: 0.39, blue: 0.4, alpha: 1))
    static let separator = adaptive(light: NSColor(white: 0, alpha: 0.1), dark: NSColor(white: 1, alpha: 0.1))
    static let hover = adaptive(light: NSColor(white: 0, alpha: 0.035), dark: NSColor(white: 1, alpha: 0.05))
}

// Сегментный контрол как в iOS: серая дорожка и белый бегунок вместо заливки акцентным цветом
struct SegmentedPicker<Value: Hashable>: View {
    let options: [Value]
    @Binding var selection: Value
    let title: (Value) -> String
    var segmentWidth: CGFloat = 110
    var badge: (Value) -> Int = { _ in 0 }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.self) { option in
                let selected = option == selection
                let count = badge(option)
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { selection = option }
                } label: {
                    HStack(spacing: 5) {
                        Text(title(option))
                        if count > 0 {
                            Text(verbatim: "\(count)")
                                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .frame(minWidth: 16, minHeight: 15)
                                .background(Color.accentColor, in: Capsule())
                        }
                    }
                    .font(.system(size: 12, weight: selected ? .semibold : .regular))
                    .foregroundStyle(.primary)
                    .frame(width: segmentWidth, height: 24)
                    .background {
                        if selected {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(Theme.thumb)
                                .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Theme.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

// Секция сгруппированного списка: подпись капслоком над карточкой и необязательная сноска под ней
struct GroupedSection<Header: View, Content: View>: View {
    let header: Header
    let footer: String?
    let content: Content

    init(footer: String? = nil, @ViewBuilder header: () -> Header, @ViewBuilder content: () -> Content) {
        self.header = header()
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .padding(.horizontal, 12)
            VStack(spacing: 0) { content }
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            if let footer {
                Text(footer)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
            }
        }
    }
}

extension GroupedSection where Header == Text {
    init(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(footer: footer, header: { Text(title) }, content: content)
    }
}

// Волосяная линия в один физический пиксель на любом экране, как разделители в списках iOS
struct RowDivider: View {
    @Environment(\.displayScale) private var displayScale
    var inset: CGFloat = 12

    var body: some View {
        Rectangle()
            .fill(Theme.separator)
            .frame(height: 1 / displayScale)
            .padding(.leading, inset)
    }
}

// Тонированная капсула: цветной текст на бледном фоне того же цвета, как бейджи в iOS
struct Tag: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }
}

// Подсветка строки под курсором: @State здесь недоступен (макрос), поэтому состояние в ObservableObject
final class HoverState: ObservableObject {
    @Published var isHovered = false
}

struct HoverHighlight: ViewModifier {
    @StateObject private var hover = HoverState()

    func body(content: Content) -> some View {
        content
            .background(hover.isHovered ? Theme.hover : .clear)
            .onHover { hover.isHovered = $0 }
    }
}

extension View {
    func hoverHighlight() -> some View { modifier(HoverHighlight()) }
}

enum AppAppearance: String, CaseIterable {
    case system, light, dark

    static let storageKey = "appearance"

    var title: String {
        switch self {
        case .system: "Системная"
        case .light: "Светлая"
        case .dark: "Тёмная"
        }
    }

    static let changed = Notification.Name("PRReviewerAppearanceChanged")

    private var appearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }

    // NSApp.appearance не трогаем: его наследует и иконка в строке меню, и при светлой теме на тёмной строке
    // меню шаблонная иконка становилась чёрной и пропадала. Тема задаётся только поповеру и меню
    func apply() {
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    static var stored: AppAppearance {
        UserDefaults.standard.string(forKey: storageKey).flatMap(AppAppearance.init(rawValue:)) ?? .system
    }

    // Поповер и меню иконки по умолчанию берут оформление строки меню, а не системы, поэтому задаём его явно
    static var current: NSAppearance { stored.appearance ?? NSApp.effectiveAppearance }
}

// Палитра графиков — эталонная проверенная палитра (порядок слотов обеспечивает различимость при дальтонизме);
// у тёмной темы свои ступени тех же оттенков
enum ChartColors {
    private static let series: [(light: UInt32, dark: UInt32)] = [
        (0x2a78d6, 0x3987e5), (0xeb6834, 0xd95926), (0x1baf7a, 0x199e70), (0xeda100, 0xc98500),
        (0xe87ba4, 0xd55181), (0x008300, 0x008300), (0x4a3aa7, 0x9085e9), (0xe34948, 0xe66767),
    ]

    private static func color(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Theme.adaptive(light: color(light), dark: color(dark))
    }

    // Цвет закрепляется за сущностью по её месту в стабильном списке, а не по рангу: фильтр не перекрашивает оставшихся
    static func series(_ index: Int) -> Color {
        let slot = series[index % series.count]
        return adaptive(slot.light, slot.dark)
    }

    // Уровни — шкала серьёзности из статусной палитры; P3 нейтральный
    static func level(_ level: String) -> Color {
        switch level {
        case "P0": adaptive(0xd03b3b, 0xd03b3b)
        case "P1": adaptive(0xec835a, 0xec835a)
        case "P2": adaptive(0xfab219, 0xfab219)
        default: adaptive(0xb4b2ab, 0x6b6a65)
        }
    }

    static let addressed = adaptive(0x0ca30c, 0x0ca30c)
    static let dismissed = adaptive(0xec835a, 0xec835a)
    static let waiting = adaptive(0x2a78d6, 0x3987e5)
}
