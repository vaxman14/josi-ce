import AppKit
import Virtualization
import Darwin

/// Guest metadata is local operational state inside the encrypted volume,
/// never a credential, permission grant or replacement for current Vault
/// authority. Failed installations are retained for explicit repair.
@MainActor enum NativeWorkspaceInstaller {
    static func manifest(_ root: URL, id: UUID, device: dev_t) throws -> Wire? {
        try mounted(root, device: device)
        let path = root.appendingPathComponent("Machine.json").path
        var info = stat()
        if lstat(path, &info) != 0 {
            if errno == ENOENT { return nil }
            throw WorkspaceMachineError.invalidWorkspace
        }
        let value = try NativeFiles.json(path, owner: getuid(), maximum: 192 * 1024, privateFile: true)
        guard info.st_dev == device,
              ProtectedWire.exact(value, ["schemaVersion", "workspaceId", "state", "hardwareModel", "machineIdentifier",
                                         "cpuCount", "memoryBytes", "diskGiB", "buildVersion"]),
              value["schemaVersion"] == .number(1), value["workspaceId"].text == id.uuidString.lowercased(),
              ["installing", "installed", "needs_repair"].contains(value["state"].text),
              ProtectedWire.integer(value["cpuCount"]), (1...8).contains(value["cpuCount"].integer),
              ProtectedWire.integer(value["memoryBytes"]), (1_073_741_824...17_179_869_184).contains(value["memoryBytes"].integer),
              ProtectedWire.integer(value["diskGiB"]), (48...504).contains(value["diskGiB"].integer),
              value["buildVersion"].text.utf8.count <= 120 else { throw WorkspaceMachineError.invalidWorkspace }
        return value
    }
    static func mounted(_ root: URL, device: dev_t) throws {
        var info = stat(), parent = stat()
        guard root.isFileURL, root.resolvingSymlinksInPath() == root,
              lstat(root.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
              info.st_mode & 0o077 == 0, info.st_dev == device,
              lstat(root.deletingLastPathComponent().path, &parent) == 0, parent.st_dev != device else {
            throw WorkspaceMachineError.invalidWorkspace
        }
    }
    private static func bytes(_ value: Wire) throws -> Data {
        guard value.text.count <= 90_000, let bytes = Data(base64Encoded: value.text),
              !bytes.isEmpty, bytes.count <= 64 * 1024, bytes.base64EncodedString() == value.text else { throw WorkspaceMachineError.invalidWorkspace }
        return bytes
    }
    static func volume(_ value: Wire, root: URL, id: UUID, device: dev_t) throws -> MountedAutomationWorkspace {
        try mounted(root, device: device)
        return MountedAutomationWorkspace(workspaceId: id, mountRoot: root, volumeDevice: device,
            hardwareModel: try bytes(value["hardwareModel"]), machineIdentifier: try bytes(value["machineIdentifier"]),
            cpuCount: value["cpuCount"].integer, memoryBytes: UInt64(value["memoryBytes"].integer),
            supportDisk: URL(fileURLWithPath: "/Applications/Josi.app/Contents/Resources/JosiSupport.iso"))
    }
    private static func record(_ value: Wire, root: URL) throws {
        let export = try NativePrivateExport(destination: root.appendingPathComponent("Machine.json"))
        try export.write(JSONEncoder().encode(value)); try export.finish()
    }
    static func prepare(root: URL, id: UUID, device: dev_t, capacity: Int, restore: URL?,
                        current: @escaping @MainActor () throws -> Void,
                        retainMachine: @escaping @MainActor (VZVirtualMachine?) -> Void,
                        progress: @escaping @MainActor (String) -> Void) async throws -> MountedAutomationWorkspace {
        try current(); try mounted(root, device: device)
        if let value = try manifest(root, id: id, device: device) {
            guard value["state"].text == "installed", value["diskGiB"].integer == capacity - 8 else {
                throw JosiError(message: "This desktop has an unfinished installation. Its files were retained and need repair.")
            }
            return try volume(value, root: root, id: id, device: device)
        }
        guard let restore, restore.isFileURL, (64...512).contains(capacity) else {
            throw JosiError(message: "Choose an Apple macOS restore image (.ipsw) to install this separate development desktop.")
        }
        var backingSpace = statfs()
        guard statfs(root.deletingLastPathComponent().path, &backingSpace) == 0,
              UInt64(backingSpace.f_bavail) * UInt64(backingSpace.f_bsize) >= 64 * 1024 * 1024 * 1024 else {
            throw JosiError(message: "Installing macOS needs at least 64 GiB free on this Mac after the restore image has been downloaded.")
        }
        // The owner selects this one input. No server/model path is accepted.
        var imageInfo = stat()
        guard lstat(restore.path, &imageInfo) == 0, imageInfo.st_mode & S_IFMT == S_IFREG,
              imageInfo.st_uid == 0 || imageInfo.st_uid == getuid(), imageInfo.st_mode & 0o022 == 0,
              restore.resolvingSymlinksInPath() == restore else { throw WorkspaceMachineError.invalidWorkspace }
        let image = try await VZMacOSRestoreImage.image(from: restore)
        try current()
        let cpu = min(4, max(1, ProcessInfo.processInfo.activeProcessorCount / 2))
        let memory = min(UInt64(8 * 1024 * 1024 * 1024), ProcessInfo.processInfo.physicalMemory / 2)
        guard let requirements = image.mostFeaturefulSupportedConfiguration, requirements.hardwareModel.isSupported,
              requirements.minimumSupportedCPUCount <= cpu, requirements.minimumSupportedMemorySize <= memory,
              cpu >= VZVirtualMachineConfiguration.minimumAllowedCPUCount,
              memory >= VZVirtualMachineConfiguration.minimumAllowedMemorySize else {
            throw JosiError(message: "This Mac cannot provide the resources required by the selected restore image.")
        }
        for name in ["Disk.img", "AuxiliaryStorage", "Machine.json"] {
            var info = stat()
            guard lstat(root.appendingPathComponent(name).path, &info) != 0, errno == ENOENT else {
                throw JosiError(message: "Existing desktop files need inspection. They will not be overwritten.")
            }
        }
        var value: [String: Wire] = [
            "schemaVersion": .number(1), "workspaceId": .string(id.uuidString.lowercased()), "state": "installing",
            "hardwareModel": .string(requirements.hardwareModel.dataRepresentation.base64EncodedString()),
            "machineIdentifier": .string(VZMacMachineIdentifier().dataRepresentation.base64EncodedString()),
            "cpuCount": .number(Double(cpu)), "memoryBytes": .number(Double(memory)),
            "diskGiB": .number(Double(capacity - 8)), "buildVersion": .string(image.buildVersion),
        ]
        try record(.object(value), root: root)
        var machine: VZVirtualMachine?
        var monitor: Task<Void, Never>?
        defer { monitor?.cancel() }
        do {
            let auxiliary = root.appendingPathComponent("AuxiliaryStorage")
            _ = try VZMacAuxiliaryStorage(creatingStorageAt: auxiliary, hardwareModel: requirements.hardwareModel, options: [])
            guard chmod(auxiliary.path, 0o600) == 0 else { throw WorkspaceMachineError.invalidWorkspace }
            let disk = root.appendingPathComponent("Disk.img")
            let fd = Darwin.open(disk.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw WorkspaceMachineError.invalidWorkspace }
            let truncated = ftruncate(fd, off_t(capacity - 8) * 1024 * 1024 * 1024)
            let synced = fsync(fd); Darwin.close(fd)
            guard truncated == 0, synced == 0 else { throw WorkspaceMachineError.invalidWorkspace }
            let workspace = try volume(.object(value), root: root, id: id, device: device)
            let vm = VZVirtualMachine(configuration: try WorkspaceMachine.configuration(workspace))
            machine = vm; retainMachine(vm)
            let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: restore)
            monitor = Task { @MainActor in
                while !Task.isCancelled {
                    do {
                        try current(); try mounted(root, device: device)
                        var free = statfs(), backing = statfs()
                        guard statfs(root.path, &free) == 0, UInt64(free.f_bavail) * UInt64(free.f_bsize) >= 8 * 1024 * 1024 * 1024,
                              statfs(root.deletingLastPathComponent().path, &backing) == 0,
                              UInt64(backing.f_bavail) * UInt64(backing.f_bsize) >= 8 * 1024 * 1024 * 1024 else {
                            throw WorkspaceMachineError.unavailable
                        }
                        progress("Installing the separate desktop: \(Int(installer.progress.fractionCompleted * 100))%")
                        try await Task.sleep(for: .seconds(1))
                    } catch { installer.progress.cancel(); return }
                }
            }
            try current()
            try await installer.install()
            monitor?.cancel(); monitor = nil
            try current()
            guard vm.state == .stopped else { throw WorkspaceMachineError.needsRepair }
            value["state"] = "installed"; try record(.object(value), root: root)
            machine = nil; retainMachine(nil)
            return workspace
        } catch {
            monitor?.cancel()
            if let vm = machine, vm.state != .stopped && vm.state != .error { try? await vm.stop() }
            if machine?.state == .stopped || machine?.state == .error { retainMachine(nil) }
            value["state"] = "needs_repair"; try? record(.object(value), root: root)
            throw JosiError(message: "Desktop installation did not finish. The workspace was retained for repair; Josi will close its encrypted storage.")
        }
    }
}
