import Combine
import ImageIO
import SwiftUI
import WebKit

enum QaText {
    static func kind(_ kind: String) -> String {
        switch kind {
        case "bug": "Исправление ошибки"
        case "feature": "Новая функциональность"
        case "refactor": "Переделка без изменения поведения"
        default: "Другое"
        }
    }

    static func source(_ source: String) -> (title: String, color: Color) {
        switch source {
        case "user": ("ваш", .accentColor)
        case "change": ("изменение", .secondary)
        case "regression": ("регрессия", .secondary)
        default: (source, .secondary)
        }
    }

    static func priority(_ priority: String) -> (title: String, color: Color) {
        switch priority {
        case "high": ("важный", .orange)
        case "medium": ("средний", .secondary)
        default: ("низкий", .secondary)
        }
    }

    // Уровни из стратегии тестирования репозитория; без уровня — кейс из плана до их появления, он проверялся в браузере
    static func level(_ level: String?) -> String {
        switch level ?? "e2e" {
        case "unit": "юнит"
        case "component": "компонентный"
        default: "e2e"
        }
    }

    static let statusOrder = ["failed", "unconfirmed", "blocked", "passed", "skipped"]

    static func status(_ status: String?) -> (title: String, icon: String, color: Color) {
        switch status {
        case "passed": ("Прошёл", "checkmark.circle.fill", .green)
        case "failed": ("Ошибка приложения", "xmark.octagon.fill", .red)
        case "blocked": ("Не удалось проверить", "nosign", .orange)
        case "skipped": ("Пропущен", "minus.circle.fill", .secondary)
        default: ("Не подтверждено", "questionmark.diamond.fill", .yellow)
        }
    }

    static func playwright(_ status: String?) -> String {
        switch status {
        case "passed": "прошёл"
        case "failed": "упал"
        case "timedOut": "вышел по таймауту"
        case "skipped": "пропущен"
        case nil: "теста нет"
        default: status ?? ""
        }
    }

    // Итог прогона одним цветом: ошибка приложения важнее неподтверждённых и заблокированных кейсов
    static func runColor(_ run: QaRun) -> Color {
        if run.count("failed") > 0 { return .red }
        if run.count("unconfirmed") + run.count("blocked") > 0 { return .orange }
        return .green
    }

    static func cases(_ count: Int) -> String {
        let tens = count % 100 / 10
        let ones = count % 10
        let word = tens == 1 ? "кейсов" : ones == 1 ? "кейс" : (2...4).contains(ones) ? "кейса" : "кейсов"
        return "\(count) \(word)"
    }
}

// Пробирка в строке PR: серая — тестирования не было, синяя — план готов, цветная — итог прогона
struct QaButton: View {
    let qa: QaState?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if qa?.state == "planning" || qa?.state == "running" {
                    // Иначе клик точно по индикатору забирает NSProgressIndicator и лист не открывается
                    ProgressView().controlSize(.mini).allowsHitTesting(false)
                } else {
                    Image(systemName: icon).font(.system(size: 13, weight: .medium))
                }
            }
            .foregroundStyle(tint)
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(hint)
    }

    private var icon: String {
        switch qa?.state {
        case "planning-queued", "run-queued": "clock"
        case "plan-failed", "failed": "exclamationmark.triangle"
        default: "testtube.2"
        }
    }

    private var tint: Color {
        switch qa?.state {
        case "planned": .accentColor
        case "plan-failed", "failed": .orange
        case "done": qa?.run.map(QaText.runColor) ?? .secondary
        default: .secondary
        }
    }

    private var hint: String {
        let error = qa?.error?.split(separator: "\n").last.map(String.init) ?? ""
        switch qa?.state {
        case "planning-queued": return "План тестирования в очереди"
        case "planning": return "Составляется план тестирования\(qa?.activity.map { ": \($0)" } ?? ""). Нажмите, чтобы посмотреть"
        case "planned": return "План тестирования готов: \(QaText.cases(qa?.plan?.cases.count ?? 0)). Нажмите, чтобы выбрать кейсы и запустить прогон"
        case "plan-failed": return "План тестирования не удался: \(error). Нажмите, чтобы посмотреть"
        case "run-queued": return "Прогон в очереди"
        case "running": return "Идёт прогон: \(qa?.step ?? "…")\(qa?.activity.map { " — \($0)" } ?? ""). Нажмите, чтобы посмотреть ход или прервать"
        case "failed": return "Прогон не удался: \(error). Нажмите, чтобы посмотреть"
        case "done":
            guard let run = qa?.run else { return "Прогон готов" }
            let counts = QaText.statusOrder.compactMap { status in
                run.count(status) > 0 ? "\(QaText.status(status).title.lowercased()) — \(run.count(status))" : nil
            }
            return "Прогон готов: \(counts.joined(separator: ", ")). Нажмите, чтобы посмотреть отчёт"
        default:
            return "Тестирование PR: Claude составит план — юнит, компонентные и e2e-кейсы, а после вашего выбора напишет и прогонит тесты (e2e — в Playwright на локальном бэкенде). Тесты можно сохранить в репозиторий, в PR ничего не публикуется"
        }
    }
}

enum QaTab: Hashable {
    case plan, report
}

// Поля и выбор листа; @State здесь недоступен (макрос), поэтому ObservableObject
final class QaForm: ObservableObject {
    @Published var note = ""
    @Published var extra = ""
    @Published var skipped: Set<String> = []
    @Published var expanded: Set<String> = []
    @Published var tab = QaTab.plan
    @Published var confirmRun = false
    @Published var copied = false
    var initialized = false
}

struct QaSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var form = QaForm()
    let target: FixTarget

    private var key: String { "\(target.repo)#\(target.pr.id)" }
    private var qa: QaState? { model.qa(repo: target.repo, pr: target.pr.id) }
    private var pr: PullRequest { model.snapshots[target.repo]?.prs.first { $0.id == target.pr.id } ?? target.pr }
    private var hasReport: Bool { qa?.run != nil || ["run-queued", "running", "failed"].contains(qa?.state ?? "") }

    private var extraCases: [String] {
        form.extra.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private var selectedCases: [QaCase] {
        (qa?.plan?.cases ?? []).filter { !form.skipped.contains($0.id) }
    }

    // Как needsBrowser в qa.mjs: свой кейс человека может оказаться e2e
    private var needsBrowser: Bool {
        !extraCases.isEmpty || selectedCases.contains { QaText.level($0.level) == "e2e" }
    }

    var body: some View {
        content
        .padding(20)
        .frame(width: 700, height: 560)
        .background(Theme.background)
        .onAppear {
            guard !form.initialized else { return }
            form.initialized = true
            form.note = qa?.note ?? ""
            form.tab = hasReport ? .report : .plan
        }
        .onChange(of: qa?.state) { _, state in
            switch state {
            case "run-queued", "running", "done", "failed": form.tab = .report
            case "planning-queued", "planning", "planned", "plan-failed": form.tab = .plan
            default: break
            }
        }
        .alert("Запустить прогон #\(String(pr.id))?", isPresented: $form.confirmRun) {
            Button("Запустить") {
                model.requestQaRun(repo: target.repo, pr: pr.id, skip: Array(form.skipped).sorted(), extra: extraCases, note: form.note)
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text(verbatim: needsBrowser
                ? "Займёт 30–60 минут и несколько долларов. Сервис соберёт образ бэкенда в Docker (первая сборка на коммит — ещё несколько минут), поднимет отдельное e2e-окружение и фронтенд из ветки PR, а Claude напишет и прогонит тесты: \(QaText.cases(selectedCases.count + extraCases.count)). Mac будет заметно нагружен. В PR ничего не публикуется."
                : "e2e-кейсов нет, поэтому Docker и браузер не понадобятся: Claude напишет и прогонит юнит и компонентные тесты на Vitest — \(QaText.cases(selectedCases.count)). Это быстрее и дешевле прогона с e2e. В PR ничего не публикуется.")
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: "Тестирование #\(pr.id)").font(.title3.weight(.semibold))
                    Text(pr.title).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 12)
                if hasReport && qa?.plan != nil {
                    SegmentedPicker(options: [QaTab.plan, .report], selection: $form.tab, title: { $0 == .plan ? "План" : "Отчёт" }, segmentWidth: 80)
                }
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

            if let qa {
                statusLine(qa)
            }
            if let error = model.qaErrors[key] {
                errorBox(error)
            }

            ScrollView {
                VStack(spacing: 14) {
                    if form.tab == .report && hasReport {
                        reportTab
                    } else {
                        planTab
                    }
                }
            }
            .frame(maxHeight: .infinity)

            buttons
        }
    }

    // MARK: Статус

    private func statusLine(_ qa: QaState) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            switch qa.state {
            case "planning-queued", "run-queued":
                Image(systemName: "clock").foregroundStyle(.secondary)
                Text(qa.state == "run-queued" ? "Прогон в очереди" : "План в очереди").foregroundStyle(.secondary)
            case "planning", "running":
                FlippingHourglass().foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 2) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text((qa.state == "planning" ? "Составляется план" : qa.step ?? "Идёт прогон")
                            + (Dates.parse(qa.startedAt).map { " · " + FixTimeline.duration(context.date.timeIntervalSince($0)) } ?? ""))
                            .foregroundStyle(.blue)
                    }
                    // Во время прогона действие видно в ходе прогона под текущим шагом
                    if let activity = qa.activity, qa.state == "planning" || qa.steps?.isEmpty != false {
                        Text(activity)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            case "planned":
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                Text("План готов: \(QaText.cases(qa.plan?.cases.count ?? 0)). Снимите лишние и запустите прогон")
            case "done":
                if let run = qa.run {
                    Image(systemName: "checkmark.seal.fill").foregroundStyle(QaText.runColor(run))
                    Text(run.count("failed") > 0 ? "Прогон готов, найдены ошибки" : run.count("passed") == run.cases.count ? "Прогон готов, все кейсы прошли" : "Прогон готов")
                }
            default:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(qa.state == "plan-failed" ? "План не удался" : "Прогон не удался").foregroundStyle(.orange)
            }
        }
        .font(.system(size: 13, weight: .medium))
    }

    // Ошибку сервиса показываем целиком, как он её написал: в ней обычно и причина, и что сделать
    private func errorBox(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(text)
                .font(text.contains("\n") ? .system(size: 11, design: .monospaced) : .system(size: 12))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func banner(_ title: String, _ text: String, icon: String = "clock.arrow.circlepath") -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12, weight: .semibold))
                Text(text)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // Голова в состоянии — первые 12 символов коммита, в снимке PR длину не закладываем
    private func sameCommit(_ a: String?, _ b: String) -> Bool {
        guard let a, !a.isEmpty, !b.isEmpty else { return true }
        return a.hasPrefix(b) || b.hasPrefix(a)
    }

    // MARK: План

    @ViewBuilder
    private var planTab: some View {
        if qa?.state == "plan-failed", let error = qa?.error {
            errorBox(error)
        }
        if let plan = qa?.plan {
            if !sameCommit(qa?.planHead, pr.head), qa?.isPlanning != true {
                banner("План устарел", "Он составлен на коммите \(qa?.planHead ?? ""), а в PR уже \(pr.head). Кейсы могли измениться — составьте план заново.")
            }
            planContent(plan)
            noteSection
        } else if qa?.isPlanning == true {
            Text("Claude читает дифф, описание, комментарии ревью и e2e-тесты репозитория. Обычно несколько минут.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            noteSection
        }
    }

    private var noteSection: some View {
        let hasPlan = qa?.plan != nil
        return GroupedSection("На что обратить внимание", footer: "Ваши кейсы и пожелания — модель поставит их в плане первыми. План — несколько минут и около доллара. Ничего не публикуется.") {
            VStack(alignment: .trailing, spacing: 8) {
                editor($form.note, prompt: "Например: проверь, что черновик не теряется при перезагрузке страницы")
                Button(hasPlan ? "Составить план заново" : "Составить план") {
                    model.requestQaPlan(repo: target.repo, pr: pr.id, note: form.note)
                }
                .disabled(qa?.isActive == true)
            }
            .padding(12)
        }
    }

    // TextEditor вместо TextField: в многострочном TextField Return отправляет форму, а здесь нужны переносы
    private func editor(_ text: Binding<String>, prompt: String) -> some View {
        TextEditor(text: text)
            .font(.system(size: 13))
            .scrollContentBackground(.hidden)
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
            .frame(height: 64)
            .background(Theme.background, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(alignment: .topLeading) {
                if text.wrappedValue.isEmpty {
                    Text(prompt)
                        .font(.system(size: 13))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .allowsHitTesting(false)
                }
            }
    }

    @ViewBuilder
    private func planContent(_ plan: QaPlan) -> some View {
        if !plan.testable {
            banner("Проверять нечего", "Модель считает, что изменения PR нечем проверить ни тестом, ни в приложении. Прогон можно запустить на своих кейсах.", icon: "eye.slash")
        }
        GroupedSection("Суть · \(QaText.kind(plan.kind))") {
            paragraph(plan.summary)
        }
        GroupedSection("Как должно работать") {
            paragraph(plan.expected)
        }
        if !plan.risks.isEmpty {
            GroupedSection("Опасные места · \(plan.risks.count)") {
                ForEach(Array(plan.risks.enumerated()), id: \.offset) { index, risk in
                    if index > 0 { RowDivider(inset: 34) }
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).font(.system(size: 12))
                        VStack(alignment: .leading, spacing: 2) {
                            markdown(risk.title).fontWeight(.medium)
                            if let path = risk.path, !path.isEmpty {
                                Text(path)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .textSelection(.enabled)
                            }
                            markdown(risk.details)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
        }
        GroupedSection("Кейсы · \(selectedCases.count) из \(plan.cases.count)", footer: plan.cases.isEmpty ? nil : "Снятые кейсы не проверяются. Нажмите на кейс, чтобы увидеть данные и шаги.") {
            if plan.cases.isEmpty {
                Text("Кейсов нет").font(.system(size: 13)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(12)
            }
            ForEach(Array(plan.cases.enumerated()), id: \.element.id) { index, item in
                if index > 0 { RowDivider(inset: 36) }
                planCaseRow(item)
            }
        }
        GroupedSection("Свои кейсы", footer: "Каждая строка — отдельный кейс. Шаги и проверку модель распишет сама, такие кейсы идут первыми.") {
            editor($form.extra, prompt: "Например: черновик открывается из меню «Анализы» после повторного входа")
                .padding(12)
        }
        if !plan.notTestable.isEmpty {
            GroupedSection("Не проверить · \(plan.notTestable.count)") {
                ForEach(Array(plan.notTestable.enumerated()), id: \.offset) { index, item in
                    if index > 0 { RowDivider(inset: 34) }
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "eye.slash").foregroundStyle(.secondary).font(.system(size: 12))
                        VStack(alignment: .leading, spacing: 2) {
                            markdown(item.what).fontWeight(.medium)
                            markdown(item.why).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
        }
        details([
            ("Коммит плана", qa?.planHead),
            ("Составлен", qa?.isPlanning == true ? nil : qa?.finishedAt.flatMap(Dates.parse).map { $0.formatted(date: .abbreviated, time: .shortened) }),
            ("Цена плана", qa?.usage?.costUsd.map { String(format: "$%.2f", $0) }),
        ])
    }

    private func planCaseRow(_ item: QaCase) -> some View {
        let expanded = form.expanded.contains(item.id)
        let selected = Binding(
            get: { !form.skipped.contains(item.id) },
            set: { if $0 { form.skipped.remove(item.id) } else { form.skipped.insert(item.id) } }
        )
        return HStack(alignment: .top, spacing: 10) {
            Toggle("", isOn: selected)
                .toggleStyle(.checkbox)
                .labelsHidden()
                .disabled(qa?.isActive == true)
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) {
                        if expanded { form.expanded.remove(item.id) } else { form.expanded.insert(item.id) }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(verbatim: item.id).font(.system(size: 13).monospacedDigit()).foregroundStyle(.secondary)
                            markdown(item.title).fontWeight(.medium)
                            Spacer(minLength: 8)
                            caseTags(item)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(expanded ? 90 : 0))
                        }
                        if !expanded, let expect = item.expect, !expect.isEmpty {
                            markdown(expect).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if expanded {
                    caseDetails(item)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .opacity(selected.wrappedValue ? 1 : 0.5)
    }

    private func caseTags(_ item: QaCase) -> some View {
        HStack(spacing: 4) {
            Tag(text: QaText.level(item.level), color: .indigo)
            let source = QaText.source(item.source)
            Tag(text: source.title, color: source.color)
            let priority = QaText.priority(item.priority)
            Tag(text: priority.title, color: priority.color)
        }
    }

    @ViewBuilder
    private func caseDetails(_ item: QaCase) -> some View {
        if let target = item.target, !target.isEmpty {
            path("Проверяемый файл", target)
        }
        if let preconditions = item.preconditions, !preconditions.isEmpty {
            labeled("Данные", preconditions)
        }
        if !item.steps.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text("Шаги").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                ForEach(Array(item.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: "\(index + 1).").font(.system(size: 13).monospacedDigit()).foregroundStyle(.secondary)
                        markdown(step)
                    }
                }
            }
        }
        if let expect = item.expect, !expect.isEmpty {
            labeled("Ожидается", expect)
        }
    }

    private func path(_ title: String, _ path: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            Text(path)
                .font(.system(size: 12, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
    }

    private func labeled(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            markdown(text).fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Отчёт

    @ViewBuilder
    private var reportTab: some View {
        if let qa {
            if let steps = qa.steps, !steps.isEmpty, qa.state == "running" || qa.state == "failed" {
                FixTimeline(title: "Ход прогона", steps: steps, isActive: qa.state == "running", failed: qa.state == "failed", finishedAt: qa.finishedAt, activity: qa.activity)
            }
            if qa.state == "failed", let error = qa.error {
                errorBox(error)
            }
            if let run = qa.run {
                if qa.state != "done" {
                    Text("Ниже — отчёт прошлого прогона")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                report(run)
            } else if qa.state == "run-queued" {
                Text("Прогон начнётся, когда освободится очередь тестирования.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private func report(_ run: QaRun) -> some View {
        if let planHead = run.planHead, !sameCommit(planHead, run.head) {
            banner("План и прогон на разных коммитах", "План составлен на \(planHead), а прогон шёл на \(run.head).")
        }
        if !sameCommit(run.head, pr.head) {
            banner("Отчёт устарел", "Прогон шёл на коммите \(run.head), а в PR уже \(pr.head).")
        }
        GroupedSection("Итог") {
            VStack(alignment: .leading, spacing: 10) {
                if !run.summary.isEmpty {
                    markdown(run.summary).fixedSize(horizontal: false, vertical: true)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 12, alignment: .leading)], alignment: .leading, spacing: 6) {
                    ForEach(QaText.statusOrder.filter { run.count($0) > 0 }, id: \.self) { status in
                        let info = QaText.status(status)
                        HStack(spacing: 6) {
                            Image(systemName: info.icon).foregroundStyle(info.color)
                            Text(verbatim: "\(run.count(status))").monospacedDigit()
                            Text(info.title).foregroundStyle(.secondary)
                        }
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        if let envNotes = run.envNotes, !envNotes.isEmpty {
            GroupedSection("Окружение") { paragraph(envNotes) }
        }
        GroupedSection("Кейсы · \(run.cases.count)") {
            ForEach(Array(run.cases.enumerated()), id: \.element.id) { index, item in
                if index > 0 { RowDivider(inset: 36) }
                runCaseRow(item, runDir: URL(fileURLWithPath: run.runDir, isDirectory: true))
            }
        }
        if let tests = run.tests, !tests.isEmpty {
            testsSection(tests, saved: run.saved, prBranch: run.branch)
        }
        details([
            ("Фронтенд", run.head),
            ("Бэкенд", run.backend.map { "\($0.ref.replacingOccurrences(of: "origin/", with: "")) · \($0.commit)" }),
            ("Снят", qa?.finishedAt.flatMap(Dates.parse).map { $0.formatted(date: .abbreviated, time: .shortened) }),
            ("Цена и время", [
                run.usage?.costUsd.map { String(format: "$%.2f", $0) },
                run.durationSec.map { FixTimeline.duration(TimeInterval($0)) },
            ].compactMap { $0 }.joined(separator: " · ")),
            ("Папка прогона", run.runDir),
        ])
    }

    // Тесты прогона и их места в репозитории; «Сохранить» кладёт их в локальную копию без коммита (qa save)
    private func testsSection(_ tests: [QaTest], saved: QaSaved?, prBranch: String?) -> some View {
        let saving = model.qaSaving.contains(key)
        let repoName = URL(fileURLWithPath: saved?.checkout ?? target.repo).lastPathComponent
        return GroupedSection("Тесты · \(tests.count)", footer: "Тесты сохраняются в локальную копию \(target.repo) по местам из стратегии тестирования, без коммита. Занятый файл не перезаписывается: тест ляжет рядом с суффиксом .pr\(pr.id). e2e-тесты написаны на authenticatedTest — для сценариев, меняющих данные, стратегия требует фикстуру test со сбросом БД.") {
            ForEach(Array(tests.enumerated()), id: \.offset) { index, test in
                if index > 0 { RowDivider(inset: 34) }
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "doc.text").foregroundStyle(.secondary).font(.system(size: 12))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(test.target)
                            .font(.system(size: 12, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                        Text(verbatim: "\(QaText.level(test.level)) · \(test.cases.joined(separator: ", "))")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            RowDivider()
            HStack(alignment: .top, spacing: 10) {
                if let saved {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.system(size: 13))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Сохранены \(Dates.ago(saved.at)) в \(repoName)\(saved.branch.map { " · ветка \($0)" } ?? "")")
                            .font(.system(size: 12, weight: .medium))
                        ForEach(saved.files.filter { $0.path != $0.wanted }, id: \.path) { file in
                            Text("\(file.wanted) уже был — сохранён как \(file.path)")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                        if let prBranch = saved.prBranch ?? prBranch, saved.branch != prBranch {
                            Text("Копия на другой ветке, а PR — \(prBranch): тесты написаны под код PR и до переключения могут не пройти.")
                                .font(.system(size: 11))
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    Text("Ещё не сохранены").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if saving {
                    ProgressView().controlSize(.small)
                }
                Button(saved == nil ? "Сохранить в \(target.repo)" : "Сохранить снова") {
                    model.saveQaTests(repo: target.repo, pr: pr.id)
                }
                .disabled(saving || qa?.isActive == true)
                if let saved {
                    Button("Показать") {
                        let urls = saved.files.map { URL(fileURLWithPath: saved.checkout).appendingPathComponent($0.path) }
                        NSWorkspace.shared.activateFileViewerSelecting(urls)
                    }
                }
            }
            .padding(12)
        }
    }

    private func runCaseRow(_ item: QaCase, runDir: URL) -> some View {
        let status = QaText.status(item.status)
        let files = (item.evidence?.files ?? []).map { runDir.appendingPathComponent($0) }
        let media = files.filter { ["png", "webm"].contains($0.pathExtension.lowercased()) }
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: status.icon).foregroundStyle(status.color).font(.system(size: 14)).frame(width: 16)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: item.id).font(.system(size: 13).monospacedDigit()).foregroundStyle(.secondary)
                        markdown(item.title).fontWeight(.medium)
                        Spacer(minLength: 8)
                        caseTags(item)
                    }
                    Text(status.title).font(.system(size: 12, weight: .medium)).foregroundStyle(status.color == .yellow ? .primary : status.color)
                }
                if let test = item.savePath ?? item.evidence?.specFile, !test.isEmpty {
                    path("Тест", test)
                }
                if let checked = item.checked, !checked.isEmpty {
                    labeled("Проверено", checked)
                }
                if let bug = item.bug {
                    VStack(alignment: .leading, spacing: 4) {
                        Label { markdown(bug.title).fontWeight(.semibold) } icon: { Image(systemName: "ladybug.fill").foregroundStyle(.red) }
                        markdown(bug.details).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                if let notes = item.notes, !notes.isEmpty {
                    labeled("Заметки", notes)
                }
                if item.status == "unconfirmed" {
                    Text(verbatim: "Модель сообщила «\(item.claimed.map { QaText.status($0).title.lowercased() } ?? "нет ответа")», а итоговый прогон Playwright — «\(QaText.playwright(item.evidence?.status))».")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let errors = item.evidence?.errors, !errors.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ошибки Playwright").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                        Text(errors.joined(separator: "\n\n"))
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.background, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
                if !media.isEmpty {
                    gallery(media)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func gallery(_ files: [URL]) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), alignment: .leading, spacing: 8) {
            ForEach(Array(files.enumerated()), id: \.offset) { index, url in
                Button { QaMediaWindow.shared.show(files: files, index: index) } label: {
                    QaThumbnail(url: url)
                }
                .buttonStyle(.plain)
                .help(url.lastPathComponent)
            }
        }
    }

    // MARK: Общее

    private func details(_ rows: [(String, String?)]) -> some View {
        let rows = rows.compactMap { title, value in value.flatMap { $0.isEmpty ? nil : (title, $0) } }
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
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
    }

    // Поля плана и отчёта — markdown без заголовков: обратные кавычки и выделение рендерятся
    private func markdown(_ text: String) -> Text {
        Text(LocalizedStringKey(text)).font(.system(size: 13))
    }

    private var buttons: some View {
        let onReport = form.tab == .report && hasReport
        return HStack {
            if let url = URL(string: pr.url) {
                Button("Открыть PR") { NSWorkspace.shared.open(url) }
            }
            Button(form.copied ? "Скопировано" : onReport ? "Скопировать отчёт" : "Скопировать план") {
                model.copyQaReport(repo: target.repo, pr: pr.id, plan: !onReport) { success in
                    guard success else { return }
                    form.copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { form.copied = false }
                }
            }
            .disabled(onReport ? qa?.run == nil : qa?.plan == nil)
            if onReport, let run = qa?.run {
                Button("Открыть папку прогона") {
                    NSWorkspace.shared.open(URL(fileURLWithPath: run.runDir, isDirectory: true))
                }
            }
            Spacer()
            if qa?.state == "planning" || qa?.state == "running" {
                Button("Прервать", role: .destructive) { model.stopQa() }
            } else if onReport {
                Button("Новый прогон…") { form.tab = .plan }
                    .disabled(qa?.plan == nil || qa?.isActive == true)
            } else if qa?.plan != nil {
                Button("Запустить прогон…") { form.confirmRun = true }
                    .keyboardShortcut(.defaultAction)
                    .disabled(qa?.isActive == true || selectedCases.isEmpty && extraCases.isEmpty)
                    .help(needsBrowser ? "30–60 минут и несколько долларов: сборка бэкенда в Docker, отдельное e2e-окружение, тесты по выбранным кейсам" : "Юнит и компонентные тесты на Vitest, без Docker и браузера")
            }
        }
    }
}

// Превью уменьшаются через ImageIO: полноразмерный скриншот Playwright 1600×900 занял бы в памяти мегабайты
enum QaThumbnails {
    private static let cache = NSCache<NSURL, NSImage>()

    static func image(_ url: URL) -> NSImage? {
        if let cached = cache.object(forKey: url as NSURL) { return cached }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 480, kCGImageSourceCreateThumbnailWithTransform: true]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        cache.setObject(image, forKey: url as NSURL)
        return image
    }
}

struct QaThumbnail: View {
    let url: URL

    var body: some View {
        ZStack {
            Theme.track
            if url.pathExtension.lowercased() == "webm" {
                VStack(spacing: 4) {
                    Image(systemName: "play.circle.fill").font(.system(size: 24))
                    Text("Видео").font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(.secondary)
            } else if let image = QaThumbnails.image(url) {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "photo").foregroundStyle(.tertiary)
            }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.separator))
        .contentShape(Rectangle())
    }
}

// Файлы кейса для окна просмотра: скриншоты и видео листаются стрелками
final class QaMediaState: ObservableObject {
    @Published var files: [URL] = []
    @Published var index = 0
    // Скорость видео общая для всех файлов: при переходе к следующему видео сохраняется
    @Published var rate = 1.0

    var url: URL? { files.indices.contains(index) ? files[index] : nil }
    var isVideo: Bool { url?.pathExtension.lowercased() == "webm" }
}

// Скриншоты и видео в отдельном большом окне, как Quick Look. Поповер оно не закрывает:
// тот закрывается только кликом в другом приложении или по Esc в своём окне
@MainActor
final class QaMediaWindow: NSObject, NSWindowDelegate {
    static let shared = QaMediaWindow()

    private let state = QaMediaState()
    private var window: NSWindow?
    private var titleUpdates: AnyCancellable?

    func show(files: [URL], index: Int) {
        state.files = files
        state.index = index
        let source = NSApp.keyWindow
        let window = self.window ?? makeWindow()
        if source !== window {
            // Поповер и его лист висят выше обычных окон: без этого окно просмотра открылось бы под ними
            window.level = NSWindow.Level(rawValue: max(NSWindow.Level.normal.rawValue, (source?.level.rawValue ?? 0) + 1))
        }
        if !window.isVisible { place(window, on: source?.screen) }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    // Когда поповер закрыт, окну незачем висеть поверх чужих окон
    func lower() {
        window?.level = .normal
    }

    private func makeWindow() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 480, height: 320)
        window.delegate = self
        window.appearance = AppAppearance.current
        window.contentView = NSHostingView(rootView: QaMediaBrowser(state: state) { [weak window] in window?.close() })
        titleUpdates = state.$index.combineLatest(state.$files).sink { [weak window] index, files in
            guard files.indices.contains(index) else { return }
            window?.title = "\(files[index].lastPathComponent) — \(index + 1) из \(files.count)"
        }
        self.window = window
        return window
    }

    // Как Quick Look: почти весь экран, пропорции кадра Playwright 16:9 плюс панель снизу
    private func place(_ window: NSWindow, on screen: NSScreen?) {
        guard let frame = (screen ?? NSScreen.main)?.visibleFrame else { return }
        let width = min(frame.width * 0.85, (frame.height * 0.85 - 52) * 16 / 9)
        let size = NSSize(width: width, height: width * 9 / 16 + 52)
        window.setFrame(NSRect(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2, width: size.width, height: size.height), display: true)
    }

    func windowWillClose(_ notification: Notification) {
        // Иначе видео продолжило бы играть в закрытом окне
        state.files = []
    }
}

struct QaMediaBrowser: View {
    @ObservedObject var state: QaMediaState
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if let url = state.url {
                    if state.isVideo {
                        QaVideoView(url: url, rate: state.rate).id(url)
                    } else {
                        QaZoomableImage(url: url).id(url)
                    }
                }
            }
            HStack(spacing: 8) {
                Button { state.index -= 1 } label: { Image(systemName: "chevron.left") }
                    .keyboardShortcut(.leftArrow, modifiers: [])
                    .disabled(state.index <= 0)
                Button { state.index += 1 } label: { Image(systemName: "chevron.right") }
                    .keyboardShortcut(.rightArrow, modifiers: [])
                    .disabled(state.index >= state.files.count - 1)
                if state.isVideo {
                    SegmentedPicker(options: [0.5, 1, 1.5, 2], selection: $state.rate, title: { "\($0.formatted(.number.precision(.fractionLength(0...1))))×" }, segmentWidth: 48)
                        .help("Скорость видео")
                } else {
                    Text("Щипок или двойной клик — увеличить")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let url = state.url {
                    Button("Показать в Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    Button(state.isVideo ? "Открыть в другом приложении" : "Открыть в Просмотре") { NSWorkspace.shared.open(url) }
                }
                // Esc закрывает окно просмотра, а не поповер под ним
                Button("Закрыть", action: close)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 12)
            .frame(height: 52)
            .background(Theme.background)
        }
        .environment(\.locale, Locale(identifier: "ru_RU"))
    }
}

// Скриншот на весь размер окна с увеличением, как в Quick Look: щипок — масштаб, двойной клик — 1:1 или обратно по размеру окна
struct QaZoomableImage: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QaImageScrollView {
        let view = QaImageScrollView()
        view.image = NSImage(contentsOf: url)
        return view
    }

    func updateNSView(_ view: QaImageScrollView, context: Context) {}
}

final class QaImageScrollView: NSScrollView {
    private let imageView = QaImageDocumentView()
    // Пока человек не увеличил картинку сам, она вписывается в окно и при изменении его размера
    private var fitted = true

    var image: NSImage? {
        didSet {
            imageView.image = image
            imageView.frame = NSRect(origin: .zero, size: image?.size ?? .zero)
            fitted = true
            needsLayout = true
        }
    }

    init() {
        super.init(frame: .zero)
        contentView = QaCenteringClipView()
        documentView = imageView
        drawsBackground = false
        contentView.drawsBackground = false
        hasVerticalScroller = true
        hasHorizontalScroller = true
        autohidesScrollers = true
        allowsMagnification = true
        minMagnification = 0.05
        maxMagnification = 8
        imageView.toggleZoom = { [weak self] point in self?.toggleZoom(at: point) }
    }

    required init?(coder: NSCoder) { fatalError() }

    private var fitMagnification: CGFloat {
        guard let size = image?.size, size.width > 0, size.height > 0 else { return 1 }
        return min(contentSize.width / size.width, contentSize.height / size.height, 1)
    }

    override func layout() {
        super.layout()
        if fitted { magnification = fitMagnification }
    }

    override func magnify(with event: NSEvent) {
        fitted = false
        super.magnify(with: event)
    }

    private func toggleZoom(at point: NSPoint) {
        if fitted || magnification < 0.99 {
            fitted = false
            setMagnification(1, centeredAt: point)
        } else {
            fitted = true
            magnification = fitMagnification
        }
    }
}

final class QaImageDocumentView: NSImageView {
    var toggleZoom: ((NSPoint) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        imageScaling = .scaleAxesIndependently
    }

    required init?(coder: NSCoder) { fatalError() }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { toggleZoom?(convert(event.locationInWindow, from: nil)) } else { super.mouseDown(with: event) }
    }
}

// Картинка меньше окна стоит по центру, а не в левом нижнем углу
final class QaCenteringClipView: NSClipView {
    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var rect = super.constrainBoundsRect(proposedBounds)
        guard let document = documentView else { return rect }
        if rect.width > document.frame.width { rect.origin.x = (document.frame.width - rect.width) / 2 }
        if rect.height > document.frame.height { rect.origin.y = (document.frame.height - rect.height) / 2 }
        return rect
    }
}

// AVFoundation не играет webm от Playwright (VP8), а WebKit играет: видео показывается в WKWebView через <video>.
// Страница лежит во временной папке: из loadHTMLString с базой в ~/Library WebKit видео не читает,
// а встроенный плеер WebKit для открытого напрямую файла раскладывается криво
struct QaVideoView: NSViewRepresentable {
    let url: URL
    var rate = 1.0

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.underPageBackgroundColor = .black
        let html = """
        <!doctype html><meta charset="utf-8">
        <style>html,body{margin:0;height:100%;background:#000}video{display:block;width:100%;height:100%;object-fit:contain}</style>
        <video id="v" src="\(url.absoluteString)" controls autoplay muted playsinline></video>
        <script>v.defaultPlaybackRate = v.playbackRate = \(rate)</script>
        """
        let page = FileManager.default.temporaryDirectory.appendingPathComponent("pr-reviewer-video.html")
        do {
            try html.write(to: page, atomically: true, encoding: .utf8)
            view.loadFileURL(page, allowingReadAccessTo: URL(fileURLWithPath: "/"))
        } catch {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        // defaultPlaybackRate — чтобы скорость пережила перемотку в начало и повтор
        view.evaluateJavaScript("var v = document.getElementById('v'); if (v) { v.defaultPlaybackRate = v.playbackRate = \(rate) }")
    }
}
