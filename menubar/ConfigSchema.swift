import Foundation

// schema/config.schema.json — та же схема, что подхватывает VS Code через "$schema" в конфиге.
// Встроенный редактор берёт из неё описание поля под курсором и проверку перед сохранением.
// Поддержано подмножество JSON Schema, которое схема использует: type, enum, minimum/maximum,
// required, properties, additionalProperties, items, $ref на definitions и format: regex
struct ConfigSchema {
    private let root: [String: Any]

    static func load() -> ConfigSchema? {
        let url = Paths.config.deletingLastPathComponent().appendingPathComponent("schema/config.schema.json")
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return ConfigSchema(root: root)
    }

    private func resolve(_ node: [String: Any]) -> [String: Any] {
        guard let ref = node["$ref"] as? String,
              let name = ref.split(separator: "/").last,
              let definition = (root["definitions"] as? [String: Any])?[String(name)] as? [String: Any] else { return node }
        return definition.merging(node.filter { $0.key != "$ref" }) { _, own in own }
    }

    // key == nil — элемент массива
    private func child(_ node: [String: Any], key: String?) -> [String: Any]? {
        let node = resolve(node)
        guard let key else { return node["items"] as? [String: Any] }
        return (node["properties"] as? [String: Any])?[key] as? [String: Any] ?? node["additionalProperties"] as? [String: Any]
    }

    // У элемента массива или вложенного поля без своего описания показываем описание ближайшего родителя
    func description(at path: [String?]) -> String? {
        var node: [String: Any]? = root
        var found: String?
        for key in path {
            node = node.flatMap { child($0, key: key) }.map(resolve)
            found = node?["description"] as? String ?? found
        }
        return found
    }

    func validate(_ value: Any) -> [String] {
        var problems: [String] = []
        check(value, root, "", &problems)
        return problems
    }

    private static func typeName(_ value: Any) -> String {
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return "boolean" }
            return number.doubleValue.rounded() == number.doubleValue ? "integer" : "number"
        }
        if value is String { return "string" }
        if value is [Any] { return "array" }
        if value is [String: Any] { return "object" }
        return "null"
    }

    private static let typeTitles = ["string": "строка", "integer": "целое число", "number": "число", "boolean": "true или false", "object": "объект", "array": "массив"]

    private func check(_ value: Any, _ schema: [String: Any], _ path: String, _ problems: inout [String]) {
        let schema = resolve(schema)
        let name = path.isEmpty ? "конфиг" : path
        let type = Self.typeName(value)
        if let options = schema["enum"] as? [String], !options.contains(value as? String ?? "\u{0}") {
            problems.append("\(name): допустимо \(options.joined(separator: ", "))")
        }
        if let expected = schema["type"] as? String, expected != type, !(expected == "number" && type == "integer") {
            problems.append("\(name): нужно \(Self.typeTitles[expected] ?? expected)")
            return
        }
        if let number = value as? NSNumber, type != "boolean" {
            if let minimum = schema["minimum"] as? Double, number.doubleValue < minimum { problems.append("\(name): не меньше \(Int(minimum))") }
            if let maximum = schema["maximum"] as? Double, number.doubleValue > maximum { problems.append("\(name): не больше \(Int(maximum))") }
        }
        if schema["format"] as? String == "regex", let pattern = value as? String, (try? NSRegularExpression(pattern: pattern)) == nil {
            problems.append("\(name): неверное регулярное выражение")
        }
        if let object = value as? [String: Any] {
            for key in schema["required"] as? [String] ?? [] where object[key] == nil {
                problems.append("\(name): нет поля \(key)")
            }
            for key in object.keys.sorted() {
                let childPath = path.isEmpty ? key : "\(path).\(key)"
                if let sub = child(schema, key: key) {
                    check(object[key]!, sub, childPath, &problems)
                } else if schema["additionalProperties"] as? Bool == false {
                    problems.append("\(childPath): неизвестное поле")
                }
            }
        }
        if let array = value as? [Any], let items = schema["items"] as? [String: Any] {
            for (index, item) in array.enumerated() { check(item, items, "\(path)[\(index)]", &problems) }
        }
    }

    // Путь к полю, на котором стоит курсор: ключи объектов и nil для элементов массивов.
    // Лёгкий проход по тексту до курсора — работает и на недописанном JSON
    static func path(in text: String, at caret: Int) -> [String?] {
        enum Frame { case object(String?), array }
        let chars = Array(text.utf16)
        var stack: [Frame] = []
        var expectKey = false
        var index = 0
        while index < min(caret, chars.count) {
            switch chars[index] {
            case 0x22:
                var end = index + 1
                var unit: [UInt16] = []
                while end < chars.count, chars[end] != 0x22 {
                    if chars[end] == 0x5C { end += 1 }
                    if end < chars.count { unit.append(chars[end]) }
                    end += 1
                }
                if expectKey, case .object = stack.last {
                    stack[stack.count - 1] = .object(String(utf16CodeUnits: unit, count: unit.count))
                    expectKey = false
                }
                index = end
            case 0x7B:
                stack.append(.object(nil))
                expectKey = true
            case 0x5B:
                stack.append(.array)
            case 0x7D, 0x5D:
                if !stack.isEmpty { stack.removeLast() }
            case 0x2C:
                if case .object = stack.last {
                    stack[stack.count - 1] = .object(nil)
                    expectKey = true
                }
            default:
                break
            }
            index += 1
        }
        var path: [String?] = []
        for frame in stack {
            switch frame {
            case .object(let key):
                guard let key else { return path }
                path.append(key)
            case .array:
                path.append(nil)
            }
        }
        return path
    }

    static func title(_ path: [String?]) -> String {
        path.reduce("") { result, key in
            guard let key else { return result + "[]" }
            return result.isEmpty ? key : "\(result).\(key)"
        }
    }
}
