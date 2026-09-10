import AppKit
import ImageIO
import SwiftUI

/// Provider artwork is read only from the signed application resources and cached once.
@MainActor
private enum ArkProviderArtwork {
  private struct Manifest: Decodable { let providers: [String: String] }

  static let images: [String: NSImage] = {
    guard let directory = Bundle.main.resourceURL?.appendingPathComponent("ProviderIcons"),
          let data = try? Data(contentsOf: directory.appendingPathComponent("provenance.json")),
          let manifest = try? JSONDecoder().decode(Manifest.self, from: data)
    else { return [:] }
    var files: [String: NSImage] = [:]
    for filename in Set(manifest.providers.values) {
      guard filename.range(of: #"^[a-z0-9-]+\.png$"#, options: .regularExpression) != nil,
            let source = CGImageSourceCreateWithURL(directory.appendingPathComponent(filename) as CFURL, nil),
            let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
              kCGImageSourceCreateThumbnailFromImageAlways: true,
              kCGImageSourceCreateThumbnailWithTransform: true,
              kCGImageSourceThumbnailMaxPixelSize: 64,
              kCGImageSourceShouldCacheImmediately: true,
            ] as CFDictionary)
      else { continue }
      let image = NSImage(cgImage: thumbnail, size: NSSize(width: 32, height: 32))
      image.isTemplate = true
      files[filename] = image
    }
    return manifest.providers.reduce(into: [:]) { result, entry in
      if let image = files[entry.value] { result[entry.key] = image }
    }
  }()
}

/// A decorative provider mark; unknown brands retain an explicit text identity.
@MainActor
struct ArkProviderMark: View {
  let providerID: String
  let label: String
  var size: CGFloat = 24

  var body: some View {
    Group {
      if let image = ArkProviderArtwork.images[providerID] {
        Image(nsImage: image)
          .renderingMode(.template)
          .resizable()
          .scaledToFit()
          .padding(3)
      } else {
        Text(String(label.prefix(2)).uppercased())
          .font(.system(size: size * 0.4, weight: .semibold))
          .lineLimit(1)
          .minimumScaleFactor(0.6)
      }
    }
    .frame(width: size, height: size)
    .background(ArkPalette.raised, in: RoundedRectangle(cornerRadius: size * 0.2))
    .accessibilityHidden(true)
  }
}
