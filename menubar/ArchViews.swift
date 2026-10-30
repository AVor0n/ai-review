import SwiftUI

enum ArchText {
    static func verdict(_ verdict: String) -> (title: String, icon: String, color: Color) {
        switch verdict {
        case "keep": ("Оставить как есть", "checkmark.seal.fill", .green)
        case "discuss": ("Стоит обсудить", "bubble.left.and.bubble.right.fill", .yellow)
        case "rework": ("Лучше переделать", "arrow.triangle.2.circlepath.circle.fill", .orange)
        default: (verdict, "questionmark.circle.fill", .secondary)
        }
    }

    static func clarity(_ clarity: String) -> String {
        switch clarity {
        case "stated": "описана автором"
        case "inferred": "восстановлена по коду"
        case "unclear": "непонятна"
        default: clarity
        }
    }

    static func switchCost(_ cost: String) -> String {
        switch cost {
        case "low": "переделка — часы"
        case "medium": "переделка — день-два"
        case "high": "переделка — больше двух дней"
        default: cost
        }
    }
}

// Иконка-колонна в строке PR: серая — ревью не было, цветная — вердикт, бледная — отчёт на старом коммите
struct ArchButton: View {
    @EnvironmentObject private var model: AppModel
    let arch: ArchState?
    let pr: PullRequest
    let start: () -> Void
    let showReport: () -> Void

    private var stale: Bool { arch?.isStale(for: pr) == true }

    var body: some View {
        Button {
            if arch == nil { start() } else { showReport() }
        } label: {
            ZStack {
                if arch?.state == "running" {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: icon).font(.system(size: 13, weight: .medium))
                }
            }
            .foregroundStyle(tint)
            .opacity(arch?.state == "done" && stale ? 0.45 : 1)
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(hint)
    }

    private var icon: String {
        switch arch?.state {
        case "queued": "clock"
        case "failed": "exclamationmark.triangle"
        case "done": "building.columns.fill"
        default: "building.columns"
        }
    }

    private var tint: Color {
        switch arch?.state {
        case "failed": .orange
        case "done": arch?.result.map { ArchText.verdict($0.report.verdict).color } ?? .secondary
        default: .secondary
        }
    }

    private var hint: String {
        switch arch?.state {
        case "queued": return "Архитектурное ревью в очереди. Нажмите, чтобы посмотреть"
        case "running": return "Идёт архитектурное ревью\(arch?.activity.map { ": \($0)" } ?? ""). Нажмите, чтобы посмотреть ход или прервать"
        case "failed": return "Архитектурное ревью не удалось: \(arch?.error?.split(separator: "\n").last.map(String.init) ?? ""). Нажмите, чтобы посмотреть"
        case "done":
            let verdict = arch?.result.map { ArchText.verdict($0.report.verdict).title } ?? "готово"
            return stale
                ? "Архитектурное ревью: \(verdict). Отчёт снят на старом коммите — нажмите, чтобы посмотреть и перезапустить"
                : "Архитектурное ревью: \(verdict). Нажмите, чтобы посмотреть отчёт"
        default:
            return "Архитектурное ревью — \(model.archAgentName) оценит цель, альтернативы, где можно проще и риски. Отчёт только здесь, в PR не публикуется"
        }
    }
}

// Подтверждение «Скопировано» живёт пару секунд; @State здесь недоступен (макрос), поэтому ObservableObject
final class CopyState: ObservableObject {
    @Published var copied = false
}

struct ArchReportSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var copy = CopyState()
    let target: FixTarget
    let rerun: () -> Void

    private var arch: ArchState? { model.arch(repo: target.repo, pr: target.pr.id) }
    // Снимок PR обновляется, пока лист открыт: устаревание отчёта сверяем со свежей головой
    private var pr: PullRequest { model.snapshots[target.repo]?.prs.first { $0.id == target.pr.id } ?? target.pr }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: "Архитектурное ревью #\(pr.id)").font(.title3.weight(.semibold))
                    Text(pr.title).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
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

            if let arch {
                statusLine(arch)
                if let result = arch.result, !arch.isActive, arch.isStale(for: pr) {
                    staleBanner(result)
                }
                ScrollView {
                    VStack(spacing: 14) {
                        if arch.state == "failed", let error = arch.error, error.contains("\n") {
                            GroupedSection("Вывод") { output(error) }
                        }
                        if let result = arch.result {
                            report(result)
                        }
                    }
                }
                .frame(height: 400)
            } else {
                Text("Архитектурного ревью этого PR ещё не было")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }

            HStack {
                if let url = URL(string: pr.url) {
                    Button("Открыть PR") { NSWorkspace.shared.open(url) }
                }
                Button(copy.copied ? "Скопировано" : "Скопировать markdown") {
                    model.copyArchMarkdown(repo: target.repo, pr: pr.id) { success in
                        guard success else { return }
                        copy.copied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copy.copied = false }
                    }
                }
                .disabled(arch?.result == nil)
                Spacer()
                if arch?.isActive == true {
                    Button("Прервать", role: .destructive) { model.stopArch(repo: target.repo, pr: target.pr.id) }
                } else if arch?.isStale(for: pr) == true {
                    Button("Перезапустить") {
                        dismiss()
                        rerun()
                    }
                    .keyboardShortcut(.defaultAction)
                } else {
                    Button(arch == nil ? "Запустить" : "Запустить снова") {
                        dismiss()
                        rerun()
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 660)
        .background(Theme.background)
    }

    private func statusLine(_ arch: ArchState) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            switch arch.state {
            case "queued":
                Image(systemName: "clock").foregroundStyle(.secondary)
                Text(arch.result == nil ? "В очереди" : "В очереди. Ниже — прошлый отчёт").foregroundStyle(.secondary)
            case "running":
                FlippingHourglass().foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 2) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text("Идёт ревью" + (Dates.parse(arch.startedAt).map { " · " + FixTimeline.duration(context.date.timeIntervalSince($0)) } ?? "")
                            + (arch.result == nil ? "" : ". Ниже — прошлый отчёт"))
                            .foregroundStyle(.blue)
                    }
                    if let activity = arch.activity {
                        Text(activity)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            case "done":
                let verdict = ArchText.verdict(arch.result?.report.verdict ?? "")
                Image(systemName: verdict.icon).foregroundStyle(verdict.color)
                Text(verdict.title)
            default:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(arch.error?.split(separator: "\n").last.map(String.init) ?? "Не удалось")
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.system(size: 13, weight: .medium))
    }

    private func staleBanner(_ result: ArchResult) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "clock.arrow.circlepath").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Отчёт устарел").font(.system(size: 12, weight: .semibold))
                Text(verbatim: "Он снят на коммите \(result.head), а в PR уже \(pr.head). Решение могло измениться — перезапустите ревью.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private func report(_ result: ArchResult) -> some View {
        let report = result.report
        GroupedSection("Итог") {
            paragraph(report.summary)
        }
        GroupedSection("Цель · \(ArchText.clarity(report.goalClarity))") {
            paragraph(report.goal)
        }
        GroupedSection("Как решено") {
            paragraph(report.approach)
        }
        if !report.alternatives.isEmpty {
            GroupedSection("Альтернативы · \(report.alternatives.count)") {
                ForEach(Array(report.alternatives.enumerated()), id: \.offset) { index, alternative in
                    if index > 0 { RowDivider() }
                    alternativeRow(alternative)
                }
            }
        }
        if !report.simpler.isEmpty {
            GroupedSection("Можно проще · \(report.simpler.count)") {
                ForEach(Array(report.simpler.enumerated()), id: \.offset) { index, item in
                    if index > 0 { RowDivider(inset: 34) }
                    placeRow(item) {
                        Image(systemName: "scissors").foregroundStyle(Color.accentColor)
                    }
                }
            }
        }
        if !report.risks.isEmpty {
            GroupedSection("Серьёзные риски · \(report.risks.count)") {
                ForEach(Array(report.risks.enumerated()), id: \.offset) { index, risk in
                    if index > 0 { RowDivider(inset: 46) }
                    placeRow(risk) {
                        Tag(text: risk.level ?? "P1", color: risk.level == "P0" ? .red : .orange)
                    }
                }
            }
        }
        if !report.questions.isEmpty {
            GroupedSection("Вопросы автору · \(report.questions.count)") {
                ForEach(Array(report.questions.enumerated()), id: \.offset) { index, question in
                    if index > 0 { RowDivider(inset: 34) }
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "questionmark.circle").foregroundStyle(.secondary).font(.system(size: 13))
                        markdown(question)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
        }
        details(result)
    }

    private func alternativeRow(_ alternative: ArchAlternative) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                markdown(alternative.title).fontWeight(.semibold)
                Spacer(minLength: 8)
                if alternative.better {
                    Tag(text: "стоит рассмотреть", color: .green)
                }
                Tag(text: ArchText.switchCost(alternative.switchCost))
            }
            markdown(alternative.idea)
            ForEach(Array(alternative.pros.enumerated()), id: \.offset) { _, pro in
                bullet(pro, icon: "plus.circle.fill", color: .green)
            }
            ForEach(Array(alternative.cons.enumerated()), id: \.offset) { _, con in
                bullet(con, icon: "minus.circle.fill", color: .orange)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func bullet(_ text: String, icon: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon).foregroundStyle(color).font(.system(size: 11))
            markdown(text)
        }
    }

    private func placeRow<Marker: View>(_ item: ArchPlace, @ViewBuilder marker: () -> Marker) -> some View {
        HStack(alignment: .top, spacing: 10) {
            marker().font(.system(size: 13))
            VStack(alignment: .leading, spacing: 2) {
                markdown(item.title).fontWeight(.medium)
                if let location = item.location {
                    Text(location)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                markdown(item.details)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func details(_ result: ArchResult) -> some View {
        let rows: [(String, String)] = [
            ("Модель", model.agentName(result.agent) + (result.model.map { " · \($0)" } ?? "")),
            ("Коммит", result.head),
            ("Снят", arch?.finishedAt.flatMap(Dates.parse).map { $0.formatted(date: .abbreviated, time: .shortened) }),
            ("Цена и время", [
                result.usage?.costUsd.map { String(format: "$%.2f", $0) },
                result.durationSec.map { FixTimeline.duration(TimeInterval($0)) },
            ].compactMap { $0 }.joined(separator: " · ")),
        ].compactMap { title, value in value.flatMap { $0.isEmpty ? nil : (title, $0) } }
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

    private func paragraph(_ text: String) -> some View {
        markdown(text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
    }

    // Поля отчёта — markdown без заголовков: обратные кавычки и выделение рендерятся, переносы строк сохраняются
    private func markdown(_ text: String) -> Text {
        Text(LocalizedStringKey(text)).font(.system(size: 13))
    }

    private func output(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
    }
}
