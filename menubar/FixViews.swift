import SwiftUI

// Цель подтверждения или отчёта доработки — PR в конкретном репозитории; rebase — только перенос ветки на базу
struct FixTarget: Identifiable {
    let repo: String
    let pr: PullRequest
    var rebase = false
    var id: String { "\(repo)#\(pr.id)" }
    var openThreads: Int { pr.threads - pr.resolved }
    var behind: Int { pr.behind ?? 0 }
}

// Одна кнопка на два действия: Fix, когда есть открытые треды (он и сам делает rebase), иначе Rebase, когда ветка отстала от базы
struct FixButton: View {
    let fix: FixState?
    let openThreads: Int
    // Треды, появившиеся после доработки: галочка становится жёлтой
    var newThreads = 0
    let behind: Int
    let conflicts: Bool
    let start: (_ rebase: Bool) -> Void
    let showReport: () -> Void

    // Что можно запустить сейчас: nil — нечего, false — Fix, true — Rebase
    private var available: Bool? { openThreads > 0 ? false : behind > 0 ? true : nil }

    // Итог прошлого запуска показываем, пока не стало доступно другое действие: иначе после Fix нельзя было бы сделать Rebase
    private var showsState: Bool {
        guard let fix else { return false }
        return fix.isActive || available == nil || available == fix.isRebase
    }

    private var isRebase: Bool { showsState ? fix?.isRebase == true : available == true }
    private var state: String? { showsState ? fix?.state : nil }

    var body: some View {
        Button {
            if showsState { showReport() } else if let available { start(available) }
        } label: {
            ZStack {
                if fix?.isActive == true && state == "running" {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: icon).font(.system(size: 13, weight: .medium))
                }
            }
            .foregroundStyle(tint)
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!showsState && available == nil)
        .opacity(!showsState && available == nil ? 0.35 : 1)
        .help(hint)
    }

    // Иконка без рамки, как кнопки в строках Mail и Finder. В покое Fix и Rebase серые, цветом выделены только
    // итоги и будущие конфликты — то, что требует внимания
    private var icon: String {
        switch state {
        case "queued": "clock"
        case "done": "checkmark.circle"
        case "failed": "exclamationmark.triangle"
        default: isRebase ? "arrow.triangle.branch" : "wand.and.stars"
        }
    }

    private var tint: Color {
        switch state {
        case "queued", "running": .secondary
        case "done": newThreads > 0 ? .yellow : .green
        case "failed": .orange
        default: isRebase && conflicts && (showsState || available != nil) ? .orange : .secondary
        }
    }

    private var hint: String {
        let name = isRebase ? "Rebase" : "Доработка"
        switch state {
        case "queued": return "\(name) в очереди"
        case "running": return "\(name) идёт: \(fix?.step ?? "…")\(fix?.activity.map { " — \($0)" } ?? ""). Нажмите, чтобы посмотреть ход или прервать"
        case "done" where newThreads > 0:
            return "\(name): \(fix?.report?.message ?? "готово"), но после неё появились новые замечания (\(newThreads)). Нажмите, чтобы посмотреть их и запустить доработку снова"
        case "done": return "\(name): \(fix?.report?.message ?? "готово"). Нажмите, чтобы посмотреть отчёт"
        case "failed": return "\(name) не удалась: \(fix?.error?.split(separator: "\n").last.map(String.init) ?? ""). Нажмите, чтобы посмотреть отчёт"
        default:
            if isRebase {
                return "Ветка отстала от базы на \(behind) коммит(ов)\(conflicts ? ", будут конфликты — их разрешит Claude" : "") — rebase, проверки и push"
            }
            return available == nil ? "Открытых замечаний нет, ветка на свежей базе" : "Исправить открытые замечания (\(openThreads)) — Claude: rebase, правки, проверки, коммит и push"
        }
    }
}

struct FixReportSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let target: FixTarget
    let rerun: () -> Void

    private var fix: FixState? { model.fix(repo: target.repo, pr: target.pr.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: "\(target.rebase ? "Rebase" : "Доработка") #\(target.pr.id)").font(.title3.weight(.semibold))
                    Text(target.pr.title).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
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
            }

            if let fix {
                statusLine(fix)
                // Всё содержимое — в одной прокрутке: лист открыт поверх панели и не должен выходить за её высоту
                ScrollView {
                    VStack(spacing: 14) {
                        if let steps = fix.steps, !steps.isEmpty {
                            FixTimeline(fix: fix, steps: steps)
                        }
                        if fix.report == nil, let error = fix.error, error.contains("\n") {
                            GroupedSection("Вывод") { output(error) }
                        }
                        if let report = fix.report {
                            newThreadsSection(fix.newThreads(in: target.pr))
                            items("Исправлено", report.fixed ?? [], icon: "checkmark.circle.fill", color: .green) { $0.summary }
                            items("Не исправлено", report.skipped ?? [], icon: "minus.circle.fill", color: .orange) { $0.reason }
                            details(report)
                            if let hook = report.hook {
                                GroupedSection("Вывод команд") { output(hook) }
                            }
                        }
                    }
                }
                .frame(height: 380)
            }

            HStack {
                if let url = URL(string: target.pr.url) {
                    Button("Открыть PR") { NSWorkspace.shared.open(url) }
                }
                Spacer()
                if fix?.isActive == true {
                    Button("Прервать", role: .destructive) { model.stopFix(repo: target.repo, pr: target.pr.id) }
                } else {
                    Button("Запустить снова") {
                        dismiss()
                        rerun()
                    }
                    .disabled(target.rebase ? target.behind == 0 : target.openThreads == 0)
                }
            }
        }
        .padding(20)
        .frame(width: 620)
        .background(Theme.background)
    }

    private func output(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
    }

    private func statusLine(_ fix: FixState) -> some View {
        let (icon, color, text): (String, Color, String) = switch fix.state {
        case "queued": ("clock", .secondary, "В очереди")
        case "running": ("hourglass", .blue, fix.step ?? "Идёт доработка")
        case "done" where !fix.newThreads(in: target.pr).isEmpty:
            ("checkmark.seal.fill", .yellow, "\(fix.report?.message ?? "Готово"). После доработки появились новые замечания")
        case "done": ("checkmark.seal.fill", .green, fix.report?.message ?? "Готово")
        default: ("exclamationmark.triangle.fill", .orange, fix.report?.message ?? fix.error?.split(separator: "\n").last.map(String.init) ?? "Не удалось")
        }
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            if fix.state == "running" {
                FlippingHourglass()
            } else {
                Image(systemName: icon)
            }
            // Жёлтый текст на светлом фоне не читается — жёлтым остаётся только значок
            Text(text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(color == .yellow ? .primary : color)
        }
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(color)
    }

    @ViewBuilder
    private func items(_ title: String, _ list: [FixItem], icon: String, color: Color, text: @escaping (FixItem) -> String?) -> some View {
        if !list.isEmpty {
            GroupedSection("\(title) · \(list.count)") {
                ForEach(Array(list.enumerated()), id: \.offset) { index, item in
                    if index > 0 { RowDivider(inset: 34) }
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: icon).foregroundStyle(color).font(.system(size: 13))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.location).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                            Text(LocalizedStringKey(text(item) ?? "")).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
        }
    }

    // Появились после доработки — сверху отчёта: ради них лист чаще всего и открывают
    @ViewBuilder
    private func newThreadsSection(_ threads: [OpenThread]) -> some View {
        if !threads.isEmpty {
            GroupedSection("Новые после доработки · \(threads.count)") {
                ForEach(Array(threads.enumerated()), id: \.element.id) { index, thread in
                    if index > 0 { RowDivider(inset: 34) }
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "plus.bubble.fill").foregroundStyle(.yellow).font(.system(size: 13))
                        VStack(alignment: .leading, spacing: 2) {
                            Text([thread.author, thread.path].compactMap { $0 }.joined(separator: " · "))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text(LocalizedStringKey(thread.text)).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        if let url = thread.url.flatMap(URL.init(string:)) {
                            Button { NSWorkspace.shared.open(url) } label: {
                                Image(systemName: "arrow.up.right.square").foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .help("Открыть тред в Bitbucket")
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
        }
    }

    private func details(_ report: FixReport) -> some View {
        let rows: [(String, String)] = [
            ("Правки", report.resumedFrom.map { "из прошлого запуска (\($0)), Claude не запускался заново" }),
            ("Rebase", report.rebase),
            ("Проверки", report.checks),
            ("Резервная ветка", report.backup),
            ("Заметки", report.notes.flatMap { $0.isEmpty ? nil : $0 }),
            ("Цена и время", report.usage?.costUsd.map { cost in
                String(format: "$%.2f", cost) + (report.durationSec.map { " · \($0 / 60) мин \($0 % 60) с" } ?? "")
            }),
        ].compactMap { title, value in value.map { (title, $0) } }
        return GroupedSection("Подробности") {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { RowDivider() }
                HStack(alignment: .top) {
                    Text(row.0).font(.system(size: 13)).foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
                    Text(row.1).font(.system(size: 13)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
    }
}

// Шаги доработки или тестирования со временем: у текущего — живой таймер и последнее действие модели или проверки
struct FixTimeline: View {
    var title = "Ход доработки"
    let steps: [FixStep]
    let isActive: Bool
    let failed: Bool
    let finishedAt: String?
    let activity: String?

    init(fix: FixState, steps: [FixStep]) {
        self.init(steps: steps, isActive: fix.isActive, failed: fix.state == "failed", finishedAt: fix.finishedAt, activity: fix.activity)
    }

    init(title: String = "Ход доработки", steps: [FixStep], isActive: Bool, failed: Bool, finishedAt: String?, activity: String?) {
        self.title = title
        self.steps = steps
        self.isActive = isActive
        self.failed = failed
        self.finishedAt = finishedAt
        self.activity = activity
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            GroupedSection(title) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    if index > 0 { RowDivider(inset: 34) }
                    row(index: index, step: step, now: context.date)
                }
            }
        }
    }

    private func row(index: Int, step: FixStep, now: Date) -> some View {
        let isLast = index == steps.count - 1
        let isCurrent = isLast && isActive
        let started = Dates.parse(step.at)
        let ended = isLast ? (isActive ? now : Dates.parse(finishedAt)) : Dates.parse(steps[index + 1].at)
        return HStack(alignment: .top, spacing: 10) {
            ZStack {
                if isCurrent {
                    ProgressView().controlSize(.mini)
                } else if isLast && failed {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.orange)
                } else {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
            }
            .font(.system(size: 13))
            .frame(width: 14, height: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.title).font(.system(size: 13, weight: isCurrent ? .medium : .regular))
                if isCurrent, let activity {
                    Text(activity)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            if let started, let ended {
                Text(Self.duration(ended.timeIntervalSince(started)))
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        return total < 60 ? "\(total) с" : "\(total / 60) мин \(total % 60) с"
    }
}

// Песочные часы переворачиваются и стоят, пока «пересыпаются», — без @State, от времени TimelineView
struct FlippingHourglass: View {
    private static let period = 2.0
    private static let turn = 0.6

    var body: some View {
        TimelineView(.animation) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let phase = time.truncatingRemainder(dividingBy: Self.period)
            let progress = min(phase / Self.turn, 1)
            let eased = progress < 0.5 ? 2 * progress * progress : 1 - pow(-2 * progress + 2, 2) / 2
            Image(systemName: "hourglass")
                .rotationEffect(.degrees(eased * 180))
        }
    }
}
