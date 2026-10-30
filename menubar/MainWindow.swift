import SwiftUI

enum Tab: Hashable, CaseIterable {
    case overview, backlog, stats, log, settings

    var title: String {
        switch self {
        case .overview: "Обзор"
        case .backlog: "Бэклог"
        case .stats: "Статистика"
        case .log: "Журнал"
        case .settings: "Настройки"
        }
    }
}

final class TabSelection: ObservableObject {
    @Published var tab: Tab = .overview
    // Открыть лист памяти этого репозитория при переходе в настройки
    @Published var memoryRepo: String?
    // Открыть лист токенов при переходе в настройки
    @Published var tokens = false
}

struct MainView: View {
    @ObservedObject var selection: TabSelection

    var body: some View {
        VStack(spacing: 0) {
            SegmentedPicker(options: Tab.allCases, selection: $selection.tab, title: \.title)
                .padding(.top, 14)
                .padding(.bottom, 10)
            switch selection.tab {
            case .overview:
                OverviewView(
                    openRepos: { selection.tab = .settings },
                    openLog: { selection.tab = .log },
                    openMemory: { slug in
                        selection.memoryRepo = slug
                        selection.tab = .settings
                    },
                    openTokens: {
                        selection.tokens = true
                        selection.tab = .settings
                    }
                )
            case .backlog: BacklogView()
            case .stats: StatsView()
            case .log: LogView()
            case .settings: SettingsView(selection: selection)
            }
        }
        .frame(width: 780, height: 600)
        .background(Theme.background)
        // Без этого поповер ставит фокус клавиатуры на первый контрол и рисует вокруг него синюю обводку
        .focusEffectDisabled()
        .environment(\.locale, Locale(identifier: "ru_RU"))
    }
}

@MainActor
final class PanelController: NSObject, NSPopoverDelegate {
    private let model = AppModel()
    private let selection = TabSelection()
    private var monitors: [Any] = []
    private lazy var popover: NSPopover = {
        let popover = NSPopover()
        // Встроенное transient-закрытие ждёт деактивации приложения, а приложение строки состояния
        // система может так и не активировать — тогда поповер не закрывался вовсе. Закрываем сами
        popover.behavior = .applicationDefined
        popover.animates = true
        popover.contentSize = NSSize(width: 780, height: 600)
        popover.contentViewController = NSHostingController(rootView: MainView(selection: selection).environmentObject(model))
        popover.delegate = self
        return popover
    }()

    var isShown: Bool { popover.isShown }

    override init() {
        super.init()
        NotificationCenter.default.addObserver(forName: AppAppearance.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.popover.appearance = AppAppearance.current }
        }
    }

    func show(_ tab: Tab, from button: NSStatusBarButton?) {
        selection.tab = tab
        guard let button else { return }
        model.start()
        NSApp.activate()
        popover.appearance = AppAppearance.current
        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            startMonitors()
        }
        popover.contentViewController?.view.window?.makeKey()
    }

    func close() {
        // Если панель закрыть с открытым листом, лист остаётся привязанным к её окну и после повторного
        // открытия перехватывает все клики. Сначала закрываем лист так же, как Esc, — тогда и состояние SwiftUI сбросится
        if let window = popover.contentViewController?.view.window, let sheet = window.attachedSheet {
            sheet.makeKey()
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let escape = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: sheet.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                                                 isARepeat: false, keyCode: 53) {
                    sheet.sendEvent(escape)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    // Лист без кнопки отмены на Esc не реагирует — снимаем его силой
                    if let stuck = window.attachedSheet { window.endSheet(stuck) }
                    self.popover.performClose(nil)
                }
            }
            return
        }
        popover.performClose(nil)
    }

    private func startMonitors() {
        // Глобальный монитор видит клики только в чужих приложениях: свой диалог выбора папки поповер не закрывает
        if let global = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            guard event.keyCode == 53, let self, NSApp.keyWindow == self.popover.contentViewController?.view.window else { return event }
            self.close()
            return nil
        }) {
            monitors.append(local)
        }
    }

    func popoverDidClose(_ notification: Notification) {
        QaMediaWindow.shared.lower()
        monitors.forEach(NSEvent.removeMonitor)
        monitors = []
        model.stop()
    }
}
