import SwiftUI

struct ClaudeMark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        let rays = 12
        for index in 0..<rays {
            let angle = Double(index) / Double(rays) * 2 * .pi
            let length = radius * (index.isMultiple(of: 2) ? 1 : 0.78)
            let width = radius * 0.2
            let ray = Path(roundedRect: CGRect(x: -width / 2, y: -length, width: width, height: length), cornerRadius: width / 2)
            path.addPath(ray, transform: CGAffineTransform(translationX: center.x, y: center.y).rotated(by: angle))
        }
        return path
    }
}

struct OpenAIMark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        let width = radius * 0.62
        let height = radius * 1.25
        for index in 0..<6 {
            let angle = Double(index) / 6 * 2 * .pi
            let petal = Path(roundedRect: CGRect(x: radius * 0.05, y: -height + radius * 0.35, width: width, height: height), cornerRadius: width / 2)
            path.addPath(petal, transform: CGAffineTransform(translationX: center.x, y: center.y).rotated(by: angle))
        }
        return path
    }
}

// Куб в изометрии, как у Cursor: шестиугольник и три ребра от центра
struct CursorMark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2 * 0.95
        let corners = (0..<6).map { index -> CGPoint in
            let angle = Double(index) / 6 * 2 * .pi - .pi / 2
            return CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
        }
        path.addLines(corners)
        path.closeSubpath()
        for index in [1, 3, 5] {
            path.move(to: center)
            path.addLine(to: corners[index])
        }
        return path
    }
}

// Значок модели для строки меню: шаблонное изображение (macOS сама красит его под тему), повёрнутое на angle
enum StatusMark {
    static func image(agent: String, angle: CGFloat) -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            let frame = rect.insetBy(dx: 1.5, dy: 1.5)
            let (path, filled): (Path, Bool) = switch agent {
            case "claude": (ClaudeMark().path(in: frame), true)
            case "codex": (OpenAIMark().path(in: frame), false)
            case "cursor": (CursorMark().path(in: frame), false)
            default: (Circle().path(in: frame), false)
            }
            context.translateBy(x: rect.midX, y: rect.midY)
            context.rotate(by: angle)
            context.translateBy(x: -rect.midX, y: -rect.midY)
            context.addPath(path.cgPath)
            context.setFillColor(NSColor.black.cgColor)
            context.setStrokeColor(NSColor.black.cgColor)
            context.setLineWidth(1.25)
            context.setLineJoin(.round)
            if filled { context.fillPath() } else { context.strokePath() }
            return true
        }
        image.isTemplate = true
        return image
    }
}

struct AgentMark: View {
    let agent: String

    var body: some View {
        switch agent {
        case "claude": ClaudeMark().fill(style: FillStyle())
        case "codex": OpenAIMark().stroke(style: StrokeStyle(lineWidth: 1.2))
        case "cursor": CursorMark().stroke(style: StrokeStyle(lineWidth: 1.3, lineJoin: .round))
        default: Circle()
        }
    }

    static func color(_ agent: String) -> Color {
        switch agent {
        case "claude": Color(red: 0.85, green: 0.47, blue: 0.34)
        // Графитовый в светлой теме и светло-серый в тёмной: чистый чёрный выглядел слишком тяжело рядом с Claude
        case "codex": Theme.adaptive(light: NSColor(white: 0.36, alpha: 1), dark: NSColor(white: 0.8, alpha: 1))
        case "cursor": Color(red: 0.2, green: 0.6, blue: 0.72)
        default: .accentColor
        }
    }
}

struct AgentReviewButton: View {
    let agent: String
    let name: String
    let state: ReviewState
    var manualOnly = false
    let action: () -> Void

    private var busy: Bool { state == .queued || state == .running }

    private var tint: Color {
        switch state {
        case .none, .queued: .secondary.opacity(0.4)
        case .stale: AgentMark.color(agent).opacity(0.45)
        case .done, .running: AgentMark.color(agent)
        }
    }

    private var hint: String {
        switch state {
        case .none: "\(name): ревью не было. Нажмите, чтобы запустить"
        case .stale: "\(name): ревью было на старом коммите. Нажмите, чтобы проверить новый"
        case .done: "\(name): ревью актуально. Нажмите, чтобы проверить заново"
        case .queued: "\(name): ревью в очереди"
        case .running: "\(name): идёт ревью"
        }
    }

    var body: some View {
        Button(action: action) {
            // Угол считаем от времени, а не через repeatForever: анимации в строках List сбрасываются при перерисовке
            TimelineView(.animation(minimumInterval: 1 / 30, paused: !busy)) { context in
                let degrees = busy ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2) * 180 : 0
                AgentMark(agent: agent)
                    .foregroundStyle(tint)
                    .frame(width: 15, height: 15)
                    .rotationEffect(.degrees(degrees))
            }
            .frame(width: 20, height: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .help(manualOnly ? "\(hint). В фоне эта модель не запускается" : hint)
    }
}
