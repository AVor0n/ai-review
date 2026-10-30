import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let panel = PanelController()
    private let notifier = Notifier()
    private var important: [OpenFinding] = []
    private let menu = NSMenu()
    private let agentNames = ["claude": "Claude", "codex": "Codex", "cursor": "Cursor"]
    private let roleNames = ["first": "первым", "second": "следом", "replies": "ответы"]

    func applicationDidFinishLaunching(_ notification: Notification) {
        // По этому имени macOS запоминает место иконки после перетаскивания с ⌘ и восстанавливает его после перезагрузки
        statusItem.autosaveName = "PRReviewer"
        NSApp.mainMenu = editMenu()
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusItemClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        notifier.setup()
        refreshIcon()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshIcon() }
        }
    }

    // У приложения строки состояния нет главного меню, а Cmd+V/C/X/A/Z macOS доставляет полям ввода
    // через пункты меню «Правка». Меню невидимо (строки меню у приложения нет), но сочетания начинают работать
    private func editMenu() -> NSMenu {
        let edit = NSMenu(title: "Правка")
        let items: [(String, Selector, String, NSEvent.ModifierFlags)] = [
            ("Отменить", Selector(("undo:")), "z", .command),
            ("Повторить", Selector(("redo:")), "z", [.command, .shift]),
            ("Вырезать", #selector(NSText.cut(_:)), "x", .command),
            ("Копировать", #selector(NSText.copy(_:)), "c", .command),
            ("Вставить", #selector(NSText.paste(_:)), "v", .command),
            ("Выбрать всё", #selector(NSText.selectAll(_:)), "a", .command),
        ]
        for (title, action, key, modifiers) in items {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            edit.addItem(item)
        }
        let editItem = NSMenuItem(title: "Правка", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        let main = NSMenu()
        main.addItem(NSMenuItem())
        main.addItem(editItem)
        return main
    }

    // Меню по правому клику: чем занят сервис и частые действия из шапки обзора, уведомления и выход.
    // Меню собирается при каждом показе: в нём текущее состояние и срок, до которого уведомления выключены
    private func rebuildMenu() {
        menu.removeAllItems()
        menu.addItem(NSMenuItem(title: statusLine(), action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        // Как кнопки ■ и ▶ в шапке обзора: явное ревью по иконке идёт и при выключенном фоновом, его тоже можно прервать
        if isRunning {
            addAction("Прервать ревью", #selector(stopClicked))
        } else if !isPaused {
            addAction("Проверить сейчас", #selector(runNowClicked))
        }
        addAction(isPaused ? "Включить фоновое ревью" : "Выключить фоновое ревью", #selector(togglePauseClicked))
        menu.addItem(.separator())
        let settings = NotificationStore.shared.settings
        if settings.isMuted {
            menu.addItem(NSMenuItem(title: "Уведомления: \(settings.muteSummary.lowercased())", action: nil, keyEquivalent: ""))
            let unmute = NSMenuItem(title: "Включить уведомления", action: #selector(unmuteClicked), keyEquivalent: "")
            unmute.target = self
            menu.addItem(unmute)
        }
        let periods = NSMenu()
        for period in MutePeriod.all {
            let item = NSMenuItem(title: period.title, action: #selector(muteClicked(_:)), keyEquivalent: "")
            item.target = self
            item.tag = period.id
            periods.addItem(item)
        }
        let mute = NSMenuItem(title: settings.isMuted ? "Выключить на другое время" : "Выключить уведомления", action: nil, keyEquivalent: "")
        mute.submenu = periods
        menu.addItem(mute)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Выйти из PR Reviewer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func addAction(_ title: String, _ action: Selector) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
    }

    // Порядок проверок — как у подсказки значка в refreshIcon()
    private func statusLine() -> String {
        let status = loadStatus()
        if let stall = workerStall() { return "Проход не продвигается \(stall.minutes) мин" }
        if isRunning { return status?.current.map { "Идёт ревью: \(reviewTarget($0))" } ?? "Идёт проверка PR" }
        if fixIsRunning { return "Идёт доработка · Claude" }
        if isPaused { return "Фоновое ревью выключено" }
        if status?.phase == "error" { return "Последний проход завершился с ошибкой" }
        guard let last = Dates.parse(status?.lastPassAt) else { return "Ожидание" }
        let interval = readJSON(AppConfig.self, Paths.config)?.intervalMinutes ?? 15
        let minutes = Int((last.addingTimeInterval(TimeInterval(interval * 60)).timeIntervalSinceNow / 60).rounded(.up))
        return minutes <= 1 ? "Следующий проход в течение минуты" : "Следующий проход через \(minutes) мин"
    }

    private func runCommand(_ arguments: [String]) {
        CLI.run(arguments) { _, _ in self.refreshIcon() }
    }

    @objc private func stopClicked() { runCommand(["stop"]) }

    @objc private func runNowClicked() { runCommand(["run-now"]) }

    // pause в CLI заодно прерывает идущее ревью
    @objc private func togglePauseClicked() { runCommand([isPaused ? "resume" : "pause"]) }

    @objc private func muteClicked(_ sender: NSMenuItem) {
        guard let period = MutePeriod.all.first(where: { $0.id == sender.tag }) else { return }
        NotificationStore.shared.mute(period)
        refreshIcon()
    }

    @objc private func unmuteClicked() {
        NotificationStore.shared.unmute()
        refreshIcon()
    }

    private func loadStatus() -> Status? { readJSON(Status.self, Paths.status) }
    private var isPaused: Bool { workerIsPaused }
    private var isRunning: Bool { workerIsRunning }

    private func refreshFindings() -> (state: WorkerState, snapshots: [String: PrSnapshot]) {
        let state = readJSON(WorkerState.self, Paths.state) ?? WorkerState(repos: nil)
        var snapshots: [String: PrSnapshot] = [:]
        for slug in state.repos?.keys.map({ $0 }) ?? [] { snapshots[slug] = loadSnapshot(slug) }
        important = openFindings(state: state, snapshots: snapshots).filter(\.finding.isImportant)
        notifier.check(state: state, snapshots: snapshots, status: loadStatus()) { self.agentNames[$0] ?? $0 }
        return (state, snapshots)
    }

    // Модель, которая работает прямо сейчас: ревью из status.json или доработка (её всегда делает Claude)
    private var spinningAgent: String?
    private var spinAngle: CGFloat = 0
    private var spinTimer: Timer?

    private func setSpinning(_ agent: String?) {
        guard agent != spinningAgent else { return }
        spinningAgent = agent
        spinTimer?.invalidate()
        spinTimer = nil
        guard agent != nil else { return }
        // Оборот за 2 секунды, 20 кадров в секунду: плавно и почти без нагрузки
        spinTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let agent = self.spinningAgent else { return }
                self.spinAngle = (self.spinAngle + .pi / 20).truncatingRemainder(dividingBy: 2 * .pi)
                self.statusItem.button?.image = StatusMark.image(agent: agent, angle: self.spinAngle)
            }
        }
    }

    private func refreshIcon() {
        let (state, snapshots) = refreshFindings()
        let config = readJSON(AppConfig.self, Paths.config)
        let unreviewed = config.map { unreviewedPrs(config: $0, state: state, snapshots: snapshots) } ?? 0
        let status = loadStatus()
        let fixing = fixIsRunning
        var tip: String
        var symbol: String?
        var tint: NSColor?
        let stall = workerStall()
        if let stall {
            // Зависший проход важнее крутящегося значка модели: иначе выглядит, будто ревью идёт
            setSpinning(nil)
            symbol = "exclamationmark.triangle.fill"
            tint = .systemOrange
            tip = "PR Reviewer: проход ревью не продвигается \(stall.minutes) мин — прервать можно в обзоре"
            if !stallShown { blinkOnce() }
            stallShown = true
        } else if isRunning, let agent = status?.current?.agent {
            tip = "PR Reviewer: \(currentText(status?.current))"
            setSpinning(agent)
        } else if fixing {
            tip = "PR Reviewer: доработка PR по замечаниям · Claude"
            setSpinning("claude")
        } else {
            setSpinning(nil)
            if isPaused {
                symbol = "pause.circle"
                tip = "PR Reviewer: пауза"
            } else if isRunning {
                symbol = "ellipsis.bubble"
                tip = "PR Reviewer: идёт проверка PR"
            } else if status?.phase == "error" {
                symbol = "exclamationmark.bubble"
                tip = "PR Reviewer: ошибка"
                tint = .systemRed
            } else {
                symbol = "checkmark.bubble"
                tip = "PR Reviewer: ожидание"
            }
        }
        if stall == nil { stallShown = false }
        if let symbol {
            let image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
            image?.isTemplate = true
            statusItem.button?.image = image
        }
        statusItem.button?.contentTintColor = tint
        // Счётчик — открытые PR без ревью на текущем коммите
        statusItem.button?.title = unreviewed > 0 ? "\(unreviewed)" : ""
        if unreviewed > 0 { tip += "\nPR без ревью на текущем коммите: \(unreviewed)" }
        if !important.isEmpty { tip += "\nВажных замечаний ждут правки: \(important.count)" }
        let notifications = NotificationStore.shared.settings
        if notifications.isMuted { tip += "\nУведомления: \(notifications.muteSummary.lowercased())" }
        statusItem.button?.toolTip = tip
    }

    private var stallShown = false
    private var blinkTimer: Timer?

    // Мигает несколько секунд, когда зависание только обнаружено, дальше горит ровно:
    // постоянная анимация в строке меню раздражала бы часами, пока проход висит
    private func blinkOnce() {
        blinkTimer?.invalidate()
        var ticks = 0
        blinkTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let button = self?.statusItem.button else { return timer.invalidate() }
                ticks += 1
                button.alphaValue = ticks % 2 == 1 ? 0.25 : 1
                if ticks >= 12 {
                    button.alphaValue = 1
                    timer.invalidate()
                }
            }
        }
    }

    private func currentText(_ current: Current?) -> String {
        guard let current else { return "идёт проверка PR" }
        return "ревью \(reviewTarget(current))"
    }

    private func reviewTarget(_ current: Current) -> String {
        let agent = agentNames[current.agent] ?? current.agent
        return "\(shortRepo(current.repo)) #\(current.pr) · \(agent) (\(roleNames[current.role] ?? current.role))"
    }

    private func shortRepo(_ slug: String) -> String {
        slug.hasPrefix("project-") ? String(slug.dropFirst("project-".count)) : slug
    }

    // Левый клик открывает и закрывает обзор, правый или Ctrl-клик — меню
    @objc private func statusItemClicked() {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            panel.close()
            // Меню привязываем только на время показа, иначе оно перехватывало бы и левый клик
            menu.appearance = AppAppearance.current
            rebuildMenu()
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else if panel.isShown {
            panel.close()
        } else {
            panel.show(.overview, from: statusItem.button)
        }
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
