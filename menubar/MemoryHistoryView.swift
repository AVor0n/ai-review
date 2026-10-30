import SwiftUI

// Вкладка «Что менялось» в листе памяти: журнал от новых записей к старым и откат последнего разбора
struct MemoryHistoryPanel: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var confirm = RestoreConfirmation()
    let slug: String

    private static let limit = 100

    private var entries: [MemoryChange] { (model.memoryHistory[slug] ?? []).suffix(Self.limit).reversed() }

    // Откатить можно только последний применённый разбор, и только если после него не было отката
    private var restorableAt: String? {
        guard let last = model.memoryHistory[slug]?.last(where: { $0.kind == "review" || $0.kind == "restore" }), last.kind == "review" else { return nil }
        return last.at
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let error = model.memoryHistoryErrors[slug] {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Откатить не получилось", systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.orange)
                        Text(error)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                if let restored = model.memoryRestored[slug] {
                    Label(restored, systemImage: "checkmark.circle.fill")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(ChartColors.addressed)
                }
                if entries.isEmpty {
                    Text("Журнал пуст: изменения памяти записываются с этой версии сервиса. Ручная правка файла в редакторе сюда не попадает.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                    entryCard(entry)
                }
            }
        }
        .alert("Откатить разбор памяти?", isPresented: $confirm.isShown) {
            Button("Откатить", role: .destructive) { model.restoreMemory(slug) }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Память вернётся к копии, сохранённой перед разбором: удалённые правила вернутся, переписанные и склеенные — станут прежними. Если после разбора память менялась, сервис откажет, чтобы не потерять эти изменения.")
        }
    }

    private func entryCard(_ entry: MemoryChange) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Tag(text: Self.title(entry.kind), color: Self.color(entry.kind))
                Text(Self.date(entry.at))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                if let pr = entry.pr, let url = entry.url.flatMap(URL.init(string:)) {
                    Button { NSWorkspace.shared.open(url) } label: {
                        Text(verbatim: "PR #\(pr)").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .help("Открыть PR в Bitbucket")
                }
                Spacer(minLength: 0)
                if entry.kind == "review", entry.at == restorableAt {
                    if model.memoryRestoring.contains(slug) {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Откатить") { confirm.isShown = true }
                            .controlSize(.small)
                            .help("Вернуть память к копии, сохранённой перед этим разбором")
                    }
                }
            }
            if let reason = entry.reason, !reason.isEmpty {
                Text(inlineMarkdown(reason))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array((entry.added ?? []).enumerated()), id: \.offset) { _, item in
                line("plus", .green) { Text(inlineMarkdown(item.text)) }
            }
            ForEach(Array((entry.removed ?? []).enumerated()), id: \.offset) { _, item in
                line("minus", .red) {
                    Text(inlineMarkdown(item.text)).foregroundColor(.secondary).strikethrough()
                    if let reason = item.reason { Text(inlineMarkdown(reason)).font(.system(size: 11)).foregroundColor(.secondary) }
                }
            }
            ForEach(Array((entry.changed ?? []).enumerated()), id: \.offset) { _, change in
                line("pencil", .orange) {
                    if let reason = change.reason { Text(inlineMarkdown(reason)).font(.system(size: 11, weight: .medium)) }
                    ChangeDiff(before: [change.before], after: change.after)
                }
            }
            ForEach(Array((entry.merged ?? []).enumerated()), id: \.offset) { _, merge in
                line("arrow.triangle.merge", .purple) {
                    if let reason = merge.reason { Text(inlineMarkdown(reason)).font(.system(size: 11, weight: .medium)) }
                    ChangeDiff(before: merge.from.map(\.text), after: merge.into.text)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func line<Content: View>(_ icon: String, _ color: Color, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 12)
            VStack(alignment: .leading, spacing: 4) { content() }
                .font(.system(size: 12))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    static func title(_ kind: String) -> String {
        switch kind {
        case "learn": "Выучено"
        case "add": "Добавлено вручную"
        case "edit": "Исправлено вручную"
        case "remove": "Удалено вручную"
        case "evict": "Вытеснено"
        case "review": "Разбор памяти"
        case "restore": "Откат разбора"
        default: kind
        }
    }

    static func color(_ kind: String) -> Color {
        switch kind {
        case "learn", "add": ChartColors.waiting
        case "review": .purple
        case "evict", "remove": ChartColors.dismissed
        default: .secondary
        }
    }

    // Журнал читают по датам, поэтому дата точная, а не «2 дня назад»
    static func date(_ iso: String) -> String {
        guard let date = Dates.parse(iso) else { return iso }
        let style = Date.FormatStyle(locale: Locale(identifier: "ru_RU")).day().month(.abbreviated).hour().minute()
        let sameYear = Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
        return date.formatted(sameYear ? style : style.year())
    }
}

// Подтверждение отката: @State здесь недоступен (макрос), поэтому состояние в ObservableObject
private final class RestoreConfirmation: ObservableObject {
    @Published var isShown = false
}
