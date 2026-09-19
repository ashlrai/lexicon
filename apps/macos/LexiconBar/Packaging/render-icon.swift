// Renders the app icon: a dark rounded square with the SF Symbol "waveform".
// Run by scripts/build-macos-app.sh as `swift render-icon.swift <out.png> [size]`.
// Draws into an explicit 1x bitmap so the output is exactly `size` pixels
// regardless of the display scale of the machine doing the build.
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: render-icon.swift <out.png> [size]\n".data(using: .utf8)!)
    exit(2)
}
let outPath = args[1]
let size = args.count >= 3 ? Int(args[2]) ?? 1024 : 1024

guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                 samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
    FileHandle.standardError.write("could not create bitmap\n".data(using: .utf8)!)
    exit(1)
}
rep.size = NSSize(width: size, height: size)

NSGraphicsContext.saveGraphicsState()
guard let context = NSGraphicsContext(bitmapImageRep: rep) else { exit(1) }
NSGraphicsContext.current = context
context.imageInterpolation = .high

let s = CGFloat(size)
// macOS icon grid: the artwork sits inside ~80% of the canvas.
let inset = s * 0.10
let rect = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
let path = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.2237, yRadius: rect.height * 0.2237)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.16, green: 0.17, blue: 0.22, alpha: 1),
    NSColor(calibratedRed: 0.07, green: 0.08, blue: 0.11, alpha: 1),
])
gradient?.draw(in: path, angle: -90)

let config = NSImage.SymbolConfiguration(pointSize: s * 0.50, weight: .medium)
    .applying(NSImage.SymbolConfiguration(paletteColors: [NSColor(calibratedRed: 0.55, green: 0.85, blue: 1.0, alpha: 1)]))
if let symbol = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)?.withSymbolConfiguration(config) {
    let symbolSize = symbol.size
    let scale = min(rect.width * 0.62 / symbolSize.width, rect.height * 0.62 / symbolSize.height)
    let drawSize = NSSize(width: symbolSize.width * scale, height: symbolSize.height * scale)
    let origin = NSPoint(x: rect.midX - drawSize.width / 2, y: rect.midY - drawSize.height / 2)
    symbol.draw(in: NSRect(origin: origin, size: drawSize), from: .zero, operation: .sourceOver, fraction: 1)
}

NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
do {
    try png.write(to: URL(fileURLWithPath: outPath))
} catch {
    FileHandle.standardError.write("write failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
