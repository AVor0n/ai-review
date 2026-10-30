import SwiftUI

// Раскрытые записи и открытая форма статуса; @State здесь недоступен (макрос), поэтому ObservableObject
private final class BacklogScreen: ObservableObject {
    @Published var expanded: Set<String> = []
    @Published var editing: BacklogEdit?
    @Published var draft = ""
    @Published var copied = false
    @Published var confirmTriage = false
}

private struct BacklogEdit: Equatable {
    enum Action { case filed, drop }
    let id: String
    let action: Action
}

struct BacklogView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("backlogShowAll") private var showAll = false
    // Итог последней задачи висит, пока его не закроют; закрытый запоминается по времени окончания
    @AppStorage("backlogJobSeen") private var jobSeen = ""
    @StateObject private var screen = BacklogScreen()

    private var items: [BacklogItem] {
        model.backlog.filter { showAll || $0.isOpen }.sorted { a, b in
            a.isOpen != b.isOpen ? a.isOpen : BacklogItem.byPriority(a, b)
        }
    }

    // Репозитории — в порядке обзора; отключённые, у которых остались записи, — в конце
    private var groups: [(repo: String, items: [BacklogItem])] {
        let grouped = Dictionary(grouping: items, by: \.repo)
        let order = model.config.repos.map(\.slug)
        return grouped.keys
            .sorted { (order.firstIndex(of: $0) ?? order.count, $0) < (order.firstIndex(of: $1) ?? order.count, $1) }
            .map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                SegmentedPicker(options: [false, true], selection: $showAll, title: { $0 ? "Все" : "Ждут разбора" }, segmentWidth: 110)
                Spacer()
                if model.backlogWaiting > 0 && model.backlogJob?.isRunning != true {
                    Button { screen.confirmTriage = true } label: {
                        Label("Разобрать", systemImage: "stethoscope")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                    .help("Проверить по текущему коду основной ветки, какие проблемы ещё актуальны")
                    .padding(.trailing, 12)
                }
                Button(action: copyMarkdown) {
                    Label(screen.copied ? "Скопировано" : "Скопировать .md", systemImage: screen.copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12))
                        .foregroundStyle(items.isEmpty ? Color.secondary : Color.accentColor)
                }
                .buttonStyle(.plain)
                .disabled(items.isEmpty)
                .help(showAll
                    ? "Весь бэклог в markdown для разбора: по репозиториям, со сценариями, исправлениями и ссылками на PR"
                    : "Ждущие разбора проблемы в markdown: по репозиториям, со сценариями, исправлениями и ссылками на PR")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 10)

            if let error = model.backlogError {
                errorBanner(error)
            }
            if let job = model.backlogJob {
                jobBanner(job)
            }
            if !model.backlogStale.isEmpty {
                staleBanner(model.backlogStale.count)
            }

            if items.isEmpty {
                ContentUnavailableView {
                    Label(model.backlog.isEmpty ? "Бэклог пуст" : "Всё разобрано", systemImage: model.backlog.isEmpty ? "tray" : "checkmark.circle")
                } description: {
                    Text("Сюда попадают проблемы, которые модели нашли по ходу ревью, но которые были в коде ещё до PR")
                    if model.backlogWaiting == 0, let last = lastScan {
                        Text(last).font(.system(size: 11))
                    }
                } actions: {
                    if model.backlogWaiting == 0 { learnActions }
                }
                // Без рамки пустое состояние берёт высоту по содержимому и выталкивает переключатель вкладок за верх окна
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(spacing: 18) {
                        ForEach(groups, id: \.repo) { group in
                            GroupedSection {
                                HStack(spacing: 6) {
                                    Text(group.repo)
                                    Text(verbatim: "· \(group.items.count)")
                                }
                            } content: {
                                ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                                    if index > 0 { RowDivider(inset: 56) }
                                    BacklogRow(item: item, screen: screen)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
            }
        }
        .alert("Разобрать \(model.backlogWaiting) записей по текущему коду?", isPresented: $screen.confirmTriage) {
            Button("Разобрать") { model.startBacklogJob("triage") }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Модель прочитает код основной ветки каждого репозитория и отметит, какие проблемы уже исправлены или пропали. Закрываете вы. Записи, уже проверенные на той же версии кода, пропускаются. Около $0.2 за 10 записей, несколько минут")
        }
    }

    // Сбор из истории предлагается, только когда разбирать нечего: дальше записи приходят из ревью сами
    @ViewBuilder
    private var learnActions: some View {
        if model.backlogJob?.isRunning == true && model.backlogJob?.kind == "learn" {
            ProgressView().controlSize(.small)
        } else {
            Button("Собрать из истории PR") { model.startBacklogJob("learn") }
                .help("Модель разберёт незакрытые треды последних 100 влитых PR и запишет отложенные проблемы. Обычно до доллара")
        }
    }

    private var lastScan: String? {
        let repos = model.backlogScan?.repos.values.filter { $0.at != nil } ?? []
        guard let at = repos.compactMap({ Dates.parse($0.at) }).max() else { return nil }
        let found = repos.compactMap(\.found).reduce(0, +)
        let date = at.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, locale: Locale(identifier: "ru_RU")))
        return "Последний разбор истории — \(date), \(found == 0 ? "ничего не найдено" : "найдено \(found)"). Повторный запуск разберёт только новые обсуждения"
    }

    @ViewBuilder
    private func jobBanner(_ job: BacklogJob) -> some View {
        if job.isRunning {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("\(job.title) · \(job.activity ?? "запуск…")")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button("Прервать") { model.stopBacklogJob() }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.red)
            }
            .padding(12)
            .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        } else if let finished = job.finishedAt ?? job.startedAt, finished != jobSeen {
            let failed = job.state != "done"
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(failed ? Color.orange : Color.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(job.title) · \(Dates.ago(finished))")
                        .font(.system(size: 12, weight: .semibold))
                    Text(failed ? job.error ?? "задача прервана" : job.message ?? "")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
                Spacer()
                Button { jobSeen = finished } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(12)
            .background((failed ? Color.orange : Color.green).opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    private func staleBanner(_ count: Int) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "stethoscope")
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("Похоже, неактуальны: \(count)")
                    .font(.system(size: 12, weight: .semibold))
                Text("Модель считает, что проблему исправили, кода больше нет или анализ в записи ошибочен. Причина — в записи. Закрытые записи останутся во «Все» как отклонённые")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button("Закрыть все") { model.closeStaleBacklog() }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    private func copyMarkdown() {
        model.exportBacklog(all: showAll) { markdown in
            copyToPasteboard(markdown)
            screen.copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { screen.copied = false }
        }
    }

    private func errorBanner(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Не удалось выполнить команду")
                    .font(.system(size: 12, weight: .semibold))
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Spacer()
            Button { model.backlogError = nil } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }
}

private struct BacklogRow: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var hover = HoverState()
    let item: BacklogItem
    @ObservedObject var screen: BacklogScreen
    @FocusState private var fieldFocused: Bool

    private var isExpanded: Bool { screen.expanded.contains(item.id) }
    private var edit: BacklogEdit? { screen.editing?.id == item.id ? screen.editing : nil }

    private func toggle() {
        withAnimation(.easeOut(duration: 0.15)) {
            if isExpanded { screen.expanded.remove(item.id) } else { screen.expanded.insert(item.id) }
        }
    }

    private func startEdit(_ action: BacklogEdit.Action) {
        screen.draft = ""
        screen.editing = BacklogEdit(id: item.id, action: action)
    }

    private func submit() {
        guard let edit else { return }
        model.setBacklogStatus(item.id, edit.action == .filed ? "filed" : "drop", screen.draft)
        screen.editing = nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                Button(action: toggle) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .frame(width: 10)
                        Tag(text: item.level, color: ChartColors.level(item.level))
                            .frame(width: 28, alignment: .leading)
                        Text(item.title)
                            .font(.system(size: 13))
                            .lineLimit(isExpanded ? nil : 2)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(isExpanded ? "Свернуть" : "Показать сценарий и исправление")
                actions
            }
            meta
                .padding(.leading, 56)
            if isExpanded {
                details
                    .padding(.leading, 56)
                    .transition(.opacity)
            }
            if let edit {
                editor(edit)
                    .padding(.leading, 56)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        // Разобранные записи в режиме «Все» приглушены и проявляются под курсором, как черновики в обзоре
        .opacity(!item.isOpen && !hover.isHovered ? 0.55 : 1)
        .background(hover.isHovered ? Theme.hover : .clear)
        .onHover { hover.isHovered = $0 }
    }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 12) {
            if model.backlogBusy.contains(item.id) {
                ProgressView().controlSize(.small)
            } else if item.isOpen {
                Button("Задача заведена") { startEdit(.filed) }
                    .foregroundStyle(Color.accentColor)
                    .help("Отметить, что по проблеме заведена задача; номер задачи можно указать")
                if let triage = item.triage, item.isStale {
                    Button("Закрыть") { model.setBacklogStatus(item.id, "drop", "Неактуально (\(triage.title)): \(triage.reason)") }
                        .foregroundStyle(.secondary)
                        .help("Отклонить с причиной из разбора по коду")
                } else {
                    Button("Отклонить") { startEdit(.drop) }
                        .foregroundStyle(.secondary)
                        .help("Не заводить задачу. Модели и дальше будут знать о проблеме и не найдут её заново")
                }
            } else {
                if item.status == "filed" {
                    Tag(text: item.ticket.map { "Задача \($0)" } ?? "Задача заведена", color: ChartColors.addressed)
                } else {
                    Tag(text: "Отклонено")
                }
                Button("Вернуть") { model.setBacklogStatus(item.id, "reopen") }
                    .foregroundStyle(Color.accentColor)
                    .help("Снова в «Ждут разбора»")
            }
        }
        .buttonStyle(.plain)
        .font(.system(size: 12, weight: .medium))
        .fixedSize()
    }

    private var meta: some View {
        HStack(spacing: 6) {
            Text("найдено в")
            ForEach(item.prSources, id: \.pr) { source in
                Button {
                    if let url = URL(string: source.url) { NSWorkspace.shared.open(url) }
                } label: {
                    Text(verbatim: "#\(source.pr)").foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .help("Открыть PR в Bitbucket")
            }
            Text("· \(agents)")
                .lineLimit(1)
            if let likelihood = likelihoodTitle {
                Tag(text: likelihood)
            }
            // «Актуально» не показываем: запись в «Ждут разбора» и так считается актуальной
            if let triage = item.triage, item.isOpen, triage.verdict != "actual" {
                Tag(text: triage.title, color: triage.isStale ? ChartColors.addressed : .secondary)
                    .help(triage.reason)
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
    }

    private var agents: String {
        var seen = Set<String>()
        return item.sources.map(sourceName).filter { seen.insert($0).inserted }.joined(separator: ", ")
    }

    private func sourceName(_ source: BacklogSource) -> String {
        source.agent == "human" ? source.author ?? "команда" : model.agentName(source.agent)
    }

    private var likelihoodTitle: String? {
        switch item.likelihood {
        case "rare": "редкий случай"
        case "race": "гонка или сбой"
        default: nil
        }
    }

    // Строка указана для коммита последнего источника (у записей из истории — для коммита разбора по коду): на голове ветки она могла сдвинуться
    private var fileURL: URL? {
        guard let path = item.path,
              let web = model.config.repos.first(where: { $0.slug == item.repo })?.webURL,
              let commit = item.sources.last(where: { $0.commit != nil })?.commit ?? item.triage?.commit,
              let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        return URL(string: "\(web.absoluteString)/src/\(commit)/\(encoded)\(item.line.map { "#lines-\($0)" } ?? "")")
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let location = item.location {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Файл")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Button {
                        if let url = fileURL { NSWorkspace.shared.open(url) }
                    } label: {
                        Text(location)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(fileURL == nil ? Color.secondary : Color.accentColor)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                    .disabled(fileURL == nil)
                    .help(fileURL == nil ? location : "Открыть файл в Bitbucket на коммите, где нашли проблему")
                }
            }
            if let scenario = item.scenario, !scenario.isEmpty { block("Сценарий", scenario) }
            if let fix = item.fix, !fix.isEmpty { block("Исправление", fix) }
            if item.status == "dropped", let note = item.note, !note.isEmpty { block("Причина отклонения", note) }
            if let triage = item.triage { triageBlock(triage) }
            VStack(alignment: .leading, spacing: 2) {
                Text("Где нашли")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                ForEach(Array(item.sources.enumerated()), id: \.offset) { _, source in
                    Text(verbatim: [
                        "#\(source.pr)",
                        sourceName(source),
                        source.kind == "history" ? "из незакрытого треда влитого PR" : source.kind == "reply" ? "признала старой проблемой замечание в треде" : source.kind == "deferred" ? "автор PR отложил замечание" : "нашла при ревью",
                        Dates.ago(source.at),
                    ].joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                }
            }
            Text(verbatim: "id \(item.id) · в бэклоге с \(item.createdAt.flatMap(Dates.parse).map { TokenInfo.date($0) } ?? "—")")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .textSelection(.enabled)
        }
    }

    // Линия слева и цветной заголовок — зелёные, только когда запись можно закрыть; значок дублирует цвет
    private func triageBlock(_ triage: BacklogTriage) -> some View {
        let color: Color = triage.isStale ? ChartColors.addressed : .secondary
        let icon = switch triage.verdict {
        case "fixed": "checkmark.circle"
        case "gone": "trash"
        case "invalid": "xmark.circle"
        case "actual": "exclamationmark.circle"
        default: "questionmark.circle"
        }
        let commit = triage.commit.map { " · \(triage.branch ?? "") \($0.prefix(7))" } ?? ""
        return HStack(alignment: .top, spacing: 10) {
            Rectangle()
                .fill(color)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 2) {
                Label("\(triage.title.prefix(1).uppercased() + triage.title.dropFirst()) · разбор по коду · \(Dates.ago(triage.at))\(commit)", systemImage: icon)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(color)
                Text(markdown(triage.reason))
                    .font(.system(size: 12))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func block(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            Text(markdown(text))
                .font(.system(size: 12))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // Модели пишут сценарий в markdown: `код`, **жирный**; блочную разметку оставляем как есть
    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    private func editor(_ edit: BacklogEdit) -> some View {
        HStack(spacing: 10) {
            TextField("", text: $screen.draft, prompt: Text(edit.action == .filed ? "Номер задачи, например PROJ-1234" : "Причина, необязательно"))
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($fieldFocused)
                .onSubmit(submit)
                .onAppear { fieldFocused = true }
            Button("Отмена") { screen.editing = nil }
                .foregroundStyle(.secondary)
            Button(edit.action == .filed ? "Сохранить" : "Отклонить", action: submit)
                .foregroundStyle(edit.action == .filed ? Color.accentColor : Color.red)
        }
        .buttonStyle(.plain)
        .font(.system(size: 12, weight: .medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Theme.background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
