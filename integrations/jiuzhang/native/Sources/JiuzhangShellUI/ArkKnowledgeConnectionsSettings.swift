import Foundation
import SwiftUI
import JiuzhangShellCore

/// Connection editing keeps secrets in Keychain and uses the Host settings revision for the route selection.
struct ArkKnowledgeConnectionsSettings: View {
  @ObservedObject var model: ArkAppModel
  @State private var fields: [String: String] = [:]
  @State private var revision = -1
  @State private var embeddingSecret = ""
  @State private var saving = false
  @State private var result: String?

  private let names = ["textProvider", "textModel", "visionProvider", "visionModel", "embeddingProvider",
    "embeddingBaseUrl", "embeddingModel", "embeddingCredential"]
  private var namespace: ArkSettingsNamespace? {
    model.settingsSnapshot?.namespaces.first { $0.id == "knowledge-wiki" }
  }
  private func binding(_ key: String) -> Binding<String> {
    Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0; result = nil })
  }
  private func routePicker(_ title: String, provider: String, modelKey: String) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Picker(title, selection: Binding(get: {
        (fields[provider] ?? "") + "\u{0}" + (fields[modelKey] ?? "")
      }, set: { value in
        let parts = value.split(separator: "\u{0}", omittingEmptySubsequences: false).map(String.init)
        fields[provider] = parts.first ?? ""; fields[modelKey] = parts.last ?? ""; result = nil
      })) {
        Text("未配置").tag("\u{0}")
        ForEach(model.availableModelGroups) { group in
          ForEach(group.models) { item in
            Text("\(group.name) · \(item.name)").tag(group.id + "\u{0}" + item.id)
          }
        }
        if let p = fields[provider], let m = fields[modelKey], !p.isEmpty,
          !model.availableModelGroups.contains(where: { $0.id == p && $0.models.contains(where: { $0.id == m }) }) {
          Text("\(p) / \(m)（当前不可用）").tag(p + "\u{0}" + m)
        }
      }
      .accessibilityIdentifier("ark.knowledge.connections.\(provider)")
    }
  }

  var body: some View {
    if namespace != nil {
      GroupBox("知识连接") {
        VStack(alignment: .leading, spacing: 12) {
          Text("文本与图片使用下方明确选择的模型连接。图片与云端向量默认关闭，不会借用聊天密钥。")
            .font(.system(size: 11)).foregroundStyle(.secondary)
          routePicker("文本分析与研究", provider: "textProvider", modelKey: "textModel")
          routePicker("图片说明", provider: "visionProvider", modelKey: "visionModel")
          DisclosureGroup("独立向量服务（可选）") {
            VStack(alignment: .leading, spacing: 8) {
              Text("留空时仅在本机进行关键词检索。启用后，此端点会收到查询、页面摘要及所选凭据；仅填写属于该服务的凭据引用。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
              TextField("服务名称", text: binding("embeddingProvider"))
              TextField("HTTPS API 地址（含 /v1 等服务前缀）", text: binding("embeddingBaseUrl"))
              TextField("向量模型 ID", text: binding("embeddingModel"))
              TextField("已有独立凭据引用；填写新密钥时自动生成新引用", text: binding("embeddingCredential"))
              SecureField("向量服务密钥；留空使用已存凭据", text: $embeddingSecret)
              Button("关闭云端向量检索") {
                for key in names where key.hasPrefix("embedding") { fields[key] = "" }
                embeddingSecret = ""
              }
            }.textFieldStyle(.roundedBorder).padding(.top, 8)
          }
          if let result { Text(result).font(.system(size: 11)).textSelection(.enabled) }
          HStack {
            Button("恢复已保存配置", action: reload)
            Spacer()
            Button(saving ? "正在保存…" : "保存知识连接") {
              saving = true
              let values = fields.mapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
              let expected = revision
              let secret = embeddingSecret
              Task {
                defer { saving = false }
                if await model.saveKnowledgeConnections(values, expectedRevision: expected, embeddingSecret: secret) {
                  reload()
                  result = "知识连接已保存；这不表示实际模型调用已经通过验证。"
                } else { result = "配置未保存，请重新载入并检查错误信息。" }
              }
            }.accessibilityIdentifier("ark.knowledge.connections.save")
          }
        }.padding(8)
        .disabled(saving || model.settingsBusy || model.settingsSnapshot?.writable != true)
      }
      .onAppear(perform: reload)
      .onDisappear { embeddingSecret = "" }
    }
  }
  private func reload() {
    guard let namespace else { return }
    fields = Dictionary(names.map { ($0, namespace.value[$0]?.stringValue ?? "") }, uniquingKeysWith: { first, _ in first })
    revision = namespace.revision
    embeddingSecret = ""; result = nil
  }
}
