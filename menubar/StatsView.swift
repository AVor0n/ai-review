import Charts
import SwiftUI

// Роли в ревью и перекрёстная проверка — то же, что `pr-reviewer stats`, но по выбранному срезу
private struct RoleStats {
    var firstRuns = 0
    var firstFindings: [String: Int] = [:]
    var secondRuns = 0
    var secondFindings: [String: Int] = [:]
    var confirmed = 0
    var disputed = 0
    var agreed = 0
    var disagreed = 0
    var skipped = 0

    static func perRun(_ findings: [String: Int], _ runs: Int) -> String {
        runs > 0 ? String(format: "%.1f", Double(findings.values.reduce(0, +)) / Double(runs)) : "—"
    }

    // Доля от всех чужих замечаний, на которые модель отвечала
    func givenShare(_ count: Int) -> String {
        let total = agreed + disagreed + skipped
        return total > 0 ? "\(count * 100 / total)% · \(count)/\(total)" : "—"
    }

    var confirmedShare: String {
        confirmed + disputed > 0 ? "\(confirmed * 100 / (confirmed + disputed))% · \(confirmed)/\(confirmed + disputed)" : "—"
    }
}

// Выбранный под курсором день на графиках; @State здесь недоступен (макрос), поэтому ObservableObject
private final class StatsScreen: ObservableObject {
    @Published var commentsDay: Date?
    @Published var costDay: Date?
}

struct StatsView: View {
    enum Dimension: String, CaseIterable {
        case agent, repo, author
        var title: String {
            switch self {
            case .agent: "Модели"
            case .repo: "Репозитории"
            case .author: "Авторы"
            }
        }
    }

    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var screen = StatsScreen()
    @AppStorage("statsDays") private var days = 30
    @AppStorage("statsRepo") private var repoFilter = ""
    @AppStorage("statsAuthor") private var authorFilter = ""
    @AppStorage("statsAgent") private var agentFilter = ""
    @AppStorage("statsPass") private var passFilter = ""
    @AppStorage("statsDensityBy") private var densityBy = Dimension.author
    @AppStorage("statsFateBy") private var fateBy = Dimension.agent
    @AppStorage("statsCommentsBy") private var commentsBy = Dimension.repo

    private static let passes = [("initial", "Первое ревью"), ("followup", "После правок"), ("replies", "Ответы в тредах")]

    private var data: StatsData {
        StatsData(model: model, filter: StatsFilter(repo: repoFilter, author: authorFilter, agent: agentFilter, pass: passFilter, days: days))
    }

    private var authors: [String] {
        Set(model.stats.compactMap(\.author) + model.outcomes.compactMap(\.author)).sorted()
    }

    // Цвет репозитория и автора — по месту в стабильном отсортированном списке, а не в отфильтрованном
    private func seriesColor(_ name: String, in names: [String]) -> Color {
        ChartColors.series(names.firstIndex(of: name) ?? 0)
    }

    private func money(_ value: Double?) -> String { value.map { String(format: "$%.2f", $0) } ?? "—" }

    private static func duration(_ seconds: Int) -> String {
        seconds < 60 ? "\(seconds) с" : seconds < 600 ? "\(seconds / 60) мин \(seconds % 60) с" : "\(seconds / 60) мин"
    }

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            ScrollView {
                sections(data)
            }
        }
    }

    private func sections(_ data: StatsData) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            activitySection(data)
            noiseSection(data)
            qualitySection(data)
            timeToFixSection(data)
            comparisonSection(data)
            costSection(data)
            fixSection(data)
            modesSection(data)
            savingsSection(data)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
    }

    // Вся вкладка одной картинкой, без прокрутки — в «Загрузки», и сразу открываем
    private func exportImage() {
        let content = sections(data)
            .padding(.top, 16)
            .frame(width: 780)
            .background(Theme.background)
            .environmentObject(model)
            .environment(\.colorScheme, colorScheme)
            .environment(\.locale, Locale(identifier: "ru_RU"))
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        // Адаптивные цвета Theme выбирают вариант по текущему NSAppearance в момент отрисовки
        var image: CGImage?
        NSApp.effectiveAppearance.performAsCurrentDrawingAppearance { image = renderer.cgImage }
        guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmm"
        let stamp = formatter.string(from: Date())
        let url = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0].appendingPathComponent("pr-reviewer-stats-\(stamp).png")
        guard (try? png.write(to: url)) != nil else { return }
        NSWorkspace.shared.open(url)
    }

    // Один ряд фильтров над всеми графиками: каждый действует на всю вкладку
    private var filterBar: some View {
        HStack(spacing: 6) {
            FilterMenu(icon: "shippingbox", allTitle: "Все репозитории", options: model.config.repos.map { ($0.slug, $0.slug) }, selection: $repoFilter)
            FilterMenu(icon: "person", allTitle: "Все авторы", options: authors.map { ($0, $0) }, selection: $authorFilter)
            FilterMenu(icon: "cpu", allTitle: "Все модели", options: model.agentIds.map { ($0, model.agentName($0)) }, selection: $agentFilter)
            FilterMenu(icon: "arrow.triangle.2.circlepath", allTitle: "Любое ревью", options: Self.passes.map { ($0.0, $0.1) }, selection: $passFilter)
            Spacer(minLength: 6)
            SegmentedPicker(options: [7, 30, 90], selection: $days, title: { "\($0) дн." }, segmentWidth: 52)
            Button(action: exportImage) {
                Image(systemName: "camera")
                    .font(.system(size: 12))
                    .foregroundStyle(.primary)
                    .frame(width: 28, height: 28)
                    .background(Theme.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("Сохранить всю статистику картинкой в «Загрузки»")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    // MARK: Качество кода

    @ViewBuilder
    private func qualitySection(_ data: StatsData) -> some View {
        let fate = data.overallFate
        SectionTitle(title: "Качество кода", icon: "checkmark.seal")
        HStack(spacing: 10) {
            KpiTile(title: "Замечаний", value: "\(data.findingCount)", detail: "за \(days) дн.")
            KpiTile(
                title: "Исправлено",
                value: fate.closed > 0 ? "\(fate.addressed * 100 / fate.closed)%" : "—",
                detail: fate.closed > 0 ? "\(fate.addressed) из \(fate.closed) закрытых" : "закрытых пока нет"
            )
            KpiTile(
                title: "Отклонено",
                value: fate.closed > 0 ? "\(fate.dismissed * 100 / fate.closed)%" : "—",
                detail: fate.closed > 0 ? "\(fate.dismissed) из \(fate.closed) — не стали править" : "закрытых пока нет"
            )
        }

        densityCard(data)
    }

    @ViewBuilder
    private func activitySection(_ data: StatsData) -> some View {
        SectionTitle(title: "Ревью", icon: "text.bubble")
        commentsCard(data)
        fateCard(data)
    }

    @ViewBuilder
    private func comparisonSection(_ data: StatsData) -> some View {
        SectionTitle(title: "Сравнение моделей", icon: "square.split.2x1")
        GroupedSection(footer: "Первым — модель ревьюит новый коммит с чистого листа; вторым — видит замечания первой, проверяет их и добавляет свои. Порядок чередуется на каждом новом коммите.") {
            EmptyView()
        } content: {
            comparisonTable(data)
        }
    }

    private func densityCard(_ data: StatsData) -> some View {
        let rows = data.density(byAuthor: densityBy == .author)
        let maxDensity = rows.filter { !$0.isLowVolume }.map(\.density).max() ?? rows.map(\.density).max() ?? 1
        return GroupedSection(footer: "Замечаний всех моделей на 1000 изменённых строк, без исключённых файлов. Сравнивать по числу замечаний нечестно: больше всех «ошибается» тот, кто больше пишет. Меньше 500 строк — мало данных, такие строки приглушены и стоят в конце.") {
            HStack {
                Text("Замечаний на 1000 строк")
                Spacer()
                SegmentedPicker(options: [Dimension.author, .repo], selection: $densityBy, title: \.title, segmentWidth: 90)
                    .textCase(nil)
            }
        } content: {
            if rows.isEmpty {
                emptyRow
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { RowDivider() }
                    DensityRow(row: row, scale: max(maxDensity, 0.1))
                }
                HStack(spacing: 14) {
                    ForEach(Level.all, id: \.self) { LegendItem(title: $0, color: ChartColors.level($0)) }
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
    }

    private func fateCard(_ data: StatsData) -> some View {
        let rows: [(name: String, fate: Fate)] = data.fate { repo, author, agent in
            switch fateBy {
            case .agent: agent
            case .repo: repo ?? "неизвестно"
            case .author: author ?? "неизвестно"
            }
        }
        return GroupedSection(footer: "«Исправлено» — автор правил код в пределах двух строк от замечания. «Отклонено» — код рядом не меняли, а тред закрыли через Resolve или PR влили: команда решила не править. «Ждут правки» — открытые треды в открытых PR сейчас, без учёта периода.") {
            HStack {
                Text("Судьба замечаний")
                Spacer()
                SegmentedPicker(options: Dimension.allCases, selection: $fateBy, title: \.title, segmentWidth: 90)
                    .textCase(nil)
            }
        } content: {
            if rows.isEmpty {
                emptyRow
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.name) { index, row in
                    if index > 0 { RowDivider() }
                    FateRow(name: fateBy == .agent ? model.agentName(row.name) : row.name, agent: fateBy == .agent ? row.name : nil, fate: row.fate)
                }
            }
        }
    }

    private func commentsCard(_ data: StatsData) -> some View {
        let byAgent = commentsBy == .agent
        let names = byAgent ? model.agentIds.map(model.agentName) : (commentsBy == .repo ? model.config.repos.map(\.slug) : authors)
        let values = data.commentsPerDay { entry in
            switch commentsBy {
            case .agent: model.agentName(entry.agent)
            case .repo: entry.repo
            case .author: entry.author ?? "неизвестно"
            }
        }
        let colors = names.map { name in byAgent ? AgentMark.color(model.agentIds.first { model.agentName($0) == name } ?? "") : seriesColor(name, in: names) }
        return GroupedSection(footer: "Опубликованные замечания и ответы на чужие треды, без «пропусков». Над днём — сколько было ревью кода (за 90 дней — в подсказке). Наведите на столбец, чтобы увидеть значения.") {
            HStack {
                Text("Комментарии ревьюеров по дням")
                Spacer()
                SegmentedPicker(options: Dimension.allCases, selection: $commentsBy, title: \.title, segmentWidth: 90)
                    .textCase(nil)
            }
        } content: {
            DailyChart(values: values, domain: names, colors: colors, range: data.dayRange, unit: { "\(Int($0))" }, selection: $screen.commentsDay, reviews: data.reviewsPerDay)
        }
    }

    // MARK: Цена

    private static let kindColors = WorkKind.allCases.indices.map(ChartColors.series)

    private static func kindColor(_ kind: WorkKind) -> Color { kindColors[WorkKind.allCases.firstIndex(of: kind) ?? 0] }

    @ViewBuilder
    private func costSection(_ data: StatsData) -> some View {
        let total = data.totalSpend
        let reviewCost = data.totalCost
        let perPr = data.prSpend
        let fate = data.overallFate
        let pricedAddressed = data.pricedAddressed()
        let byKind = data.costByKind
        let kinds = WorkKind.allCases.filter { (byKind[$0]?.runs ?? 0) > 0 }.sorted { byKind[$0]!.cost > byKind[$1]!.cost }
        SectionTitle(title: "Стоимость", icon: "dollarsign.circle")
        HStack(spacing: 10) {
            KpiTile(title: "Потрачено", value: money(total), detail: "\(data.spendings.count) запусков моделей")
            KpiTile(title: "За PR", value: perPr.prs > 0 ? money(perPr.cost / Double(perPr.prs)) : "—", detail: "\(perPr.prs) PR, всё, что делали по PR")
            KpiTile(title: "За исправленное замечание", value: pricedAddressed > 0 ? money(reviewCost / Double(pricedAddressed)) : "—", detail: "цена ревью · \(fate.addressed) исправлено")
        }
        GroupedSection("По видам работы", footer: "Цена по тарифам API: Claude сообщает её сам, для Codex и Cursor она считается по токенам и тарифам из config.json — agents.<модель>.modelPricing для выбранной модели или agents.<модель>.pricing. С токеном подписки это не реальное списание. Траты памяти и бэклога до 19.10.2026 перенесены из лога с точностью до цента. Фильтр автора действует на всё, что привязано к PR, фильтр типа ревью — только на ревью и ответы в тредах.") {
            if kinds.isEmpty {
                emptyRow
            } else {
                ForEach(Array(kinds.enumerated()), id: \.element) { index, kind in
                    if index > 0 { RowDivider() }
                    let cost = byKind[kind]!
                    ShareRow(title: kind.title, detail: "\(cost.runs) запусков", value: money(cost.cost), share: total > 0 ? cost.cost / total : 0, color: Self.kindColor(kind))
                }
            }
        }
        GroupedSection("Траты по дням", footer: "Все виды работы, той же раскраской. «За PR» — ревью, ответы, автофикс, rebase, архитектура и тестирование, поделённые на число PR; память и бэклог к PR не привязаны и в эту цену не входят.") {
            DailyChart(
                values: data.spendPerDay,
                domain: WorkKind.allCases.map(\.title),
                colors: Self.kindColors,
                range: data.dayRange,
                unit: { String(format: "$%.2f", $0) },
                selection: $screen.costDay
            )
        }
    }

    // MARK: Автофикс

    private static func fixStatus(_ status: String) -> (title: String, color: Color) {
        switch status {
        case "pushed": ("Запушено", ChartColors.addressed)
        case "nothing": ("Нечего менять", ChartColors.level("P3"))
        case "commit-failed": ("Не удалось закоммитить", ChartColors.dismissed)
        case "checks-failed": ("Не прошли проверки", ChartColors.level("P2"))
        case "rebase-failed": ("Rebase не удался", ChartColors.level("P0"))
        case "push-rejected": ("Push отклонён", ChartColors.level("P1"))
        default: (status, ChartColors.level("P3"))
        }
    }

    @ViewBuilder
    private func fixSection(_ data: StatsData) -> some View {
        let fixed = data.fixedCount
        let statuses = data.fixStatuses
        let rebases = data.fixes.count - data.fixRuns.count
        SectionTitle(title: "Автофикс", icon: "wand.and.stars")
        HStack(spacing: 10) {
            KpiTile(title: "Запусков", value: "\(data.fixes.count)", detail: "\(data.fixRuns.count) автофикс · \(rebases) rebase")
            KpiTile(title: "Исправлено замечаний", value: "\(fixed)", detail: data.fixSkipped > 0 ? "ещё \(data.fixSkipped) модель пропустила" : "за \(days) дн.")
            KpiTile(title: "Цена исправленного", value: fixed > 0 ? money(data.fixCost / Double(fixed)) : "—", detail: "\(money(data.fixCost)) на автофикс")
        }
        GroupedSection("Исходы запусков", footer: "«Запушено» — правка или rebase в ветке PR. «Нечего менять» — модель не нашла, что править. Остальное — запуск не дошёл до ветки: коммит, проверки, конфликт rebase или push, отклонённый из-за новых коммитов. Цена исправленного — траты автофикса без rebase на исправленные им замечания.") {
            if statuses.isEmpty {
                emptyRow
            } else {
                ForEach(Array(statuses.enumerated()), id: \.element.status) { index, item in
                    if index > 0 { RowDivider() }
                    let status = Self.fixStatus(item.status)
                    ShareRow(title: status.title, value: "\(item.count)", share: Double(item.count) / Double(data.fixes.count), color: status.color)
                }
            }
        }
    }

    // MARK: Шум

    private static let reasonTitles = [
        "wrong": ("Утверждение о коде неверно", ChartColors.level("P0")),
        "fixed": ("Уже исправлено в ветке", ChartColors.addressed),
        "preexisting": ("Было до PR — в бэклог", ChartColors.waiting),
        "unlikely": ("Редкий сценарий, лёгкое последствие", ChartColors.level("P2")),
        "unknown": ("Причина не указана (до 19.10)", ChartColors.level("P3")),
    ]

    private static func percent(_ part: Int, _ total: Int) -> String { total > 0 ? "\(part * 100 / total)%" : "—" }

    @ViewBuilder
    private func noiseSection(_ data: StatsData) -> some View {
        let rules = data.noiseByRules
        let selection = data.selection
        let found = selection.published + selection.backlogged + selection.filtered + selection.dropped
        let reasons = data.disagreeReasons
        let disagreed = reasons.reasons.values.reduce(0, +)
        SectionTitle(title: "Шум", icon: "speaker.wave.2")
        HStack(spacing: 10) {
            KpiTile(
                title: "Отклонено до новых правил",
                value: Self.percent(rules.before.dismissed, rules.before.closed),
                detail: rules.before.closed > 0 ? "\(rules.before.dismissed) из \(rules.before.closed) закрытых" : "закрытых нет"
            )
            KpiTile(
                title: "Отклонено после 19.10",
                value: Self.percent(rules.after.dismissed, rules.after.closed),
                detail: rules.after.closed > 0 ? "\(rules.after.dismissed) из \(rules.after.closed) закрытых" : "закрытых пока нет"
            )
            KpiTile(
                title: "Не опубликовано",
                value: "\(selection.backlogged + selection.filtered)",
                detail: "в бэклог \(selection.backlogged) · редких P3 \(selection.filtered)"
            )
        }
        GroupedSection("Доля отклонённых по неделям", footer: "Сколько замечаний закрыли без правки кода, из закрытых, — по неделе публикации замечания. Над столбцом — отклонено из закрытых. Линия — 19.10.2026, новые правила отбора: баги, которые были до PR, уходят в бэклог, редкие P3 не публикуются. Плитки «до» и «после» делятся по первому ревью с новыми правилами. Последние недели неполные: часть замечаний ещё ждёт правки.") {
            NoiseChart(weeks: data.noiseWeeks, start: StatsData.week(of: data.periodStart), end: data.dayRange.upperBound)
        }
        GroupedSection("Отбор замечаний", footer: "По ревью с новыми правилами (с 19.10.2026): что модели нашли и что из этого ушло в PR. «В бэклог» — проблема была до PR, по ней заводят отдельную задачу. «Редкие P3» — редкий сценарий или гонка с лёгким последствием. «Нет в диффе» — замечание к файлу, в котором PR не меняет ни строки; такие не публикуются.") {
            if selection.runs == 0 {
                Text("Ревью по новым правилам за период ещё не было")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            } else {
                let rows: [(String, Int, Color)] = [
                    ("Опубликовано", selection.published, ChartColors.addressed),
                    ("В бэклог", selection.backlogged, ChartColors.waiting),
                    ("Редкие P3", selection.filtered, ChartColors.level("P3")),
                    ("Нет в диффе", selection.dropped, ChartColors.dismissed),
                ]
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { RowDivider() }
                    ShareRow(title: row.0, value: "\(row.1)", share: found > 0 ? Double(row.1) / Double(found) : 0, color: row.2)
                }
                Text("\(found) находок в \(selection.runs) ревью")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        GroupedSection(footer: "Ответы моделей на чужие замечания: почему проверяющая модель не согласна. Причину модели указывают с 19.10.2026. «Было до PR» уходит в бэклог, «Редкий сценарий» — тот же отбор, что у своих замечаний.") {
            HStack {
                Text("Почему модели не согласны")
                Spacer()
                Text(reasons.checked > 0 ? "оспорено \(disagreed) из \(reasons.checked) проверенных" : "")
                    .textCase(nil)
            }
        } content: {
            if disagreed == 0 {
                emptyRow
            } else {
                let keys = (StatsData.disagreeReasons + ["unknown"]).filter { (reasons.reasons[$0] ?? 0) > 0 }
                ForEach(Array(keys.enumerated()), id: \.element) { index, key in
                    if index > 0 { RowDivider() }
                    let count = reasons.reasons[key] ?? 0
                    let title = Self.reasonTitles[key]!
                    ShareRow(title: title.0, value: "\(count)", share: Double(count) / Double(disagreed), color: title.1)
                }
            }
        }
    }

    // MARK: Время до исправления

    private static func hours(_ value: Double) -> String {
        if value < 1 { return "< 1 ч" }
        if value < 10 { return String(format: "%.1f ч", value).replacingOccurrences(of: ".", with: ",") }
        if value < 48 { return "\(Int(value.rounded())) ч" }
        return String(format: "%.1f", value / 24).replacingOccurrences(of: ".", with: ",") + " дн."
    }

    @ViewBuilder
    private func timeToFixSection(_ data: StatsData) -> some View {
        let rows = data.hoursToFix
        let longest = rows.map(\.median).max() ?? 1
        SectionTitle(title: "Время до исправления", icon: "timer")
        GroupedSection(footer: "Медиана часов от публикации замечания до правки кода рядом с ним — по исправленным замечаниям, закрытым за период. Медиана, а не среднее: одно замечание, пролежавшее неделю, не перекашивает картину.") {
            Text("Медиана по уровням")
        } content: {
            if rows.isEmpty {
                emptyRow
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.level) { index, row in
                    if index > 0 { RowDivider() }
                    ShareRow(title: row.level, detail: "\(row.count) исправлено", value: Self.hours(row.median), share: longest > 0 ? row.median / longest : 0, color: ChartColors.level(row.level))
                }
            }
        }
    }

    // MARK: Новые режимы

    @ViewBuilder
    private func modesSection(_ data: StatsData) -> some View {
        let memory = data.memory
        let backlog = data.backlogItems
        let plans = data.qas.filter { $0.stage == "plan" }
        let runs = data.qas.filter { $0.stage == "run" }
        let caseCounts = runs.compactMap(\.caseCounts).reduce(into: [String: Int]()) { $0.merge($1, uniquingKeysWith: +) }
        let verdicts = Dictionary(grouping: data.archs, by: \.verdict).mapValues(\.count)
        SectionTitle(title: "Новые режимы", icon: "sparkles")
        HStack(alignment: .top, spacing: 10) {
            GroupedSection("Архитектурное ревью") {
                StatLine(title: "Запусков", value: "\(data.archs.count)")
                ForEach(["keep", "discuss", "rework"], id: \.self) { verdict in
                    RowDivider()
                    StatLine(title: ArchText.verdict(verdict).title, value: "\(verdicts[verdict] ?? 0)", color: ArchText.verdict(verdict).color)
                }
            }
            .frame(maxWidth: .infinity)
            GroupedSection("Тестирование") {
                StatLine(title: "Планов", value: plans.isEmpty ? "0" : "\(plans.count) · \(plans.compactMap(\.plannedCases).reduce(0, +)) кейсов")
                RowDivider()
                StatLine(title: "Прогонов", value: "\(runs.count)")
                ForEach(QaText.statusOrder.filter { (caseCounts[$0] ?? 0) > 0 }, id: \.self) { status in
                    RowDivider()
                    StatLine(title: QaText.status(status).title, value: "\(caseCounts[status]!)", color: QaText.status(status).color)
                }
                RowDivider()
                StatLine(title: "Найдено багов", value: "\(runs.compactMap(\.bugs).reduce(0, +))")
            }
            .frame(maxWidth: .infinity)
        }
        HStack(alignment: .top, spacing: 10) {
            GroupedSection("Бэклог") {
                StatLine(title: "Найдено проблем", value: "\(backlog.count)")
                RowDivider()
                StatLine(title: "Заведено задач", value: "\(backlog.filter { $0.status == "filed" }.count)", color: ChartColors.addressed)
                RowDivider()
                StatLine(title: "Отклонено", value: "\(backlog.filter { $0.status == "dropped" }.count)", color: ChartColors.dismissed)
                RowDivider()
                StatLine(title: "Ждут разбора", value: "\(backlog.filter(\.isOpen).count)", color: ChartColors.waiting)
            }
            .frame(maxWidth: .infinity)
            GroupedSection("Память ревьюеров") {
                StatLine(title: "Правил", value: "\(memory.rules)")
                RowDivider()
                StatLine(title: "Срабатываний за ревью", value: memory.runs > 0 ? String(format: "%.1f", Double(memory.applied) / Double(memory.runs)).replacingOccurrences(of: ".", with: ",") : "—")
                RowDivider()
                StatLine(title: "Ни разу не сработали", value: memory.idle.map { "\($0)" } ?? "учёт не начат")
                if let since = memory.since {
                    Text("учёт с \(since.formatted(Date.FormatStyle(locale: Locale(identifier: "ru_RU")).day().month(.wide)))")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity)
        }
        Text("Архитектура и тестирование — запуски за период. Бэклог — проблемы вне PR, найденные за период, и что с ними сейчас; фильтр модели — по модели, которая их нашла. Память — правила сейчас; срабатывания — в среднем на ревью за период (модели отмечают сработавшие правила с 19.10.2026); «ни разу не сработали» — с начала учёта, без учёта периода и фильтра модели.")
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
    }

    private func roleStats(_ data: StatsData) -> [String: RoleStats] {
        var result = Dictionary(uniqueKeysWithValues: model.agentIds.map { ($0, RoleStats()) })
        for (_, entry) in data.entries where result[entry.agent] != nil {
            switch entry.role {
            case "first":
                result[entry.agent]!.firstRuns += 1
                result[entry.agent]!.firstFindings.merge(entry.findings, uniquingKeysWith: +)
            case "second":
                result[entry.agent]!.secondRuns += 1
                result[entry.agent]!.secondFindings.merge(entry.findings, uniquingKeysWith: +)
            default:
                break
            }
            for verdict in entry.verdicts {
                switch verdict.verdict {
                case "agree": result[entry.agent]!.agreed += 1
                case "disagree": result[entry.agent]!.disagreed += 1
                default: result[entry.agent]!.skipped += 1
                }
                // Вердикт модели — оценка замечаний той, кому она отвечала
                if verdict.verdict == "agree" { result[verdict.target]?.confirmed += 1 }
                if verdict.verdict == "disagree" { result[verdict.target]?.disputed += 1 }
            }
        }
        return result
    }

    // Как в строке подтверждений: доля и «сколько/из скольких». Знаменатель — закрытые замечания модели: ждущие правки ещё ничего не говорят о качестве
    private func share(_ fate: Fate?, _ part: KeyPath<Fate, Int>) -> String {
        guard let fate, fate.closed > 0 else { return "—" }
        return "\(fate[keyPath: part] * 100 / fate.closed)% · \(fate[keyPath: part])/\(fate.closed)"
    }

    private func comparisonTable(_ data: StatsData) -> some View {
        let stats = roleStats(data)
        let costs = data.agentCosts
        let fates = Dictionary(uniqueKeysWithValues: data.fate { _, _, agent in agent }.map { ($0.name, $0.fate) })
        let ids = model.agentIds
        let values = { (value: (String) -> String) in ids.map(value) }
        let role = { (value: (RoleStats) -> String) in ids.map { value(stats[$0] ?? RoleStats()) } }
        return VStack(spacing: 0) {
            HStack {
                Spacer()
                ForEach(ids, id: \.self) { agent in
                    HStack(spacing: 6) {
                        AgentMark(agent: agent)
                            .foregroundStyle(AgentMark.color(agent))
                            .frame(width: 12, height: 12)
                        Text(model.agentName(agent)).font(.system(size: 13, weight: .semibold))
                    }
                    .frame(width: ComparisonRow.columnWidth, alignment: .trailing)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            ComparisonGroup(title: "Ревью первым")
            ComparisonRow(title: "Ревью", values: role { "\($0.firstRuns)" })
            RowDivider()
            ComparisonRow(title: "Замечаний на ревью", values: role { RoleStats.perRun($0.firstFindings, $0.firstRuns) }, levels: ids.map { stats[$0]?.firstFindings ?? [:] })
            ComparisonGroup(title: "Ревью вторым")
            ComparisonRow(title: "Ревью", values: role { "\($0.secondRuns)" })
            RowDivider()
            ComparisonRow(title: "Новых замечаний на ревью", values: role { RoleStats.perRun($0.secondFindings, $0.secondRuns) }, levels: ids.map { stats[$0]?.secondFindings ?? [:] })
            ComparisonGroup(title: "Реакция команды")
            ComparisonRow(title: "Исправили", values: values { share(fates[$0], \.addressed) })
            RowDivider()
            ComparisonRow(title: "Не стали править молча", values: values { share(fates[$0], \.ignored) })
            RowDivider()
            ComparisonRow(title: "Оспорили в треде", values: values { share(fates[$0], \.disputed) })
            RowDivider()
            ComparisonRow(title: "Ждут правки", values: values { "\(fates[$0]?.waiting ?? 0)" })
            ComparisonGroup(title: "Перекрёстная проверка")
            ComparisonRow(title: "Подтверждение другой моделью", values: role { $0.confirmedShare })
            RowDivider()
            ComparisonRow(title: "Согласился с чужими", values: role { $0.givenShare($0.agreed) })
            RowDivider()
            ComparisonRow(title: "Оспорил чужие", values: role { $0.givenShare($0.disagreed) })
            RowDivider()
            ComparisonRow(title: "Пропустил (не утверждение о коде)", values: role { $0.givenShare($0.skipped) })
            ComparisonGroup(title: "Цена и время")
            ComparisonRow(title: "Время на запуск", values: values { costs[$0].flatMap { $0.runs > 0 ? Self.duration($0.seconds / $0.runs) : nil } ?? "—" })
            RowDivider()
            ComparisonRow(title: "Токенов на запуск", values: values { costs[$0].flatMap { $0.runs > 0 ? "\($0.tokens / $0.runs / 1000) тыс." : nil } ?? "—" })
            RowDivider()
            ComparisonRow(title: "Цена запуска", values: values { money(costs[$0]?.costPerRun) })
            RowDivider()
            ComparisonRow(title: "Цена исправленного замечания", values: values { agent in
                let addressed = data.pricedAddressed(agent: agent)
                guard let cost = costs[agent], cost.pricedRuns > 0, addressed > 0 else { return "—" }
                return money(cost.cost / Double(addressed))
            })
        }
    }

    // MARK: Экономия

    @ViewBuilder
    private func savingsSection(_ data: StatsData) -> some View {
        let costs = data.agentCosts
        SectionTitle(title: "Экономия", icon: "leaf")
        HStack(spacing: 10) {
            KpiTile(title: "Пропущено раундов", value: "\(data.skips.count)", detail: "≈ \(money(data.savedBySkips(model: model))) сэкономлено")
            KpiTile(title: "Вырезано из диффов", value: "≈ \(data.excludedTokens / 1000) тыс.", detail: "токенов, ≈ \(money(data.excludedCost(costs: costs)))")
        }
        Text("Раунд пропускается, когда после rebase изменения PR те же или изменились только исключённые файлы; его цена — средняя цена ревью этой модели. Вырезанные токены — оценка по размеру исключённой части диффа, по 4 байта на токен.")
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
    }

    private var emptyRow: some View {
        Text("За выбранный период данных нет")
            .font(.system(size: 13))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
    }
}

// Какой уровень сейчас под курсором — строка поднимается над соседями, чтобы подсказка не пряталась под следующей строкой
private final class LevelHover: ObservableObject {
    @Published var level: String?
}

private struct DensityRow: View {
    @StateObject private var hover = LevelHover()
    let row: Density
    let scale: Double

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name).font(.system(size: 13)).lineLimit(1)
                Text("\(row.prs) PR · \(row.lines) строк · \(row.total) замеч.\(row.isLowVolume ? " · мало данных" : "")")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .frame(width: 210, alignment: .leading)
            GeometryReader { geometry in
                let visible = Level.all.filter { (row.findings[$0] ?? 0) > 0 }
                HStack(spacing: 2) {
                    ForEach(visible, id: \.self) { level in
                        let count = row.findings[level] ?? 0
                        RoundedRectangle(cornerRadius: 2)
                            .fill(ChartColors.level(level))
                            .frame(width: max(3, geometry.size.width * min(row.perThousand(count) / scale, 1)))
                            .opacity(hover.level == nil || hover.level == level ? 1 : 0.4)
                            .overlay(alignment: .top) {
                                if hover.level == level {
                                    LevelTooltip(level: level, count: count, perThousand: row.perThousand(count))
                                        .fixedSize()
                                        .offset(y: -40)
                                        .allowsHitTesting(false)
                                }
                            }
                            // Зона наведения выше тонкой полосы: попасть в узкий кусок курсором проще
                            .contentShape(Rectangle().inset(by: -6))
                            .onHover { inside in
                                if inside { hover.level = level } else if hover.level == level { hover.level = nil }
                            }
                    }
                }
                .frame(maxHeight: .infinity)
            }
            .frame(height: 12)
            Text(String(format: "%.1f", row.density))
                .font(.system(size: 13, weight: .semibold).monospacedDigit())
                .frame(width: 40, alignment: .trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .opacity(row.isLowVolume && hover.level == nil ? 0.5 : 1)
        .zIndex(hover.level == nil ? 0 : 1)
    }
}

// Доля отклонённых по неделям; столбец — от понедельника до воскресенья, чтобы линия новых правил легла на границу недель
private struct NoiseChart: View {
    let weeks: [NoiseWeek]
    let start: Date
    let end: Date

    private static let day: TimeInterval = 24 * 3600

    private func bar(_ week: NoiseWeek) -> some ChartContent {
        let from: Date = week.week.addingTimeInterval(Self.day * 0.6)
        let to: Date = week.week.addingTimeInterval(Self.day * 6.4)
        let label = "\(week.dismissed)/\(week.closed)"
        return RectangleMark(
            xStart: .value("Неделя", from),
            xEnd: .value("Неделя", to),
            yStart: .value("Отклонено", 0.0),
            yEnd: .value("Отклонено", week.share * 100)
        )
        .foregroundStyle(ChartColors.dismissed)
        .cornerRadius(3)
        .annotation(position: .top, spacing: 3) {
            Text(label)
                .font(.system(size: 10).monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    var body: some View {
        if weeks.isEmpty {
            Text("За выбранный период закрытых замечаний нет")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 180)
        } else {
            Chart {
                ForEach(weeks) { week in
                    bar(week)
                }
                if StatsData.selectionRulesDate > start && StatsData.selectionRulesDate < end {
                    RuleMark(x: .value("Новые правила", StatsData.selectionRulesDate))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        // Подпись слева от линии: справа от неё только текущая неделя, и текст обрезался бы краем
                        .annotation(position: .top, alignment: .trailing, spacing: 2) {
                            Text("новые правила отбора")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                }
            }
            .chartXScale(domain: start...StatsData.week(of: end).addingTimeInterval(Self.day * 7))
            .chartYScale(domain: 0...100)
            .chartYAxis {
                AxisMarks(values: [0, 25, 50, 75, 100]) { value in
                    AxisGridLine()
                    AxisValueLabel { Text("\(value.as(Int.self) ?? 0)%") }
                }
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .weekOfYear)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let date = value.as(Date.self) {
                            Text(date.formatted(Date.FormatStyle(locale: Locale(identifier: "ru_RU")).day().month(.abbreviated)))
                        }
                    }
                }
            }
            .frame(height: 180)
            .padding(12)
            .padding(.top, 8)
        }
    }
}

// Значения по дням: столбцы, сложенные по сериям, или линии для сравнения серий; под курсором — подпись со значениями дня
private struct DailyChart: View {
    let values: [DayValue]
    let domain: [String]
    let colors: [Color]
    let range: ClosedRange<Date>
    let unit: (Double) -> String
    @Binding var selection: Date?
    var lines = false
    // Подпись «N ревью» над столбцом дня; в дни без комментариев — у нуля
    var reviews: [Date: Int] = [:]

    // Для линий у каждой серии нужна точка на каждый день, иначе пустые дни линия просто перескакивает
    private var filled: [DayValue] {
        let calendar = Calendar.current
        let groups = domain.filter { group in values.contains { $0.group == group } }
        var result: [DayValue] = []
        var day = calendar.startOfDay(for: range.lowerBound)
        while day < range.upperBound {
            for group in groups {
                result.append(values.first { $0.day == day && $0.group == group } ?? DayValue(day: day, group: group, value: 0))
            }
            day = calendar.date(byAdding: .day, value: 1, to: day)!
        }
        return result
    }

    private var selectedDay: Date? { selection.map { Calendar.current.startOfDay(for: $0) } }

    // Ширина дня падает с длиной периода: за неделю влезает «N ревью», за месяц — число, дальше подписи слипаются
    private var periodDays: Int { Calendar.current.dateComponents([.day], from: range.lowerBound, to: range.upperBound).day ?? 0 }
    private var reviewLabels: Bool { periodDays <= 35 }
    private var shortReviewLabels: Bool { periodDays > 10 }

    private func isRightHalf(_ day: Date) -> Bool {
        day.timeIntervalSince(range.lowerBound) > range.upperBound.timeIntervalSince(range.lowerBound) / 2
    }

    var body: some View {
        if values.isEmpty && reviews.isEmpty {
            Text("За выбранный период данных нет")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 180)
        } else {
            Chart {
                if lines {
                    ForEach(filled) { value in
                        LineMark(x: .value("День", value.day, unit: .day), y: .value("Значение", value.value))
                            .foregroundStyle(by: .value("Серия", value.group))
                            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                            .interpolationMethod(.monotone)
                    }
                    // Точки только в дни с данными: на каждом нуле они были бы шумом
                    ForEach(values) { value in
                        PointMark(x: .value("День", value.day, unit: .day), y: .value("Значение", value.value))
                            .foregroundStyle(by: .value("Серия", value.group))
                            .symbolSize(selectedDay == value.day ? 90 : 50)
                    }
                } else {
                    ForEach(values) { value in
                        BarMark(x: .value("День", value.day, unit: .day), y: .value("Значение", value.value))
                            .foregroundStyle(by: .value("Серия", value.group))
                            .cornerRadius(3)
                            .opacity(selectedDay == nil || selectedDay == value.day ? 1 : 0.35)
                    }
                }
                ForEach(reviewLabels ? reviews.sorted { $0.key < $1.key } : [], id: \.key) { day, count in
                    // Невидимая точка на вершине стопки дня держит подпись над столбцом
                    PointMark(x: .value("День", day, unit: .day), y: .value("Значение", values.filter { $0.day == day }.map(\.value).reduce(0, +)))
                        .opacity(0)
                        .annotation(position: .top, spacing: 3) {
                            Text(shortReviewLabels ? "\(count)" : "\(count) ревью")
                                .font(.system(size: 10).monospacedDigit())
                                .foregroundStyle(.secondary)
                                .opacity(selectedDay == nil || selectedDay == day ? 1 : 0.35)
                        }
                }
                if let day = selectedDay {
                    // Сверху вниз по убыванию — в том же порядке, в каком серии стоят на графике в этот день
                    let dayValues = values.filter { $0.day == day }.sorted { $0.value > $1.value }
                    RuleMark(x: .value("День", day, unit: .day))
                        .foregroundStyle(Color.secondary.opacity(0.25))
                        .lineStyle(StrokeStyle(lineWidth: 1))
                        // Сбоку от линии, чтобы не закрывать точки выбранного дня; в правой половине — слева
                        .annotation(position: isRightHalf(day) ? .leading : .trailing, alignment: .top, spacing: 8, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                            DayTooltip(day: day, values: dayValues, reviews: reviews[day], unit: unit) { group in
                                domain.firstIndex(of: group).flatMap { colors.indices.contains($0) ? colors[$0] : nil } ?? .secondary
                            }
                        }
                }
            }
            .chartForegroundStyleScale(domain: domain, range: colors)
            .chartXScale(domain: range)
            .chartXSelection(value: $selection)
            .chartLegend(position: .bottom, alignment: .leading)
            .frame(height: 200)
            .padding(12)
        }
    }
}

private struct DayTooltip: View {
    let day: Date
    let values: [DayValue]
    var reviews: Int?
    let unit: (Double) -> String
    let color: (String) -> Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Явная локаль: formatted() берёт язык системы, а не окна
            Text(day.formatted(Date.FormatStyle(locale: Locale(identifier: "ru_RU")).day().month(.wide)))
                .font(.system(size: 11, weight: .semibold))
            if let reviews {
                Text("\(reviews) ревью").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            if values.isEmpty {
                Text(reviews == nil ? "нет данных" : "без комментариев").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            ForEach(values) { value in
                HStack(spacing: 6) {
                    Circle().fill(color(value.group)).frame(width: 7, height: 7)
                    Text(value.group).foregroundStyle(.secondary)
                    Spacer(minLength: 12)
                    Text(unit(value.value)).monospacedDigit()
                }
                .font(.system(size: 11))
            }
        }
        .padding(8)
        .frame(minWidth: 140)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
    }
}

private struct LevelTooltip: View {
    let level: String
    let count: Int
    let perThousand: Double

    private static let names = ["P0": ("критичное", "критичных"), "P1": ("важное", "важных"), "P2": ("среднее", "средних"), "P3": ("мелкое", "мелких")]

    // 1 критичное замечание, 2 критичных замечания, 5 критичных замечаний
    private var text: String {
        let (one, other) = Self.names[level] ?? ("", "")
        let mod10 = count % 10, mod100 = count % 100
        if mod10 == 1 && mod100 != 11 { return "\(count) \(one) замечание" }
        if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "\(count) \(other) замечания" }
        return "\(count) \(other) замечаний"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Circle().fill(ChartColors.level(level)).frame(width: 7, height: 7)
                Text(text).font(.system(size: 12, weight: .semibold))
                Text(level).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Text(String(format: "%.1f на 1000 строк", perThousand).replacingOccurrences(of: ".", with: ","))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.leading, 13)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
    }
}
