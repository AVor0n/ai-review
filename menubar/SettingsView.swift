import SwiftUI

// @State в этом SDK — макрос, а плагина SwiftUIMacros в Command Line Tools нет; локальное состояние держим в ObservableObject
private final class SettingsScreen: ObservableObject {
    @Published var adding = false
    @Published var removing: RepoConfig?
    @Published var memoryRepo: RepoConfig?
    @Published var editingIgnore = false
    @Published var editingConfig = false
    @Published var editingBranches = false
    @Published var editingTokens = false
    @Published var editingNotifications = false
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var selection: TabSelection
    @StateObject private var screen = SettingsScreen()
    @AppStorage(AppAppearance.storageKey) private var appearance = AppAppearance.system

    private func openRequestedMemory() {
        guard let slug = selection.memoryRepo else { return }
        selection.memoryRepo = nil
        screen.memoryRepo = model.config.repos.first { $0.slug == slug }
    }

    private func openRequestedTokens() {
        guard selection.tokens else { return }
        selection.tokens = false
        screen.editingTokens = true
    }

    @ObservedObject private var notifications = NotificationStore.shared

    // Подписи строк плитки «Общие» — одной строкой под ней, как в «Настройках» iOS
    private var generalFooter: String {
        var parts = [model.isPaused ? "Ручной запуск из обзора работает всегда." : "Выключение фонового ревью прерывает идущее ревью."]
        if notifications.denied {
            parts.append("macOS запретила уведомления — включите их в системных настройках.")
        } else {
            let own = model.config.repos.map(\.slug).filter { notifications.settings.repos[$0] != nil }
            if !own.isEmpty { parts.append("Свои уведомления у \(own.joined(separator: ", ")).") }
        }
        return parts.joined(separator: " ")
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                GroupedSection(footer: generalFooter) {
                    Text("Общие")
                } content: {
                    HStack {
                        Text("Тема").font(.system(size: 13))
                        Spacer()
                        SegmentedPicker(options: AppAppearance.allCases, selection: $appearance, title: \.title, segmentWidth: 90)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    RowDivider()
                    HStack {
                        Text("Фоновое ревью").font(.system(size: 13))
                        Spacer()
                        Toggle("Фоновое ревью", isOn: Binding(get: { !model.isPaused }, set: { model.setServicePaused(!$0) }))
                            .labelsHidden()
                            .toggleStyle(.switch)
                            .tint(.green)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .help("Новые коммиты и ответы в тредах включённых репозиториев проверяются по расписанию. Выключение прерывает идущее ревью; по клику на иконку модели в обзоре ревью запускается всегда")
                    RowDivider()
                    IntervalRow()
                        .opacity(model.isPaused ? 0.45 : 1)
                    RowDivider()
                    NotificationsRow { screen.editingNotifications = true }
                }

                GroupedSection(
                    "Подключённые репозитории"
                ) {
                    ForEach(model.config.repos) { repo in
                        RepoRow(repo: repo, remove: { screen.removing = repo }, openMemory: { screen.memoryRepo = repo })
                        RowDivider(inset: 52)
                    }
                    Button {
                        screen.adding = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 20))
                                .foregroundStyle(.green)
                                .frame(width: 28)
                            Text("Добавить репозиторий").foregroundStyle(Color.accentColor)
                            Spacer()
                        }
                        .font(.system(size: 13))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverHighlight()
                }

                GroupedSection(
                    "Модели",
                    footer: "Выключенная модель запускается только по клику на её иконку в обзоре."
                ) {
                    ForEach(Array(model.agentIds.enumerated()), id: \.element) { index, id in
                        if index > 0 { RowDivider(inset: 52) }
                        AgentRow(id: id)
                    }
                }

                GroupedSection(
                    "Дополнительно",
                    footer: "Шаблон веток касается только фонового ревью."
                ) {
                    BranchPatternRow { screen.editingBranches = true }
                    RowDivider()
                    Button {
                        screen.editingIgnore = true
                    } label: {
                        HStack {
                            Text("Исключения из диффа").font(.system(size: 13))
                            Spacer()
                            Text("\(model.config.ignorePaths?.count ?? 0)")
                                .font(.system(size: 13).monospacedDigit())
                                .foregroundStyle(.secondary)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverHighlight()
                    RowDivider()
                    TokensRow { screen.editingTokens = true }
                    RowDivider()
                    Button {
                        screen.editingConfig = true
                    } label: {
                        HStack {
                            Text("config.json").font(.system(size: 13))
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverHighlight()
                }

                BuildInfoRow()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .onChange(of: appearance) { appearance.apply() }
        .onAppear {
            openRequestedMemory()
            openRequestedTokens()
            model.refreshCursorModels()
            model.refreshLimits()
        }
        .onChange(of: selection.memoryRepo) { openRequestedMemory() }
        .onChange(of: selection.tokens) { openRequestedTokens() }
        .sheet(isPresented: $screen.editingTokens) {
            TokensSheet()
        }
        .sheet(isPresented: $screen.editingNotifications) {
            NotificationsSheet()
        }
        .sheet(isPresented: $screen.adding) {
            AddRepoSheet()
        }
        .sheet(isPresented: $screen.editingIgnore) {
            IgnoreSheet()
        }
        .sheet(isPresented: $screen.editingConfig) {
            ConfigSheet()
        }
        .sheet(isPresented: $screen.editingBranches) {
            BranchPatternSheet()
        }
        .sheet(item: $screen.memoryRepo) { repo in
            MemorySheet(repo: repo)
        }
        .confirmationDialog(
            "Отключить \(screen.removing?.slug ?? "")?",
            isPresented: Binding(get: { screen.removing != nil }, set: { if !$0 { screen.removing = nil } }),
            presenting: screen.removing
        ) { repo in
            Button("Отключить и удалить клон", role: .destructive) { model.removeRepo(repo.slug) }
        } message: { _ in
            Text("Ревью этого репозитория прекратится, служебная копия будет удалена. Комментарии в Bitbucket и статистика останутся.")
        }
    }
}

private struct RepoRow: View {
    @EnvironmentObject private var model: AppModel
    let repo: RepoConfig
    let remove: () -> Void
    let openMemory: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 13))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(repo.isPaused || model.isPaused ? Color.gray : Color.blue, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("\(repo.workspace)/\(repo.slug)").font(.system(size: 13))
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let error = model.cloneErrors[repo.slug] {
                    Text(error).font(.system(size: 11)).foregroundStyle(.red).lineLimit(3).textSelection(.enabled)
                }
            }
            Spacer()
            cloneStatus
            let fresh = model.newLessons(repo.slug).count
            let broken = model.memoryBroken[repo.slug]
            let badge: Color? = broken != nil ? .red : fresh > 0 ? .accentColor : nil
            Button(action: openMemory) {
                HStack(spacing: 4) {
                    Image(systemName: "brain")
                    Text("\(model.memory[repo.slug]?.count ?? 0)").monospacedDigit()
                }
                .font(.system(size: 12))
                .foregroundStyle(badge ?? .secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(badge.map { $0.opacity(0.15) } ?? Theme.track, in: Capsule())
                // Точка, как у непрочитанного в Mail: синяя — новые правила, красная — файл памяти повреждён
                .overlay(alignment: .topTrailing) {
                    if let badge {
                        Circle().fill(badge).frame(width: 7, height: 7).offset(x: 2, y: -2)
                    }
                }
            }
            .buttonStyle(.plain)
            .help(broken.map { "Память повреждена: \($0)" } ?? (fresh > 0 ? "Новых правил: \(fresh). Откройте, чтобы посмотреть" : "Память ревьюеров: правила из ответов команды на замечания"))
            Menu {
                if let url = repo.webURL {
                    Button("Открыть в Bitbucket") { NSWorkspace.shared.open(url) }
                }
                Button("Память ревьюеров…", action: openMemory)
                Button("Показать служебную копию в Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([Paths.clone(repo.slug)])
                }
                .disabled(!model.cloned.contains(repo.slug))
                Divider()
                Button("Отключить…", role: .destructive, action: remove)
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(.secondary)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            Toggle("Фоновое ревью", isOn: Binding(get: { !repo.isPaused }, set: { model.setRepoPaused(repo.slug, !$0) }))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(.green)
                // Пока весь сервис на паузе, переключатель репозитория ни на что не влияет — показываем его приглушённым, как зависимые настройки в iOS,
                // и не даём переключить: иначе случайный клик молча менял бы конфиг
                .opacity(model.isPaused ? 0.45 : 1)
                .disabled(model.isPaused)
                .help(model.isPaused ? "Сначала включите фоновое ревью наверху" : repo.isPaused ? "Фоновое ревью репозитория выключено" : "Фоновое ревью репозитория включено")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        // У неактивного переключателя подсказка может не показаться — дублируем её на всю строку
        .help(model.isPaused ? "Сначала включите фоновое ревью наверху" : "")
    }

    private var subtitle: String {
        if let source = repo.source { return "\(repo.remote) · первый клон с \(source)" }
        return repo.remote
    }

    @ViewBuilder
    private var cloneStatus: some View {
        if model.cloning.contains(repo.slug) {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Скачивается…")
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
        } else if !model.cloned.contains(repo.slug) {
            Button("Скачать") { model.cloneRepo(repo.slug) }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
        }
    }
}

private struct AgentRow: View {
    @EnvironmentObject private var model: AppModel
    let id: String

    // Псевдоним opus всегда указывает на последнюю Opus; остальные — конкретные версии
    private static let claudeModels: [(id: String, title: String, label: String)] = [
        ("opus", "Opus (последняя)", "Claude Opus"),
        ("claude-opus-5-5", "Opus 5.5", "Claude Opus 5.5"),
        ("claude-sonnet-5-5", "Sonnet 5.5", "Claude Sonnet 5.5"),
        ("claude-haiku-5-5", "Haiku 5.5", "Claude Haiku 5.5"),
        ("claude-fable-5-1", "Fable 5.1", "Claude Fable 5.1"),
    ]
    private static let claudeEfforts = ["low", "medium", "high", "xhigh", "max"]

    private var agent: AgentConfig? { model.config.agents[id] }
    private var current: String { agent?.model ?? "" }
    // Кэш Codex CLI меняется редко, а меню перерисовывается часто — читаем файл один раз за запуск приложения
    private static let codexCache = CodexModel.load()
    private var codexModels: [CodexModel] { Self.codexCache }

    // Модель из конфига, которой нет в списке, всё равно показываем — иначе меню выглядело бы пустым
    private var modelOptions: [(id: String, title: String)] {
        let known: [(id: String, title: String)] = switch id {
        case "claude": Self.claudeModels.map { ($0.id, $0.title) }
        case "cursor": model.cursorModels
        default: codexModels.map { ($0.slug, $0.displayName) }
        }
        return known.contains { $0.id == current } || current.isEmpty ? known : [(current, current)] + known
    }

    private var effortOptions: [(id: String, title: String)] {
        if id == "claude" { return [("default", "По умолчанию")] + Self.claudeEfforts.map { ($0, $0) } }
        let levels = codexModels.first { $0.slug == current }?.efforts ?? ["low", "medium", "high"]
        return levels.map { ($0, $0) }
    }

    private var currentEffort: String {
        id == "claude" ? agent?.effort ?? "default" : agent?.reasoningEffort ?? ""
    }

    private func selectModel(_ value: String) {
        guard value != current else { return }
        if id == "claude" {
            model.setAgent(id, model: value, label: Self.claudeModels.first { $0.id == value }?.label)
        } else if id == "cursor" {
            model.setAgent(id, model: value, label: model.cursorModels.first { $0.id == value }.map { "Cursor \($0.title)" })
        } else {
            let codex = codexModels.first { $0.slug == value }
            // Уровень, которого новая модель не поддерживает, меняем на её уровень по умолчанию
            let effort = codex.flatMap { $0.efforts.contains(currentEffort) ? nil : $0.defaultReasoningLevel ?? $0.efforts.last }
            model.setAgent(id, model: value, effort: effort, label: codex.map { "Codex \($0.displayName)" })
        }
    }

    private static let resetFormat: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.setLocalizedDateFormatFromTemplate("d MMM")
        return formatter
    }()

    private static let fullFormat: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.setLocalizedDateFormatFromTemplate("d MMMM HH:mm")
        return formatter
    }()

    @ViewBuilder
    private var limitLine: some View {
        if let limit = model.limits[id] {
            HStack(spacing: 6) {
                LimitBar(remaining: limit.remaining)
                Text("\(Int(limit.remaining.rounded()))% \(limit.window == "month" ? "месяца" : "недели") осталось\(Dates.parse(limit.resetsAt).map { " · до \(Self.resetFormat.string(from: $0))" } ?? "")")
                    .font(.system(size: 11).monospacedDigit())
                    .lineLimit(1)
                    .foregroundStyle(limit.remaining < 15 ? Color.orange : .secondary)
            }
            .help("Остаток лимита подписки на \(limit.window == "month" ? "месяц" : "неделю"), сброс \(Dates.parse(limit.resetsAt).map { Self.fullFormat.string(from: $0) } ?? "—"). Обновлено \(Dates.ago(limit.at))")
        } else {
            Text(id == "claude" ? "лимит появится после ближайшего запуска" : "лимит недоступен")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            AgentMark(agent: id)
                .foregroundStyle(AgentMark.color(id))
                .frame(width: 16, height: 16)
                .frame(width: 28, height: 28)
                .background(Theme.track, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .opacity(agent?.isAuto == false ? 0.5 : 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.agentName(id)).font(.system(size: 13))
                limitLine
            }
            Spacer()
            MenuSelect(options: modelOptions, selection: current, width: 160, select: selectModel)
                .help("Модель")
            if id == "cursor" {
                // У Cursor уровень рассуждений — часть id модели: grok-4.7-high, claude-opus-5-5-xhigh
                Text("в названии модели")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .frame(width: 160)
                    .help("У Cursor уровень reasoning выбирается вместе с моделью")
            } else {
                MenuSelect(options: effortOptions, selection: currentEffort, width: 160) { value in
                    if value != currentEffort { model.setAgent(id, effort: value) }
                }
                .help("Уровень reasoning")
            }
            Toggle("Фоновое ревью", isOn: Binding(get: { agent?.isAuto ?? true }, set: { model.setAgent(id, auto: $0) }))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(.green)
                .help("Участвует ли модель в фоновом ревью. Выключенная в фоне не ревьюит и не отвечает в тредах, но запускается по клику на её иконку в обзоре")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// Выпадающий список фиксированной ширины: системный Picker подгоняет ширину под текст, и соседние строки не выравниваются
// Остаток лимита: зелёный, жёлтый ближе к концу, оранжевый, когда почти исчерпан
private struct LimitBar: View {
    let remaining: Double

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(Theme.track)
            Capsule()
                .fill(remaining < 15 ? Color.orange : remaining < 40 ? Color.yellow : Color.green)
                .frame(width: 36 * remaining / 100)
        }
        .frame(width: 36, height: 4)
    }
}

private struct MenuSelect: View {
    let options: [(id: String, title: String)]
    let selection: String
    let width: CGFloat
    let select: (String) -> Void

    var body: some View {
        Menu {
            ForEach(options, id: \.id) { option in
                Button {
                    select(option.id)
                } label: {
                    if option.id == selection {
                        Label(option.title, systemImage: "checkmark")
                    } else {
                        Text(option.title)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(options.first { $0.id == selection }?.title ?? selection)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .font(.system(size: 13))
            .padding(.horizontal, 10)
            .frame(width: width, height: 24)
            .background(Theme.track, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

// Строка как в «Настройках» iOS: текущее значение серым и шеврон, редактирование — на отдельном листе
private struct BranchPatternRow: View {
    @EnvironmentObject private var model: AppModel
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Text("Ветки для ревью").font(.system(size: 13))
                Spacer()
                Text(model.config.branchPattern ?? "PROJ-\\d+")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverHighlight()
        .help("Фоновое ревью берёт только PR, исходная ветка которых подходит под шаблон. Вручную можно отревьюить любой PR")
    }
}

// Строка уведомлений в плитке «Общие»: сводка и шеврон, подробности — на листе
private struct NotificationsRow: View {
    @ObservedObject private var store = NotificationStore.shared
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack {
                Text("Уведомления").font(.system(size: 13))
                Spacer()
                // Раз в минуту, чтобы истёкшее «Выключены до …» сменилось само
                TimelineView(.everyMinute) { _ in
                    let muted = !store.denied && store.settings.isMuted
                    Text(store.denied ? "Запрещены в macOS" : muted ? store.settings.muteSummary : "\(store.settings.all.enabled.count) из \(NotificationKind.allCases.count)")
                        .font(.system(size: 13).monospacedDigit())
                        .foregroundStyle(store.denied || muted ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverHighlight()
        .onAppear { store.refreshAuthorization() }
    }
}

private final class NotificationsForm: ObservableObject {
    // Открытый репозиторий: переход внутри листа, без второго листа поверх — вложенные листы в поповере зависают
    @Published var repo: String?
}

struct NotificationsSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = NotificationStore.shared
    @StateObject private var form = NotificationsForm()

    private static let levels = ["P1", "P2", "P3"]
    private static let levelTitles = ["P1": "P0–P1", "P2": "P0–P2", "P3": "Все"]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            ScrollView {
                VStack(spacing: 18) {
                    if let repo = form.repo { repoScreen(repo) } else { mainScreen }
                }
                .frame(maxWidth: .infinity)
            }
            .frame(height: 440)
        }
        .padding(20)
        .frame(width: 560)
        .background(Theme.background)
        .onAppear { store.refreshAuthorization() }
    }

    private var header: some View {
        ZStack {
            Text(form.repo ?? "Уведомления").font(.title3.weight(.semibold))
            HStack {
                if form.repo != nil {
                    Button { form.repo = nil } label: {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
                            Text("Уведомления").font(.system(size: 13))
                        }
                        .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Theme.track, in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Закрыть")
            }
        }
    }

    @ViewBuilder
    private var mainScreen: some View {
        if store.denied {
            GroupedSection(footer: "Пока уведомления запрещены, настройки ниже ни на что не влияют.") {
                EmptyView()
            } content: {
                HStack {
                    Label("macOS запретила уведомления PR Reviewer", systemImage: "bell.slash.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                    Spacer()
                    Button("Открыть системные настройки") { store.openSystemSettings() }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
        }
        GroupedSection(footer: "События, пропущенные за это время, не придут и после включения. Выключить можно и из меню по правому клику на иконку.") {
            EmptyView()
        } content: {
            TimelineView(.everyMinute) { _ in
                HStack {
                    Text("Не беспокоить").font(.system(size: 13))
                    Spacer()
                    if store.settings.isMuted {
                        Text(store.settings.muteSummary).font(.system(size: 13)).foregroundStyle(.orange)
                        Button("Включить") { store.unmute() }
                    } else {
                        Menu("Выключить…") {
                            ForEach(MutePeriod.all) { period in
                                Button(period.title) { store.mute(period) }
                            }
                        }
                        .menuStyle(.button)
                        .fixedSize()
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
        GroupedSection("Для всех репозиториев", footer: "Нажатие на уведомление открывает PR или тред.") {
            kindRows(NotificationKind.allCases, rules: $store.settings.all)
        }
        GroupedSection("Репозитории", footer: "Репозиторий может следовать общим настройкам или иметь свои.") {
            ForEach(Array(model.config.repos.enumerated()), id: \.element.id) { index, repo in
                if index > 0 { RowDivider() }
                Button { form.repo = repo.slug } label: {
                    HStack {
                        Text(repo.slug).font(.system(size: 13))
                        Spacer()
                        Text(repoSummary(repo.slug)).font(.system(size: 13)).foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverHighlight()
            }
        }
    }

    private func repoSummary(_ slug: String) -> String {
        guard let own = store.settings.repos[slug] else { return "Как для всех" }
        let count = NotificationKind.perRepoKinds.filter { own.enabled.contains($0) }.count
        return "Свои · \(count) из \(NotificationKind.perRepoKinds.count)"
    }

    @ViewBuilder
    private func repoScreen(_ slug: String) -> some View {
        let own = store.settings.repos[slug] != nil
        GroupedSection(footer: own ? "Общие настройки на этот репозиторий не действуют." : "Сейчас действуют общие настройки. Выключите, чтобы задать свои.") {
            EmptyView()
        } content: {
            HStack {
                Text("Как для всех репозиториев").font(.system(size: 13))
                Spacer()
                Toggle("Как для всех репозиториев", isOn: Binding(
                    get: { !own },
                    // Свои правила начинаются с копии общих: выключение переключателя ничего сразу не меняет
                    set: { store.settings.repos[slug] = $0 ? nil : store.settings.all }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(.green)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        GroupedSection("События", footer: "Ошибки сервиса не относятся к репозиторию и настраиваются только для всех.") {
            kindRows(NotificationKind.perRepoKinds, rules: Binding(
                get: { store.settings.rules(slug) },
                set: { store.settings.repos[slug] = $0 }
            ))
            .disabled(!own)
            .opacity(own ? 1 : 0.45)
        }
    }

    @ViewBuilder
    private func kindRows(_ kinds: [NotificationKind], rules: Binding<NotificationRules>) -> some View {
        ForEach(Array(kinds.enumerated()), id: \.element) { index, kind in
            if index > 0 { RowDivider(inset: 50) }
            HStack(spacing: 12) {
                Image(systemName: kind.icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 26, height: 26)
                    .background(kind.color, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(kind.title).font(.system(size: 13))
                    Text(kind.detail).font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                Toggle(kind.title, isOn: Binding(
                    get: { rules.wrappedValue.enabled.contains(kind) },
                    set: { on in
                        if on { rules.wrappedValue.enabled.insert(kind) } else { rules.wrappedValue.enabled.remove(kind) }
                    }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(.green)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            // Уровень — уточнение замечаний, поэтому только когда они включены
            if kind == .findings && rules.wrappedValue.enabled.contains(.findings) {
                RowDivider(inset: 50)
                HStack {
                    Text("Уровень").font(.system(size: 13))
                    Spacer()
                    SegmentedPicker(options: Self.levels, selection: rules.level, title: { Self.levelTitles[$0] ?? $0 }, segmentWidth: 70)
                }
                .padding(.leading, 50)
                .padding(.trailing, 12)
                .padding(.vertical, 8)
            }
        }
    }
}

// Значение — ближайшее истечение; предупреждение окрашивает строку так же, как баннер в обзоре
private struct TokensRow: View {
    @EnvironmentObject private var model: AppModel
    let open: () -> Void

    private var summary: (text: String, color: Color?) {
        if let expired = model.tokens.first(where: \.isExpired) { return ("\(expired.title): истёк", .red) }
        if let expiring = model.tokens.filter(\.isExpiring).min(by: { ($0.daysLeft ?? 0) < ($1.daysLeft ?? 0) }) {
            return ("\(expiring.title): \(expiring.daysLeft ?? 0) дн.", .orange)
        }
        if let nearest = model.tokens.compactMap(\.expiresAt).min() {
            return ("до \(TokenInfo.date(nearest))", nil)
        }
        return ("\(model.tokens.count)", nil)
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Text("Токены").font(.system(size: 13))
                Spacer()
                Text(summary.text)
                    .font(.system(size: 13).monospacedDigit())
                    .foregroundStyle(summary.color ?? .secondary)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverHighlight()
        .help("Сроки токенов Bitbucket и моделей; за \(TokenInfo.warningDays) дней до истечения в обзоре появится предупреждение")
    }
}

private final class TokensForm: ObservableObject {
    @Published var copied: String?
}

struct TokensSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var form = TokensForm()

    private static let lifetimes: [(id: String, title: String)] = [
        ("30", "30 дней"), ("90", "90 дней"), ("180", "180 дней"), ("365", "1 год"), ("0", "Без срока"),
    ]

    private func lifetimeOptions(_ token: TokenInfo) -> [(id: String, title: String)] {
        guard let days = token.lifetimeDays else { return [("unset", "Не указан")] + Self.lifetimes }
        return Self.lifetimes.contains { $0.id == String(days) } ? Self.lifetimes : [(String(days), "\(days) дн.")] + Self.lifetimes
    }

    private func status(_ token: TokenInfo) -> (text: String, color: Color?) {
        guard let savedAt = token.savedAt else { return ("Нет в Keychain (\(token.service))", .red) }
        let saved = "Сохранён \(TokenInfo.date(savedAt))"
        guard let lifetime = token.lifetimeDays else { return ("\(saved) · срок не указан — выберите тот, что задали при выпуске", nil) }
        guard lifetime > 0, let expiresAt = token.expiresAt else { return ("\(saved) · без срока", nil) }
        let date = TokenInfo.date(expiresAt)
        if token.isExpired { return ("\(saved) · истёк \(date)", .red) }
        return ("\(saved) · до \(date), осталось \(token.daysLeft ?? 0) дн.", token.isExpiring ? .orange : nil)
    }

    private func copy(_ text: String, _ key: String) {
        copyToPasteboard(text)
        form.copied = key
    }

    private func linkButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.accentColor)
    }

    private func row(_ token: TokenInfo) -> some View {
        let state = status(token)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(token.title).font(.system(size: 13, weight: .medium))
                    Text(state.text)
                        .font(.system(size: 11))
                        .foregroundStyle(state.color ?? .secondary)
                }
                Spacer(minLength: 12)
                MenuSelect(options: lifetimeOptions(token), selection: token.lifetimeDays.map(String.init) ?? "unset", width: 120) { id in
                    if let days = Int(id) { model.setTokenLifetime(token.id, days: days) }
                }
                .help("Срок, выбранный при выпуске токена")
            }
            HStack(spacing: 16) {
                switch token.issue {
                case .url(let url):
                    linkButton("Выпустить новый ↗") { NSWorkspace.shared.open(url) }
                        .help(url.absoluteString)
                case .command(let command):
                    linkButton(form.copied == "issue-\(token.id)" ? "Скопировано" : "Скопировать «\(command)»") { copy(command, "issue-\(token.id)") }
                        .help("Выполните в терминале: команда откроет браузер и выведет новый токен")
                }
                linkButton(form.copied == "save-\(token.id)" ? "Скопировано" : "Скопировать команду сохранения") { copy(token.saveCommand, "save-\(token.id)") }
                    .help(token.saveCommand)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Text("Токены").font(.title3.weight(.semibold))
                Spacer(minLength: 12)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Theme.track, in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Закрыть")
            }

            VStack(spacing: 0) {
                ForEach(Array(model.tokens.enumerated()), id: \.element.id) { index, token in
                    if index > 0 { RowDivider() }
                    row(token)
                }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            Text("Срок в самом токене не прочитать: он считается от даты сохранения в Keychain. Выпустите новый токен, сохраните его командой из буфера — дата обновится, предупреждение пропадёт.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 560)
        .background(Theme.background)
    }
}

private final class BranchPatternForm: ObservableObject {
    @Published var text = ""
    // Пока шаблон неверный, список показывает совпадения для последнего верного — он не пропадает и не прыгает
    @Published var lastValid = ""
}

// Шаблон исходных веток для фонового ревью: проверка выражения и список открытых PR, которые под него попадают, —
// опечатка в шаблоне видна сразу, до сохранения
struct BranchPatternSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var form = BranchPatternForm()

    private var saved: String { model.config.branchPattern ?? "PROJ-\\d+" }
    private var isValid: Bool { !form.text.isEmpty && (try? NSRegularExpression(pattern: form.text)) != nil }

    private var prs: [(repo: String, pr: PullRequest)] {
        model.config.repos.flatMap { repo in (model.snapshots[repo.slug]?.prs ?? []).filter { !$0.draft }.map { (repo.slug, $0) } }
    }

    private func matches(_ pr: PullRequest) -> Bool {
        pr.source.range(of: form.lastValid, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private func save() {
        guard isValid else { return }
        if form.text != saved { model.setBranchPattern(form.text) }
        dismiss()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Ветки для ревью").font(.title3.weight(.semibold))
                    Text("Регулярное выражение для исходной ветки PR, без учёта регистра. Остальные PR фон пропускает, вручную их можно отревьюить кликом по иконке модели.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Theme.track, in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Закрыть без сохранения")
            }

            HStack(spacing: 8) {
                TextField("Шаблон", text: $form.text, prompt: Text(verbatim: "PROJ-\\d+"))
                    .textFieldStyle(.plain)
                    .font(.system(size: 13, design: .monospaced))
                    .onSubmit(save)
                    .onChange(of: form.text) { if isValid { form.lastValid = form.text } }
                if !isValid {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(form.text.isEmpty ? Color.secondary : Color.red)
                        .help(form.text.isEmpty ? "Введите шаблон" : "Неверное регулярное выражение — список показывает последний верный шаблон")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            GroupedSection("Открытые PR · подходит \(prs.filter { matches($0.pr) }.count) из \(prs.count)") {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(prs.enumerated()), id: \.offset) { index, item in
                            if index > 0 { RowDivider(inset: 34) }
                            HStack(spacing: 10) {
                                Image(systemName: matches(item.pr) ? "checkmark.circle.fill" : "minus.circle")
                                    .foregroundStyle(matches(item.pr) ? Color.green : Color.secondary)
                                    .font(.system(size: 13))
                                Text(item.pr.source).font(.system(size: 12, design: .monospaced))
                                Text(verbatim: "#\(item.pr.id) \(item.pr.title)")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                        }
                    }
                }
                .frame(height: 200)
                // Список по прошлому шаблону — приглушён, чтобы не выдавать его за результат текущего ввода
                .opacity(isValid ? 1 : 0.5)
            }

            HStack {
                Spacer()
                Button("Сохранить", action: save)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid || form.text == saved)
            }
        }
        .padding(20)
        .frame(width: 560)
        .background(Theme.background)
        .onAppear {
            form.text = saved
            form.lastValid = saved
        }
    }
}

private struct IntervalRow: View {
    @EnvironmentObject private var model: AppModel
    // Шаги степпера: мелкие значения нужны редко, поэтому шкала разреженная
    private static let presets = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]

    private func step(_ direction: Int) {
        let current = model.intervalMinutes
        let next = direction > 0 ? Self.presets.first { $0 > current } : Self.presets.last { $0 < current }
        if let next { model.setPollInterval(next) }
    }

    var body: some View {
        HStack {
            Text("Проверять каждые").font(.system(size: 13))
            Spacer()
            Text("\(model.intervalMinutes) мин")
                .font(.system(size: 13).monospacedDigit())
                .foregroundStyle(.secondary)
            Stepper("Интервал", onIncrement: { step(1) }, onDecrement: { step(-1) })
                .labelsHidden()
                .disabled(model.isPaused)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .help(model.isPaused ? "Сначала включите фоновое ревью наверху" : "Как часто искать новые коммиты и ответы в тредах. Действует со следующей минуты")
    }
}

private final class AddRepoForm: ObservableObject {
    @Published var ref = ""
    @Published var busy = false
    @Published var error: String?
}

private struct AddRepoSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var form = AddRepoForm()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Новый репозиторий").font(.title3.weight(.semibold))
            VStack(alignment: .leading, spacing: 6) {
                // verbatim: строковый литерал читается как Markdown, и ссылка в подсказке становится синей
                TextField("Репозиторий", text: $form.ref, prompt: Text(verbatim: "https://bitbucket.org/workspace/repo или workspace/repo"))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(add)
                Text("Подойдёт ссылка на репозиторий или PR, SSH-адрес клона или workspace/slug.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let error = form.error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if form.busy {
                    ProgressView().controlSize(.small)
                    Text("Проверяю доступ…").foregroundStyle(.secondary)
                }
                Spacer()
                Button("Отмена") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Добавить", action: add)
                    .keyboardShortcut(.defaultAction)
                    .disabled(form.busy || form.ref.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func add() {
        guard !form.busy, !form.ref.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        form.busy = true
        form.error = nil
        model.addRepo(form.ref.trimmingCharacters(in: .whitespaces)) { failure in
            form.busy = false
            if let failure { form.error = failure } else { dismiss() }
        }
    }
}

private enum MemoryTab: Hashable {
    case rules, review, history
}

private final class MemoryForm: ObservableObject {
    @Published var editingId: String?
    @Published var editingText = ""
    @Published var historyPrs = 100
    @Published var draft = ""
    @Published var tab = MemoryTab.rules
}

struct MemorySheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var form = MemoryForm()
    let repo: RepoConfig

    private var lessons: [Lesson] { (model.memory[repo.slug] ?? []).reversed() }
    private var fresh: Set<String> { Set(model.newLessons(repo.slug).map(\.id)) }
    private var usage: MemoryUsage? { model.memoryUsage[repo.slug] }
    private var plan: MemoryPlan? { model.memoryPlans[repo.slug] }
    private var showsReview: Bool { form.tab == .review && model.memoryBroken[repo.slug] == nil && !lessons.isEmpty }
    // По нему лист замечает, что память изменилась (новое правило, правка, применённый план), и перечитывает счётчики и план
    private var signature: [String] { lessons.map { "\($0.id) \($0.text)" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Память ревьюеров · \(repo.slug)").font(.title3.weight(.semibold))
                    Text("Правила выводятся из комментариев людей в ревью и их ответов на замечания моделей и учитываются в каждом ревью этого репозитория всеми моделями. Лишнее можно удалить, недостающее — дописать.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button { openInCodeEditor(Paths.memory(repo.slug)) } label: {
                    Image(systemName: "arrow.up.forward.app")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Theme.track, in: Circle())
                }
                .buttonStyle(.plain)
                .help("Открыть файл памяти в VS Code — для массовой правки. Сохранённые изменения окно подхватит само")
                // Изменения сохраняются сразу, подтверждать нечего — поэтому крестик, а не «Готово», как в листах iOS
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Theme.track, in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Закрыть")
            }
            if let broken = model.memoryBroken[repo.slug] {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Файл памяти повреждён", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.red)
                    Text(broken)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Пока файл не исправлен, ревью идёт без правил этого репозитория, а новые правила не сохраняются — так прежние не затрутся.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Открыть в VS Code") { openInCodeEditor(Paths.memory(repo.slug)) }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: 300, alignment: .top)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else if lessons.isEmpty {
                historyLearning
                    .frame(height: 300, alignment: .top)
            } else {
                HStack(alignment: .center, spacing: 12) {
                    SegmentedPicker(
                        options: [MemoryTab.rules, .review, .history],
                        selection: $form.tab,
                        title: tabTitle,
                        badge: { $0 == .review && form.tab != .review ? plan?.changes ?? 0 : 0 }
                    )
                    Spacer(minLength: 0)
                    if form.tab == .rules, let caption = trackingCaption {
                        Text(caption)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.trailing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                switch form.tab {
                case .rules:
                    rules
                case .review:
                    MemoryReviewPanel(slug: repo.slug)
                        .frame(height: 340)
                case .history:
                    MemoryHistoryPanel(slug: repo.slug)
                        .frame(height: 340)
                }
            }
            if showsReview {
                reviewActions
            } else {
                HStack {
                    TextField("Своё правило, например: «`formatDate` всегда получает UTC»", text: $form.draft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(add)
                    Button("Добавить", action: add)
                        .disabled(form.draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                // В повреждённый файл сервис не пишет — добавить правило всё равно не получится
                .disabled(model.memoryBroken[repo.slug] != nil)
            }
        }
        .padding(20)
        .frame(width: 600)
        .background(Theme.background)
        .onAppear {
            if AppModel.hasMemoryPlan(repo.slug) || model.memoryReviewing[repo.slug] != nil { form.tab = .review }
            refresh()
        }
        .onChange(of: signature) { refresh() }
        // Новые правила считаются просмотренными, когда лист закрыли: пока он открыт, точки помогают их найти
        .onDisappear {
            model.markMemorySeen(repo.slug)
            model.memoryApplied[repo.slug] = nil
            model.memoryRestored[repo.slug] = nil
        }
    }

    private func refresh() {
        model.loadMemoryUsage(repo.slug)
        model.loadMemoryPlan(repo.slug)
        model.loadMemoryHistory(repo.slug)
    }

    private func tabTitle(_ tab: MemoryTab) -> String {
        switch tab {
        case .rules: "Правила · \(lessons.count)"
        case .review: model.memoryReviewing[repo.slug] != nil ? "Разбор…" : "Разбор"
        case .history: "Что менялось"
        }
    }

    private var trackingCaption: String? {
        guard let usage else { return nil }
        guard let since = Dates.parse(usage.since) else { return "Срабатывания правил пока не считались: учёт начнётся с ближайшего ревью" }
        return "Срабатывания считаются с \(TokenInfo.date(since)) · ревью с учётом: \(usage.runs)"
    }

    private var rules: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(Array(lessons.enumerated()), id: \.element.id) { index, lesson in
                    if index > 0 { RowDivider() }
                    if form.editingId == lesson.id {
                        LessonEditor(text: $form.editingText, save: {
                            model.updateLesson(repo.slug, lesson.id, form.editingText)
                            form.editingId = nil
                        }, cancel: { form.editingId = nil })
                    } else {
                        LessonRow(
                            lesson: lesson,
                            isNew: fresh.contains(lesson.id),
                            usage: usage?.since == nil ? nil : .some(usage?.usage(lesson.id)),
                            edit: {
                                form.editingText = lesson.text
                                form.editingId = lesson.id
                            }
                        ) { model.removeLesson(repo.slug, lesson.id) }
                    }
                }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        // В листе, который подстраивается под содержимое, ScrollView без высоты схлопывается в ноль
        .frame(height: 300)
    }

    private var reviewActions: some View {
        let reviewing = model.memoryReviewing[repo.slug] != nil
        let applying = model.memoryApplying.contains(repo.slug)
        return HStack {
            if let plan, !reviewing {
                Button(plan.changes == 0 ? "Убрать план" : "Отказаться") { model.discardMemoryPlan(repo.slug) }
                    .disabled(applying)
                    .help("Удалить план — память останется как есть")
            }
            Spacer()
            if applying {
                ProgressView().controlSize(.small)
                Text("Применяю…").font(.system(size: 12)).foregroundStyle(.secondary)
            } else if let plan, !reviewing, plan.outdated != true, plan.changes > 0 {
                Button("Применить") { model.applyMemoryPlan(repo.slug) }
                    .keyboardShortcut(.defaultAction)
                    .help("Склеить, переписать и удалить правила по плану. Применённый разбор можно откатить: pr-reviewer memory restore \(repo.slug)")
            } else if !reviewing {
                Button(plan == nil ? "Разобрать память" : "Разобрать заново") { model.reviewMemory(repo.slug) }
                    .keyboardShortcut(plan?.outdated == true || plan == nil ? .defaultAction : nil)
            }
        }
    }

    private func add() {
        let text = form.draft.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        model.addLesson(repo.slug, text)
        form.draft = ""
    }

    // Пустую память можно сразу наполнить из истории: замечания людей в прошлых PR и их ответы моделям
    private var historyLearning: some View {
        let running = model.learning.contains(repo.slug)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 22))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Изучить историю репозитория").font(.system(size: 13, weight: .semibold))
                    Text("Модель прочитает комментарии людей в последних PR — открытых, влитых и отклонённых — и выделит правила, по которым команда ревьюит код. Разовые предпочтения по именам и стилю не попадут.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack {
                Text("Последние").font(.system(size: 13))
                SegmentedPicker(options: [50, 100, 300], selection: $form.historyPrs, title: { "\($0) PR" }, segmentWidth: 70)
                    .disabled(running)
                Spacer()
                if running {
                    ProgressView().controlSize(.small)
                    Text("Изучаю…").font(.system(size: 12)).foregroundStyle(.secondary)
                } else {
                    Button("Изучить") { model.learnHistory(repo.slug, prs: form.historyPrs) }
                }
            }
            if let result = model.learnResults[repo.slug] {
                Text(result)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Займёт несколько минут; модель вызывается пачками по 30 обсуждений. Дальше память пополняется сама по новым комментариям.")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct LessonEditor: View {
    @Binding var text: String
    let save: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            TextField("Текст правила", text: $text, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 13))
                .lineLimit(2...8)
                .onSubmit(save)
                .onExitCommand(perform: cancel)
            HStack {
                Button("Отмена", action: cancel)
                Button("Сохранить", action: save)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }
}

private struct LessonRow: View {
    let lesson: Lesson
    var isNew = false
    // nil — срабатывания ещё не считались; .some(nil) — считаются, но это правило ни разу не сработало
    var usage: LessonUsage?? = nil
    let edit: () -> Void
    let remove: () -> Void

    private var origin: String {
        if lesson.manual == true { return "добавлено вручную" }
        if lesson.edited == true, let source = lesson.source { return "из PR #\(source.pr), исправлено вручную" }
        guard let source = lesson.source else { return "" }
        let authors = source.authors?.joined(separator: ", ")
        let from = source.kind == "review" ? "из ревью PR #\(source.pr)" : "из ответа в PR #\(source.pr)"
        return [source.mergedFrom == nil ? nil : "склеено разбором", from, authors].compactMap { $0 }.joined(separator: " · ")
    }

    private func usageText(_ usage: LessonUsage?) -> String {
        guard let usage, usage.applied + usage.findings > 0 else { return "не срабатывало" }
        var parts = ["сработало: \(usage.applied)"]
        if usage.findings > 0 { parts.append("замечаний: \(usage.findings) — исправлено \(usage.addressed), отклонено \(usage.dismissed)") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(isNew ? Color.accentColor : Color.clear)
                .frame(width: 7, height: 7)
                .padding(.top, 6)
                .help(isNew ? "Новое правило" : "")
            VStack(alignment: .leading, spacing: 3) {
                // Через LocalizedStringKey текст разбирается как markdown: `код` выделяется
                Text(LocalizedStringKey(lesson.text))
                    .font(.system(size: 13))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 4) {
                    if let url = lesson.source.flatMap({ URL(string: $0.url) }) {
                        Button(origin) { NSWorkspace.shared.open(url) }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.accentColor)
                    } else {
                        Text(origin).foregroundStyle(.secondary)
                    }
                    Text("· \(Dates.ago(lesson.at))").foregroundStyle(.secondary)
                }
                .font(.system(size: 11))
                if let usage {
                    Label(usageText(usage), systemImage: "bolt")
                        .font(.system(size: 11))
                        .foregroundStyle(usage == nil ? .tertiary : .secondary)
                        .help("Сколько ревью учли это правило и чем кончились замечания, основанные на нём")
                }
            }
            Spacer()
            Button(action: edit) {
                Image(systemName: "pencil")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Изменить правило")
            Button(action: remove) {
                Image(systemName: "trash")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Удалить правило")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }
}

private final class IgnoreForm: ObservableObject {
    @Published var pattern = ""
}

private struct IgnoreSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var form = IgnoreForm()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Исключения из диффа").font(.title3.weight(.semibold))
                    Text("Файлы по этим шаблонам вырезаются из диффа PR перед ревью — меньше токенов и ложных замечаний. Формат glob, ** — любое число папок. Действует со следующего ревью.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Theme.track, in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Закрыть")
            }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(model.config.ignorePaths ?? [], id: \.self) { pattern in
                        HStack {
                            Text(pattern).font(.system(size: 13, design: .monospaced))
                            Spacer()
                            Button {
                                model.setIgnored(pattern, false)
                            } label: {
                                Image(systemName: "minus.circle.fill")
                                    .font(.system(size: 15))
                                    .foregroundStyle(.red)
                            }
                            .buttonStyle(.plain)
                            .help("Снова отдавать моделям")
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        if pattern != model.config.ignorePaths?.last { RowDivider() }
                    }
                }
            }
            // В листе, который подстраивается под содержимое, ScrollView без высоты схлопывается в ноль
            .frame(height: 260)
            // Фон и скругление на самой прокрутке, а не на содержимом: иначе нижние углы обрезаются прямо
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            // Поле добавления вне прокрутки: в длинном списке оно иначе уезжает вниз
            HStack(spacing: 10) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(.green)
                // Подсказка через verbatim: иначе ** разбирается как жирный шрифт markdown
                TextField("Шаблон", text: $form.pattern, prompt: Text(verbatim: "Шаблон, например **/generated/**"))
                    .textFieldStyle(.plain)
                    .font(.system(size: 13, design: .monospaced))
                    .onSubmit(add)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .padding(20)
        .frame(width: 520)
        .background(Theme.background)
    }

    private func add() {
        let pattern = form.pattern.trimmingCharacters(in: .whitespaces)
        guard !pattern.isEmpty else { return }
        model.setIgnored(pattern, true)
        form.pattern = ""
    }
}

// Файлы для ручной правки открываются в VS Code (или Cursor), а без них — в программе по умолчанию
func openInCodeEditor(_ url: URL) {
    let workspace = NSWorkspace.shared
    let editors = ["com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92"]
    guard let app = editors.lazy.compactMap({ workspace.urlForApplication(withBundleIdentifier: $0) }).first else {
        workspace.open(url)
        return
    }
    workspace.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
}

// Редактор config.json. NSTextView вместо TextEditor: у того нельзя выключить автозамену кавычек и тире, а она ломает JSON
private struct CodeEditor: NSViewRepresentable {
    @Binding var text: String
    // Позиция курсора в UTF-16, как у NSString: по ней ищется поле для подсказки из схемы
    @Binding var caret: Int

    static let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        let view = scroll.documentView as! NSTextView
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.isRichText = false
        view.allowsUndo = true
        view.font = Self.font
        view.textContainerInset = NSSize(width: 6, height: 8)
        view.drawsBackground = false
        scroll.drawsBackground = false
        view.delegate = context.coordinator
        view.string = text
        JSONHighlighter.apply(to: view.textStorage!, font: Self.font)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let view = scroll.documentView as! NSTextView
        if view.string != text {
            view.string = text
            JSONHighlighter.apply(to: view.textStorage!, font: Self.font)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text, caret: $caret) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        let text: Binding<String>
        let caret: Binding<Int>
        init(text: Binding<String>, caret: Binding<Int>) {
            self.text = text
            self.caret = caret
        }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            JSONHighlighter.apply(to: view.textStorage!, font: CodeEditor.font)
            text.wrappedValue = view.string
        }
        func textViewDidChangeSelection(_ notification: Notification) {
            if let view = notification.object as? NSTextView { caret.wrappedValue = view.selectedRange().location }
        }
    }
}

private final class ConfigForm: ObservableObject {
    @Published var text = ""
    @Published var caret = 0
    @Published var original = ""
    @Published var loadedAt: Date?
    @Published var saveError: String?
}

struct ConfigSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var form = ConfigForm()

    // Сервис и окно сами меняют config.json (переключатели, модели); перезаписывать чужие правки нельзя
    private var modifiedOnDisk: Date? {
        (try? FileManager.default.attributesOfItem(atPath: Paths.config.path))?[.modificationDate] as? Date
    }

    private static let schema = ConfigSchema.load()

    // Проверка до записи — синтаксис и схема: битый конфиг остановил бы и фоновое ревью, и окно
    private var problem: String? {
        guard let data = form.text.data(using: .utf8) else { return "Текст не в UTF-8" }
        do {
            let object = try JSONSerialization.jsonObject(with: data)
            let problems = Self.schema?.validate(object) ?? []
            guard let first = problems.first else { return nil }
            return problems.count > 1 ? "\(first) (и ещё \(problems.count - 1))" : first
        } catch {
            let nsError = error as NSError
            return (nsError.userInfo["NSDebugDescription"] as? String) ?? nsError.localizedDescription
        }
    }

    // Описание поля под курсором — то же, что VS Code показывает при наведении
    private var fieldHelp: (path: String, text: String)? {
        let path = ConfigSchema.path(in: form.text, at: form.caret)
        guard !path.isEmpty, let text = Self.schema?.description(at: path) else { return nil }
        return (ConfigSchema.title(path), text)
    }

    private func load() {
        form.text = (try? String(contentsOf: Paths.config, encoding: .utf8)) ?? ""
        form.original = form.text
        form.loadedAt = modifiedOnDisk
        form.saveError = nil
    }

    private func save() {
        guard problem == nil else { return }
        if let loadedAt = form.loadedAt, let current = modifiedOnDisk, current > loadedAt {
            form.saveError = "Файл изменился, пока он был открыт (например, переключили модель в настройках). Нажмите «Перечитать» и внесите правку заново."
            return
        }
        do {
            try form.text.write(to: Paths.config, atomically: true, encoding: .utf8)
            model.reload()
            dismiss()
        } catch {
            form.saveError = "Не удалось сохранить: \(error.localizedDescription)"
        }
    }

    private func openInEditor() {
        openInCodeEditor(Paths.config)
        dismiss()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("config.json").font(.title3.weight(.semibold))
                    Text(Paths.config.path)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 12)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Theme.track, in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Закрыть без сохранения")
            }

            CodeEditor(text: $form.text, caret: $form.caret)
                .frame(height: 340)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            // Высота постоянная, чтобы лист не прыгал при движении курсора
            Group {
                if let help = fieldHelp {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(help.path).font(.system(size: 11, design: .monospaced))
                        Text(help.text).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                } else {
                    Text("Поставьте курсор на поле — здесь появится его описание").font(.system(size: 11)).foregroundStyle(.tertiary)
                }
            }
            .lineLimit(2)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)

            if let message = form.saveError ?? problem {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(form.saveError != nil ? Color.orange : Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Изменения подхватываются со следующего прохода, переустанавливать не нужно.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            HStack {
                Button("Открыть в VS Code", action: openInEditor)
                    .help("Открыть файл во внешнем редакторе; несохранённые правки здесь пропадут")
                if form.saveError != nil {
                    Button("Перечитать", action: load)
                }
                Spacer()
                Button("Сохранить", action: save)
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(form.text == form.original || problem != nil)
            }
        }
        .padding(20)
        .frame(width: 660)
        .background(Theme.background)
        .onAppear(perform: load)
    }
}

// Из какого коммита собрано приложение — install.sh пишет это в Info.plist при каждой сборке
private struct BuildInfoRow: View {
    private static let info = Bundle.main.infoDictionary ?? [:]
    private static let commit = (info["PRReviewerBuildCommit"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    private static let date = Dates.parse(info["PRReviewerBuildDate"] as? String)
    private static let dirty = info["PRReviewerBuildDirty"] as? Bool ?? false

    private static func format(_ template: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.dateFormat = template
        return formatter
    }
    private static let short = format("dd.MM HH:mm")
    private static let withYear = format("dd.MM.yyyy HH:mm")
    private static let full = format("d MMMM yyyy 'в' HH:mm")

    var body: some View {
        if let date = Self.date {
            let when = (Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year) ? Self.short : Self.withYear).string(from: date)
            HStack(spacing: 6) {
                Text(Self.commit.map { "Сборка \($0.prefix(7)) · \(when)" } ?? "Сборка от \(when)")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                if Self.commit != nil && Self.dirty {
                    Tag(text: "правки не закоммичены", color: .orange)
                }
            }
            .frame(maxWidth: .infinity)
            .help("Собрано \(Self.full.string(from: date))\(Self.commit.map { " из коммита \($0)" } ?? "")\(Self.commit != nil && Self.dirty ? " + незакоммиченные правки" : "")")
        }
    }
}
