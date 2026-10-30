import Foundation

struct StatsFilter {
    // Пустая строка — без фильтра
    var repo = ""
    var author = ""
    var agent = ""
    var pass = ""
    var days = 30

    func matches(repo: String?, author: String?, agent: String, pass: String?) -> Bool {
        (self.repo.isEmpty || repo == self.repo)
            && (self.author.isEmpty || author == self.author)
            && (self.agent.isEmpty || agent == self.agent)
            && (self.pass.isEmpty || pass == self.pass)
    }

    // Для работы помимо ревью: типа ревью у неё нет, а поле, которого у записи нет (nil), фильтр не ограничивает
    func matchesWork(repo: String?, author: String?, agent: String?) -> Bool {
        matches(repo: repo ?? self.repo, author: author ?? self.author, agent: agent ?? self.agent, pass: self.pass)
    }
}

enum WorkKind: String, CaseIterable {
    case review, replies, fix, rebase, arch, qa, memory, backlog

    var title: String {
        switch self {
        case .review: "Ревью"
        case .replies: "Ответы в тредах"
        case .fix: "Автофикс"
        case .rebase: "Rebase"
        case .arch: "Архитектура"
        case .qa: "Тестирование"
        case .memory: "Память"
        case .backlog: "Бэклог"
        }
    }
}

struct Spending {
    let date: Date
    let kind: WorkKind
    // repo#pr у трат, привязанных к PR
    let pr: String?
    let cost: Double
}

struct KindCost {
    var runs = 0
    var cost = 0.0
}

struct NoiseWeek: Identifiable {
    let week: Date
    var addressed = 0
    var dismissed = 0
    var id: Date { week }

    var closed: Int { addressed + dismissed }
    var share: Double { closed > 0 ? Double(dismissed) / Double(closed) : 0 }
}

struct MemoryStats {
    var rules = 0
    // Ревью за период, в которых учитывались срабатывания, и сколько правил на них сработало
    var runs = 0
    var applied = 0
    // Правил без единого срабатывания с начала учёта; nil — учёт ещё не начался
    var idle: Int?
    var since: Date?
}

enum Level {
    static let all = ["P0", "P1", "P2", "P3"]
}

struct Density: Identifiable {
    let name: String
    let prs: Int
    let lines: Int
    let findings: [String: Int]
    var id: String { name }

    var total: Int { findings.values.reduce(0, +) }
    func perThousand(_ count: Int) -> Double { lines > 0 ? Double(count) * 1000 / Double(lines) : 0 }
    var density: Double { perThousand(total) }
    // На маленьком объёме одно замечание резко двигает плотность — такие строки помечаем
    var isLowVolume: Bool { lines < 500 }
}

struct DayValue: Identifiable {
    let day: Date
    let group: String
    let value: Double
    var id: String { "\(day.timeIntervalSince1970)-\(group)" }
}

struct Fate {
    var addressed = 0
    var dismissed = 0
    // Часть dismissed: человек ответил в треде; остальные не стали править молча
    var disputed = 0
    var waiting = 0

    var ignored: Int { dismissed - disputed }

    var closed: Int { addressed + dismissed }
    var total: Int { closed + waiting }
}

struct AgentCost {
    var runs = 0
    var seconds = 0
    var tokens = 0
    var cost = 0.0
    var pricedRuns = 0
    var inputTokens = 0

    var costPerRun: Double? { pricedRuns > 0 ? cost / Double(pricedRuns) : nil }
    // Цена входного токена с запасом: в стоимость входит и вывод, поэтому оценка экономии — верхняя граница
    var costPerInputToken: Double? { inputTokens > 0 && pricedRuns > 0 ? cost / Double(inputTokens) : nil }
}

struct StatsData {
    let filter: StatsFilter
    let entries: [(date: Date, entry: StatEntry)]
    let outcomes: [Outcome]
    let waiting: [WaitingFinding]
    let skips: [Skip]
    let fixes: [FixRecord]
    let archs: [ArchRecord]
    let qas: [QaRecord]
    let spendings: [Spending]
    let backlogItems: [BacklogItem]
    let noiseOutcomes: [(published: Date, outcome: Outcome)]
    let memory: MemoryStats
    // Первое ревью с новыми правилами: 19.10.2026 они включились не с полуночи, а с перезапуском сервиса
    let rulesStart: Date
    let periodStart: Date

    // День, с которого действуют новые правила отбора: старые баги уходят в бэклог, редкие P3 не публикуются
    static let selectionRulesDate = calendar.date(from: DateComponents(year: 2026, month: 10, day: 19))!

    private static let calendar = Calendar.current

    @MainActor
    init(model: AppModel, filter: StatsFilter) {
        self.filter = filter
        let calendar = Self.calendar
        let start = calendar.date(byAdding: .day, value: -(filter.days - 1), to: calendar.startOfDay(for: Date()))!
        periodStart = start
        let inPeriod = { (iso: String) -> Date? in Dates.parse(iso).flatMap { $0 >= start ? $0 : nil } }
        entries = model.stats.compactMap { entry in
            guard filter.matches(repo: entry.repo, author: entry.author, agent: entry.agent, pass: entry.pass),
                  let date = inPeriod(entry.at) else { return nil }
            return (date, entry)
        }
        outcomes = model.outcomes.filter {
            filter.matches(repo: $0.repo, author: $0.author, agent: $0.agent, pass: $0.pass) && inPeriod($0.at) != nil
        }
        // «Ждут правки» — текущее состояние, период к нему не применяется
        waiting = model.waitingFindings.filter {
            filter.matches(repo: $0.repo, author: $0.finding.author, agent: $0.finding.agent, pass: $0.finding.pass)
        }
        // Пропуск — это несостоявшееся повторное ревью, поэтому в фильтре типа он относится к «после правок»
        skips = model.skips.filter {
            filter.matches(repo: $0.repo, author: $0.author, agent: $0.agent, pass: "followup") && inPeriod($0.at) != nil
        }

        // Автора у записей автофикса, тестирования и архитектуры нет — берём автора PR из ревью
        var prAuthors: [String: String] = [:]
        for entry in model.stats {
            if let pr = entry.pr, let author = entry.author { prAuthors["\(entry.repo)#\(pr)"] = author }
        }
        let authorOf = { (repo: String, pr: Int) in prAuthors["\(repo)#\(pr)"] ?? "неизвестно" }
        // Автофикс и тестирование всегда идут через Claude (fix.mjs, qa.mjs), поэтому модели в их журналах нет
        fixes = model.fixLog.filter { filter.matchesWork(repo: $0.repo, author: authorOf($0.repo, $0.pr), agent: "claude") && inPeriod($0.at) != nil }
        archs = model.archLog.filter { filter.matchesWork(repo: $0.repo, author: authorOf($0.repo, $0.pr), agent: $0.agent) && inPeriod($0.at) != nil }
        qas = model.qaLog.filter { filter.matchesWork(repo: $0.repo, author: authorOf($0.repo, $0.pr), agent: "claude") && inPeriod($0.at) != nil }
        let spends = model.spendLog.compactMap { record -> (Date, SpendRecord)? in
            guard filter.matchesWork(repo: record.repo, author: nil, agent: record.agent), let date = inPeriod(record.at) else { return nil }
            return (date, record)
        }

        var spendings: [Spending] = []
        let add = { (date: Date?, kind: WorkKind, pr: String?, cost: Double?) in
            if let date, let cost { spendings.append(Spending(date: date, kind: kind, pr: pr, cost: cost)) }
        }
        for (date, entry) in entries {
            add(date, entry.pass == "replies" ? .replies : .review, entry.pr.map { "\(entry.repo)#\($0)" }, entry.usage?.costUsd)
        }
        for fix in fixes { add(Dates.parse(fix.at), fix.isRebase ? .rebase : .fix, "\(fix.repo)#\(fix.pr)", fix.usage?.costUsd) }
        for arch in archs { add(Dates.parse(arch.at), .arch, "\(arch.repo)#\(arch.pr)", arch.usage?.costUsd) }
        for qa in qas { add(Dates.parse(qa.at), .qa, "\(qa.repo)#\(qa.pr)", qa.usage?.costUsd) }
        for (date, record) in spends {
            add(date, record.kind.hasPrefix("backlog") ? .backlog : .memory, nil, record.usage?.costUsd)
        }
        self.spendings = spendings

        backlogItems = model.backlog.filter { item in
            guard filter.repo.isEmpty || item.repo == filter.repo, item.createdAt.flatMap(inPeriod) != nil else { return false }
            return (filter.agent.isEmpty || item.sources.contains { $0.agent == filter.agent })
                && (filter.author.isEmpty || item.sources.contains { authorOf(item.repo, $0.pr) == filter.author })
        }

        // Шум считаем по времени публикации замечания, а не закрытия PR: так видно, с каких замечаний подействовали новые правила
        noiseOutcomes = model.outcomes.compactMap { outcome in
            guard filter.matches(repo: outcome.repo, author: outcome.author, agent: outcome.agent, pass: outcome.pass),
                  let closedAt = Dates.parse(outcome.at) else { return nil }
            let published = closedAt.addingTimeInterval(-(outcome.hours ?? 0) * 3600)
            return published >= start ? (published, outcome) : nil
        }

        rulesStart = model.stats.first { $0.backlogged != nil }.flatMap { Dates.parse($0.at) } ?? Self.selectionRulesDate

        var memory = MemoryStats()
        let repos = model.config.repos.map(\.slug).filter { filter.repo.isEmpty || $0 == filter.repo }
        for (_, entry) in entries {
            guard let applied = entry.appliedLessons else { continue }
            memory.runs += 1
            memory.applied += Set(applied).count
        }
        // Как `memory list`: учёт идёт с первого ревью репозитория с appliedLessons, склеенное правило наследует срабатывания исходных
        for slug in repos {
            let lessons = model.memory[slug] ?? []
            memory.rules += lessons.count
            let tracked = model.stats.filter { $0.repo == slug && $0.appliedLessons != nil }
            guard let first = tracked.first.flatMap({ Dates.parse($0.at) }) else { continue }
            memory.since = min(memory.since ?? first, first)
            let alias = Dictionary(lessons.flatMap { lesson in (lesson.source?.mergedFrom ?? []).map { ($0, lesson.id) } }, uniquingKeysWith: { first, _ in first })
            let fired = Set(tracked.flatMap { $0.appliedLessons ?? [] }.map { alias[$0] ?? $0 })
            memory.idle = (memory.idle ?? 0) + lessons.filter { !fired.contains($0.id) }.count
        }
        self.memory = memory
    }

    var dayRange: ClosedRange<Date> {
        periodStart...Self.calendar.date(byAdding: .day, value: 1, to: Self.calendar.startOfDay(for: Date()))!
    }

    // MARK: Качество

    var findingCount: Int { entries.map(\.entry.findingCount).reduce(0, +) }

    // Замечания на 1000 изменённых строк: объём PR берём по последнему ревью, замечания — по всем ревью PR
    func density(byAuthor: Bool) -> [Density] {
        var lines: [String: [String: Int]] = [:]
        var findings: [String: [String: Int]] = [:]
        for (_, entry) in entries {
            let group = byAuthor ? (entry.author ?? "неизвестно") : entry.repo
            if let pr = entry.pr, let diffLines = entry.diffLines {
                lines[group, default: [:]]["\(entry.repo)#\(pr)"] = max(lines[group]?["\(entry.repo)#\(pr)"] ?? 0, diffLines)
            }
            for (level, count) in entry.findings where count > 0 {
                findings[group, default: [:]][level, default: 0] += count
            }
        }
        return Set(lines.keys).union(findings.keys).map { group in
            Density(name: group, prs: lines[group]?.count ?? 0, lines: lines[group]?.values.reduce(0, +) ?? 0, findings: findings[group] ?? [:])
        }
        .sorted { ($0.isLowVolume ? 1 : 0, -$0.density) < ($1.isLowVolume ? 1 : 0, -$1.density) }
    }

    func fate(by key: (String?, String?, String) -> String) -> [(name: String, fate: Fate)] {
        var result: [String: Fate] = [:]
        for outcome in outcomes {
            let name = key(outcome.repo, outcome.author, outcome.agent)
            switch outcome.outcome {
            case "addressed": result[name, default: Fate()].addressed += 1
            // Прежний исход «влили без правки, тред открыт» теперь тоже считается отклонённым
            case "dismissed", "unchanged":
                result[name, default: Fate()].dismissed += 1
                if outcome.disputed == true { result[name, default: Fate()].disputed += 1 }
            default: break
            }
        }
        for item in waiting {
            result[key(item.repo, item.finding.author, item.finding.agent), default: Fate()].waiting += 1
        }
        return result.map { ($0.key, $0.value) }.sorted { $0.fate.total > $1.fate.total }
    }

    var overallFate: Fate { fate { _, _, _ in "" }.first?.fate ?? Fate() }

    // Ревью кода по дням, без запусков «только ответы в тредах»: видно, что работа шла, даже если замечаний не было
    var reviewsPerDay: [Date: Int] {
        var result: [Date: Int] = [:]
        for (date, entry) in entries where entry.pass != "replies" {
            result[Self.calendar.startOfDay(for: date), default: 0] += 1
        }
        return result
    }

    func commentsPerDay(group: (StatEntry) -> String) -> [DayValue] {
        perDay { ($0.entry.postedComments > 0 ? Double($0.entry.postedComments) : nil, group($0.entry)) }
    }

    // MARK: Цена

    var totalCost: Double { entries.compactMap(\.entry.usage?.costUsd).reduce(0, +) }

    var reviewedPrs: Int { Set(entries.compactMap { entry in entry.entry.pr.map { "\(entry.entry.repo)#\($0)" } }).count }

    func costPerDay(name: (String) -> String) -> [DayValue] {
        perDay { ($0.entry.usage?.costUsd, name($0.entry.agent)) }
    }

    var agentCosts: [String: AgentCost] {
        var result: [String: AgentCost] = [:]
        for (_, entry) in entries {
            guard let usage = entry.usage else { continue }
            var row = result[entry.agent, default: AgentCost()]
            row.runs += 1
            row.seconds += entry.durationSec ?? 0
            row.tokens += usage.inputTokens + usage.outputTokens
            if let cost = usage.costUsd {
                row.cost += cost
                row.pricedRuns += 1
                row.inputTokens += usage.inputTokens
            }
            result[entry.agent] = row
        }
        return result
    }

    // MARK: Экономия

    // Цена несостоявшегося раунда — средняя цена ревью этой модели (без ответов в тредах), по всем данным модели
    @MainActor
    func savedBySkips(model: AppModel) -> Double {
        var average: [String: Double] = [:]
        for agent in Set(skips.map(\.agent)) {
            let costs = model.stats.filter { $0.agent == agent && $0.pass != "replies" }.compactMap(\.usage?.costUsd)
            average[agent] = costs.isEmpty ? 0 : costs.reduce(0, +) / Double(costs.count)
        }
        return skips.map { average[$0.agent] ?? 0 }.reduce(0, +)
    }

    // Примерно 4 байта на токен; токены не прочитаны моделью, но и не сэкономлены точно — это оценка
    var excludedTokens: Int { entries.compactMap(\.entry.excludedBytes).reduce(0, +) / 4 }

    func excludedCost(costs: [String: AgentCost]) -> Double {
        entries.reduce(0) { sum, item in
            let tokens = Double(item.entry.excludedBytes ?? 0) / 4
            return sum + tokens * (costs[item.entry.agent]?.costPerInputToken ?? 0)
        }
    }

    // MARK: Все траты

    var totalSpend: Double { spendings.map(\.cost).reduce(0, +) }

    var costByKind: [WorkKind: KindCost] {
        var result: [WorkKind: KindCost] = [:]
        for spending in spendings {
            result[spending.kind, default: KindCost()].runs += 1
            result[spending.kind, default: KindCost()].cost += spending.cost
        }
        return result
    }

    var spendPerDay: [DayValue] {
        var sums: [Date: [String: Double]] = [:]
        for spending in spendings {
            sums[Self.calendar.startOfDay(for: spending.date), default: [:]][spending.kind.title, default: 0] += spending.cost
        }
        return sums.flatMap { day, groups in groups.map { DayValue(day: day, group: $0.key, value: $0.value) } }
            .sorted { ($0.day, $0.group) < ($1.day, $1.group) }
    }

    // Все траты, привязанные к PR: ревью, ответы, автофикс, rebase, архитектура, тестирование
    var prSpend: (cost: Double, prs: Int) {
        let linked = spendings.filter { $0.pr != nil }
        return (linked.map(\.cost).reduce(0, +), Set(linked.compactMap(\.pr)).count)
    }

    // MARK: Автофикс

    var fixRuns: [FixRecord] { fixes.filter { !$0.isRebase } }

    var fixStatuses: [(status: String, count: Int)] {
        Dictionary(grouping: fixes, by: \.status).map { ($0.key, $0.value.count) }.sorted { $0.count > $1.count }
    }

    var fixedCount: Int { fixRuns.compactMap(\.fixed).reduce(0, +) }
    var fixSkipped: Int { fixRuns.compactMap(\.skipped).reduce(0, +) }
    var fixCost: Double { fixRuns.compactMap(\.usage?.costUsd).reduce(0, +) }

    // MARK: Шум

    // Недели с понедельника, как в русском календаре, независимо от настроек системы
    private static let weekCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        return calendar
    }()

    static func week(of date: Date) -> Date {
        weekCalendar.dateInterval(of: .weekOfYear, for: date)?.start ?? calendar.startOfDay(for: date)
    }

    var noiseWeeks: [NoiseWeek] {
        var result: [Date: NoiseWeek] = [:]
        for (published, outcome) in noiseOutcomes {
            let week = Self.week(of: published)
            switch outcome.outcome {
            case "addressed": result[week, default: NoiseWeek(week: week)].addressed += 1
            case "dismissed", "unchanged": result[week, default: NoiseWeek(week: week)].dismissed += 1
            default: break
            }
        }
        return result.values.sorted { $0.week < $1.week }
    }

    // Доля отклонённых до и после новых правил отбора
    var noiseByRules: (before: NoiseWeek, after: NoiseWeek) {
        var before = NoiseWeek(week: periodStart), after = NoiseWeek(week: rulesStart)
        for (published, outcome) in noiseOutcomes {
            let isAfter = published >= rulesStart
            switch outcome.outcome {
            case "addressed": if isAfter { after.addressed += 1 } else { before.addressed += 1 }
            case "dismissed", "unchanged": if isAfter { after.dismissed += 1 } else { before.dismissed += 1 }
            default: break
            }
        }
        return (before, after)
    }

    // Что модели нашли, но не опубликовали; считается только по запускам с новыми полями
    var selection: (runs: Int, published: Int, backlogged: Int, filtered: Int, dropped: Int) {
        let tracked = entries.map(\.entry).filter { $0.backlogged != nil }
        return (
            tracked.count,
            tracked.map(\.findingCount).reduce(0, +),
            tracked.compactMap(\.backlogged).reduce(0, +),
            tracked.compactMap(\.filtered).reduce(0, +),
            tracked.compactMap(\.dropped).reduce(0, +)
        )
    }

    static let disagreeReasons = ["wrong", "fixed", "preexisting", "unlikely"]

    // Причины несогласия; у вердиктов до 19.10.2026 причины нет — они идут отдельным ключом "unknown"
    var disagreeReasons: (checked: Int, reasons: [String: Int]) {
        var checked = 0
        var reasons: [String: Int] = [:]
        for (_, entry) in entries {
            for verdict in entry.verdicts where verdict.verdict != "skip" {
                checked += 1
                guard verdict.verdict == "disagree" else { continue }
                let reason = verdict.reason.flatMap { Self.disagreeReasons.contains($0) ? $0 : nil } ?? "unknown"
                reasons[reason, default: 0] += 1
            }
        }
        return (checked, reasons)
    }

    // MARK: Время до исправления

    var hoursToFix: [(level: String, median: Double, count: Int)] {
        let byLevel = Dictionary(grouping: outcomes.filter { $0.outcome == "addressed" && $0.hours != nil }, by: \.level)
        return Level.all.compactMap { level in
            guard let hours = byLevel[level]?.compactMap(\.hours).sorted(), !hours.isEmpty else { return nil }
            let middle = hours.count / 2
            let median = hours.count % 2 == 1 ? hours[middle] : (hours[middle - 1] + hours[middle]) / 2
            return (level, median, hours.count)
        }
    }

    private func perDay(_ value: ((date: Date, entry: StatEntry)) -> (Double?, String)) -> [DayValue] {
        var sums: [Date: [String: Double]] = [:]
        for item in entries {
            let (amount, group) = value(item)
            guard let amount else { continue }
            sums[Self.calendar.startOfDay(for: item.date), default: [:]][group, default: 0] += amount
        }
        return sums.flatMap { day, groups in groups.map { DayValue(day: day, group: $0.key, value: $0.value) } }
            .sorted { ($0.day, $0.group) < ($1.day, $1.group) }
    }
}
