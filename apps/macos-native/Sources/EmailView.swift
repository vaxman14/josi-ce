import SwiftUI

private struct NativeTemplateDraft: Equatable {
    var name = "Welcome"
    var subject = "Welcome, {{name}}"
    var heading = "A warm welcome"
    var body = "Hello {{name}},\n\nThank you for getting in touch. We look forward to working with you."
    var accentColor = "#2563eb"
    var ctaLabel = ""
    var ctaUrl = ""
    var footer = "Warm regards,\nYour team"
    init() {}
    init(_ value: Wire) {
        name = value["name"].text; subject = value["subject"].text; heading = value["heading"].text
        body = value["body"].text; accentColor = value["accentColor"].text; ctaLabel = value["ctaLabel"].text
        ctaUrl = value["ctaUrl"].text; footer = value["footer"].text
    }
    var wire: Wire {
        ["name": .string(name), "subject": .string(subject), "heading": .string(heading), "body": .string(body),
         "accentColor": .string(accentColor), "ctaLabel": .string(ctaLabel), "ctaUrl": .string(ctaUrl), "footer": .string(footer)]
    }
}

struct NativeEmailView: View {
    @EnvironmentObject var model: JosiModel
    @State private var templates: [Wire] = []
    @State private var selected = ""
    @State private var form = NativeTemplateDraft()
    @State private var preview: Wire = .null
    @State private var previewError = ""
    @State private var loaded = false
    @State private var unavailable = false
    @State private var error = ""
    @State private var note = ""
    @State private var generation = 0
    // Drafting a message for approval.
    @State private var draftTemplate = ""
    @State private var recipient = ""
    @State private var mergeName = ""
    @State private var mergeDate = ""
    @State private var mergeTime = ""
    @State private var plainSubject = ""
    @State private var plainBody = ""
    @State private var prepared: Wire = .null
    @State private var draftError = ""
    private var canSave: Bool { !form.name.isEmpty && !form.subject.isEmpty && !form.body.isEmpty }
    private var canPrepare: Bool {
        !recipient.isEmpty && (!draftTemplate.isEmpty || (!plainSubject.isEmpty && !plainBody.isEmpty))
    }

    var body: some View {
        NativeLeanPage {
            HStack(alignment: .top) {
                JosiHeading(title: "Email", subtitle: "Reusable messages, and drafts you approve before they go out.")
                Button("Refresh") { model.run { await load() } }.buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
            }
            NativeLeanStatus(loading: !loaded && error.isEmpty && !unavailable, error: error, note: note)
            if unavailable {
                NativeLeanNote(text: "This server does not offer email templates yet. Update the server to use them.")
            } else if loaded {
                templatePicker
                editor
                previewCard
                mergeHelp
                draftCard
            }
        }
        .textFieldStyle(JosiFieldStyle())
        .task { await load() }
        .task(id: form) { await refreshPreview() }
        .onChange(of: selected) { _, id in
            let template = templates.first { $0.identifier == id }
            form = template.map(NativeTemplateDraft.init) ?? NativeTemplateDraft()
            note = ""
        }
        .onDisappear { generation += 1 }
    }

    private var templatePicker: some View {
        JosiCard {
            HStack {
                Picker("Saved template", selection: $selected) {
                    Text("New template").tag("")
                    ForEach(templates, id: \.identifier) { Text($0["name"].text).tag($0.identifier) }
                }.font(JosiFont.callout)
                Button("New Template") { selected = ""; form = NativeTemplateDraft() }.buttonStyle(JosiOutlineButtonStyle())
            }.disabled(model.busy)
            if templates.isEmpty { NativeLeanNote(text: "No saved templates yet. Edit the one below and save it.") }
            if !selected.isEmpty { NativeLeanNote(text: "Template ID for Josi: " + selected, color: JosiTheme.muted) }
        }
    }
    private var editor: some View {
        JosiCard {
            NativeLeanTitle(text: selected.isEmpty ? "New template" : "Edit template")
            field("Template name", $form.name)
            field("Subject", $form.subject)
            field("Heading", $form.heading)
            field("Body", $form.body, lines: 5...14)
            field("Accent color (six-digit hex)", $form.accentColor)
            field("Button label (optional)", $form.ctaLabel)
            field("Button link (http or https)", $form.ctaUrl)
            field("Footer or signature", $form.footer, lines: 2...6)
            NativeLeanNote(text: "Text only. Blank lines make paragraphs. HTML and Markdown show as plain text.", color: JosiTheme.muted)
            HStack {
                Button("Save Template") { save() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(!canSave)
                if !selected.isEmpty { Button("Delete…") { remove() }.buttonStyle(JosiOutlineButtonStyle()) }
            }.disabled(model.busy)
        }
    }
    private var previewCard: some View {
        JosiCard {
            NativeLeanTitle(text: "Preview")
            NativeLeanNote(text: "Sample values: Alex, alex@example.test, September 18, 2026, 10:00 AM PDT.", color: JosiTheme.muted)
            if !previewError.isEmpty { NativeLeanNote(text: previewError, color: JosiTheme.error) }
            if preview != .null {
                Text(preview["subject"].text).font(JosiFont.headline).textSelection(.enabled)
                Text(preview["text"].text).font(JosiFont.body()).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                    .background(JosiTheme.deep, in: RoundedRectangle(cornerRadius: 11))
            } else if previewError.isEmpty { ProgressView().controlSize(.small) }
        }
    }
    private var mergeHelp: some View {
        JosiCard {
            NativeLeanTitle(text: "Merge fields")
            NativeLeanNote(text: "Use {{recipient}} for the To address, {{name}} for the recipient's name, {{date}} for your date text and {{time}} for your time text, with the time zone. They work in the subject, heading, body, button label and footer. A missing value stops the draft. Dates and times are never guessed or reformatted. Button links cannot use merge fields.")
        }
    }
    private var draftCard: some View {
        JosiCard {
            NativeLeanTitle(text: "Draft an email")
            NativeLeanNote(text: "Choose a template or write a plain message. Nothing is sent until you approve it.")
            Picker("Template", selection: $draftTemplate) {
                Text("No template, plain text").tag("")
                ForEach(templates, id: \.identifier) { Text($0["name"].text).tag($0.identifier) }
            }.font(JosiFont.callout)
            field("To", $recipient)
            if draftTemplate.isEmpty {
                field("Subject", $plainSubject)
                field("Body", $plainBody, lines: 4...12)
            } else {
                HStack(alignment: .top) {
                    field("Recipient name", $mergeName)
                    field("Date text", $mergeDate)
                    field("Time text and zone", $mergeTime)
                }
            }
            if !draftError.isEmpty { NativeLeanNote(text: draftError, color: JosiTheme.error) }
            Button("Prepare for Approval") { prepare() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                .disabled(model.busy || !canPrepare)
            if prepared != .null {
                Divider().overlay(JosiTheme.hairline)
                Text("Prepared. No email has been sent.").font(JosiFont.headline)
                NativeLeanNote(text: prepared["summary"].text)
                Button("Review in Approvals") { model.section = "approvals" }.buttonStyle(JosiOutlineButtonStyle())
            }
        }
        .onChange(of: draftInputs) { _, _ in prepared = .null }
    }
    private var draftInputs: [String] { [draftTemplate, recipient, mergeName, mergeDate, mergeTime, plainSubject, plainBody] }
    private func field(_ label: String, _ text: Binding<String>, lines: ClosedRange<Int>? = nil) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
            if let lines { TextField("", text: text, axis: .vertical).lineLimit(lines) }
            else { TextField("", text: text) }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        let owner = model.user["id"], started = generation
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == owner }
        do {
            let result = try await api.request("/mail/templates")
            guard current() else { return }
            templates = result["templates"].list; loaded = true; unavailable = false; error = ""
            if !selected.isEmpty, !templates.contains(where: { $0.identifier == selected }) { selected = "" }
            if !draftTemplate.isEmpty, !templates.contains(where: { $0.identifier == draftTemplate }) { draftTemplate = "" }
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { unavailable = true } else { self.error = error.localizedDescription }
        }
    }
    private func refreshPreview() async {
        guard let api = model.api, !unavailable else { return }
        do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
        let sample: Wire = ["name": "Alex", "date": "September 18, 2026", "time": "10:00 AM PDT"]
        do {
            let result = try await api.request("/mail/templates/preview", method: "POST",
                body: ["template": form.wire, "recipient": "alex@example.test", "merge_values": sample])
            guard !Task.isCancelled, model.api === api else { return }
            preview = result; previewError = ""
        } catch {
            guard !Task.isCancelled, model.api === api else { return }
            preview = .null; previewError = error.localizedDescription
        }
    }
    private func save() {
        guard let api = model.api else { return }
        let id = selected, draft = form.wire, owner = model.user["id"]
        error = ""; note = ""
        model.run {
            do {
                let route = id.isEmpty ? "/mail/templates" : "/mail/templates/\(try api.uuid(id))"
                let result = try await api.request(route, method: id.isEmpty ? "POST" : "PUT", body: draft)
                guard model.api === api, model.user["id"] == owner else { return }
                await load()
                selected = result["template"].identifier
                note = "Template saved."
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
        }
    }
    private func remove() {
        guard let api = model.api, let id = try? api.uuid(selected),
              nativeConfirm("Delete this template?", detail: "Drafts already prepared keep their original content.", button: "Delete Template") else { return }
        let owner = model.user["id"]
        error = ""; note = ""
        model.run {
            do {
                _ = try await api.request("/mail/templates/\(id)", method: "DELETE")
                guard model.api === api, model.user["id"] == owner else { return }
                selected = ""; await load()
                note = "Template deleted."
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
        }
    }
    private func prepare() {
        guard let api = model.api else { return }
        let owner = model.user["id"]
        var body: Wire = ["recipient": .string(recipient.trimmingCharacters(in: .whitespacesAndNewlines))]
        if case .object(var fields) = body {
            if draftTemplate.isEmpty {
                fields["subject"] = .string(plainSubject); fields["body"] = .string(plainBody)
            } else {
                fields["template_id"] = .string(draftTemplate)
                fields["merge_values"] = ["name": .string(mergeName), "date": .string(mergeDate), "time": .string(mergeTime)]
            }
            body = .object(fields)
        }
        draftError = ""; prepared = .null
        let draft = body
        model.run {
            do {
                let result = try await api.request("/mail/templates/draft", method: "POST", body: draft)
                guard model.api === api, model.user["id"] == owner else { return }
                guard result["state"].text == "prepared" else {
                    draftError = result["message"].text.isEmpty ? "Complete the draft first." : result["message"].text
                    return
                }
                prepared = result
            } catch {
                guard model.api === api else { return }
                // A refused draft answers with a short code in `error` and its reason
                // in `message`, which api.request drops. Never show the bare code.
                let detail = error.localizedDescription
                draftError = detail.contains(" ") && !detail.hasPrefix("The server could not")
                    ? detail : "The draft is not complete. Check the address and every merge value."
            }
        }
    }
}
