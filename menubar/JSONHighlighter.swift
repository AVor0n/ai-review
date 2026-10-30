import AppKit

// Подсветка JSON во встроенном редакторе конфига: серая гамма и два акцента — числа синие, true/false янтарные.
// Красятся только атрибуты, текст не меняется, поэтому разбор нестрогий и работает на недописанном JSON
enum JSONHighlighter {
    private static func color(_ light: UInt32, _ dark: UInt32) -> NSColor {
        func rgb(_ hex: UInt32) -> NSColor {
            NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        }
        return NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(dark) : rgb(light) }
    }

    // Чистый жёлтый на белом нечитаем (контраст 2.6), поэтому в светлой теме он янтарный
    private static let number = color(0x2a78d6, 0x5a9ef0)
    private static let boolean = color(0xb07800, 0xe8c15a)

    static func apply(to storage: NSTextStorage, font: NSFont) {
        let chars = Array(storage.string.utf16)
        storage.beginEditing()
        defer { storage.endEditing() }
        storage.setAttributes([.font: font, .foregroundColor: NSColor.labelColor], range: NSRange(location: 0, length: chars.count))
        func paint(_ start: Int, _ end: Int, _ color: NSColor) {
            storage.addAttribute(.foregroundColor, value: color, range: NSRange(location: start, length: end - start))
        }
        let digits: ClosedRange<UInt16> = 0x30...0x39
        let letters: ClosedRange<UInt16> = 0x61...0x7A
        var index = 0
        while index < chars.count {
            switch chars[index] {
            case 0x22:
                var end = index + 1
                while end < chars.count, chars[end] != 0x22, chars[end] != 0x0A {
                    if chars[end] == 0x5C { end += 1 }
                    end += 1
                }
                end = min(end + 1, chars.count)
                // Ключ от строкового значения отличает двоеточие после закрывающей кавычки
                var next = end
                while next < chars.count, chars[next] == 0x20 || chars[next] == 0x09 { next += 1 }
                if next >= chars.count || chars[next] != 0x3A { paint(index, end, .secondaryLabelColor) }
                index = end
            case 0x2D, digits:
                var end = index + 1
                while end < chars.count, digits.contains(chars[end]) || [0x2E, 0x65, 0x45, 0x2B, 0x2D].contains(chars[end]) { end += 1 }
                paint(index, end, number)
                index = end
            case letters:
                var end = index + 1
                while end < chars.count, letters.contains(chars[end]) { end += 1 }
                let word = String(utf16CodeUnits: Array(chars[index..<end]), count: end - index)
                paint(index, end, word == "true" || word == "false" ? boolean : .secondaryLabelColor)
                index = end
            case 0x7B, 0x7D, 0x5B, 0x5D, 0x2C, 0x3A:
                paint(index, index + 1, .tertiaryLabelColor)
                index += 1
            default:
                index += 1
            }
        }
    }
}
