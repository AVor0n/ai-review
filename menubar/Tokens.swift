import AppKit
import Security

struct BitbucketConfig: Decodable {
    let email: String?
    let keychainService: String?
    let tokenLifetimeDays: Int?
}

// Токен для фоновых запусков. Срок в самом токене не прочитать, поэтому он считается от даты сохранения в Keychain
// и срока, выбранного при выпуске: после сохранения нового токена дата обновляется сама
struct TokenInfo: Identifiable {
    enum Issue {
        case url(URL)
        case command(String)
    }

    let id: String
    let title: String
    let service: String
    let account: String
    let savedAt: Date?
    // nil — срок не указан, 0 — без срока
    let lifetimeDays: Int?
    let issue: Issue

    static let warningDays = 14
    // Atlassian и `claude setup-token` по умолчанию выпускают токены на год; у Cursor срок выбирается при выпуске
    private static let defaultLifetime = ["bitbucket": 365, "claude": 365]

    var expiresAt: Date? {
        guard let savedAt, let lifetimeDays, lifetimeDays > 0 else { return nil }
        return Calendar.current.date(byAdding: .day, value: lifetimeDays, to: savedAt)
    }

    var daysLeft: Int? {
        guard let expiresAt else { return nil }
        let calendar = Calendar.current
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: Date()), to: calendar.startOfDay(for: expiresAt)).day
    }

    // Год — только если не текущий: «до 20 окт.», но «до 8 окт. 2027 г.»
    static func date(_ date: Date) -> String {
        let style = Date.FormatStyle(locale: Locale(identifier: "ru_RU")).day().month(.abbreviated)
        let sameYear = Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
        return date.formatted(sameYear ? style : style.year())
    }

    var isExpired: Bool { expiresAt.map { $0 <= Date() } ?? false }
    var isExpiring: Bool { daysLeft.map { $0 <= Self.warningDays } ?? false }

    // Значение не попадает в историю шелла и не обрезается: у интерактивного `security … -w` предел 128 символов
    var saveCommand: String {
        "read -rs 'TOKEN?Токен \(title): ' && security add-generic-password -U -s \(service) -a \(account) -T /usr/bin/security -w \"$TOKEN\"; unset TOKEN"
    }

    static func load(_ config: AppConfig) -> [TokenInfo] {
        var tokens: [TokenInfo] = []
        if let bitbucket = config.bitbucket, let service = bitbucket.keychainService {
            let saved = Keychain.attributes(service: service)
            tokens.append(TokenInfo(
                id: "bitbucket", title: "Bitbucket", service: service,
                account: bitbucket.email ?? saved?.account ?? NSUserName(), savedAt: saved?.modified,
                lifetimeDays: bitbucket.tokenLifetimeDays ?? defaultLifetime["bitbucket"],
                issue: .url(URL(string: "https://id.atlassian.com/manage-profile/security/api-tokens")!)
            ))
        }
        for id in ["claude", "codex", "cursor"] {
            guard let agent = config.agents[id], let service = agent.keychainService else { continue }
            let saved = Keychain.attributes(service: service)
            let issue: Issue = id == "cursor"
                ? .url(URL(string: "https://cursor.com/dashboard?tab=integrations")!)
                : .command("claude setup-token")
            tokens.append(TokenInfo(
                id: id, title: agent.shortName, service: service,
                account: saved?.account ?? (id == "claude" ? "claude" : NSUserName()), savedAt: saved?.modified,
                lifetimeDays: agent.tokenLifetimeDays ?? defaultLifetime[id], issue: issue
            ))
        }
        return tokens
    }
}

enum Keychain {
    // Только атрибуты записи, без значения: такой запрос не спрашивает доступ к Keychain
    static func attributes(service: String) -> (account: String?, modified: Date?)? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let item = result as? [String: Any] else { return nil }
        return (item[kSecAttrAccount as String] as? String, item[kSecAttrModificationDate as String] as? Date)
    }
}

func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
