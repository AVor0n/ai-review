import AppKit
import Combine

struct Current: Decodable {
    let repo: String
    let pr: Int
    let agent: String
    let role: String
    let title: String?
}

// Имя репозитория без общего префикса — для тесных мест: меню, подсказка значка, шапка с несколькими ревью
func shortRepoName(_ slug: String) -> String {
    slug.hasPrefix("project-") ? String(slug.dropFirst("project-".count)) : slug
}

func roleName(_ role: String) -> String {
    ["first": "первым", "second": "следом", "replies": "ответы"][role] ?? role
}

struct Verdict: Decodable {
    let target: String
    let verdict: String
    // С 19.10.2026: почему модель не согласна — wrong, fixed, preexisting, unlikely; у согласия и пропуска — none
    let reason: String?
}

struct Recent: Decodable {
    let at: String
    let repo: String
    let pr: Int
    let title: String?
    let url: String
    let agent: String
    let role: String
    let findings: [String: Int]
    let verdicts: [Verdict]
}

// Только поля, нужные графику: старые записи stats.jsonl без url или title не должны выпадать из статистики
struct Usage: Decodable {
    let inputTokens: Int
    let cachedTokens: Int
    let outputTokens: Int
    let costUsd: Double?
}

struct StatEntry: Decodable {
    let at: String
    let repo: String
    let pr: Int?
    let title: String?
    let url: String?
    let author: String?
    let agent: String
    let role: String
    // initial — первое ревью PR, followup — после новых коммитов, replies — только ответы в тредах
    let pass: String?
    let findings: [String: Int]
    let verdicts: [Verdict]
    let durationSec: Int?
    let usage: Usage?
    let excludedBytes: Int?
    // Изменённых строк в диффе PR на момент ревью, без исключённых файлов
    let diffLines: Int?
    // Не опубликованы: строки нет в диффе, проблема была до PR (ушла в бэклог), редкий P3. Последние два — с 19.10.2026
    let dropped: Int?
    let backlogged: Int?
    let filtered: Int?
    let appliedLessons: [String]?
    // Опубликованные ответы в тредах; в записях до этого поля — все вердикты, кроме skip, вместе с голыми согласиями
    let postedReplies: Int?

    var findingCount: Int { findings.values.reduce(0, +) }

    var postedComments: Int {
        findings.values.reduce(0, +) + (postedReplies ?? verdicts.filter { $0.verdict != "skip" }.count)
    }
}

struct Status: Decodable {
    let phase: String?
    let current: Current?
    // Ревью идут параллельно по репозиториям; running упорядочен по времени начала, current — первое из них
    let running: [Current]?
    let lastRunAt: String?
    let lastPassAt: String?
    let lastError: String?
    // Номер ошибки подряд: уведомление — только о первой в серии
    let errorStreak: Int?
    let recent: [Recent]?

    // Сервис до параллельных ревью писал только current
    var reviews: [Current] { running ?? current.map { [$0] } ?? [] }
}

struct AgentConfig: Decodable {
    let shortName: String
    let model: String?
    let effort: String?
    let reasoningEffort: String?
    let auto: Bool?
    let keychainService: String?
    let tokenLifetimeDays: Int?

    var isAuto: Bool { auto ?? true }
}

// Модели Codex и их уровни reasoning — из кэша, который ведёт сам Codex CLI: список меняется вместе с CLI
struct CodexModel: Decodable, Hashable {
    let slug: String
    let displayName: String
    let visibility: String?
    let defaultReasoningLevel: String?
    let supportedReasoningLevels: [Level]?

    struct Level: Decodable, Hashable {
        let effort: String
    }

    var efforts: [String] { supportedReasoningLevels?.map(\.effort) ?? ["low", "medium", "high"] }

    static func loadCursor() -> [(id: String, title: String)] {
        struct Item: Decodable { let id: String; let title: String }
        struct File: Decodable { let models: [Item] }
        guard let file = readJSON(File.self, Paths.data.appendingPathComponent("cursor-models.json")) else { return [] }
        return file.models.map { ($0.id, $0.title) }
    }

    static func load() -> [CodexModel] {
        struct Cache: Decodable { let models: [CodexModel] }
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/models_cache.json")
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let data = try? Data(contentsOf: url), let cache = try? decoder.decode(Cache.self, from: data) else { return [] }
        return cache.models.filter { $0.visibility == "list" }
    }
}

struct RepoConfig: Decodable, Identifiable, Hashable {
    let workspace: String
    let slug: String
    let remote: String
    let source: String?
    let paused: Bool?
    var id: String { slug }
    var isPaused: Bool { paused ?? false }
    var webURL: URL? { URL(string: "https://bitbucket.org/\(workspace)/\(slug)") }
}

struct MemoryConfig: Decodable {
    let maxLessons: Int?
}

struct ArchConfig: Decodable {
    let agent: String?
}

struct QaConfig: Decodable {
    let frontend: String?
}

struct AppConfig: Decodable {
    let repos: [RepoConfig]
    let agents: [String: AgentConfig]
    var intervalMinutes: Int?
    var ignorePaths: [String]?
    var memory: MemoryConfig?
    var branchPattern: String?
    var bitbucket: BitbucketConfig?
    var arch: ArchConfig?
    var qa: QaConfig?

    // Тестировать в браузере сервис умеет только фронтенд из qa.frontend (qaSettings в qa.mjs)
    var qaFrontend: String { qa?.frontend ?? "frontend" }

    // Тот же шаблон, что у фонового ревью в review.mjs: остальные PR ревьюятся только вручную
    func isTaskBranch(_ branch: String) -> Bool {
        branch.range(of: branchPattern ?? "PROJ-\\d+", options: [.regularExpression, .caseInsensitive]) != nil
    }
}

struct PullRequest: Decodable, Identifiable {
    let id: Int
    let title: String
    let draft: Bool
    let author: String?
    let updatedOn: String?
    let commentCount: Int
    let openThreads: Int?
    let resolvedThreads: Int?
    let url: String
    let head: String
    let source: String
    let destination: String
    // Насколько ветка отстала от базы и будет ли конфликт; nil — ещё не посчитано (нет клона)
    let behind: Int?
    let conflicts: Bool?
    let openRoots: [OpenThread]?
    let humanComments: [HumanComment]?
}

// Комментарий человека (кроме своих) — для уведомлений о новых тредах и ответах
struct HumanComment: Decodable, Identifiable {
    let id: Int
    let author: String?
    let text: String
    let reply: Bool
    let path: String?
    let url: String?
    let at: String?
}

// Открытый тред PR кратко: первая строка корневого комментария
struct OpenThread: Decodable, Identifiable {
    let id: Int
    let author: String?
    let text: String
    let path: String?
    let url: String?
    let at: String?
}

extension PullRequest {
    var resolved: Int { resolvedThreads ?? 0 }
    // Снимки до появления счётчика тредов: показываем число комментариев, как раньше
    var threads: Int { openThreads.map { $0 + resolved } ?? commentCount }

    var threadsLabel: String { resolved > 0 ? "\(resolved)/\(threads)" : "\(threads)" }
}

struct PrSnapshot: Decodable {
    let fetchedAt: String
    let prs: [PullRequest]
}

struct TrackedFinding: Decodable {
    let commentId: Int?
    let agent: String
    let author: String?
    let pass: String?
    let path: String?
    let level: String
    let title: String
    let at: String
    let resolved: Bool?

    var isImportant: Bool { level == "P0" || level == "P1" }
    // Тред закрыли через Resolve — замечание больше не ждёт правки, даже если код рядом не меняли
    var isWaiting: Bool { resolved != true }
}

struct PrState: Decodable {
    let reviewed: [String: String]
    let findings: [TrackedFinding]?
    let skipped: [String: SkipMark]?
}

// Голова, отмеченная проверенной без ревью: rebase (тот же патч), ignored (только исключённые файлы), empty (пустой дифф)
struct SkipMark: Decodable {
    let head: String
    let reason: String
}

// Особое состояние модели в фоновом ревью — одно значение, чтобы порог лимита потом стал ещё одним случаем
enum AgentAvailability {
    case available
    case limitExhausted(resetsAt: Date, updatedAt: Date?)
    case manualOnly

    var isLimitExhausted: Bool {
        if case .limitExhausted = self { true } else { false }
    }
}

struct Outcome: Decodable {
    let at: String
    let repo: String?
    let pr: Int?
    let author: String?
    let agent: String
    let pass: String?
    let level: String
    let outcome: String
    let disputed: Bool?
    // Часов от публикации замечания до исхода
    let hours: Double?
}

struct Skip: Decodable {
    let at: String
    let repo: String
    let pr: Int
    let author: String?
    let agent: String
    let reason: String
}

// В журналах автофикса, тестирования и трат памяти usage бывает урезан до одной цены
struct SpendUsage: Decodable {
    let costUsd: Double?
}

// Запись fixes.jsonl; у записей до появления rebase нет mode — это автофикс
struct FixRecord: Decodable {
    let at: String
    let repo: String
    let pr: Int
    let mode: String?
    let status: String
    let fixed: Int?
    let skipped: Int?
    let usage: SpendUsage?
    let durationSec: Int?

    var isRebase: Bool { mode == "rebase" }
}

struct ArchRecord: Decodable {
    let at: String
    let repo: String
    let pr: Int
    let agent: String?
    let verdict: String
    let usage: SpendUsage?
}

// Запись qa.jsonl: у плана cases — число кейсов, у прогона — счётчики по статусам
struct QaRecord: Decodable {
    let at: String
    let stage: String
    let repo: String
    let pr: Int
    let plannedCases: Int?
    let caseCounts: [String: Int]?
    let bugs: Int?
    let usage: SpendUsage?

    private enum CodingKeys: String, CodingKey { case at, stage, repo, pr, cases, bugs, usage }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        at = try container.decode(String.self, forKey: .at)
        stage = try container.decode(String.self, forKey: .stage)
        repo = try container.decode(String.self, forKey: .repo)
        pr = try container.decode(Int.self, forKey: .pr)
        plannedCases = try? container.decode(Int.self, forKey: .cases)
        caseCounts = try? container.decode([String: Int].self, forKey: .cases)
        bugs = try container.decodeIfPresent(Int.self, forKey: .bugs)
        usage = try container.decodeIfPresent(SpendUsage.self, forKey: .usage)
    }
}

// Запись spend.jsonl: траты памяти и бэклога; у перенесённых из лога записей бэклога repo пустой
struct SpendRecord: Decodable {
    let at: String
    let kind: String
    let repo: String?
    let agent: String?
    let usage: SpendUsage?
}

// Замечание открытого PR, которое ещё ждёт правки, с репозиторием — для фильтров статистики
struct WaitingFinding {
    let repo: String
    let finding: TrackedFinding
}

// Важное замечание в открытом PR, строки которого ещё не правили
struct OpenFinding {
    let repo: String
    let pr: PullRequest
    let finding: TrackedFinding

    var url: URL? { URL(string: finding.commentId.map { "\(pr.url)#comment-\($0)" } ?? pr.url) }
}

struct RepoState: Decodable {
    let prs: [String: PrState]
}

struct WorkerState: Decodable {
    let repos: [String: RepoState]?
}

struct QueuedReview: Decodable {
    let repo: String
    let pr: Int
    let agent: String
}

struct LessonSource: Decodable {
    let pr: Int
    let url: String
    let authors: [String]?
    // review — из замечания человека в ревью, reply — из ответа на замечание модели
    let kind: String?
    // У правила, склеенного разбором памяти, — id исходных правил; источник взят от первого из них
    let mergedFrom: [String]?
}

struct Lesson: Decodable, Identifiable {
    let id: String
    let text: String
    let at: String
    let manual: Bool?
    let edited: Bool?
    let source: LessonSource?
    // Склеенное только из добавленных вручную: источника нет, список исходных правил лежит здесь
    let mergedFrom: [String]?

    var mergedIds: [String] { source?.mergedFrom ?? mergedFrom ?? [] }
}

// Сколько раз правило повлияло на ревью и чем кончились основанные на нём замечания
struct LessonUsage: Decodable {
    let applied: Int
    let findings: Int
    let addressed: Int
    let dismissed: Int
}

// Вывод `memory list --json`: since — первый запуск ревью, с которого считаются срабатывания
struct MemoryUsage: Decodable {
    struct Item: Decodable {
        let id: String
        let usage: LessonUsage?
    }

    let since: String?
    let runs: Int
    let lessons: [Item]

    func usage(_ id: String) -> LessonUsage? { lessons.first { $0.id == id }?.usage }
}

// Запись журнала памяти (`memory history --json`). kind: learn — выучено из PR, add/edit/remove — вручную,
// evict — вытеснено при переполнении, review — применённый разбор, restore — его откат
struct MemoryChange: Decodable {
    struct Item: Decodable {
        let id: String
        let text: String
        let reason: String?
    }

    struct Edit: Decodable {
        let id: String
        let before: String
        let after: String
        let reason: String?
    }

    struct Merge: Decodable {
        let from: [Item]
        let into: Item
        let reason: String?
    }

    let at: String
    let kind: String
    let reason: String?
    let pr: Int?
    let url: String?
    let added: [Item]?
    let removed: [Item]?
    let changed: [Edit]?
    let merged: [Merge]?
}

// План разбора памяти (`memory review --json`): keep — оставить, drop — удалить, merge — склеить ids в text, rewrite — переписать
struct MemoryPlan: Decodable {
    struct Action: Decodable {
        let type: String
        let ids: [String]
        let text: String
        let reason: String
    }

    let at: String
    let summary: String
    let actions: [Action]
    let usage: Usage?
    // Память изменилась после разбора: такой план сервис применять откажется
    let outdated: Bool?

    func group(_ type: String) -> [Action] { actions.filter { $0.type == type } }
    var changes: Int { actions.filter { $0.type != "keep" }.count }

    var counts: (before: Int, after: Int) {
        let before = actions.reduce(0) { $0 + $1.ids.count }
        let removed = actions.reduce(0) { total, action in
            total + (action.type == "drop" ? action.ids.count : action.type == "merge" ? action.ids.count - 1 : 0)
        }
        return (before, before - removed)
    }
}

private struct MemoryFile: Decodable {
    let lessons: [Lesson]
}

// Файл памяти правят и руками — битый показываем как ошибку, а не как пустую память. Проверки те же, что у сервиса (memory.mjs)
private func readMemoryFile(_ slug: String) -> (lessons: [Lesson], broken: String?) {
    let url = Paths.memory(slug)
    guard let data = try? Data(contentsOf: url) else { return ([], nil) }
    do {
        guard let lessons = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["lessons"] as? [Any] else {
            return ([], "нет массива lessons")
        }
        if let index = lessons.firstIndex(where: { item in
            guard let lesson = item as? [String: Any] else { return true }
            return !["id", "text", "at"].allSatisfy { lesson[$0] is String }
        }) {
            return ([], "у правила \(index + 1) нет id, text или at")
        }
        return (try JSONDecoder().decode(MemoryFile.self, from: data).lessons, nil)
    } catch {
        let nsError = error as NSError
        return ([], (nsError.userInfo["NSDebugDescription"] as? String) ?? nsError.localizedDescription)
    }
}

// kind: finding — модель нашла сама, reply — признала старой проблемой чужое замечание в треде, deferred — человек отложил её замечание
struct BacklogSource: Decodable {
    let pr: Int
    let url: String
    let agent: String
    let commit: String?
    let kind: String?
    let at: String?
    // Автор треда-человека, если проблему взяли из истории PR
    let author: String?
}

struct BacklogTriage: Decodable {
    static let stale: Set<String> = ["fixed", "gone", "invalid"]

    let at: String
    let commit: String?
    let branch: String?
    let verdict: String
    let reason: String

    var isStale: Bool { Self.stale.contains(verdict) }

    var title: String {
        switch verdict {
        case "actual": "актуально"
        case "fixed": "решено"
        case "gone": "удалено"
        case "invalid": "не баг"
        default: "неясно"
        }
    }
}

// Сбор из истории или разбор по коду: идут отдельным процессом, ход — в backlog-job.json
struct BacklogJob: Decodable {
    let kind: String
    let state: String
    let pid: Int32?
    let activity: String?
    let startedAt: String?
    let finishedAt: String?
    let message: String?
    let error: String?

    var title: String { kind == "learn" ? "Сбор из истории PR" : "Разбор по коду" }

    // «Идёт» без живого процесса — след прерванного запуска
    var isRunning: Bool {
        guard state == "running", let pid else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }
}

struct BacklogScan: Decodable {
    struct Repo: Decodable {
        let at: String?
        let found: Int?
    }

    let repos: [String: Repo]
}

// Проблема вне скоупа PR из backlog.json; path, scenario и fix бывают пустыми у записей из ответов в тредах
struct BacklogItem: Decodable, Identifiable {
    static let levels = ["P0", "P1", "P2", "P3"]

    let id: String
    let repo: String
    let status: String
    let level: String
    let likelihood: String?
    let path: String?
    let line: Int?
    let title: String
    let scenario: String?
    let fix: String?
    let ticket: String?
    let note: String?
    let createdAt: String?
    let updatedAt: String?
    let sources: [BacklogSource]
    let triage: BacklogTriage?

    var isOpen: Bool { status == "open" }
    var isStale: Bool { isOpen && triage?.isStale == true }

    var location: String? { path.map { path in line.map { "\(path):\($0)" } ?? path } }

    var prSources: [BacklogSource] {
        var seen = Set<Int>()
        return sources.filter { seen.insert($0.pr).inserted }
    }

    // Тот же порядок, что у `backlog export`: уровень, затем сколько раз проблема всплывала
    static func byPriority(_ a: BacklogItem, _ b: BacklogItem) -> Bool {
        let (left, right) = (levels.firstIndex(of: a.level) ?? levels.count, levels.firstIndex(of: b.level) ?? levels.count)
        if left != right { return left < right }
        if a.sources.count != b.sources.count { return a.sources.count > b.sources.count }
        return (a.updatedAt ?? "") > (b.updatedAt ?? "")
    }
}

private struct BacklogFile: Decodable {
    let items: [BacklogItem]
}

struct FixItem: Decodable, Identifiable {
    let commentId: Int
    let location: String
    let summary: String?
    let reason: String?
    var id: Int { commentId }
}

struct FixReport: Decodable {
    let status: String
    let message: String
    // Открытые треды, которые видела доработка; в старых отчётах поля нет — тогда берём исправленные и пропущенные
    let seenIds: [Int]?
    let fixed: [FixItem]?
    let skipped: [FixItem]?
    let notes: String?
    let checks: String?
    let rebase: String?
    let backup: String?
    let hook: String?
    let resumedFrom: String?
    let usage: Usage?
    let durationSec: Int?
    // Голова ветки после пуша — чтобы не сообщать о «новых коммитах», которые запушила сама доработка
    let head: String?
}

struct FixState: Decodable {
    let repo: String
    let pr: Int
    let state: String
    let step: String?
    let error: String?
    let report: FixReport?
    let startedAt: String?
    let finishedAt: String?
    let steps: [FixStep]?
    let activity: String?
    let activityAt: String?
    let mode: String?

    var isRebase: Bool { mode == "rebase" }

    var isActive: Bool { state == "queued" || state == "running" }

    // Треды, открытые сейчас, но появившиеся после доработки: её итог уже не закрывает все замечания PR
    func newThreads(in pr: PullRequest) -> [OpenThread] {
        guard state == "done", !isRebase, let report else { return [] }
        let seen = Set(report.seenIds ?? ((report.fixed ?? []) + (report.skipped ?? [])).map(\.commentId))
        return (pr.openRoots ?? []).filter { !seen.contains($0.id) }
    }
}

struct ArchAlternative: Decodable {
    let title: String
    let idea: String
    let pros: [String]
    let cons: [String]
    let switchCost: String
    let better: Bool
}

// path пустой, а line — 0, когда у пункта нет конкретного места в коде
struct ArchPlace: Decodable {
    let level: String?
    let title: String
    let details: String
    let path: String
    let line: Int

    var location: String? { path.isEmpty ? nil : line > 0 ? "\(path):\(line)" : path }
}

// Отчёт по schema/arch.schema.json
struct ArchReport: Decodable {
    let goal: String
    let goalClarity: String
    let approach: String
    let alternatives: [ArchAlternative]
    let simpler: [ArchPlace]
    let risks: [ArchPlace]
    let verdict: String
    let summary: String
    let questions: [String]
}

struct ArchResult: Decodable {
    let report: ArchReport
    let head: String
    let agent: String
    let model: String?
    let title: String?
    let url: String?
    let usage: Usage?
    let durationSec: Int?
}

// Прошлый отчёт остаётся в result, пока идёт новый запуск
struct ArchState: Decodable {
    let repo: String
    let pr: Int
    let state: String
    let activity: String?
    let error: String?
    let startedAt: String?
    let finishedAt: String?
    let result: ArchResult?

    var isActive: Bool { state == "queued" || state == "running" }

    // Голова в отчёте и в снимке PR — первые 12 символов коммита, но длину не закладываем
    func isStale(for pr: PullRequest) -> Bool {
        guard let head = result?.head, !head.isEmpty, !pr.head.isEmpty else { return false }
        return !(head.hasPrefix(pr.head) || pr.head.hasPrefix(head))
    }

    func interrupted() -> ArchState {
        ArchState(repo: repo, pr: pr, state: "failed", activity: nil, error: "архитектурное ревью прервано", startedAt: startedAt, finishedAt: nil, result: result)
    }
}

struct QaRisk: Decodable {
    let title: String
    let details: String
    let path: String?
}

struct QaBug: Decodable {
    let title: String
    let details: String
}

// files — пути относительно папки прогона: <id кейса>/<имя>, скриншоты .png и видео .webm от Playwright
struct QaEvidence: Decodable {
    let status: String
    let durationMs: Int?
    let files: [String]
    let errors: [String]
    let specFile: String?
}

// Кейс плана; у кейса прогона к нему добавлены итог и доказательства. Свои кейсы человека (U1, U2…) приходят без шагов
struct QaCase: Decodable, Identifiable {
    let id: String
    let title: String
    let source: String
    let priority: String
    // e2e, component или unit; в планах до уровней его нет — тогда e2e. У своего кейса человека до прогона — null
    let level: String?
    // Проверяемый файл юнит или компонентного кейса
    let target: String?
    let preconditions: String?
    let steps: [String]
    let expect: String?
    let status: String?
    let claimed: String?
    let checked: String?
    let notes: String?
    let bug: QaBug?
    let evidence: QaEvidence?
    // Где тест должен лежать в репозитории по стратегии тестирования
    let savePath: String?
}

struct QaUntestable: Decodable {
    let what: String
    let why: String
}

// План по schema/qa-plan.schema.json
struct QaPlan: Decodable {
    let kind: String
    let testable: Bool
    let summary: String
    let expected: String
    let risks: [QaRisk]
    let cases: [QaCase]
    let notTestable: [QaUntestable]
}

struct QaBackend: Decodable {
    let ref: String
    let commit: String
}

// Тест прогона: file — копия в папке прогона, target — место в репозитории по стратегии
struct QaTest: Decodable {
    let source: String
    let file: String
    let target: String
    let level: String?
    let cases: [String]
}

struct QaSavedFile: Decodable {
    let path: String
    let wanted: String
    let cases: [String]
}

// Куда `qa save` положил тесты: локальная копия, её ветка и ветка PR
struct QaSaved: Decodable {
    let at: String
    let checkout: String
    let branch: String?
    let prBranch: String?
    let files: [QaSavedFile]
}

struct QaRun: Decodable {
    let head: String
    let branch: String?
    let planHead: String?
    // Бэкенд поднимается только для e2e-кейсов
    let backend: QaBackend?
    let summary: String
    let envNotes: String?
    let runDir: String
    let usage: Usage?
    let durationSec: Int?
    let cases: [QaCase]
    let tests: [QaTest]?
    let saved: QaSaved?

    func count(_ status: String) -> Int { cases.filter { $0.status == status }.count }
}

// Состояние тестирования PR из qa/state; план и прошлый отчёт остаются, пока идёт новый этап
struct QaState: Decodable {
    let repo: String
    let pr: Int
    var state: String
    var step: String?
    var steps: [FixStep]?
    var activity: String?
    var error: String?
    let note: String?
    let title: String?
    let url: String?
    let planHead: String?
    let plan: QaPlan?
    let run: QaRun?
    let startedAt: String?
    let finishedAt: String?
    // Цена составления плана
    let usage: Usage?

    static let activeStates: Set<String> = ["planning-queued", "planning", "run-queued", "running"]

    var isActive: Bool { Self.activeStates.contains(state) }
    var isPlanning: Bool { state == "planning-queued" || state == "planning" }
    var isQueued: Bool { state == "planning-queued" || state == "run-queued" }

    func interrupted() -> QaState {
        var copy = self
        copy.state = isPlanning ? "plan-failed" : "failed"
        copy.error = "тестирование прервано"
        copy.step = nil
        copy.activity = nil
        return copy
    }
}

struct AgentLimit: Decodable {
    let window: String
    let usedPercent: Double
    let resetsAt: String?
    let at: String?
    // Последний опрос не удался: остаток выше — с прошлого удачного
    let error: LimitError?
    let errorAt: String?

    var remaining: Double { max(0, 100 - usedPercent) }
}

struct LimitError: Decodable {
    let code: Int?
    let text: String

    var description: String { [401, 403].contains(code ?? 0) ? "ошибка \(code ?? 0), \(text)" : text }
}

struct FixStep: Decodable {
    let title: String
    let at: String
}

struct LogEntry: Identifiable {
    let id: Int
    let date: Date?
    let message: String
    let isError: Bool
}

enum ReviewState {
    case none, stale, done, queued, running
}

enum Paths {
    // Как у сервиса (os.homedir() читает HOME): иначе с подменённым HOME окно и его CLI смотрели бы в разные папки
    static let home = ProcessInfo.processInfo.environment["HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? FileManager.default.homeDirectoryForCurrentUser
    static let data = home.appendingPathComponent("Library/Application Support/pr-reviewer")
    static let log = home.appendingPathComponent("Library/Logs/pr-reviewer/worker.log")
    static let cli = Bundle.main.object(forInfoDictionaryKey: "PRReviewerCLI") as? String ?? ""
    static let config = URL(fileURLWithPath: cli).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("config.json")
    static let paused = data.appendingPathComponent("paused")
    static let pid = data.appendingPathComponent("worker.pid")
    static let heartbeat = data.appendingPathComponent("heartbeat")
    static let status = data.appendingPathComponent("status.json")
    static let state = data.appendingPathComponent("state.json")
    static let stats = data.appendingPathComponent("stats.jsonl")
    static let outcomes = data.appendingPathComponent("outcomes.jsonl")
    static let skips = data.appendingPathComponent("skips.jsonl")
    static let fixLog = data.appendingPathComponent("fixes.jsonl")
    static let archLog = data.appendingPathComponent("arch.jsonl")
    static let qaLog = data.appendingPathComponent("qa.jsonl")
    static let spend = data.appendingPathComponent("spend.jsonl")
    static let backlog = data.appendingPathComponent("backlog.json")
    static let backlogJob = data.appendingPathComponent("backlog-job.json")
    static let backlogScan = data.appendingPathComponent("backlog-scan.json")
    static let fixStates = data.appendingPathComponent("fixes/state")
    static let fixPid = data.appendingPathComponent("fixes/worker.pid")
    static let archStates = data.appendingPathComponent("arch/state")
    static let archPid = data.appendingPathComponent("arch/worker.pid")
    static let qaStates = data.appendingPathComponent("qa/state")
    static let qaPid = data.appendingPathComponent("qa/worker.pid")
    static let queue = data.appendingPathComponent("queue")
    static let prs = data.appendingPathComponent("prs")
    static func clone(_ slug: String) -> URL { home.appendingPathComponent(".pr-reviewer/repos/\(slug)") }
    static func memory(_ slug: String) -> URL { data.appendingPathComponent("memory/\(slug).json") }
    static func memoryPlan(_ slug: String) -> URL { data.appendingPathComponent("memory/\(slug).review.json") }
}

enum Dates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()
    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.unitsStyle = .short
        return formatter
    }()

    static func parse(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return fractional.date(from: iso) ?? plain.date(from: iso)
    }

    static func ago(_ iso: String?) -> String {
        guard let date = parse(iso) else { return "—" }
        return ago(date)
    }

    static func ago(_ date: Date) -> String {
        Date().timeIntervalSince(date) < 60 ? "только что" : relative.localizedString(for: date, relativeTo: Date())
    }

    private static func formatter(_ format: String, template: Bool = false) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        if template { formatter.setLocalizedDateFormatFromTemplate(format) } else { formatter.dateFormat = format }
        return formatter
    }
    private static let time = formatter("HH:mm")
    private static let day = formatter("d MMM", template: true)
    private static let dayTime = formatter("d MMMM 'в' HH:mm")

    // Сброс лимита: «до 14:00» сегодня, «до завтра 14:00», дальше — «до 31 окт.»
    static func resetShort(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return "до \(time.string(from: date))" }
        if Calendar.current.isDateInTomorrow(date) { return "до завтра \(time.string(from: date))" }
        return "до \(day.string(from: date))"
    }

    static func resetFull(_ date: Date) -> String { dayTime.string(from: date) }

    private static let dayTimePlain = formatter("d MMMM HH:mm")
    private static let dayShortTime = formatter("d MMM HH:mm", template: true)

    // «11:09» сегодня, иначе «29 окт. 11:09»
    static func moment(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? time.string(from: date) : dayShortTime.string(from: date)
    }

    static func momentFull(_ date: Date) -> String { dayTimePlain.string(from: date) }

    // Явная локаль: formatted() берёт язык системы, а не окна
    static let russian = Locale(identifier: "ru_RU")

    static func format(_ date: Date, date dateStyle: Date.FormatStyle.DateStyle = .abbreviated, time: Date.FormatStyle.TimeStyle = .shortened) -> String {
        date.formatted(Date.FormatStyle(date: dateStyle, time: time, locale: russian))
    }
}

enum CLI {
    // Колбэк приходит на главном потоке: (успех, вывод)
    static func run(_ arguments: [String], completion: ((Bool, String) -> Void)? = nil) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: Paths.cli)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.terminationHandler = { finished in
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let success = finished.terminationStatus == 0
            DispatchQueue.main.async { completion?(success, output.trimmingCharacters(in: .whitespacesAndNewlines)) }
        }
        do {
            try process.run()
        } catch {
            completion?(false, "Не удалось запустить \(Paths.cli): \(error.localizedDescription)")
        }
    }
}

func readJSON<T: Decodable>(_ type: T.Type, _ url: URL) -> T? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
}

var workerIsRunning: Bool {
    // status.json может остаться в phase=running после падения, поэтому живость проверяем по pid
    guard let text = try? String(contentsOf: Paths.pid, encoding: .utf8),
          let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

// Проход завис, если сервис 15 минут не обновлял пульс: его останавливает только заблокированный процесс (git, сеть).
// since — время последней записи в журнале: по нему видно, на каком шаге встал проход
func workerStall() -> (since: Date, minutes: Int)? {
    func modified(_ url: URL) -> Date? { (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date }
    guard workerIsRunning, let beat = modified(Paths.heartbeat) else { return nil }
    let idle = Date().timeIntervalSince(beat)
    guard idle > 15 * 60 else { return nil }
    return (min(modified(Paths.log) ?? beat, beat), Int(idle / 60))
}

func minutesText(_ minutes: Int) -> String {
    minutes >= 60 ? "\(minutes / 60) ч \(minutes % 60) мин" : "\(minutes) мин"
}

var workerIsPaused: Bool { FileManager.default.fileExists(atPath: Paths.paused.path) }

var fixIsRunning: Bool {
    guard let text = try? String(contentsOf: Paths.fixPid, encoding: .utf8),
          let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

// Открытые PR, текущий коммит которых ещё не проверила хотя бы одна модель фонового ревью.
// Черновики, ветки не по задачам и репозитории на паузе фон не ревьюит — их не считаем, иначе число никогда бы не обнулялось
func unreviewedPrs(config: AppConfig, state: WorkerState, snapshots: [String: PrSnapshot]) -> Int {
    let agents = config.agents.filter { $0.value.isAuto }.map(\.key)
    guard !agents.isEmpty else { return 0 }
    return config.repos.filter { !$0.isPaused }.reduce(0) { total, repo in
        let prs = snapshots[repo.slug]?.prs.filter { !$0.draft && config.isTaskBranch($0.source) } ?? []
        return total + prs.filter { pr in
            let reviewed = state.repos?[repo.slug]?.prs[String(pr.id)]?.reviewed ?? [:]
            return agents.contains { reviewed[$0] != pr.head }
        }.count
    }
}

func readJSONLines<T: Decodable>(_ type: T.Type, _ url: URL) -> [T] {
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
    let decoder = JSONDecoder()
    return text.split(separator: "\n").compactMap { try? decoder.decode(type, from: Data($0.utf8)) }
}

// Отсутствующий файл — обычное дело (сервис его ещё не создал), а не прочитавшийся надо показать: иначе вкладка молча пустеет
enum ReadOutcome<T> {
    case missing
    case loaded(T)
    case failed(String)

    func value(missing: T?, previous: T?) -> T? {
        switch self {
        case .loaded(let value): value
        case .missing: missing
        case .failed: previous
        }
    }
}

func readOutcome<T: Decodable>(_ type: T.Type, _ url: URL) -> ReadOutcome<T> {
    let data: Data
    do {
        data = try Data(contentsOf: url)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
        return .missing
    } catch let error as CocoaError where error.code == .fileReadNoPermission {
        return .failed("нет доступа")
    } catch {
        return .failed("ошибка чтения")
    }
    guard let value = try? JSONDecoder().decode(type, from: data) else { return .failed("ошибка формата") }
    return .loaded(value)
}

struct UnreadableFile: Identifiable {
    let name: String
    let url: URL
    let reason: String
    var id: String { name }
}

func loadSnapshot(_ slug: String) -> PrSnapshot? {
    readJSON(PrSnapshot.self, Paths.prs.appendingPathComponent("\(slug).json"))
}

func openFindings(state: WorkerState, snapshots: [String: PrSnapshot]) -> [OpenFinding] {
    var result: [OpenFinding] = []
    for (repo, repoState) in state.repos ?? [:] {
        guard let prs = snapshots[repo]?.prs else { continue }
        for pr in prs {
            for finding in repoState.prs[String(pr.id)]?.findings ?? [] where finding.isWaiting {
                result.append(OpenFinding(repo: repo, pr: pr, finding: finding))
            }
        }
    }
    return result.sorted { ($0.finding.level, $1.finding.at) < ($1.finding.level, $0.finding.at) }
}

@MainActor
final class AppModel: ObservableObject {
    static let agentOrder = ["claude", "codex", "cursor"]
    // Модели, чей лимит сервис опрашивает (refreshLimits в limits.mjs); остальные сообщают его только в своих запусках
    static let polledLimitAgents: Set<String> = ["codex", "cursor"]

    @Published private(set) var config = AppConfig(repos: [], agents: [:])
    @Published private(set) var snapshots: [String: PrSnapshot] = [:]
    @Published private(set) var state = WorkerState(repos: nil)
    @Published private(set) var status: Status?
    @Published private(set) var queued: Set<String> = []
    @Published private(set) var isRunning = false
    @Published private(set) var isPaused = false
    @Published private(set) var stats: [StatEntry] = []
    @Published private(set) var outcomes: [Outcome] = []
    @Published private(set) var skips: [Skip] = []
    @Published private(set) var fixLog: [FixRecord] = []
    @Published private(set) var archLog: [ArchRecord] = []
    @Published private(set) var qaLog: [QaRecord] = []
    @Published private(set) var spendLog: [SpendRecord] = []
    @Published private(set) var fixes: [String: FixState] = [:]
    @Published private(set) var logEntries: [LogEntry] = []
    @Published private(set) var memory: [String: [Lesson]] = [:]
    @Published private(set) var learning: Set<String> = []
    @Published var learnResults: [String: String] = [:]
    @Published private(set) var cloned: Set<String> = []
    @Published private(set) var cloning: Set<String> = []
    @Published var cloneErrors: [String: String] = [:]
    @Published private(set) var syncing = false
    @Published var syncError: String?

    private var timer: Timer?
    private var statsModified: Date?
    private var outcomesModified: Date?
    private var skipsModified: Date?
    private var fixLogModified: Date?
    private var archLogModified: Date?
    private var qaLogModified: Date?
    private var spendModified: Date?
    private var logModified: Date?

    var agentIds: [String] {
        config.agents.keys.sorted { (Self.agentOrder.firstIndex(of: $0) ?? 99, $0) < (Self.agentOrder.firstIndex(of: $1) ?? 99, $1) }
    }

    func agentName(_ id: String) -> String { config.agents[id]?.shortName ?? id }

    func start() {
        reload()
        if needsSync { sync() }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    // Файлы, которые не прочитались два обновления подряд: один сбой бывает и при записи файла сервисом
    @Published private(set) var unreadableFiles: [UnreadableFile] = []
    private var readFailures: [String: (url: URL, reason: String, count: Int)] = [:]
    private var failedThisReload: [String: (url: URL, reason: String)] = [:]

    private func track<T: Decodable>(_ type: T.Type, _ url: URL, name: String) -> ReadOutcome<T> {
        let outcome = readOutcome(type, url)
        if case .failed(let reason) = outcome { failedThisReload[name] = (url, reason) }
        return outcome
    }

    private func finishTracking() {
        readFailures = failedThisReload.reduce(into: [:]) { result, item in
            result[item.key] = (item.value.url, item.value.reason, (readFailures[item.key]?.count ?? 0) + 1)
        }
        unreadableFiles = readFailures.filter { $0.value.count >= 2 }.sorted { $0.key < $1.key }
            .map { UnreadableFile(name: $0.key, url: $0.value.url, reason: $0.value.reason) }
        failedThisReload = [:]
    }

    // При сбое чтения остаётся прошлое значение: баннер говорит, что на вкладках последние прочитанные данные
    func reload() {
        if case .loaded(let loaded) = track(AppConfig.self, Paths.config, name: "config.json") { config = loaded }
        status = track(Status.self, Paths.status, name: "status.json").value(missing: nil, previous: status)
        tokens = TokenInfo.load(config)
        state = track(WorkerState.self, Paths.state, name: "state.json").value(missing: WorkerState(repos: nil), previous: state) ?? WorkerState(repos: nil)
        isRunning = workerIsRunning
        isPaused = workerIsPaused
        var loaded: [String: PrSnapshot] = [:]
        for repo in config.repos {
            loaded[repo.slug] = track(PrSnapshot.self, Paths.prs.appendingPathComponent("\(repo.slug).json"), name: "prs/\(repo.slug).json")
                .value(missing: nil, previous: snapshots[repo.slug])
        }
        snapshots = loaded
        let memoryFiles = config.repos.map { ($0.slug, readMemoryFile($0.slug)) }
        memory = Dictionary(uniqueKeysWithValues: memoryFiles.map { ($0.0, $0.1.lessons) })
        memoryBroken = Dictionary(uniqueKeysWithValues: memoryFiles.compactMap { slug, file in file.broken.map { (slug, $0) } })
        // Новый репозиторий (и первый запуск этой версии) начинают с «всё просмотрено» — иначе все старые правила разом стали бы новыми
        let unseen = config.repos.map(\.slug).filter { memorySeenAt[$0] == nil }
        if !unseen.isEmpty {
            for slug in unseen { memorySeenAt[slug] = Date() }
            UserDefaults.standard.set(memorySeenAt, forKey: Self.memorySeenKey)
        }
        cloned = Set(config.repos.map(\.slug).filter {
            FileManager.default.fileExists(atPath: Paths.clone($0).appendingPathComponent(".git").path)
        })
        let files = (try? FileManager.default.contentsOfDirectory(at: Paths.queue, includingPropertiesForKeys: nil)) ?? []
        queued = Set(files.compactMap { readJSON(QueuedReview.self, $0) }.map { key($0.repo, $0.pr, $0.agent) })
        reloadStats()
        reloadFixes()
        reloadArchs()
        reloadQas()
        limits = track([String: AgentLimit].self, Paths.data.appendingPathComponent("limits.json"), name: "limits.json").value(missing: [:], previous: limits) ?? [:]
        backlog = track(BacklogFile.self, Paths.backlog, name: "backlog.json").value(missing: BacklogFile(items: []), previous: BacklogFile(items: backlog))?.items ?? []
        backlogJob = readJSON(BacklogJob.self, Paths.backlogJob)
        backlogScan = readJSON(BacklogScan.self, Paths.backlogScan)
        finishTracking()
    }

    // jsonl-файлы только растут, поэтому перечитываем их, лишь когда файл изменился
    private func reloadStats() {
        if let entries = reloadIfModified(Paths.stats, &statsModified, StatEntry.self) { stats = entries }
        if let entries = reloadIfModified(Paths.outcomes, &outcomesModified, Outcome.self) { outcomes = entries }
        if let entries = reloadIfModified(Paths.skips, &skipsModified, Skip.self) { skips = entries }
        if let entries = reloadIfModified(Paths.fixLog, &fixLogModified, FixRecord.self) { fixLog = entries }
        if let entries = reloadIfModified(Paths.archLog, &archLogModified, ArchRecord.self) { archLog = entries }
        if let entries = reloadIfModified(Paths.qaLog, &qaLogModified, QaRecord.self) { qaLog = entries }
        if let entries = reloadIfModified(Paths.spend, &spendModified, SpendRecord.self) { spendLog = entries }
        reloadLog()
    }

    private static let logLimit = 256 * 1024

    // Читаем только хвост лога: файл ротируется на 5 МБ, а окну хватает последних записей
    private func reloadLog() {
        let modified = (try? FileManager.default.attributesOfItem(atPath: Paths.log.path))?[.modificationDate] as? Date
        guard modified != logModified, let handle = try? FileHandle(forReadingFrom: Paths.log) else { return }
        logModified = modified
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(Self.logLimit) ? size - UInt64(Self.logLimit) : 0
        try? handle.seek(toOffset: start)
        let data = handle.readDataToEndOfFile()

        var entries: [LogEntry] = []
        // id записи — её смещение в файле: номер в хвосте съезжал бы с каждой новой записью, и раскрытой оказывалась бы другая
        var current: (id: Int, date: Date?, lines: [String])?
        func flush() {
            guard let current else { return }
            var message = current.lines.joined(separator: "\n")
            let marked = message.hasPrefix("ERROR ")
            if marked { message.removeFirst("ERROR ".count) }
            // Записи до появления метки ERROR узнаём по тексту
            let isError = marked || message.contains("Error:") || message.contains(": ошибка") || message.hasPrefix("ошибка")
            entries.append(LogEntry(id: current.id, date: current.date, message: message, isError: isError))
        }
        var offset = Int(start)
        for bytes in data.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: false) {
            let line = String(decoding: bytes, as: UTF8.self)
            // Запись начинается с ISO-времени; строки без него — продолжение (стек, вывод git)
            if let space = line.firstIndex(of: " "), let date = Dates.parse(String(line[..<space])) {
                flush()
                current = (offset, date, [String(line[line.index(after: space)...])])
            } else if current != nil, !line.isEmpty {
                current?.lines.append(line)
            }
            offset += bytes.count + 1
        }
        flush()
        logEntries = entries.reversed()
    }

    private func reloadIfModified<T: Decodable>(_ url: URL, _ lastModified: inout Date?, _ type: T.Type) -> [T]? {
        let modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        guard modified != lastModified else { return nil }
        lastModified = modified
        return readJSONLines(type, url)
    }

    func importantFindings(repo: String, pr: Int) -> [TrackedFinding] {
        (state.repos?[repo]?.prs[String(pr)]?.findings ?? []).filter { $0.isImportant && $0.isWaiting }
    }

    var waitingFindings: [WaitingFinding] {
        (state.repos ?? [:]).flatMap { slug, repo in
            repo.prs.values.flatMap { $0.findings ?? [] }.filter(\.isWaiting).map { WaitingFinding(repo: slug, finding: $0) }
        }
    }

    // repo = nil — по всем репозиториям
    func openFindingCount(repo slug: String? = nil) -> [String: Int] {
        var counts: [String: Int] = [:]
        for (name, repo) in state.repos ?? [:] where slug == nil || name == slug {
            for pr in repo.prs.values {
                for finding in pr.findings ?? [] where finding.isWaiting { counts[finding.agent, default: 0] += 1 }
            }
        }
        return counts
    }

    private func key(_ repo: String, _ pr: Int, _ agent: String) -> String { "\(repo)#\(pr)#\(agent)" }

    // Список PR обновляется при открытии панели, но не чаще раза в минуту: каждое обновление —
    // запрос списка плюс по запросу на каждый PR с комментариями, а у токена Bitbucket лимит запросов в час
    private static let syncOnOpenAfter: TimeInterval = 60

    private var needsSync: Bool {
        config.repos.contains { repo in
            guard let fetched = Dates.parse(snapshots[repo.slug]?.fetchedAt) else { return true }
            return Date().timeIntervalSince(fetched) > Self.syncOnOpenAfter
        }
    }

    // Исчерпанный лимит до сброса сам не восстанавливается, поэтому давность данных не важна — только что сброс впереди
    func availability(_ agent: String) -> AgentAvailability {
        if let limit = limits[agent], limit.usedPercent >= 100,
           let resetsAt = Dates.parse(limit.resetsAt), resetsAt > Date() {
            return .limitExhausted(resetsAt: resetsAt, updatedAt: Dates.parse(limit.at))
        }
        return config.agents[agent]?.isAuto == false ? .manualOnly : .available
    }

    func skipReason(repo: String, pr: PullRequest, agent: String) -> String? {
        guard let mark = state.repos?[repo]?.prs[String(pr.id)]?.skipped?[agent], mark.head == pr.head else { return nil }
        return mark.reason
    }

    func reviewState(repo: String, pr: PullRequest, agent: String) -> ReviewState {
        if isRunning, status?.reviews.contains(where: { $0.repo == repo && $0.pr == pr.id && $0.agent == agent }) == true { return .running }
        if queued.contains(key(repo, pr.id, agent)) { return .queued }
        guard let head = state.repos?[repo]?.prs[String(pr.id)]?.reviewed[agent] else { return .none }
        return head == pr.head ? .done : .stale
    }

    // Состояние «идёт» без живого процесса — след прерванного запуска: показываем как сбой, чтобы кнопка не крутилась вечно
    private func reloadFixes() {
        let files = (try? FileManager.default.contentsOfDirectory(at: Paths.fixStates, includingPropertiesForKeys: nil)) ?? []
        let alive = (try? String(contentsOf: Paths.fixPid, encoding: .utf8))
            .flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .map { kill($0, 0) == 0 || errno == EPERM } ?? false
        var loaded: [String: FixState] = [:]
        for file in files {
            guard let fix = readJSON(FixState.self, file) else { continue }
            if fix.isActive && !alive && fix.state == "running" {
                loaded["\(fix.repo)#\(fix.pr)"] = FixState(repo: fix.repo, pr: fix.pr, state: "failed", step: nil, error: "доработка прервана", report: fix.report, startedAt: fix.startedAt, finishedAt: nil, steps: fix.steps, activity: nil, activityAt: nil, mode: fix.mode)
            } else {
                loaded["\(fix.repo)#\(fix.pr)"] = fix
            }
        }
        fixes = loaded
    }

    func fix(repo: String, pr: Int) -> FixState? { fixes["\(repo)#\(pr)"] }

    func requestFix(repo: String, pr: Int, rebase: Bool = false) {
        fixes["\(repo)#\(pr)"] = FixState(repo: repo, pr: pr, state: "queued", step: nil, error: nil, report: nil, startedAt: nil, finishedAt: nil, steps: nil, activity: nil, activityAt: nil, mode: rebase ? "rebase" : "fix")
        CLI.run(["fix", "--repo", repo, "--pr", String(pr)] + (rebase ? ["--rebase"] : [])) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    // Только этот PR: его заявка снимается из очереди или его доработка прерывается; очередь других PR идёт дальше
    func stopFix(repo: String, pr: Int) {
        CLI.run(["fix", "stop", "--repo", repo, "--pr", String(pr)]) { _, _ in self.reload() }
    }

    // MARK: Архитектурное ревью

    @Published private(set) var archs: [String: ArchState] = [:]

    var archAgentName: String { agentName(config.arch?.agent ?? "claude") }

    // Как у доработки: «идёт» без живого процесса — след прерванного запуска
    private func reloadArchs() {
        let files = (try? FileManager.default.contentsOfDirectory(at: Paths.archStates, includingPropertiesForKeys: nil)) ?? []
        let alive = (try? String(contentsOf: Paths.archPid, encoding: .utf8))
            .flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .map { kill($0, 0) == 0 || errno == EPERM } ?? false
        var loaded: [String: ArchState] = [:]
        for file in files where file.pathExtension == "json" {
            guard let arch = readJSON(ArchState.self, file) else { continue }
            loaded["\(arch.repo)#\(arch.pr)"] = arch.state == "running" && !alive ? arch.interrupted() : arch
        }
        archs = loaded
    }

    func arch(repo: String, pr: Int) -> ArchState? { archs["\(repo)#\(pr)"] }

    func requestArch(repo: String, pr: Int) {
        let previous = arch(repo: repo, pr: pr)
        archs["\(repo)#\(pr)"] = ArchState(repo: repo, pr: pr, state: "queued", activity: nil, error: nil, startedAt: nil, finishedAt: nil, result: previous?.result)
        CLI.run(["arch", "--repo", repo, "--pr", String(pr)]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    func stopArch(repo: String, pr: Int) {
        CLI.run(["arch", "stop", "--repo", repo, "--pr", String(pr)]) { _, _ in self.reload() }
    }

    func copyArchMarkdown(repo: String, pr: Int, completion: @escaping (Bool) -> Void) {
        CLI.run(["arch", "show", "--repo", repo, "--pr", String(pr)]) { success, output in
            if success {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(output + "\n", forType: .string)
            } else {
                self.syncError = output
            }
            completion(success)
        }
    }

    // MARK: Тестирование в браузере

    @Published private(set) var qas: [String: QaState] = [:]
    // Отказ CLI (например, «нет плана») показывается в листе тестирования: плашка обзора скрыта под ним
    @Published var qaErrors: [String: String] = [:]

    // Очередь разбирает отдельный процесс; «идёт» без него — след прерванного запуска
    private func reloadQas() {
        let files = (try? FileManager.default.contentsOfDirectory(at: Paths.qaStates, includingPropertiesForKeys: nil)) ?? []
        let alive = (try? String(contentsOf: Paths.qaPid, encoding: .utf8))
            .flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .map { kill($0, 0) == 0 || errno == EPERM } ?? false
        var loaded: [String: QaState] = [:]
        for file in files where file.pathExtension == "json" {
            guard let qa = readJSON(QaState.self, file) else { continue }
            let started = qa.state == "planning" || qa.state == "running"
            loaded["\(qa.repo)#\(qa.pr)"] = started && !alive ? qa.interrupted() : qa
        }
        // Пока CLI ставит заявку, файл ещё старый: не даём перечитыванию откатить показанную очередь
        for (key, local) in qas where local.isQueued && pendingQa.contains(key) {
            loaded[key] = local
        }
        qas = loaded
    }

    private var pendingQa: Set<String> = []

    func qa(repo: String, pr: Int) -> QaState? { qas["\(repo)#\(pr)"] }

    func canTest(repo: String) -> Bool { repo == config.qaFrontend }

    private func queueQa(repo: String, pr: Int, state: String, _ arguments: [String]) {
        let key = "\(repo)#\(pr)"
        qaErrors[key] = nil
        var local = qas[key] ?? QaState(repo: repo, pr: pr, state: state, note: nil, title: nil, url: nil, planHead: nil, plan: nil, run: nil, startedAt: nil, finishedAt: nil, usage: nil)
        local.state = state
        local.error = nil
        qas[key] = local
        pendingQa.insert(key)
        CLI.run(arguments) { success, output in
            self.pendingQa.remove(key)
            if !success { self.qaErrors[key] = output }
            self.reload()
        }
    }

    func requestQaPlan(repo: String, pr: Int, note: String) {
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        queueQa(repo: repo, pr: pr, state: "planning-queued", ["qa", "plan", "--repo", repo, "--pr", String(pr)] + (note.isEmpty ? [] : ["--note", note]))
    }

    // skip — id кейсов плана, с которых сняли галочку; extra — свои кейсы, по одному на строку
    func requestQaRun(repo: String, pr: Int, skip: [String], extra: [String], note: String) {
        var arguments = ["qa", "run", "--repo", repo, "--pr", String(pr)]
        if !skip.isEmpty { arguments += ["--skip", skip.joined(separator: ",")] }
        for item in extra { arguments += ["--add", item] }
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !note.isEmpty { arguments += ["--note", note] }
        queueQa(repo: repo, pr: pr, state: "run-queued", arguments)
    }

    func stopQa(repo: String, pr: Int) {
        CLI.run(["qa", "stop", "--repo", repo, "--pr", String(pr)]) { _, _ in self.reload() }
    }

    @Published private(set) var qaSaving: Set<String> = []

    func saveQaTests(repo: String, pr: Int) {
        let key = "\(repo)#\(pr)"
        qaSaving.insert(key)
        qaErrors[key] = nil
        CLI.run(["qa", "save", "--repo", repo, "--pr", String(pr)]) { success, output in
            self.qaSaving.remove(key)
            if !success { self.qaErrors[key] = output }
            self.reload()
        }
    }

    func copyQaReport(repo: String, pr: Int, plan: Bool, completion: @escaping (Bool) -> Void) {
        CLI.run(["qa", "show", "--repo", repo, "--pr", String(pr)] + (plan ? ["--plan"] : [])) { success, output in
            if success {
                copyToPasteboard(output + "\n")
            } else {
                self.qaErrors["\(repo)#\(pr)"] = output
            }
            completion(success)
        }
    }

    func requestReview(repo: String, pr: Int, agent: String) {
        // Иконка начинает крутиться сразу, не дожидаясь, пока CLI положит заявку в очередь
        queued.insert(key(repo, pr, agent))
        CLI.run(["review", "--repo", repo, "--pr", String(pr), "--agent", agent]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    func sync() {
        guard !syncing else { return }
        syncing = true
        CLI.run(["sync"]) { success, output in
            self.syncing = false
            self.syncError = success ? nil : output
            self.reload()
        }
    }

    // Локальная копия для быстрого первого клона ищется рядом с копиями уже подключённых репозиториев
    func addRepo(_ ref: String, completion: @escaping (String?) -> Void) {
        let arguments = ["repo", "add", ref, "--json"]
        CLI.run(arguments) { success, output in
            guard success, let repo = try? JSONDecoder().decode(RepoConfig.self, from: Data(output.utf8)) else {
                completion(output.isEmpty ? "Не удалось подключить репозиторий" : output)
                return
            }
            completion(nil)
            self.reload()
            self.cloneRepo(repo.slug)
        }
    }

    func cloneRepo(_ slug: String) {
        cloning.insert(slug)
        cloneErrors[slug] = nil
        CLI.run(["repo", "clone", slug]) { success, output in
            self.cloning.remove(slug)
            if !success { self.cloneErrors[slug] = output }
            self.reload()
        }
    }

    func runNow() {
        CLI.run(["run-now"]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    func stopReview() {
        CLI.run(["stop"]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    // pause в CLI заодно прерывает идущее ревью
    func setServicePaused(_ paused: Bool) {
        isPaused = paused
        CLI.run([paused ? "pause" : "resume"]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    var intervalMinutes: Int { config.intervalMinutes ?? 15 }

    // Воркер просыпается раз в минуту, поэтому новый интервал действует сразу, без переустановки
    func setBranchPattern(_ pattern: String) {
        CLI.run(["branches", pattern]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    func setPollInterval(_ minutes: Int) {
        CLI.run(["interval", String(minutes)]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    var nextPassAt: Date? {
        guard !isPaused, !isRunning else { return nil }
        guard let last = Dates.parse(status?.lastPassAt) else { return Date() }
        return last.addingTimeInterval(TimeInterval(intervalMinutes * 60))
    }

    func setIgnored(_ pattern: String, _ ignored: Bool) {
        CLI.run(["ignore", ignored ? "add" : "remove", pattern]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    // Разбор истории идёт минуты: результат — последняя строка вывода CLI («Правил в памяти: было …, стало …»)
    func learnHistory(_ slug: String, prs: Int) {
        learning.insert(slug)
        learnResults[slug] = nil
        CLI.run(["memory", "learn", slug, "--prs", String(prs)]) { success, output in
            self.learning.remove(slug)
            self.learnResults[slug] = success ? output.split(separator: "\n").last.map(String.init) : output
            self.reload()
        }
    }

    func addLesson(_ slug: String, _ text: String) {
        CLI.run(["memory", "add", slug, text]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    var memoryLimit: Int { config.memory?.maxLessons ?? 60 }

    // Что из памяти уже просмотрено и до какого момента закрыт баннер — личное, поэтому в настройках приложения, а не у сервиса
    private static let memorySeenKey = "memorySeenAt"
    private static let memoryBannerKey = "memoryBannerClosedAt"
    @Published private var memorySeenAt = UserDefaults.standard.dictionary(forKey: AppModel.memorySeenKey) as? [String: Date] ?? [:]
    @Published private var memoryBannerClosedAt = UserDefaults.standard.dictionary(forKey: AppModel.memoryBannerKey) as? [String: Date] ?? [:]

    // Свои правила новыми не считаются: их и так видели, когда добавляли
    func newLessons(_ slug: String) -> [Lesson] {
        guard let seen = memorySeenAt[slug] else { return [] }
        return (memory[slug] ?? []).filter { $0.manual != true && (Dates.parse($0.at) ?? .distantPast) > seen }
    }

    // Баннер закрывается, а подсветка в настройках остаётся до просмотра памяти; следующее новое правило снова покажет баннер
    var newMemoryBanners: [(slug: String, lessons: [Lesson])] {
        config.repos.compactMap { repo in
            let fresh = newLessons(repo.slug)
            let closed = memoryBannerClosedAt[repo.slug] ?? .distantPast
            guard fresh.contains(where: { (Dates.parse($0.at) ?? .distantPast) > closed }) else { return nil }
            return (repo.slug, fresh)
        }
    }

    func closeMemoryBanner(_ slug: String) {
        memoryBannerClosedAt[slug] = Date()
        UserDefaults.standard.set(memoryBannerClosedAt, forKey: Self.memoryBannerKey)
    }

    func markMemorySeen(_ slug: String) {
        memorySeenAt[slug] = Date()
        UserDefaults.standard.set(memorySeenAt, forKey: Self.memorySeenKey)
    }

    // Репозитории, где память заполнена на 80% и больше: пора просмотреть правила, пока не начали вытесняться правила
    var memoryNearlyFull: [(slug: String, count: Int)] {
        config.repos.compactMap { repo in
            let count = memory[repo.slug]?.count ?? 0
            return count * 5 >= memoryLimit * 4 ? (repo.slug, count) : nil
        }
    }

    func updateLesson(_ slug: String, _ id: String, _ text: String) {
        CLI.run(["memory", "edit", slug, id, text]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    func removeLesson(_ slug: String, _ id: String) {
        memory[slug]?.removeAll { $0.id == id }
        CLI.run(["memory", "remove", slug, id]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    // MARK: Разбор памяти

    @Published private(set) var memoryUsage: [String: MemoryUsage] = [:]
    @Published private(set) var memoryPlans: [String: MemoryPlan] = [:]
    // Когда начался идущий разбор: лист показывает, сколько он уже длится
    @Published private(set) var memoryReviewing: [String: Date] = [:]
    @Published private(set) var memoryApplying: Set<String> = []
    @Published var memoryReviewErrors: [String: String] = [:]
    @Published var memoryApplied: [String: String] = [:]
    @Published private(set) var memoryHistory: [String: [MemoryChange]] = [:]
    @Published private(set) var memoryRestoring: Set<String> = []
    @Published var memoryHistoryErrors: [String: String] = [:]
    @Published var memoryRestored: [String: String] = [:]

    static func hasMemoryPlan(_ slug: String) -> Bool { FileManager.default.fileExists(atPath: Paths.memoryPlan(slug).path) }

    // Срабатывания считает сервис: склеенное правило наследует счёт исходных, а это знает только он
    func loadMemoryUsage(_ slug: String) {
        CLI.run(["memory", "list", slug, "--json"]) { success, output in
            guard success, let usage = try? JSONDecoder().decode(MemoryUsage.self, from: Data(output.utf8)) else { return }
            self.memoryUsage[slug] = usage
        }
    }

    // Признак outdated тоже считает сервис, поэтому сохранённый план читаем через CLI, а не из файла
    func loadMemoryPlan(_ slug: String) {
        CLI.run(["memory", "review", slug, "--show", "--json"]) { success, output in
            guard success else { return }
            self.memoryPlans[slug] = try? JSONDecoder().decode(MemoryPlan.self, from: Data(output.utf8))
        }
    }

    // Разбор идёт 1–3 минуты; состояние в модели, поэтому лист можно закрыть и открыть снова
    func reviewMemory(_ slug: String) {
        guard memoryReviewing[slug] == nil else { return }
        memoryReviewing[slug] = Date()
        memoryReviewErrors[slug] = nil
        memoryApplied[slug] = nil
        CLI.run(["memory", "review", slug, "--json"]) { success, output in
            self.memoryReviewing[slug] = nil
            if !success { self.memoryReviewErrors[slug] = output }
            self.loadMemoryPlan(slug)
        }
    }

    func applyMemoryPlan(_ slug: String) {
        guard !memoryApplying.contains(slug) else { return }
        memoryApplying.insert(slug)
        memoryReviewErrors[slug] = nil
        CLI.run(["memory", "apply", slug]) { success, output in
            self.memoryApplying.remove(slug)
            if success {
                self.memoryPlans[slug] = nil
                self.memoryApplied[slug] = output.split(separator: "\n").last.map(String.init)
            } else {
                self.memoryReviewErrors[slug] = output
                self.loadMemoryPlan(slug)
            }
            self.reload()
            self.loadMemoryUsage(slug)
            self.loadMemoryHistory(slug)
        }
    }

    func loadMemoryHistory(_ slug: String) {
        CLI.run(["memory", "history", slug, "--json"]) { success, output in
            guard success, let history = try? JSONDecoder().decode([MemoryChange].self, from: Data(output.utf8)) else { return }
            self.memoryHistory[slug] = history
        }
    }

    // Можно ли откатить разбор, решает сервис: он сверяет память с той, что осталась после разбора, и откажет, если её меняли
    func restoreMemory(_ slug: String) {
        guard !memoryRestoring.contains(slug) else { return }
        memoryRestoring.insert(slug)
        memoryHistoryErrors[slug] = nil
        memoryRestored[slug] = nil
        CLI.run(["memory", "restore", slug]) { success, output in
            self.memoryRestoring.remove(slug)
            if success {
                self.memoryRestored[slug] = output.split(separator: "\n").last.map(String.init)
            } else {
                self.memoryHistoryErrors[slug] = output
            }
            self.reload()
            self.loadMemoryHistory(slug)
            self.loadMemoryUsage(slug)
            self.loadMemoryPlan(slug)
        }
    }

    func discardMemoryPlan(_ slug: String) {
        memoryPlans[slug] = nil
        memoryReviewErrors[slug] = nil
        CLI.run(["memory", "review", slug, "--discard"]) { success, output in
            if !success { self.memoryReviewErrors[slug] = output }
        }
    }

    // MARK: Бэклог

    @Published private(set) var backlog: [BacklogItem] = []
    @Published private(set) var backlogBusy: Set<String> = []
    @Published var backlogError: String?

    var backlogWaiting: Int { backlog.filter(\.isOpen).count }

    // action — filed, drop или reopen; text — номер задачи или причина отклонения
    func setBacklogStatus(_ id: String, _ action: String, _ text: String = "") {
        backlogBusy.insert(id)
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        CLI.run(["backlog", action, id] + (text.isEmpty ? [] : [text])) { success, output in
            self.backlogBusy.remove(id)
            self.backlogError = success ? nil : output
            self.reload()
        }
    }

    @Published private(set) var backlogJob: BacklogJob?
    @Published private(set) var backlogScan: BacklogScan?

    var backlogStale: [BacklogItem] { backlog.filter(\.isStale) }

    // kind — learn или triage; CLI запускает задачу отдельным процессом и сразу возвращается
    func startBacklogJob(_ kind: String) {
        CLI.run(["backlog", kind, "--background"]) { success, output in
            self.backlogError = success ? nil : output
            self.reload()
        }
    }

    func stopBacklogJob() {
        CLI.run(["backlog", "stop"]) { _, _ in self.reload() }
    }

    func closeStaleBacklog() {
        backlogBusy.formUnion(backlogStale.map(\.id))
        CLI.run(["backlog", "close-stale"]) { success, output in
            self.backlogBusy.removeAll()
            self.backlogError = success ? nil : output
            self.reload()
        }
    }

    func exportBacklog(all: Bool, completion: @escaping (String) -> Void) {
        CLI.run(["backlog", "export"] + (all ? ["--all"] : [])) { success, output in
            if success { completion(output) } else { self.backlogError = output }
        }
    }

    @Published private(set) var cursorModels = CodexModel.loadCursor()
    @Published private(set) var limits: [String: AgentLimit] = [:]
    // Репозитории с повреждённым файлом памяти и причина: ревью идёт без правил, сервис не пишет в такой файл
    @Published private(set) var memoryBroken: [String: String] = [:]

    // MARK: Токены

    @Published private(set) var tokens: [TokenInfo] = []
    private static let tokenBannerKey = "tokenBannerClosedAt"
    @Published private var tokenBannerClosedAt = UserDefaults.standard.dictionary(forKey: AppModel.tokenBannerKey) as? [String: Date] ?? [:]

    // Закрытое предупреждение возвращается на следующий день; об истёкшем токене — не закрывается
    var tokenBanners: [TokenInfo] {
        tokens.filter { token in
            token.isExpired || (token.isExpiring && !Calendar.current.isDateInToday(tokenBannerClosedAt[token.id] ?? .distantPast))
        }
    }

    func closeTokenBanner(_ id: String) {
        tokenBannerClosedAt[id] = Date()
        UserDefaults.standard.set(tokenBannerClosedAt, forKey: Self.tokenBannerKey)
    }

    func setTokenLifetime(_ id: String, days: Int) {
        CLI.run(["token", id, days == 0 ? "never" : String(days)]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    private var limitsRequestedAt: Date?

    // Codex и Cursor отдают лимиты по сети, поэтому спрашиваем не чаще раза в 5 минут; Claude пишет их сам при каждом запуске.
    // Свежесть — по полю at каждой модели: дата изменения файла не годится, его перезаписывает каждый запуск Claude.
    // Свой таймер попыток — чтобы модель, которая не отдаёт лимит, не дёргала сеть при каждом открытии настроек
    func refreshLimits() {
        let isStale = { (id: String) in
            Dates.parse(self.limits[id]?.at).map { Date().timeIntervalSince($0) > 300 } ?? true
        }
        guard Self.polledLimitAgents.contains(where: { config.agents[$0] != nil && isStale($0) }),
              limitsRequestedAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true else { return }
        limitsRequestedAt = Date()
        CLI.run(["limits"]) { _, _ in self.reload() }
    }

    // Список моделей Cursor зависит от аккаунта и тянется из сети, поэтому обновляем его не чаще раза в сутки
    func refreshCursorModels() {
        let file = Paths.data.appendingPathComponent("cursor-models.json")
        let modified = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
        guard config.agents["cursor"] != nil, modified.map({ Date().timeIntervalSince($0) > 86_400 }) ?? true else { return }
        CLI.run(["agent", "models", "cursor"]) { _, _ in
            self.cursorModels = CodexModel.loadCursor()
        }
    }

    // label — название модели для подписи в комментариях, auto — участие в фоновом ревью
    func setAgent(_ id: String, model: String? = nil, effort: String? = nil, label: String? = nil, auto: Bool? = nil) {
        var arguments = ["agent", "set", id]
        if let model { arguments += ["--model", model] }
        if let effort { arguments += ["--effort", effort] }
        if let label { arguments += ["--label", label] }
        if let auto { arguments += ["--auto", auto ? "on" : "off"] }
        CLI.run(arguments) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    func setRepoPaused(_ slug: String, _ paused: Bool) {
        CLI.run(["repo", paused ? "pause" : "resume", slug]) { success, output in
            if !success { self.syncError = output }
            self.reload()
        }
    }

    func removeRepo(_ slug: String) {
        CLI.run(["repo", "remove", slug]) { success, output in
            if !success { self.cloneErrors[slug] = output }
            self.reload()
        }
    }
}
