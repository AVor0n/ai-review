import SwiftUI

// Официальные знаки моделей из product/design/logos: путь SVG, вписанный в кадр с сохранением пропорций.
// В исходниках только абсолютные команды M L H V C Z, вырезы — за счёт направления обхода (nonzero)
struct SVGMark {
    let viewBox: CGRect
    let path: Path

    init(viewBox: CGRect, data: String) {
        self.viewBox = viewBox
        let tokens = data.matches(of: #/[MLHVCZ]|-?(?:\d+\.?\d*|\.\d+)/#).map { String($0.output) }
        var path = Path()
        var command = ""
        var numbers: [CGFloat] = []
        var current = CGPoint.zero
        func flush() {
            switch command {
            case "M", "L":
                for index in stride(from: 0, to: numbers.count - 1, by: 2) {
                    current = CGPoint(x: numbers[index], y: numbers[index + 1])
                    // Пары после первой у M — неявные L
                    if command == "M" && index == 0 { path.move(to: current) } else { path.addLine(to: current) }
                }
            case "H":
                for x in numbers { current.x = x; path.addLine(to: current) }
            case "V":
                for y in numbers { current.y = y; path.addLine(to: current) }
            case "C":
                for index in stride(from: 0, to: numbers.count - 5, by: 6) {
                    current = CGPoint(x: numbers[index + 4], y: numbers[index + 5])
                    path.addCurve(to: current, control1: CGPoint(x: numbers[index], y: numbers[index + 1]), control2: CGPoint(x: numbers[index + 2], y: numbers[index + 3]))
                }
            case "Z":
                path.closeSubpath()
            default:
                break
            }
            numbers = []
        }
        for token in tokens {
            if let value = Double(token) {
                numbers.append(CGFloat(value))
            } else {
                flush()
                command = token
                if token == "Z" { flush() }
            }
        }
        flush()
        self.path = path
    }

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
        let x = rect.minX + (rect.width - viewBox.width * scale) / 2 - viewBox.minX * scale
        let y = rect.minY + (rect.height - viewBox.height * scale) / 2 - viewBox.minY * scale
        return path.applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: x, ty: y))
    }
}

// Claude Spark
struct ClaudeMark: Shape {
    private static let mark = SVGMark(viewBox: CGRect(x: 0, y: 0, width: 94, height: 94), data: "M18.7657 62.4437L37.1822 52.1167L37.4857 51.2122L37.1822 50.7085H36.2715L33.1852 50.5208L22.6615 50.2391L13.5545 49.8636L4.70044 49.3942L2.47428 48.9248L0.399902 46.1553L0.602281 44.794L2.47428 43.5266L5.15579 43.7613L11.0754 44.1837L19.98 44.794L26.4055 45.1695L35.9679 46.1553H37.4857L37.6881 45.545L37.1822 45.1695L36.7774 44.794L27.5692 38.5508L17.6021 31.9791L12.3908 28.1769L9.60812 26.2524L8.19147 24.4686L7.58433 20.5256L10.1141 17.7091L13.5545 17.9438L14.4146 18.1785L17.9056 20.8542L25.343 26.6279L35.0572 33.7629L36.4739 34.9364L37.0443 34.5514L37.1316 34.2792L36.4739 33.1996L31.212 23.6706L25.596 13.9539L23.0663 9.91695L22.4086 7.52296C22.1538 6.51831 22.0038 5.68714 22.0038 4.65957L24.8877 0.716544L26.5067 0.200195L30.4025 0.716544L32.0215 2.12477L34.4501 7.66379L38.3458 16.3478L44.4172 28.1769L46.188 31.6975L47.1493 34.9364L47.5035 35.9222H48.1106V35.3589L48.6166 28.6933L49.5273 20.5256L50.438 10.0108L50.7415 7.05356L52.2088 3.48605L55.1433 1.56148L57.42 2.64112L59.292 5.31674L59.039 7.05356L57.926 14.2824L55.7504 25.5952L54.3337 33.1996H55.1433L56.1046 32.2138L59.9497 27.1442L66.3752 19.0704L69.2085 15.8784L72.5478 12.3579L74.6728 10.668H78.7203L81.6548 15.0804L80.3394 19.6337L76.1906 24.8911L72.7502 29.3504L67.8172 35.9595L64.7562 41.2734L65.0307 41.7118L65.7681 41.6489L76.8989 39.255L82.9197 38.1753L90.1041 36.9549L93.3422 38.457L93.6963 40.006L92.4315 43.151L84.7411 45.0287L75.7353 46.8594L62.3244 50.0164L62.1759 50.1358L62.3512 50.3958L68.399 50.9432L70.9794 51.084H77.3037L89.0922 51.9759L92.1785 53.9944L93.9999 56.4822L93.6963 58.4068L88.9404 60.8008L82.5655 59.2987L67.6401 55.7312L62.5301 54.4638H61.8217V54.8862L66.0717 59.064L73.9139 66.1051L83.6786 75.2116L84.1845 77.4648L82.9197 79.2485L81.6042 79.0608L73.0032 72.5829L69.6639 69.6726L62.1759 63.3356H61.67V63.9928L63.3902 66.5276L72.5478 80.2812L73.0032 84.5059L72.3454 85.8672L69.9675 86.7121L67.3871 86.2427L61.9735 78.6852L56.4587 70.2359L52.0064 62.6315L51.4687 62.971L48.8189 91.2654L47.6047 92.7206L44.7714 93.8002L42.3934 92.0164L41.1286 89.1061L42.3934 83.3324L43.9113 75.8219L45.1255 69.8604L46.2386 62.4437L46.9184 59.9661L46.8583 59.8003L46.3153 59.8916L40.7238 67.5603L32.2239 79.0608L25.4948 86.2427L23.8758 86.8999L21.0931 85.4447L21.3461 82.863L22.9145 80.5629L32.2239 68.7338L37.8399 61.3641L41.4594 57.1337L41.4242 56.5218L41.2244 56.5048L16.489 72.6299L12.0873 73.1932L10.1647 71.4094L10.4176 68.4991L11.3283 67.5603L18.7657 62.4437Z")

    func path(in rect: CGRect) -> Path { Self.mark.path(in: rect) }
}

// OpenAI Blossom
struct OpenAIMark: Shape {
    private static let mark = SVGMark(viewBox: CGRect(x: 146.694, y: 227.042, width: 267.198, height: 264.812), data: "M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z")

    func path(in rect: CGRect) -> Path { Self.mark.path(in: rect) }
}

// Куб Cursor, одноцветный знак
struct CursorMark: Shape {
    private static let mark = SVGMark(viewBox: CGRect(x: 387.545, y: 394.6, width: 191.7, height: 191.7), data: "M563.463 439.971L487.344 396.057C484.899 394.646 481.883 394.646 479.439 396.057L403.323 439.971C401.269 441.156 400 443.349 400 445.723V534.276C400 536.647 401.269 538.843 403.323 540.029L479.443 583.943C481.887 585.353 484.903 585.353 487.347 583.943L563.466 540.029C565.521 538.843 566.79 536.651 566.79 534.276V445.723C566.79 443.352 565.521 441.156 563.466 439.971H563.463ZM558.681 449.273L485.199 576.451C484.703 577.308 483.391 576.958 483.391 575.966V492.691C483.391 491.027 482.501 489.488 481.058 488.652L408.887 447.016C408.03 446.52 408.38 445.209 409.373 445.209H556.337C558.424 445.209 559.728 447.47 558.685 449.276H558.681V449.273Z")

    func path(in rect: CGRect) -> Path { Self.mark.path(in: rect) }
}

// Значок модели для строки меню: шаблонное изображение (macOS сама красит его под тему), повёрнутое на angle
enum StatusMark {
    static func image(agent: String, angle: CGFloat) -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            let frame = rect.insetBy(dx: 1.5, dy: 1.5)
            let (path, filled): (Path, Bool) = switch agent {
            case "claude": (ClaudeMark().path(in: frame), true)
            case "codex": (OpenAIMark().path(in: frame), true)
            case "cursor": (CursorMark().path(in: frame), true)
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
        case "claude": ClaudeMark().fill()
        case "codex": OpenAIMark().fill()
        case "cursor": CursorMark().fill()
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

// Бейдж особого состояния поверх знака модели: песочные часы — лимит исчерпан, пауза — только вручную
struct AgentBadge: View {
    let availability: AgentAvailability

    var body: some View {
        switch availability {
        case .limitExhausted: badge("hourglass.circle.fill", .red)
        case .manualOnly: badge("pause.circle.fill", .gray)
        case .available: EmptyView()
        }
    }

    private func badge(_ symbol: String, _ color: Color) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 8, weight: .bold))
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, color)
            .background(Circle().fill(Theme.card).padding(-1))
            .offset(x: 3, y: 3)
    }
}

// Капсула в шапке обзора для модели с исчерпанным лимитом или только для ручного запуска
struct AvailabilityCapsule: View {
    let agent: String
    let name: String
    let availability: AgentAvailability
    let action: () -> Void

    private var text: String {
        switch availability {
        case .limitExhausted(let resetsAt, _): "\(name): лимит \(Dates.resetShort(resetsAt))"
        case .manualOnly, .available: "\(name): только вручную"
        }
    }

    private var hint: String {
        switch availability {
        case .limitExhausted(let resetsAt, let updatedAt):
            "\(name) исчерпал лимит, сброс \(Dates.resetFull(resetsAt)). После сброса модель снова начнёт ревью сама. Обновлено \(Dates.ago(updatedAt))"
        case .manualOnly, .available:
            "\(name) не участвует в фоновом ревью и запускается только по клику на значок. Включить — Настройки → Модели"
        }
    }

    var body: some View {
        let limited = availability.isLimitExhausted
        Button(action: action) {
            HStack(spacing: 4) {
                AgentMark(agent: agent)
                    .foregroundStyle(AgentMark.color(agent))
                    .frame(width: 15, height: 15)
                    .overlay(alignment: .bottomTrailing) { AgentBadge(availability: availability) }
                    .scaleEffect(0.8)
                    .frame(width: 16, height: 16)
                Text(text)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(limited ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(limited ? Color.red.opacity(0.12) : Color.secondary.opacity(0.14), in: Capsule())
            .fixedSize()
        }
        .buttonStyle(.plain)
        .help(hint)
    }
}

struct AgentReviewButton: View {
    let agent: String
    let name: String
    let state: ReviewState
    var availability: AgentAvailability = .available
    // При выключенном фоновом ревью вручную запускаются все модели, и пометка «только вручную» ничего не говорит
    var showsManualBadge = true
    var skipReason: String?
    let action: () -> Void

    private var busy: Bool { state == .queued || state == .running }

    private var tint: Color {
        switch state {
        case .none, .queued: .secondary.opacity(0.4)
        case .stale: AgentMark.color(agent).opacity(0.45)
        case .done, .running: AgentMark.color(agent)
        }
    }

    private var badge: AgentAvailability {
        if case .manualOnly = availability, !showsManualBadge { return .available }
        return availability
    }

    // У лимита нет «Нажмите, чтобы запустить»: запуск упрётся в лимит, но кнопка работает — данные о лимите могут устареть
    private var hint: String {
        switch (state, availability) {
        case (.none, .limitExhausted(let resetsAt, _)), (.stale, .limitExhausted(let resetsAt, _)):
            return "\(name): лимит исчерпан \(Dates.resetShort(resetsAt)) — ревью будет после сброса"
        case (.none, .manualOnly):
            return "\(name): ревью не было — модель только для ручного запуска. Нажмите, чтобы запустить"
        case (.stale, .manualOnly):
            return "\(name): ревью было на старом коммите, в фоне модель не запускается. Нажмите, чтобы проверить новый"
        case (.done, _) where skipReason == "rebase":
            return "\(name): повторное ревью не нужно — после rebase изменения те же. Нажмите, чтобы проверить заново"
        case (.done, _) where skipReason == "ignored":
            return "\(name): ревью не понадобилось — в диффе только исключённые файлы. Нажмите, чтобы проверить заново"
        case (.done, _) where skipReason == "empty":
            return "\(name): ревью не понадобилось — в PR нет изменений относительно целевой ветки. Нажмите, чтобы проверить заново"
        default:
            break
        }
        let base = switch state {
        case .none: "\(name): ревью не было. Нажмите, чтобы запустить"
        case .stale: "\(name): ревью было на старом коммите. Нажмите, чтобы проверить новый"
        case .done: "\(name): ревью актуально. Нажмите, чтобы проверить заново"
        case .queued: "\(name): ревью в очереди"
        case .running: "\(name): идёт ревью"
        }
        if case .manualOnly = availability { return "\(base). В фоне эта модель не запускается" }
        return base
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
                    .overlay(alignment: .bottomTrailing) {
                        if !busy { AgentBadge(availability: badge) }
                    }
            }
            .frame(width: 20, height: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .help(hint)
    }
}
