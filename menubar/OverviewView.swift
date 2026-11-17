import SwiftUI

// Подтверждения и отчёты доработки, архитектурного ревью и тестирования; @State здесь недоступен (макрос), поэтому ObservableObject
final class FixPrompts: ObservableObject {
    @Published var confirm: FixTarget?
    @Published var report: FixTarget?
    @Published var archConfirm: FixTarget?
    @Published var archReport: FixTarget?
    @Published var qa: FixTarget?
}

struct OverviewView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("collapsedRepos") private var collapsedStorage = ""
    @StateObject private var prompts = FixPrompts()
    // Раскрытые баннеры — только пока открыт поповер: при закрытии PanelController сворачивает их
    @Binding var bannersExpanded: Bool
    let openRepos: () -> Void
    let openLog: () -> Void
    let openMemory: (String) -> Void
    let openTokens: () -> Void

    private var collapsed: Set<String> { Set(collapsedStorage.split(separator: ",").map(String.init)) }

    private func toggle(_ slug: String) {
        var next = collapsed
        if next.contains(slug) { next.remove(slug) } else { next.insert(slug) }
        withAnimation(.easeOut(duration: 0.15)) { collapsedStorage = next.sorted().joined(separator: ",") }
    }

    var body: some View {
        content
            .alert(
                // Заголовок alert — LocalizedStringKey: Int в нём получил бы разделитель разрядов («#2 058»)
                prompts.confirm.map { $0.rebase ? "Сделать rebase #\(String($0.pr.id)) на \($0.pr.destination)?" : "Доработать #\(String($0.pr.id)) по замечаниям?" } ?? "",
                isPresented: Binding(get: { prompts.confirm != nil }, set: { if !$0 { prompts.confirm = nil } }),
                presenting: prompts.confirm
            ) { target in
                Button(target.rebase ? "Rebase" : "Доработать") { model.requestFix(repo: target.repo, pr: target.pr.id, rebase: target.rebase) }
                Button("Отмена", role: .cancel) {}
            } message: { target in
                if target.rebase {
                    Text(verbatim: "Ветка \(target.pr.source) отстала от \(target.pr.destination) на \(target.behind) коммит(ов)\(target.pr.conflicts == true ? ", будут конфликты — их разрешит Claude, а если вариант неочевиден, rebase отменится" : ""). После rebase прогоняются проверки и делается push --force-with-lease. Работа идёт в отдельной копии, перед изменениями создаётся резервная ветка.")
                } else {
                    Text(verbatim: "Claude перенесёт ветку \(target.pr.source) на свежую \(target.pr.destination), исправит открытые замечания (\(target.openThreads)), закоммитит, прогонит проверки и, если они прошли, сделает push --force-with-lease. Работа идёт в отдельной копии и может занять до часа. Перед изменениями создаётся резервная ветка.")
                }
            }
            .sheet(item: $prompts.report) { target in
                FixReportSheet(target: target) { prompts.confirm = target }
            }
            .alert(
                prompts.archConfirm.map { "Архитектурное ревью #\(String($0.pr.id))?" } ?? "",
                isPresented: Binding(get: { prompts.archConfirm != nil }, set: { if !$0 { prompts.archConfirm = nil } }),
                presenting: prompts.archConfirm
            ) { target in
                Button("Запустить") { model.requestArch(repo: target.repo, pr: target.pr.id) }
                Button("Отмена", role: .cancel) {}
            } message: { _ in
                Text(verbatim: "\(model.archAgentName) оценит решение целиком: цель, альтернативы с ценой переделки, где можно проще, серьёзные риски. Это займёт до часа. Отчёт останется только здесь, в PR ничего не публикуется.")
            }
            .sheet(item: $prompts.archReport) { target in
                ArchReportSheet(target: target) { prompts.archConfirm = target }
            }
            .sheet(item: $prompts.qa) { target in
                QaSheet(target: target)
            }
    }

    private var content: some View {
        VStack(spacing: 0) {
            statusBar
            bannerStack
            if model.config.repos.isEmpty {
                ContentUnavailableView {
                    Label("Нет репозиториев", systemImage: "tray")
                } description: {
                    Text("Подключите репозиторий, чтобы видеть его PR")
                } actions: {
                    Button("Подключить…", action: openRepos)
                }
            } else {
                ScrollView {
                    VStack(spacing: 18) {
                        ForEach(model.config.repos) { repo in
                            repoSection(repo)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
            }
        }
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(model.isRunning ? Color.blue : model.isPaused ? Color.orange : Color.green)
                .frame(width: 7, height: 7)
            statusText
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if model.isPaused && !model.isRunning {
                Button("Включить") { model.setServicePaused(false) }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.accentColor)
            }
            Spacer()
            availabilityCapsules
            if model.isRunning {
                Button {
                    model.stopReview()
                } label: {
                    Image(systemName: "stop.circle")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(runningReviews.count > 1 ? "Прервать все ревью и очистить очередь" : "Прервать ревью и очистить очередь")
            } else if !model.isPaused {
                Button {
                    model.runNow()
                } label: {
                    Image(systemName: "play.circle")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Проверить сейчас, не дожидаясь расписания")
            }
            if model.syncing {
                ProgressView().controlSize(.small)
            } else {
                Button {
                    model.sync()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Обновить список PR")
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 8)
    }

    private struct Banner: Identifiable {
        let id: String
        let view: AnyView
    }

    // По важности: свёрнутым виден только первый, остальные — под строкой «Ещё N сообщений»
    private var banners: [Banner] {
        var result: [Banner] = []
        if let stall = workerStall() { result.append(Banner(id: "stall", view: AnyView(stallBanner(stall)))) }
        if let error = model.syncError ?? lastRunError { result.append(Banner(id: "error", view: AnyView(errorBanner(error)))) }
        if !model.unreadableFiles.isEmpty { result.append(Banner(id: "unreadable", view: AnyView(unreadableBanner(model.unreadableFiles)))) }
        let tokens = model.tokenBanners
        result += tokens.filter(\.isExpired).map { Banner(id: "token-\($0.id)", view: AnyView(tokenBanner($0))) }
        result += model.memoryBroken.sorted { $0.key < $1.key }.map { Banner(id: "broken-\($0.key)", view: AnyView(brokenMemoryBanner(slug: $0.key, reason: $0.value))) }
        result += tokens.filter { !$0.isExpired }.map { Banner(id: "token-\($0.id)", view: AnyView(tokenBanner($0))) }
        let memory = model.memoryNearlyFull
        result += memory.filter { $0.count >= model.memoryLimit }.map { Banner(id: "memory-\($0.slug)", view: AnyView(memoryBanner(slug: $0.slug, count: $0.count))) }
        result += memory.filter { $0.count < model.memoryLimit }.map { Banner(id: "memory-\($0.slug)", view: AnyView(memoryBanner(slug: $0.slug, count: $0.count))) }
        result += model.newMemoryBanners.map { Banner(id: "lessons-\($0.slug)", view: AnyView(newLessonsBanner(slug: $0.slug, lessons: $0.lessons))) }
        return result
    }

    @ViewBuilder
    private var bannerStack: some View {
        let all = banners
        let shown = bannersExpanded ? all : Array(all.prefix(1))
        ForEach(Array(shown.enumerated()), id: \.element.id) { index, banner in
            banner.view
                .padding(.bottom, all.count > 1 && index == shown.count - 1 ? 4 : 12)
        }
        if all.count > 1 {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { bannersExpanded.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(bannersExpanded ? "Свернуть" : Self.moreMessages(all.count - 1))
                        .font(.system(size: 12))
                    Image(systemName: bannersExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                    Spacer()
                }
                .foregroundStyle(.secondary)
                .frame(height: 20)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, 28)
            .padding(.trailing, 16)
            .padding(.bottom, 12)
        }
    }

    // Ещё 1 сообщение, ещё 2 сообщения, ещё 5 сообщений
    private static func moreMessages(_ count: Int) -> String {
        let mod10 = count % 10, mod100 = count % 100
        if mod10 == 1 && mod100 != 11 { return "Ещё \(count) сообщение" }
        if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "Ещё \(count) сообщения" }
        return "Ещё \(count) сообщений"
    }

    private var lastRunError: String? {
        model.isRunning || model.status?.phase != "error" ? nil : model.status?.lastError
    }

    private func memoryBanner(slug: String, count: Int) -> some View {
        let full = count >= model.memoryLimit
        // Сверх лимита память бывает, только когда сервису нечего вытеснить
        let overflow = count > model.memoryLimit
        let color: Color = full ? .red : .yellow
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: "brain")
                .foregroundStyle(full ? Color.red : Color.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(overflow ? "Память \(slug) переполнена: \(count) из \(model.memoryLimit)" : full ? "Память \(slug) заполнена: \(count) из \(model.memoryLimit)" : "Память \(slug) почти заполнена: \(count) из \(model.memoryLimit)")
                    .font(.system(size: 12, weight: .semibold))
                Text(overflow
                    ? "Вытеснять нечего: все правила добавлены или исправлены вручную либо выучены недавно. Удалите лишние или поднимите memory.maxLessons в config.json."
                    : full
                    ? "Новые правила вытесняют наименее полезные автоматические. Удалите лишние или поправьте нужные — исправленные вручную не вытесняются."
                    : "Скоро новые правила начнут вытеснять наименее полезные. Просмотрите память: удалите лишнее, поправьте нужное — исправленные вручную правила не вытесняются.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button("Проверить правила") { openMemory(slug) }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
        }
        .padding(12)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
    }

    private func brokenMemoryBanner(slug: String, reason: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "brain")
                .foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Память \(slug) повреждена — ревью идёт без её правил")
                    .font(.system(size: 12, weight: .semibold))
                Text(reason)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Spacer()
            Button("Открыть в VS Code") { openInCodeEditor(Paths.memory(slug)) }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
        }
        .padding(12)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
    }

    // Синий — информация, а не проблема: ревьюеры выучили что-то новое из ответов команды
    private func newLessonsBanner(slug: String, lessons: [Lesson]) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "brain")
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("Новые правила в памяти \(slug): \(lessons.count)")
                    .font(.system(size: 12, weight: .semibold))
                if let latest = lessons.max(by: { $0.at < $1.at }) {
                    Text(LocalizedStringKey(latest.text))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            Button("Посмотреть") { openMemory(slug) }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
            Button { model.closeMemoryBanner(slug) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Скрыть баннер. Подсветка памяти в настройках останется, пока вы её не откроете")
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
    }

    private func tokenBanner(_ token: TokenInfo) -> some View {
        let date = token.expiresAt.map { TokenInfo.date($0) } ?? ""
        let title = token.isExpired
            ? "Токен \(token.title) истёк \(date)"
            : token.daysLeft == 0 ? "Токен \(token.title) истекает сегодня" : "Токен \(token.title) истекает через \(token.daysLeft ?? 0) дн. — \(date)"
        let impact = token.id == "bitbucket"
            ? "Без него фоновое ревью не видит PR и не публикует комментарии."
            : "Без него \(token.title) не сможет ревьюить в фоне."
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: "key.fill")
                .foregroundStyle(token.isExpired ? Color.red : Color.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12, weight: .semibold))
                Text("\(impact) Выпустите новый и сохраните в Keychain — срок обновится сам.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button("Обновить…", action: openTokens)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
            if !token.isExpired {
                Button { model.closeTokenBanner(token.id) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Скрыть до завтра")
            }
        }
        .padding(12)
        .background((token.isExpired ? Color.red : Color.yellow).opacity(token.isExpired ? 0.1 : 0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
    }

    private func stallBanner(_ stall: (since: Date, minutes: Int)) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "hourglass")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Проход ревью не продвигается \(minutesText(stall.minutes))")
                    .font(.system(size: 12, weight: .semibold))
                Text("Сервис не подаёт признаков жизни, последняя запись в журнале — в \(Dates.format(stall.since, date: .omitted)). Похоже, завис git или сеть. «Прервать» остановит этот проход, следующий начнётся по расписанию.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button("Журнал", action: openLog)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
            Button("Прервать") { model.stopReview() }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.red)
        }
        .padding(12)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
    }

    private static func fileContents(_ name: String) -> String {
        if name.hasPrefix("prs/") { return "список PR репозитория" }
        return [
            "config.json": "настройки",
            "status.json": "состояние сервиса",
            "state.json": "что проверено моделями",
            "limits.json": "лимиты моделей",
            "backlog.json": "бэклог",
        ][name] ?? "данные сервиса"
    }

    // Крестика нет: баннер уходит сам, когда файл снова прочитается
    private func unreadableBanner(_ files: [UnreadableFile]) -> some View {
        let reasons = Array(NSOrderedSet(array: files.map(\.reason))).compactMap { $0 as? String }.joined(separator: ", ")
        let what = files.count == 1
            ? "\(files[0].name) — \(Self.fileContents(files[0].name)): \(files[0].reason)"
            : "\(files.map(\.name).joined(separator: ", ")): \(reasons)"
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Не удалось прочитать данные сервиса")
                    .font(.system(size: 12, weight: .semibold))
                Text(verbatim: "\(what). Пока \(files.count == 1 ? "файл не прочитается" : "файлы не прочитаются"), на вкладках показаны последние прочитанные данные")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            Button("Показать в Finder") { NSWorkspace.shared.activateFileViewerSelecting(files.map(\.url)) }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
        }
        .padding(12)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
    }

    private func errorBanner(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.syncError != nil ? "Не удалось выполнить команду" : "Последний запуск завершился с ошибкой")
                    .font(.system(size: 12, weight: .semibold))
                Text(error.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Spacer()
            Button("Журнал", action: openLog)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.accentColor)
        }
        .padding(12)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
    }

    // Сначала лимит, потом «только вручную»; при выключенном фоновом ревью вручную работают все модели
    private var availabilityCapsules: some View {
        let states = model.agentIds.map { (agent: $0, availability: model.availability($0)) }
        let limited = states.filter { $0.availability.isLimitExhausted }
        let manual = model.isPaused ? [] : states.filter { if case .manualOnly = $0.availability { true } else { false } }
        return ForEach(limited + manual, id: \.agent) { item in
            AvailabilityCapsule(agent: item.agent, name: model.agentName(item.agent), availability: item.availability, action: openRepos)
        }
    }

    private var runningReviews: [Current] { model.isRunning ? model.status?.reviews ?? [] : [] }

    // Несколько ревью — по значку модели и номеру PR в одной строке; вращение значков уже есть в строках PR
    @ViewBuilder
    private var statusText: some View {
        let reviews = runningReviews
        if reviews.count > 1 {
            HStack(spacing: 0) {
                Text("Идут ревью: ")
                ForEach(Array(reviews.enumerated()), id: \.offset) { index, review in
                    if index > 0 { Text(" · ").foregroundStyle(.tertiary) }
                    AgentMark(agent: review.agent)
                        .foregroundStyle(AgentMark.color(review.agent))
                        .frame(width: 11, height: 11)
                        .padding(.trailing, 3)
                    Text(verbatim: "\(shortRepoName(review.repo)) #\(review.pr)")
                }
            }
            .help(reviews.map { "\(shortRepoName($0.repo)) #\($0.pr)\($0.title.map { " «\($0)»" } ?? "") · \(model.agentName($0.agent)), \(roleName($0.role))" }.joined(separator: "\n"))
        } else {
            Text(headline)
                // Полный текст паузы не помещается рядом с кнопкой «Включить» и капсулами
                .help(model.isPaused && !model.isRunning ? "Фоновое ревью выключено, работают только запуски по иконкам" : "")
        }
    }

    private var headline: String {
        if model.isRunning, let current = model.status?.reviews.first {
            return "Идёт ревью \(current.repo) #\(current.pr) · \(model.agentName(current.agent))"
        }
        if model.isPaused { return "Фоновое ревью выключено" }
        guard let next = model.nextPassAt else { return "Ожидание" }
        let minutes = Int((next.timeIntervalSinceNow / 60).rounded(.up))
        return minutes <= 1 ? "Ожидание · проверка в течение минуты" : "Ожидание · следующая проверка через \(minutes) мин"
    }

    private func repoSection(_ repo: RepoConfig) -> some View {
        let snapshot = model.snapshots[repo.slug]
        let isExpanded = !collapsed.contains(repo.slug)
        return GroupedSection {
            Button {
                toggle(repo.slug)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Text(repo.slug)
                    if let snapshot { Text("· \(snapshot.prs.count)") }
                    // При выключенном общем фоновом ревью об этом уже говорит шапка обзора
                    if repo.isPaused && !model.isPaused {
                        HStack(spacing: 4) {
                            Image(systemName: "pause.circle.fill").foregroundStyle(Color.orange)
                            Text("фоновое ревью выключено")
                        }
                        // Подсказка внутри textCase(nil): иначе заголовок секции переводит её в капслок
                        .help("Фоновое ревью этого репозитория выключено в настройках. Ручной запуск по значку модели работает")
                        .textCase(nil)
                    }
                    Spacer()
                    if let snapshot {
                        Text("обновлено \(Dates.ago(snapshot.fetchedAt))").textCase(nil)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } content: {
            if isExpanded { prRows(repo, snapshot) }
        }
    }

    @ViewBuilder
    private func prRows(_ repo: RepoConfig, _ snapshot: PrSnapshot?) -> some View {
        if let snapshot, !snapshot.prs.isEmpty {
            // Черновики уходят вниз и приглушаются: фоновое ревью их пропускает, и они только отвлекают.
            // Ветки не по задачам остаются на месте с тегом: такой PR часто хочется посмотреть вручную
            let sorted = snapshot.prs.sorted { a, b in
                a.draft != b.draft ? !a.draft : (a.updatedOn ?? "") > (b.updatedOn ?? "")
            }
            ForEach(Array(sorted.enumerated()), id: \.element.id) { index, pr in
                if index > 0 { RowDivider(inset: 64) }
                PullRequestRow(repo: repo.slug, pr: pr, dimmed: pr.draft, prompts: prompts)
            }
        } else {
            Text(snapshot != nil ? "Открытых PR нет" : model.syncing ? "Загружаю список PR…" : "Список PR ещё не загружен")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        }
    }
}

struct PullRequestRow: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var hover = HoverState()
    let repo: String
    let pr: PullRequest
    var dimmed = false
    @ObservedObject var prompts: FixPrompts

    private var repoPaused: Bool { model.config.repos.first { $0.slug == repo }?.isPaused == true }
    private var autoAgents: [String] { model.agentIds.filter { model.config.agents[$0]?.isAuto != false } }

    // Модели только для ручного запуска не в счёт; без фоновых моделей галочку ставить не на чем
    private var reviewedClean: Bool {
        let auto = autoAgents
        return pr.threads == 0 && !auto.isEmpty && auto.allSatisfy { model.reviewState(repo: repo, pr: pr, agent: $0) == .done }
    }

    // Пропуск без ревью голова тоже считает проверенной: галочка не должна выдавать его за чистое ревью
    private var cleanHint: String {
        let reasons = autoAgents.compactMap { model.skipReason(repo: repo, pr: pr, agent: $0) }
        if reasons.contains("ignored") { return "Ревью не понадобилось: в диффе только исключённые файлы" }
        if reasons.contains("empty") { return "Ревью не понадобилось: в PR нет изменений относительно целевой ветки" }
        return "Модели проверили последний коммит и замечаний не нашли"
    }

    private var noReviewHint: String {
        let manual = "Запустить можно по значку модели"
        if model.isPaused { return "Фоновое ревью выключено. \(manual)" }
        if repoPaused { return "Фоновое ревью репозитория выключено. \(manual)" }
        if pr.draft { return "Черновик — фоновое ревью черновики пропускает. \(manual)" }
        if !model.config.isTaskBranch(pr.source) { return "Ветка вне шаблона веток задач — фоновое ревью её пропускает. \(manual)" }
        let auto = autoAgents
        if auto.isEmpty { return "Все модели запускаются только вручную — фоновое ревью этот PR не возьмёт. \(manual)" }
        if auto.allSatisfy({ model.availability($0).isLimitExhausted }) {
            return "Все фоновые модели упёрлись в лимит. Ревью будет после сброса"
        }
        if model.isRunning { return "Ревью ещё не было: идёт проход" }
        guard let next = model.nextPassAt else { return "Ревью ещё не было: ждёт прохода" }
        let minutes = Int((next.timeIntervalSinceNow / 60).rounded(.up))
        return minutes <= 1 ? "Ревью ещё не было: ждёт прохода, следующий в течение минуты" : "Ревью ещё не было: ждёт прохода, следующий через \(minutes) мин"
    }

    @ViewBuilder private var threadsCounter: some View {
        if reviewedClean {
            Image(systemName: "checkmark.bubble.fill")
                .font(.system(size: 12))
                .foregroundStyle(Color.green)
                .help(cleanHint)
        } else {
            HStack(spacing: 3) {
                Image(systemName: pr.threads > 0 && pr.resolved == pr.threads ? "checkmark.bubble" : "bubble.left")
                Text(verbatim: pr.threadsLabel).monospacedDigit()
            }
            .font(.system(size: 12))
            .foregroundStyle(pr.threads == 0 ? AnyShapeStyle(.tertiary) : pr.resolved == pr.threads ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
            .help(pr.threads == 0 ? noReviewHint : "Тредов закрыто \(pr.resolved) из \(pr.threads), всего комментариев \(pr.commentCount)")
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 2) {
                ForEach(model.agentIds, id: \.self) { agent in
                    AgentReviewButton(
                        agent: agent,
                        name: model.agentName(agent),
                        state: model.reviewState(repo: repo, pr: pr, agent: agent),
                        availability: model.availability(agent),
                        showsManualBadge: !model.isPaused && !repoPaused,
                        skipReason: model.skipReason(repo: repo, pr: pr, agent: agent)
                    ) {
                        model.requestReview(repo: repo, pr: pr.id, agent: agent)
                    }
                }
            }
            Button {
                if let url = URL(string: pr.url) { NSWorkspace.shared.open(url) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(verbatim: "#\(pr.id)").foregroundStyle(.secondary)
                        Text(pr.title).lineLimit(1)
                    }
                    .font(.system(size: 13))
                    Text([pr.author, "\(pr.source) → \(pr.destination)"].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Открыть PR в Bitbucket")
            badges
            threadsCounter
            FixButton(
                fix: model.fix(repo: repo, pr: pr.id),
                openThreads: pr.threads - pr.resolved,
                newThreads: model.fix(repo: repo, pr: pr.id)?.newThreads(in: pr).count ?? 0,
                behind: pr.behind ?? 0,
                conflicts: pr.conflicts == true,
                start: { rebase in prompts.confirm = FixTarget(repo: repo, pr: pr, rebase: rebase) },
                showReport: { prompts.report = FixTarget(repo: repo, pr: pr, rebase: model.fix(repo: repo, pr: pr.id)?.isRebase == true) }
            )
            ArchButton(
                arch: model.arch(repo: repo, pr: pr.id),
                pr: pr,
                start: { prompts.archConfirm = FixTarget(repo: repo, pr: pr) },
                showReport: { prompts.archReport = FixTarget(repo: repo, pr: pr) }
            )
            if model.canTest(repo: repo) {
                QaButton(qa: model.qa(repo: repo, pr: pr.id)) { prompts.qa = FixTarget(repo: repo, pr: pr) }
            }
            Text(Dates.ago(pr.updatedOn))
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .trailing)
                .help("Обновлён \(pr.updatedOn.flatMap(Dates.parse).map { Dates.format($0) } ?? "—")")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        // Приглушённая строка проявляется под курсором, чтобы с ней было удобно работать
        .opacity(dimmed && !hover.isHovered ? 0.45 : 1)
        .background(hover.isHovered ? Theme.hover : .clear)
        .onHover { hover.isHovered = $0 }
    }

    @ViewBuilder
    private var badges: some View {
        let important = model.importantFindings(repo: repo, pr: pr.id)
        if let worst = important.min(by: { $0.level < $1.level }) {
            Button {
                if let url = OpenFinding(repo: repo, pr: pr, finding: worst).url { NSWorkspace.shared.open(url) }
            } label: {
                Tag(text: important.count > 1 ? "\(worst.level) +\(important.count - 1)" : worst.level, color: worst.level == "P0" ? .red : .orange)
            }
            .buttonStyle(.plain)
            .help(important.map { "\($0.level) · \(model.agentName($0.agent)): \($0.title)" }.joined(separator: "\n") + "\n\nСтроки ещё не правили. Нажмите, чтобы открыть замечание")
        }
        if pr.draft {
            Tag(text: "Draft")
        } else if !model.config.isTaskBranch(pr.source) {
            Tag(text: "Untracked")
                .help("Ветка \(pr.source) не подходит под шаблон веток задач, поэтому фоновое ревью этот PR пропускает. Запустить ревью можно кликом по иконке модели. Шаблон — в настройках")
        }
    }
}
