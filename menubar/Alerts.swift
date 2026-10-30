import AppKit
import SwiftUI
import UserNotifications

enum NotificationKind: String, CaseIterable, Codable {
    case findings, comments, reviews, updates, fixes, errors

    var title: String {
        switch self {
        case .findings: "Замечания моделей"
        case .comments: "Комментарии людей"
        case .reviews: "Ревью завершено"
        case .updates: "Обновление PR"
        case .fixes: "Доработка и rebase"
        case .errors: "Ошибки сервиса"
        }
    }

    var detail: String {
        switch self {
        case .findings: "Новые замечания в PR"
        case .comments: "Новые треды и ответы команды, кроме ваших"
        case .reviews: "Модель прошла PR: сколько замечаний или «чисто»"
        case .updates: "Новые коммиты, новые и закрытые PR"
        case .fixes: "Итог: запушено, конфликты, упали проверки"
        case .errors: "Первая ошибка подряд и зависший проход"
        }
    }

    var icon: String {
        switch self {
        case .findings: "exclamationmark.bubble.fill"
        case .comments: "person.bubble.fill"
        case .reviews: "checkmark.bubble.fill"
        case .updates: "arrow.triangle.pull"
        case .fixes: "wand.and.stars"
        case .errors: "exclamationmark.triangle.fill"
        }
    }

    var color: Color {
        switch self {
        case .findings: .red
        case .comments: .blue
        case .reviews: .green
        case .updates: .purple
        case .fixes: .orange
        case .errors: .gray
        }
    }

    // Ошибки сервиса не относятся к репозиторию — настраиваются только для всех
    var perRepo: Bool { self != .errors }
    static let perRepoKinds = allCases.filter(\.perRepo)
}

struct NotificationRules: Codable, Equatable {
    var enabled: Set<NotificationKind>
    // Самый низкий уровень замечаний, о котором сообщать: P1 — только P0 и P1
    var level: String

    // Раньше приложение сообщало только о P0–P1, доработке и ошибках; комментарии людей — новое и полезное по умолчанию
    static let defaults = NotificationRules(enabled: [.findings, .comments, .fixes, .errors], level: "P1")

    func allows(level finding: String) -> Bool { finding <= level }
}

struct MutePeriod: Identifiable {
    // nil — пока не включат вручную
    let hours: Int?
    let title: String
    var id: Int { hours ?? 0 }

    static let all = [
        MutePeriod(hours: 1, title: "На 1 час"),
        MutePeriod(hours: 2, title: "На 2 часа"),
        MutePeriod(hours: 4, title: "На 4 часа"),
        MutePeriod(hours: 8, title: "На 8 часов"),
        MutePeriod(hours: 12, title: "На 12 часов"),
        MutePeriod(hours: 24, title: "На 24 часа"),
        MutePeriod(hours: nil, title: "Пока не включу"),
    ]
}

struct NotificationSettings: Codable, Equatable {
    var all = NotificationRules.defaults
    // Свои правила репозитория; нет записи — как для всех
    var repos: [String: NotificationRules] = [:]
    // Истёкший срок не стирается: проверка идёт по времени, а не по таймеру
    var mutedUntil: Date?

    var isMuted: Bool { (mutedUntil ?? .distantPast) > Date() }

    // «Выключены до 14:30»; бессрочно — просто «Выключены»
    var muteSummary: String {
        guard let until = mutedUntil, until != .distantFuture else { return "Выключены" }
        return "Выключены до \(until.formatted(date: Calendar.current.isDateInToday(until) ? .omitted : .abbreviated, time: .shortened))"
    }

    func rules(_ repo: String) -> NotificationRules { repos[repo] ?? all }

    func allows(_ kind: NotificationKind, repo: String?) -> Bool {
        guard let repo, kind.perRepo else { return all.enabled.contains(kind) }
        return rules(repo).enabled.contains(kind)
    }

    private static let key = "notificationSettings"

    static func load() -> NotificationSettings {
        guard let data = UserDefaults.standard.data(forKey: key), let settings = try? JSONDecoder().decode(NotificationSettings.self, from: data) else { return NotificationSettings() }
        return settings
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}

// Настройки уведомлений — личные, как тема: живут в UserDefaults, а не в config.json сервиса
@MainActor
final class NotificationStore: ObservableObject {
    static let shared = NotificationStore()

    @Published var settings = NotificationSettings.load() {
        didSet { settings.save() }
    }
    @Published private(set) var denied = false

    func mute(_ period: MutePeriod) {
        settings.mutedUntil = period.hours.map { Date().addingTimeInterval(Double($0) * 3600) } ?? .distantFuture
    }

    func unmute() { settings.mutedUntil = nil }

    func refreshAuthorization() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let denied = settings.authorizationStatus == .denied
            DispatchQueue.main.async { self.denied = denied }
        }
    }

    func openSystemSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
    }
}

// Все уведомления шлёт приложение: оно читает файлы сервиса раз в 5 секунд и сравнивает с тем, о чём уже сообщило.
// Сервис сам ничего не показывает — иначе настройки пришлось бы держать в двух местах, а его уведомления не открывали бы PR
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private let category = "pull-request"
    private let openAction = "open"

    // Головы PR с прошлой проверки; при запуске приложения — точка отсчёта, без уведомлений
    private var heads: [String: [Int: String]] = [:]
    private var lastRunAt: String??
    // О зависшем проходе — одно уведомление на проход (pid воркера)
    private var stallNotified: String?
    private var stats: [StatEntry] = []
    private var statsModified: Date?
    private var muted = false

    func setup() {
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(identifier: category, actions: [UNNotificationAction(identifier: openAction, title: "Открыть PR", options: [.foreground])], intentIdentifiers: []),
        ])
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        // При первом запуске не засыпаем уведомлениями о старых событиях
        for mark in Mark.allCases {
            switch UserDefaults.standard.object(forKey: mark.rawValue) {
            case nil: setSince(mark, Date())
            // Строка прежней версии отброшена до секунды — с запасом в секунду последнее событие не придёт ещё раз
            case let text as String: setSince(mark, (Dates.parse(text) ?? Date()).addingTimeInterval(1))
            default: break
            }
        }
    }

    // Отметки «сообщено до»: событие новее отметки — новое
    private enum Mark: String, CaseIterable {
        case findings = "notifiedFindingsSince"
        case comments = "notifiedCommentsSince"
        case reviews = "notifiedReviewsSince"
        case fixes = "notifiedFixesSince"
    }

    // Отметка — число секунд, а не ISO-строка: строка без долей секунды отставала от события на миллисекунды,
    // и то же событие снова считалось новым на каждой проверке. Строки от прежних версий читаются как есть
    private func since(_ mark: Mark) -> Date {
        let stored = UserDefaults.standard.object(forKey: mark.rawValue)
        if let seconds = stored as? Double { return Date(timeIntervalSinceReferenceDate: seconds) }
        return Dates.parse(stored as? String) ?? Date()
    }

    private func setSince(_ mark: Mark, _ date: Date) {
        UserDefaults.standard.set(date.timeIntervalSinceReferenceDate, forKey: mark.rawValue)
    }

    // Отметка двигается по всем свежим событиям, даже выключенным: при включении не придут старые
    private func fresh<T>(_ items: [T], _ mark: Mark, at: (T) -> String?) -> [T] {
        let since = since(mark)
        let result = items.filter { (Dates.parse(at($0)) ?? .distantPast) > since }
        if let latest = result.compactMap({ Dates.parse(at($0)) }).max() { setSince(mark, latest) }
        return result
    }

    func check(state: WorkerState, snapshots: [String: PrSnapshot], status: Status?, agentName: (String) -> String) {
        let settings = NotificationSettings.load()
        // Проверки идут и без уведомлений, чтобы двигать отметки: после включения не придёт пачка пропущенного
        muted = settings.isMuted
        let prs = snapshots.flatMap { repo, snapshot in snapshot.prs.map { (repo: repo, pr: $0) } }
        let fixes = loadFixes()
        findings(openFindings(state: state, snapshots: snapshots), settings, agentName)
        comments(prs, settings)
        reviews(prs, settings, agentName)
        updates(snapshots, fixes, settings)
        fixResults(fixes, prs, settings)
        errors(status, settings)
        stall(settings)
    }

    private func stall(_ settings: NotificationSettings) {
        guard let stall = workerStall() else { return }
        let run = (try? String(contentsOf: Paths.pid, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard run != stallNotified, settings.allows(.errors, repo: nil) else { return }
        stallNotified = run
        post(id: "stall#\(run ?? "")", title: "Проход ревью завис", subtitle: "", body: "Сервис не отвечает \(minutesText(stall.minutes)) — похоже, завис git или сеть. Прервать проход можно в окне PR Reviewer, в «Обзоре».", url: nil, thread: "errors")
    }

    private func findings(_ findings: [OpenFinding], _ settings: NotificationSettings, _ agentName: (String) -> String) {
        let allowed = fresh(findings, .findings) { $0.finding.at }.filter {
            settings.allows(.findings, repo: $0.repo) && settings.rules($0.repo).allows(level: $0.finding.level)
        }
        // Одно уведомление на запуск модели по PR, а не на каждое замечание
        for (id, group) in Dictionary(grouping: allowed, by: { "\($0.repo)#\($0.pr.id)#\($0.finding.agent)" }) {
            guard let first = group.first else { continue }
            let levels = Dictionary(grouping: group, by: \.finding.level).sorted { $0.key < $1.key }
                .map { $0.value.count > 1 ? "\($0.key)×\($0.value.count)" : $0.key }
                .joined(separator: " ")
            post(
                id: "\(id)#\(first.finding.at)",
                title: "\(levels) в \(first.repo) #\(first.pr.id) · \(agentName(first.finding.agent))",
                subtitle: first.pr.title,
                body: group.map { "\($0.finding.level): \($0.finding.title)" }.joined(separator: "\n"),
                url: first.url?.absoluteString ?? first.pr.url,
                thread: "\(first.repo)#\(first.pr.id)"
            )
        }
    }

    private func comments(_ prs: [(repo: String, pr: PullRequest)], _ settings: NotificationSettings) {
        let all = prs.flatMap { item in (item.pr.humanComments ?? []).map { (repo: item.repo, pr: item.pr, comment: $0) } }
        let allowed = fresh(all, .comments) { $0.comment.at }.filter { settings.allows(.comments, repo: $0.repo) }
        for (id, group) in Dictionary(grouping: allowed, by: { "\($0.repo)#\($0.pr.id)" }) {
            guard let first = group.first, let last = group.last else { continue }
            let authors = Array(Set(group.compactMap(\.comment.author))).sorted().joined(separator: ", ")
            post(
                id: "comments#\(id)#\(last.comment.id)",
                title: group.count > 1 ? "\(group.count) комментария в \(first.repo) #\(first.pr.id)" : "\(first.comment.reply ? "Ответ" : "Комментарий") в \(first.repo) #\(first.pr.id)",
                subtitle: authors.isEmpty ? first.pr.title : authors,
                body: group.map { "\($0.comment.author.map { "\($0): " } ?? "")\($0.comment.text)" }.joined(separator: "\n"),
                url: last.comment.url ?? first.pr.url,
                thread: id
            )
        }
    }

    private func reviews(_ prs: [(repo: String, pr: PullRequest)], _ settings: NotificationSettings, _ agentName: (String) -> String) {
        let modified = (try? FileManager.default.attributesOfItem(atPath: Paths.stats.path))?[.modificationDate] as? Date
        if modified != statsModified {
            statsModified = modified
            stats = readJSONLines(StatEntry.self, Paths.stats)
        }
        let finished = fresh(stats, .reviews) { $0.at }.filter { $0.pass != "replies" && settings.allows(.reviews, repo: $0.repo) }
        for entry in finished {
            let pr = prs.first { $0.repo == entry.repo && $0.pr.id == entry.pr }?.pr
            let levels = Level.all.compactMap { level in entry.findings[level].flatMap { $0 > 0 ? ($0 > 1 ? "\(level)×\($0)" : level) : nil } }
            post(
                id: "review#\(entry.repo)#\(entry.pr ?? 0)#\(entry.agent)#\(entry.at)",
                title: "\(agentName(entry.agent)) закончил ревью \(entry.repo) #\(entry.pr.map(String.init) ?? "")",
                subtitle: pr?.title ?? entry.title ?? "",
                body: levels.isEmpty ? "Замечаний нет" : "Замечания: \(levels.joined(separator: " "))",
                url: pr?.url ?? entry.url,
                thread: "\(entry.repo)#\(entry.pr ?? 0)"
            )
        }
    }

    private func updates(_ snapshots: [String: PrSnapshot], _ fixes: [FixState], _ settings: NotificationSettings) {
        for (repo, snapshot) in snapshots {
            let current = Dictionary(uniqueKeysWithValues: snapshot.prs.map { ($0.id, $0) })
            defer { heads[repo] = current.mapValues(\.head) }
            // Репозиторий впервые в поле зрения (запуск приложения, подключение) — только точка отсчёта
            guard let known = heads[repo], settings.allows(.updates, repo: repo) else { continue }
            for pr in snapshot.prs {
                guard let head = known[pr.id] else {
                    post(id: "new#\(repo)#\(pr.id)", title: "Новый PR \(repo) #\(pr.id)", subtitle: pr.author ?? "", body: pr.title, url: pr.url, thread: "\(repo)#\(pr.id)")
                    continue
                }
                // Свой пуш доработки — уже сообщила доработка
                let pushedByFix = fixes.contains { $0.repo == repo && $0.pr == pr.id && $0.report?.head == pr.head }
                if head != pr.head && !pushedByFix {
                    post(id: "push#\(repo)#\(pr.id)#\(pr.head)", title: "Новые коммиты в \(repo) #\(pr.id)", subtitle: pr.author ?? "", body: pr.title, url: pr.url, thread: "\(repo)#\(pr.id)")
                }
            }
            for (id, head) in known where current[id] == nil {
                post(id: "closed#\(repo)#\(id)#\(head)", title: "PR \(repo) #\(id) закрыт", subtitle: "", body: "Влит или отклонён", url: nil, thread: "\(repo)#\(id)")
            }
        }
    }

    private func loadFixes() -> [FixState] {
        let files = (try? FileManager.default.contentsOfDirectory(at: Paths.fixStates, includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { readJSON(FixState.self, $0) }
    }

    private func fixResults(_ fixes: [FixState], _ prs: [(repo: String, pr: PullRequest)], _ settings: NotificationSettings) {
        let finished = fresh(fixes.filter { !$0.isActive }, .fixes) { $0.finishedAt }.filter { settings.allows(.fixes, repo: $0.repo) }
        for fix in finished {
            let name = fix.isRebase ? "Rebase" : "Доработка"
            let counts = fix.isRebase || fix.report == nil ? "" : "\nИсправлено \(fix.report?.fixed?.count ?? 0), не исправлено \(fix.report?.skipped?.count ?? 0)"
            let pr = prs.first { $0.repo == fix.repo && $0.pr.id == fix.pr }?.pr
            post(
                id: "fix#\(fix.repo)#\(fix.pr)#\(fix.finishedAt ?? "")",
                title: "\(name) \(fix.repo) #\(fix.pr)\(fix.state == "done" ? "" : " не удалась")",
                subtitle: pr?.title ?? "",
                body: (fix.report?.message ?? fix.error ?? "") + counts,
                url: pr?.url,
                thread: "\(fix.repo)#\(fix.pr)"
            )
        }
    }

    private func errors(_ status: Status?, _ settings: NotificationSettings) {
        guard let status else { return }
        defer { lastRunAt = .some(status.lastRunAt) }
        guard let previous = lastRunAt, previous != status.lastRunAt else { return }
        guard status.phase == "error", status.errorStreak == 1, let error = status.lastError, settings.allows(.errors, repo: nil) else { return }
        post(id: "error#\(status.lastRunAt ?? "")", title: "PR Reviewer: проход завершился с ошибкой", subtitle: "", body: error, url: nil, thread: "errors")
    }

    private func post(id: String, title: String, subtitle: String, body: String, url: String?, thread: String) {
        guard !muted else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = subtitle
        content.body = body
        content.categoryIdentifier = category
        content.threadIdentifier = thread
        content.sound = .default
        if let url { content.userInfo = ["url": url] }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let dismissed = response.actionIdentifier == UNNotificationDismissActionIdentifier
        if !dismissed, let url = (response.notification.request.content.userInfo["url"] as? String).flatMap(URL.init(string:)) {
            DispatchQueue.main.async { NSWorkspace.shared.open(url) }
        }
        completionHandler()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
