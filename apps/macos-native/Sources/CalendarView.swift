import SwiftUI

private enum NativeCalendarMode: String, CaseIterable, Identifiable {
    case list, day, week, month
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

/// One event, with its wire times read once. All-day events stay as calendar
/// dates so a time zone can never move them to the neighbouring day.
private struct NativeCalendarEvent: Identifiable {
    let raw: Wire
    let start: Date?
    let end: Date?
    var id: String { raw["sourceId"].text + ":" + raw["eventId"].text }
    var allDay: Bool { raw["allDay"].flag }
    var title: String { raw["title"].text.isEmpty ? "Untitled event" : raw["title"].text }
    var startDay: String { String(raw["start"].text.prefix(10)) }
    var endDay: String { String(raw["end"].text.prefix(10)) }
    init(_ value: Wire) {
        raw = value
        start = Self.instant(value["start"].text)
        end = Self.instant(value["end"].text)
    }
    /// Providers send anything from no fraction to seven digits of one.
    static func instant(_ value: String) -> Date? {
        let plain = value.replacingOccurrences(of: "\\.\\d+", with: "", options: .regularExpression)
        return ISO8601DateFormatter().date(from: plain)
    }
    var color: Color { nativeCalendarColor(raw["sourceColor"].text) }
    var timeLabel: String {
        if allDay { return "All day" }
        return start?.formatted(date: .omitted, time: .shortened) ?? "Unknown time"
    }
}

/// Calendar colours belong to the person's own account, so they are shown as
/// sent. Without one the theme's gold stands in.
private func nativeCalendarColor(_ hex: String) -> Color {
    guard hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return JosiTheme.gold }
    return Color(hex: value)
}

private func nativeCalendarProvider(_ value: String) -> String {
    ["google": "Google Calendar", "microsoft": "Microsoft Outlook", "local": "On this server"][value] ?? value.capitalized
}

struct NativeCalendarView: View {
    @EnvironmentObject var model: JosiModel
    @State private var sources: [Wire] = []
    @State private var events: [NativeCalendarEvent] = []
    @State private var warnings: [String] = []
    @State private var anchor = Calendar.current.startOfDay(for: Date())
    @State private var mode = NativeCalendarMode.week
    @State private var detail: Wire = .null
    @State private var sourcesLoaded = false
    @State private var loading = true
    @State private var unavailable = false
    @State private var error = ""
    @State private var generation = 0
    private let calendar = Calendar.current

    /// The dates on show: seven from the chosen day for the list, and whole
    /// weeks for the grids. Month always shows six rows, as the server allows.
    private var days: [Date] {
        var first = anchor, count = 7
        switch mode {
        case .day: count = 1
        case .list: break
        case .week: first = calendar.dateInterval(of: .weekOfYear, for: anchor)?.start ?? anchor
        case .month:
            let month = calendar.dateInterval(of: .month, for: anchor)?.start ?? anchor
            first = calendar.dateInterval(of: .weekOfYear, for: month)?.start ?? month
            count = 42
        }
        return (0..<count).compactMap { calendar.date(byAdding: .day, value: $0, to: first) }
    }
    private var rangeLabel: String {
        switch mode {
        case .day: return anchor.formatted(date: .complete, time: .omitted)
        case .month: return anchor.formatted(.dateTime.month(.wide).year())
        default:
            guard let first = days.first, let last = days.last else { return "" }
            return first.formatted(.dateTime.month(.abbreviated).day()) + " to " + last.formatted(.dateTime.month(.abbreviated).day().year())
        }
    }

    var body: some View {
        NativeLeanPage(maxWidth: 1180) {
            HStack(alignment: .top) {
                JosiHeading(title: "Calendar", subtitle: "One view of the calendars you choose from your connected accounts.")
                Button("Refresh") { model.run { await reload(rediscover: true) } }.buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
            }
            NativeLeanStatus(error: error)
            ForEach(Array(Set(warnings)).sorted(), id: \.self) { NativeLeanNote(text: $0, color: JosiTheme.error) }
            if unavailable {
                NativeLeanNote(text: "This server does not offer calendars yet. Update the server to use them.")
            } else {
                controls
                if detail != .null { detailCard(detail) }
                schedule
                calendarsCard
            }
        }
        .task(id: "\(mode.rawValue) \(anchor.timeIntervalSinceReferenceDate)") { await reload() }
        .onDisappear { generation += 1 }
    }

    private var controls: some View {
        HStack(spacing: 8) {
            Button("Previous") { move(-1) }.buttonStyle(JosiOutlineButtonStyle())
            Button("Today") { anchor = calendar.startOfDay(for: Date()) }.buttonStyle(JosiOutlineButtonStyle())
            Button("Next") { move(1) }.buttonStyle(JosiOutlineButtonStyle())
            Text(rangeLabel).font(JosiFont.headline).padding(.leading, 8)
            Spacer()
            Picker("View", selection: $mode) {
                ForEach(NativeCalendarMode.allCases) { Text($0.label).tag($0) }
            }.pickerStyle(.segmented).labelsHidden().frame(width: 260)
        }
    }
    @ViewBuilder private var schedule: some View {
        if loading {
            ProgressView().controlSize(.small)
        } else {
            if events.isEmpty { NativeLeanNote(text: "No events in this range.") }
            switch mode {
            case .list, .day: agenda
            case .week: week
            case .month: month
            }
        }
    }
    private var agenda: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(days, id: \.self) { day in
                let rows = eventsOn(day)
                if !rows.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(day.formatted(date: .complete, time: .omitted)).font(JosiFont.headline)
                        ForEach(rows) { eventButton($0) }
                    }
                }
            }
        }
    }
    private var week: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(days, id: \.self) { day in
                VStack(alignment: .leading, spacing: 6) {
                    dayButton(day, label: day.formatted(.dateTime.weekday(.abbreviated).day()))
                    ForEach(eventsOn(day)) { eventButton($0, compact: true) }
                }.frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
    private var month: some View {
        let symbols = calendar.shortWeekdaySymbols, shift = calendar.firstWeekday - 1
        let columns = Array(repeating: GridItem(.flexible(), spacing: 6, alignment: .top), count: 7)
        return LazyVGrid(columns: columns, spacing: 6) {
            ForEach(0..<7, id: \.self) { Text(symbols[($0 + shift) % 7]).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac) }
            ForEach(days, id: \.self) { day in
                let rows = eventsOn(day)
                VStack(alignment: .leading, spacing: 4) {
                    dayButton(day, label: day.formatted(.dateTime.day()))
                    ForEach(rows.prefix(3)) { eventButton($0, compact: true) }
                    if rows.count > 3 {
                        Text("\(rows.count - 3) more").font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
                    }
                }.padding(6).frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
                    .background(JosiTheme.card.opacity(calendar.isDate(day, equalTo: anchor, toGranularity: .month) ? 0.8 : 0.3), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(JosiTheme.hairline, lineWidth: 1))
            }
        }
    }
    private func dayButton(_ day: Date, label: String) -> some View {
        let today = calendar.isDateInToday(day)
        return Button { anchor = day; mode = .day } label: {
            Text(label).font(JosiFont.body(12, weight: today ? .bold : .medium))
                .foregroundStyle(today ? JosiTheme.gold : JosiTheme.text)
        }.buttonStyle(.plain).accessibilityLabel("Open " + day.formatted(date: .complete, time: .omitted))
    }
    private func eventButton(_ event: NativeCalendarEvent, compact: Bool = false) -> some View {
        Button { inspect(event) } label: {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 2).fill(event.color).frame(width: 3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(event.title).font(JosiFont.body(compact ? 12 : 14, weight: .medium)).lineLimit(compact ? 2 : 1).foregroundStyle(JosiTheme.text)
                    Text(event.timeLabel).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                    if !compact {
                        Text(sourceLine(event.raw["sourceName"].text, provider: event.raw["provider"].text, account: event.raw["account"].text))
                            .font(JosiFont.caption).foregroundStyle(JosiTheme.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }.fixedSize(horizontal: false, vertical: true).padding(compact ? 6 : 10).frame(maxWidth: .infinity, alignment: .leading)
                .background(JosiTheme.deep.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(event.title + ", " + event.timeLabel)
    }
    private func detailCard(_ event: Wire) -> some View {
        JosiCard {
            HStack {
                NativeLeanTitle(text: event["title"].text.isEmpty ? "Untitled event" : event["title"].text)
                Spacer()
                Button("Close") { detail = .null }.buttonStyle(JosiOutlineButtonStyle())
            }
            line("Calendar", sourceLine(event["sourceName"].text, provider: event["provider"].text, account: event["account"].text))
            line("When", whenLabel(event))
            if !event["location"].text.isEmpty { line("Location", event["location"].text) }
            if !event["description"].text.isEmpty { line("Details", event["description"].text) }
        }
    }
    private func line(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
            Text(value).font(JosiFont.callout).textSelection(.enabled)
        }
    }
    private var calendarsCard: some View {
        JosiCard {
            NativeLeanTitle(text: "Calendars")
            if !sourcesLoaded {
                ProgressView().controlSize(.small)
            } else if sources.isEmpty {
                NativeLeanNote(text: "No calendar is connected yet. Connect Google or Microsoft and turn on calendar reading.")
                Button("Open Connections") { model.section = "connections" }.buttonStyle(JosiOutlineButtonStyle())
            }
            ForEach(sources, id: \.identifier) { source in
                HStack(spacing: 10) {
                    Toggle(source["name"].text, isOn: Binding(get: { source["selected"].flag }, set: { select(source, on: $0) }))
                        .toggleStyle(.checkbox).labelsHidden().accessibilityLabel(source["name"].text)
                    Circle().fill(nativeCalendarColor(source["color"].text)).frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(source["name"].text).font(JosiFont.callout).lineLimit(1)
                        Text(sourceLine("", provider: source["provider"].text, account: source["account"].text))
                            .font(JosiFont.caption).foregroundStyle(JosiTheme.muted).lineLimit(1)
                    }
                    Spacer()
                    if source["primary"].flag { JosiPill(text: "Primary", color: JosiTheme.lilac) }
                    if source["writeDefault"].flag { JosiPill(text: "Default for new events", color: JosiTheme.gold) }
                    else if source["writable"].flag {
                        Button("Make Default") { makeDefault(source) }.buttonStyle(JosiOutlineButtonStyle())
                    }
                }.disabled(model.busy)
            }
        }
    }

    private func sourceLine(_ name: String, provider: String, account: String) -> String {
        [name, nativeCalendarProvider(provider), account].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private func whenLabel(_ event: Wire) -> String {
        if event["allDay"].flag { return "All day, " + String(event["start"].text.prefix(10)) }
        let start = NativeCalendarEvent.instant(event["start"].text), end = NativeCalendarEvent.instant(event["end"].text)
        guard let start else { return "Unknown" }
        guard let end else { return start.formatted(date: .abbreviated, time: .shortened) }
        return start.formatted(date: .abbreviated, time: .shortened) + " to " + end.formatted(date: .abbreviated, time: .shortened)
    }
    private func dayKey(_ day: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
    private func eventsOn(_ day: Date) -> [NativeCalendarEvent] {
        guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { return [] }
        let key = dayKey(day), nextKey = dayKey(next)
        return events.filter { event in
            if event.allDay {
                guard !event.startDay.isEmpty else { return false }
                return event.startDay <= key && (event.endDay.isEmpty ? nextKey : event.endDay) > key
            }
            guard let start = event.start else { return false }
            return start < next && max(event.end ?? start, start.addingTimeInterval(1)) > day
        }.sorted { ($0.allDay ? 0 : 1, $0.start ?? day) < ($1.allDay ? 0 : 1, $1.start ?? day) }
    }
    private func move(_ direction: Int) {
        let unit: Calendar.Component = mode == .month ? .month : mode == .day ? .day : .weekOfYear
        anchor = calendar.date(byAdding: unit, value: direction, to: anchor) ?? anchor
    }

    private func reload(rediscover: Bool = false) async {
        guard let api = model.api else { return }
        generation += 1
        let owner = model.user["id"], started = generation
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == owner }
        guard let first = days.first, let last = days.last, let end = calendar.date(byAdding: .day, value: 1, to: last) else { return }
        let formatter = ISO8601DateFormatter()
        let query = "start=\(formatter.string(from: first))&end=\(formatter.string(from: end))"
        loading = true; error = ""
        defer { if generation == started { loading = false } }
        do {
            var notices: [String] = []
            if rediscover || !sourcesLoaded {
                let result = try await api.request("/calendar/sources" + (rediscover ? "?refresh=true" : ""))
                guard current() else { return }
                sources = result["sources"].list; sourcesLoaded = true; unavailable = false
                notices += result["discoveryErrors"].list.map { $0["error"].text }
            }
            let result = try await api.request("/calendar/events?" + query)
            guard current() else { return }
            events = result["events"].list.map(NativeCalendarEvent.init)
            warnings = notices + result["sourceErrors"].list.map { $0["error"].text }
        } catch {
            guard current() else { return }
            events = []
            if nativeRouteMissing(error) { unavailable = true } else { self.error = error.localizedDescription }
        }
    }
    private func change(_ source: Wire, body: Wire) {
        guard let api = model.api, let id = try? api.uuid(source.identifier) else { return }
        let owner = model.user["id"]
        error = ""
        model.run {
            do {
                _ = try await api.request("/calendar/sources/\(id)", method: "PUT", body: body)
                guard model.api === api, model.user["id"] == owner else { return }
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
            sourcesLoaded = false
            await reload()
        }
    }
    private func select(_ source: Wire, on: Bool) { change(source, body: ["selected": .bool(on)]) }
    private func makeDefault(_ source: Wire) { change(source, body: ["writeDefault": .bool(true)]) }
    private func inspect(_ event: NativeCalendarEvent) {
        guard let api = model.api, let source = try? api.uuid(event.raw["sourceId"].text),
              let id = event.raw["eventId"].text.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return }
        let owner = model.user["id"], summary = event.raw
        error = ""
        model.run {
            do {
                let result = try await api.request("/calendar/events/\(source)/\(id)")
                guard model.api === api, model.user["id"] == owner else { return }
                detail = result["event"]
            } catch {
                guard model.api === api else { return }
                // The list already has the basics; show them rather than nothing.
                detail = summary
                self.error = error.localizedDescription
            }
        }
    }
}
