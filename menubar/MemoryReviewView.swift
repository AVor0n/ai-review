import SwiftUI

// Вкладка «Разбор» в листе памяти: модель предлагает план, человек смотрит его и применяет кнопкой под панелью
struct MemoryReviewPanel: View {
    @EnvironmentObject private var model: AppModel
    let slug: String

    private static let groups = [("merge", "Склеить"), ("rewrite", "Переписать"), ("drop", "Удалить")]

    private var plan: MemoryPlan? { model.memoryPlans[slug] }

    // Файл памяти правят и руками, id могут повториться — берём первый
    private var texts: [String: String] {
        Dictionary((model.memory[slug] ?? []).map { ($0.id, $0.text) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let error = model.memoryReviewErrors[slug] {
                    errorCard(error)
                }
                if let started = model.memoryReviewing[slug] {
                    progress(started)
                } else if let plan {
                    planView(plan)
                } else {
                    if let applied = model.memoryApplied[slug] {
                        Label(applied, systemImage: "checkmark.circle.fill")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(ChartColors.addressed)
                    }
                    intro
                }
            }
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "wand.and.stars")
                    .font(.system(size: 22))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Разобрать память").font(.system(size: 13, weight: .semibold))
                    Text("Модель просмотрит правила вместе с их срабатываниями и предложит склеить дубли, переписать размытые и удалить бесполезные: детали одного PR, общие истины и правила про код, которого больше нет в основной ветке. Пока вы не примените план, память не меняется.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("Займёт 1–3 минуты и стоит около $0.1–0.2. Правила, добавленные или исправленные вручную, разбор не трогает.")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func progress(_ started: Date) -> some View {
        HStack(alignment: .top, spacing: 10) {
            FlippingHourglass().foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("Идёт разбор · \(FixTimeline.duration(context.date.timeIntervalSince(started)))")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.blue)
                }
                Text("Обычно 1–3 минуты. Лист можно закрыть: разбор продолжится, а план появится здесь.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func errorCard(_ error: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Не получилось", systemImage: "exclamationmark.triangle.fill")
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

    private func planView(_ plan: MemoryPlan) -> some View {
        let counts = plan.counts
        let meta = [
            "Разбор \(Dates.ago(plan.at))",
            plan.usage?.costUsd.map { String(format: "$%.2f", $0) },
            "правил \(counts.before) → \(counts.after)",
        ].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(meta)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(inlineMarkdown(plan.summary))
                    .font(.system(size: 13))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if plan.outdated == true {
                    Label("Память изменилась после разбора — этот план уже не применить. Запустите разбор заново.", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            ForEach(Self.groups, id: \.0) { type, title in
                let actions = plan.group(type)
                if !actions.isEmpty {
                    GroupedSection("\(title) · \(actions.count)") {
                        ForEach(Array(actions.enumerated()), id: \.offset) { index, action in
                            if index > 0 { RowDivider() }
                            actionRow(action)
                        }
                    }
                }
            }

            let kept = plan.group("keep").reduce(0) { $0 + $1.ids.count }
            Text(plan.changes == 0 ? "Менять нечего: все правила остаются как есть." : "Без изменений: \(kept)")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
        }
    }

    private func actionRow(_ action: MemoryPlan.Action) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(inlineMarkdown(action.reason))
                .font(.system(size: 12, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            if action.type == "drop" {
                ForEach(action.ids, id: \.self) { id in
                    Text(inlineMarkdown(lessonText(id)))
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .strikethrough()
                }
            } else {
                ChangeDiff(before: action.ids.map(lessonText), after: action.text)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private func lessonText(_ id: String) -> String { texts[id] ?? "(правила \(id) уже нет в памяти)" }
}

// Правила и причины модель пишет с `кодом` и **жирным**
func inlineMarkdown(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
}

// «Было» и «станет» с подсветкой слов: в «было» — чего не осталось, в «станет» — что появилось.
// У склеенного правила «было» несколько, и новое сравнивается с ними всеми подряд
struct ChangeDiff: View {
    let before: [String]
    let after: String

    var body: some View {
        let afterWords = WordDiff.words(after)
        let sourceWords = before.map(WordDiff.words)
        let kept = WordDiff.common(sourceWords.flatMap { $0 }, afterWords).b
        VStack(alignment: .leading, spacing: 6) {
            labeled("было") {
                ForEach(Array(sourceWords.enumerated()), id: \.offset) { _, words in
                    Text(WordDiff.render(words, kept: WordDiff.common(words, afterWords).a, highlight: .red))
                        .foregroundColor(.secondary)
                }
            }
            labeled("станет") {
                Text(WordDiff.render(afterWords, kept: kept, highlight: .green))
            }
        }
    }

    private func labeled<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
                .frame(width: 52, alignment: .leading)
            VStack(alignment: .leading, spacing: 4) { content() }
                .font(.system(size: 12))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// Пословная разница по наибольшей общей подпоследовательности; слово — вместе с пробелами после него,
// чтобы текст собирался обратно без потерь
enum WordDiff {
    static func words(_ text: String) -> [String] {
        var result: [String] = []
        var current = ""
        for character in text {
            if !character.isWhitespace, current.last?.isWhitespace == true {
                result.append(current)
                current = ""
            }
            current.append(character)
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    // Индексы слов a и b, которые вошли в общую подпоследовательность
    static func common(_ a: [String], _ b: [String]) -> (a: Set<Int>, b: Set<Int>) {
        let x = a.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let y = b.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        var lengths = Array(repeating: Array(repeating: 0, count: y.count + 1), count: x.count + 1)
        for i in stride(from: x.count - 1, through: 0, by: -1) {
            for j in stride(from: y.count - 1, through: 0, by: -1) {
                lengths[i][j] = x[i] == y[j] ? lengths[i + 1][j + 1] + 1 : max(lengths[i + 1][j], lengths[i][j + 1])
            }
        }
        var i = 0, j = 0
        var keptA = Set<Int>(), keptB = Set<Int>()
        while i < x.count, j < y.count {
            if x[i] == y[j] {
                keptA.insert(i)
                keptB.insert(j)
                i += 1
                j += 1
            } else if lengths[i + 1][j] >= lengths[i][j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        return (keptA, keptB)
    }

    // Markdown здесь не разобрать: подсветка режет `код` на части. Поэтому обратные кавычки обрабатываем сами — переключают моноширинный шрифт
    static func render(_ words: [String], kept: Set<Int>, highlight: Color, size: CGFloat = 12) -> AttributedString {
        var result = AttributedString()
        var code = false
        for (index, word) in words.enumerated() {
            let spaces = word.reversed().prefix(while: \.isWhitespace).count
            let core = word.dropLast(spaces)
            let changed = !kept.contains(index)
            var segment = ""
            func flush(marked: Bool) {
                guard !segment.isEmpty else { return }
                var run = AttributedString(segment)
                if code { run.font = .system(size: size, design: .monospaced) }
                if marked { run.backgroundColor = highlight.opacity(0.2) }
                result += run
                segment = ""
            }
            for character in core {
                if character == "`" {
                    flush(marked: changed)
                    code.toggle()
                } else {
                    segment.append(character)
                }
            }
            flush(marked: changed)
            // Пробел между двумя изменёнными словами тоже подсвечен: правка читается одним куском, а не пятнами
            segment = String(word.suffix(spaces))
            flush(marked: changed && index + 1 < words.count && !kept.contains(index + 1))
        }
        return result
    }
}
