import SwiftUI

// Плитка с ключевым числом: когда история — одна цифра, график не нужен
struct KpiTile: View {
    let title: String
    let value: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 26, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(detail ?? " ")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct FilterMenu: View {
    let icon: String
    let allTitle: String
    let options: [(value: String, title: String)]
    @Binding var selection: String

    private var title: String { options.first { $0.value == selection }?.title ?? allTitle }

    var body: some View {
        Menu {
            Button(allTitle) { selection = "" }
            Divider()
            ForEach(options, id: \.value) { option in
                Button(option.title) { selection = option.value }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
            }
            .font(.system(size: 12, weight: selection.isEmpty ? .regular : .semibold))
            .foregroundStyle(selection.isEmpty ? .secondary : .primary)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Theme.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

struct SectionTitle: View {
    let title: String
    let icon: String

    var body: some View {
        Label(title, systemImage: icon)
            .font(.system(size: 17, weight: .bold))
            .padding(.top, 6)
    }
}

struct LegendItem: View {
    let title: String
    let color: Color
    var count: Int?

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(title).foregroundStyle(.secondary)
            if let count { Text("\(count)").monospacedDigit() }
        }
        .font(.system(size: 11))
    }
}

struct FateRow: View {
    let name: String
    var agent: String?
    let fate: Fate

    private var parts: [(title: String, count: Int, color: Color)] {
        [
            ("Исправлено", fate.addressed, ChartColors.addressed),
            ("Отклонено", fate.dismissed, ChartColors.dismissed),
            ("Ждут правки", fate.waiting, ChartColors.waiting),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if let agent {
                    AgentMark(agent: agent)
                        .foregroundStyle(AgentMark.color(agent))
                        .frame(width: 12, height: 12)
                }
                Text(name).font(.system(size: 13, weight: .semibold))
                Spacer()
                if fate.closed > 0 {
                    Text("исправлено \(fate.addressed * 100 / fate.closed)% закрытых")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                Text("\(fate.total) замеч.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            // Между сегментами 2 точки фона, концы скруглены — без обводок
            GeometryReader { geometry in
                let visible = parts.filter { $0.count > 0 }
                let gaps = CGFloat(max(0, visible.count - 1)) * 2
                HStack(spacing: 2) {
                    ForEach(visible, id: \.title) { part in
                        Rectangle()
                            .fill(part.color)
                            .frame(width: max(3, (geometry.size.width - gaps) * CGFloat(part.count) / CGFloat(max(fate.total, 1))))
                    }
                }
            }
            .frame(height: 8)
            .clipShape(Capsule())
            HStack(spacing: 14) {
                ForEach(parts, id: \.title) { part in
                    LegendItem(title: part.title, color: part.color, count: part.count)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

struct ComparisonGroup: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 4)
            .background(Theme.background.opacity(0.5))
    }
}

struct ComparisonRow: View {
    static let columnWidth: CGFloat = 150
    let title: String
    let values: [String]
    // Разбивка замечаний по уровням под значением, каждый уровень своим цветом
    var levels: [[String: Int]]?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.system(size: 13))
            Spacer()
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                VStack(alignment: .trailing, spacing: 2) {
                    Text(value).font(.system(size: 13).monospacedDigit())
                    if let counts = levels?[index] {
                        HStack(spacing: 6) {
                            ForEach(Level.all.filter { (counts[$0] ?? 0) > 0 }, id: \.self) { level in
                                Text("\(level)×\(counts[level]!)")
                                    .font(.system(size: 10, weight: .medium).monospacedDigit())
                                    .foregroundStyle(ChartColors.level(level))
                            }
                        }
                    }
                }
                .frame(width: Self.columnWidth, alignment: .trailing)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// Строка с долей от целого: цветная точка, подпись, полоса доли и значение справа
struct ShareRow: View {
    let title: String
    var detail: String?
    let value: String
    let share: Double
    let color: Color

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 7) {
                Circle().fill(color).frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13)).lineLimit(1)
                    if let detail {
                        Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            .frame(width: 250, alignment: .leading)
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.track)
                    Capsule().fill(color).frame(width: share > 0 ? max(4, geometry.size.width * min(share, 1)) : 0)
                }
            }
            .frame(height: 8)
            Text(value)
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 90, alignment: .trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }
}

// Строка «подпись — значение» в маленьких карточках режимов
struct StatLine: View {
    let title: String
    let value: String
    var color: Color?

    var body: some View {
        HStack(spacing: 7) {
            if let color { Circle().fill(color).frame(width: 7, height: 7) }
            Text(title).font(.system(size: 13)).foregroundStyle(color == nil ? .primary : .secondary)
            Spacer(minLength: 8)
            Text(value).font(.system(size: 13, weight: color == nil ? .semibold : .regular).monospacedDigit())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }
}
