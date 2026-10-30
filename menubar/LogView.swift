import SwiftUI

private final class LogScreen: ObservableObject {
    @Published var expanded: Set<Int> = []
}

struct LogView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("logErrorsOnly") private var errorsOnly = false
    @StateObject private var screen = LogScreen()

    private static let limit = 300

    private var entries: [LogEntry] {
        Array(model.logEntries.filter { !errorsOnly || $0.isError }.prefix(Self.limit))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                SegmentedPicker(options: [false, true], selection: $errorsOnly, title: { $0 ? "Ошибки" : "Все записи" }, segmentWidth: 100)
                Spacer()
                Button {
                    NSWorkspace.shared.open(Paths.log)
                } label: {
                    Label("Открыть файл", systemImage: "arrow.up.forward.app")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .help(Paths.log.path)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 10)

            if entries.isEmpty {
                ContentUnavailableView(errorsOnly ? "Ошибок нет" : "Лог пуст", systemImage: errorsOnly ? "checkmark.circle" : "doc.text")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            if index > 0 { RowDivider(inset: 28) }
                            LogRow(entry: entry, isExpanded: screen.expanded.contains(entry.id)) {
                                if screen.expanded.contains(entry.id) { screen.expanded.remove(entry.id) } else { screen.expanded.insert(entry.id) }
                            }
                        }
                    }
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
            }
        }
    }
}

private struct LogRow: View {
    let entry: LogEntry
    let isExpanded: Bool
    let toggle: () -> Void

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.dateFormat = "d MMM HH:mm:ss"
        return formatter
    }()

    private var isMultiline: Bool { entry.message.contains("\n") || entry.message.count > 140 }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: entry.isError ? "exclamationmark.triangle.fill" : "circle.fill")
                .font(.system(size: entry.isError ? 11 : 4))
                .foregroundStyle(entry.isError ? Color.orange : Color.secondary.opacity(0.5))
                .frame(width: 12)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.date.map { Self.time.string(from: $0) } ?? "")
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(entry.message)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(entry.isError ? Color.primary : Color.primary.opacity(0.85))
                    .lineLimit(isExpanded ? nil : 2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if isMultiline {
                Button(action: toggle) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                        .foregroundStyle(.tertiary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(isExpanded ? "Свернуть" : "Показать целиком")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(entry.isError ? Color.orange.opacity(0.06) : .clear)
    }
}
