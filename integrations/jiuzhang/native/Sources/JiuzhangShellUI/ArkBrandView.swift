import SwiftUI

/// Shared native geometry keeps compact Ark branding sharp at every display scale.
struct ArkBrandView: View {
  enum Layout { case symbol, wordmark }

  let layout: Layout
  let size: CGFloat
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    ArkBrandShape(layout: layout)
      .fill(LinearGradient(
        colors: colorScheme == .dark
          ? [Color(red: 0.85, green: 0.87, blue: 0.90), Color(red: 0.65, green: 0.69, blue: 0.74)]
          : [Color(red: 0.26, green: 0.29, blue: 0.33), Color(red: 0.13, green: 0.16, blue: 0.20)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      ))
      .aspectRatio(layout == .wordmark ? 3 : 1, contentMode: .fit)
      .frame(width: layout == .wordmark ? size * 3.6 : size, height: size)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Ark")
  }
}

private struct ArkBrandShape: Shape {
  let layout: ArkBrandView.Layout

  func path(in rect: CGRect) -> Path {
    var path = Path()
    switch layout {
    case .wordmark:
      // Original letter contours, expressed on the artwork's 2172 × 724 canvas.
      path.move(to: CGPoint(x: 92, y: 538))
      path.addLine(to: CGPoint(x: 345, y: 216))
      path.addQuadCurve(to: CGPoint(x: 379, y: 198), control: CGPoint(x: 357, y: 198))
      path.addLine(to: CGPoint(x: 401, y: 198))
      path.addQuadCurve(to: CGPoint(x: 431, y: 216), control: CGPoint(x: 419, y: 198))
      path.addLine(to: CGPoint(x: 692, y: 538))
      path.addLine(to: CGPoint(x: 574, y: 538))
      path.addLine(to: CGPoint(x: 398, y: 295))
      path.addLine(to: CGPoint(x: 210, y: 538))
      path.closeSubpath()

      path.move(to: CGPoint(x: 798, y: 198))
      path.addLine(to: CGPoint(x: 1228, y: 198))
      path.addCurve(to: CGPoint(x: 1340, y: 307), control1: CGPoint(x: 1290, y: 198), control2: CGPoint(x: 1340, y: 245))
      path.addCurve(to: CGPoint(x: 1260, y: 412), control1: CGPoint(x: 1340, y: 363), control2: CGPoint(x: 1308, y: 399))
      path.addLine(to: CGPoint(x: 1340, y: 538))
      path.addLine(to: CGPoint(x: 1228, y: 538))
      path.addLine(to: CGPoint(x: 1110, y: 420))
      path.addLine(to: CGPoint(x: 956, y: 420))
      path.addLine(to: CGPoint(x: 900, y: 350))
      path.addLine(to: CGPoint(x: 1218, y: 350))
      path.addCurve(to: CGPoint(x: 1218, y: 272), control1: CGPoint(x: 1275, y: 350), control2: CGPoint(x: 1275, y: 272))
      path.addLine(to: CGPoint(x: 854, y: 272))
      path.closeSubpath()

      path.addRect(CGRect(x: 1525, y: 198, width: 94, height: 340))
      path.move(to: CGPoint(x: 1631, y: 368))
      path.addLine(to: CGPoint(x: 1890, y: 198))
      path.addLine(to: CGPoint(x: 2018, y: 198))
      path.addLine(to: CGPoint(x: 1760, y: 368))
      path.addLine(to: CGPoint(x: 2018, y: 538))
      path.addLine(to: CGPoint(x: 1890, y: 538))
      path.closeSubpath()
      return path.applying(CGAffineTransform(scaleX: rect.width / 2172, y: rect.height / 724)
        .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))

    case .symbol:
      // The two separate ribbon strokes remain recognizable without bitmap fringes.
      path.move(to: CGPoint(x: 150, y: 1005))
      path.addLine(to: CGPoint(x: 636, y: 308))
      path.addCurve(to: CGPoint(x: 737, y: 311), control1: CGPoint(x: 665, y: 265), control2: CGPoint(x: 708, y: 265))
      path.addLine(to: CGPoint(x: 822, y: 461))
      path.addCurve(to: CGPoint(x: 668, y: 531), control1: CGPoint(x: 760, y: 446), control2: CGPoint(x: 714, y: 470))
      path.addLine(to: CGPoint(x: 417, y: 914))
      path.addCurve(to: CGPoint(x: 258, y: 1005), control1: CGPoint(x: 373, y: 987), control2: CGPoint(x: 317, y: 1005))
      path.closeSubpath()

      path.move(to: CGPoint(x: 611, y: 687))
      path.addLine(to: CGPoint(x: 811, y: 687))
      path.addCurve(to: CGPoint(x: 919, y: 753), control1: CGPoint(x: 862, y: 687), control2: CGPoint(x: 891, y: 711))
      path.addLine(to: CGPoint(x: 1074, y: 1005))
      path.addLine(to: CGPoint(x: 913, y: 1005))
      path.addCurve(to: CGPoint(x: 787, y: 936), control1: CGPoint(x: 853, y: 1005), control2: CGPoint(x: 818, y: 986))
      path.addLine(to: CGPoint(x: 679, y: 761))
      path.addQuadCurve(to: CGPoint(x: 611, y: 687), control: CGPoint(x: 647, y: 708))
      path.closeSubpath()
      return path.applying(CGAffineTransform(scaleX: rect.width / 1254, y: rect.height / 1254)
        .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
  }
}
