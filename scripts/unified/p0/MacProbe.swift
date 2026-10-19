// Disposable feasibility probe, not a production automation executor.
// Never reads personal profiles, requests TCC access, or controls host input.
import Foundation
import Virtualization

@main
struct MacProbe {
    static let output = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.deletingLastPathComponent()
    static let workspace = output.appendingPathComponent("guest", isDirectory: true)

    static func failure(_ message: String) -> NSError {
        NSError(domain: "JosiP0", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    static func record(_ value: [String: Any], name: String) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: workspace.appendingPathComponent(name), options: [.atomic])
    }

    @MainActor
    static func configuration() throws -> VZVirtualMachineConfiguration {
        let marker = try JSONSerialization.jsonObject(with: Data(contentsOf: workspace.appendingPathComponent("proof.json"))) as? [String: Any]
        guard marker?["purpose"] as? String == "disposable-josi-p0" else { throw failure("Disposable workspace marker required") }
        guard let hardware = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: workspace.appendingPathComponent("hardware.bin"))),
              let identifier = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: workspace.appendingPathComponent("machine.bin"))) else {
            throw failure("Invalid persisted VM identity")
        }
        let platform = VZMacPlatformConfiguration()
        platform.hardwareModel = hardware
        platform.machineIdentifier = identifier
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: workspace.appendingPathComponent("auxiliary.bin"))
        let config = VZVirtualMachineConfiguration()
        config.platform = platform
        config.bootLoader = VZMacOSBootLoader()
        config.cpuCount = 4
        config.memorySize = 8 * 1024 * 1024 * 1024
        let graphics = VZMacGraphicsDeviceConfiguration()
        graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1440, heightInPixels: 900, pixelsPerInch: 144)]
        config.graphicsDevices = [graphics]
        config.keyboards = [VZUSBKeyboardConfiguration()]
        config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: workspace.appendingPathComponent("disk.img"), readOnly: false))]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        // Isolation starts at the hardware boundary. No NAT, bridge, host folders,
        // clipboard, microphone, camera, or personal browser storage is attached.
        config.networkDevices = []
        config.directorySharingDevices = []
        config.audioDevices = []
        try config.validate()
        return config
    }

    @MainActor
    static func install() async throws {
        guard !FileManager.default.fileExists(atPath: workspace.path) else {
            throw failure("Workspace already exists. Existing proof data will not be overwritten.")
        }
        // The restore image coexists with installation scratch data and the
        // growing guest disk. A sparse disk's logical size is not free space.
        let space = try FileManager.default.attributesOfFileSystem(forPath: output.path)
        let capacity = try output.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        let immediate = (space[.systemFreeSize] as? NSNumber)?.uint64Value ?? 0
        // Apple includes automatically reclaimable space in this estimate.
        // This is admission only, not a reservation: keep monitoring actual
        // free blocks while installing. Never delete user snapshots ourselves.
        let available = capacity.volumeAvailableCapacityForImportantUsage.map { UInt64(max(0, $0)) } ?? immediate
        guard available >= 64 * 1024 * 1024 * 1024,
              immediate >= 16 * 1024 * 1024 * 1024 else {
            throw failure("This development probe requires 64 GiB available and 16 GiB immediately free AFTER downloading the restore image; production minimums remain unmeasured")
        }
        emit(["probe": "install-storage-preflight", "immediateFreeBytes": immediate, "availableForImportantUsageBytes": available, "emergencyReserveBytes": 8 * 1024 * 1024 * 1024])
        let imageURL = output.appendingPathComponent("downloads/restore.ipsw")
        let image = try await VZMacOSRestoreImage.image(from: imageURL)
        guard let requirement = image.mostFeaturefulSupportedConfiguration,
              requirement.minimumSupportedCPUCount <= 4,
              requirement.minimumSupportedMemorySize <= 8 * 1024 * 1024 * 1024 else {
            throw failure("The restore image exceeds the bounded development VM configuration")
        }
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try record(["purpose": "disposable-josi-p0", "state": "installing", "buildVersion": image.buildVersion], name: "proof.json")
        try requirement.hardwareModel.dataRepresentation.write(to: workspace.appendingPathComponent("hardware.bin"), options: .withoutOverwriting)
        try VZMacMachineIdentifier().dataRepresentation.write(to: workspace.appendingPathComponent("machine.bin"), options: .withoutOverwriting)
        _ = try VZMacAuxiliaryStorage(creatingStorageAt: workspace.appendingPathComponent("auxiliary.bin"), hardwareModel: requirement.hardwareModel, options: [])
        let disk = workspace.appendingPathComponent("disk.img")
        guard FileManager.default.createFile(atPath: disk.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw failure("Could not create disposable disk") }
        let handle = try FileHandle(forWritingTo: disk)
        try handle.truncate(atOffset: 64 * 1024 * 1024 * 1024)
        try handle.close()
        let config = try configuration()
        let machine = VZVirtualMachine(configuration: config)
        let installer = VZMacOSInstaller(virtualMachine: machine, restoringFromImageAt: imageURL)
        let progressTask = Task { @MainActor in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
                let attributes = try? FileManager.default.attributesOfFileSystem(forPath: workspace.path)
                if let free = attributes?[.systemFreeSize] as? NSNumber, free.uint64Value < 8 * 1024 * 1024 * 1024 {
                    installer.progress.cancel()
                    print("VM installation cancelled to preserve an 8 GiB free-space reserve.")
                    fflush(stdout)
                    return
                }
                print("VM installation: \(Int(installer.progress.fractionCompleted * 100))%")
                fflush(stdout)
            }
        }
        defer { progressTask.cancel() }
        do {
            try await installer.install()
        } catch {
            try? record(["purpose": "disposable-josi-p0", "state": "install-failed", "buildVersion": image.buildVersion,
                         "errorDomain": (error as NSError).domain, "errorCode": (error as NSError).code], name: "proof.json")
            throw error
        }
        try record(["purpose": "disposable-josi-p0", "state": "installed", "buildVersion": image.buildVersion], name: "proof.json")
        emit(["probe": "macos-install", "installed": true, "cpuCount": config.cpuCount, "memoryBytes": config.memorySize, "networkDeviceCount": config.networkDevices.count, "hostShareCount": config.directorySharingDevices.count, "diskLogicalBytes": 64 * 1024 * 1024 * 1024])
    }

    @MainActor
    static func lifecycle() async throws {
        let marker = try JSONSerialization.jsonObject(with: Data(contentsOf: workspace.appendingPathComponent("proof.json"))) as? [String: Any]
        guard marker?["state"] as? String == "installed" else { throw failure("A completed disposable installation is required") }
        let config = try configuration()
        let machine = VZVirtualMachine(configuration: config)
        try await machine.start()
        guard machine.state == .running else { throw failure("VM did not start") }
        try await Task.sleep(nanoseconds: 20_000_000_000)
        try await machine.pause()
        guard machine.state == .paused else { throw failure("VM did not pause") }
        try await machine.resume()
        guard machine.state == .running else { throw failure("VM did not resume") }
        // Deliberate cold-stop recovery test of this disposable guest with no sign-ins.
        try await machine.stop()
        guard machine.state == .stopped else { throw failure("VM did not stop") }
        try await machine.start()
        try await Task.sleep(nanoseconds: 10_000_000_000)
        try await machine.stop()
        let result: [String: Any] = ["probe": "vm-lifecycle", "startPauseResumeColdRestart": true, "networkDeviceCount": machine.networkDevices.count, "hostShareCount": machine.directorySharingDevices.count, "guestDesktopVerified": false]
        try record(result, name: "lifecycle.json")
        emit(result)
    }

    static func emit(_ value: [String: Any]) {
        do {
            let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
            print(String(decoding: data, as: UTF8.self))
        } catch {
            fputs("Could not encode probe result\n", stderr)
            exit(1)
        }
    }

    @MainActor
    static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else {
                throw failure("Use capabilities, restore-info, install, or lifecycle")
            }
            switch CommandLine.arguments[1] {
            case "capabilities":
                emit([
                    "probe": "macos-virtualization-capabilities",
                    "supported": VZVirtualMachine.isSupported,
                    "hostOS": ProcessInfo.processInfo.operatingSystemVersionString,
                    "hostMemoryBytes": ProcessInfo.processInfo.physicalMemory,
                    "hostLogicalCPUCount": ProcessInfo.processInfo.processorCount,
                    "minimumCPUCount": VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                    "maximumCPUCount": VZVirtualMachineConfiguration.maximumAllowedCPUCount,
                    "minimumMemoryBytes": VZVirtualMachineConfiguration.minimumAllowedMemorySize,
                    "maximumMemoryBytes": VZVirtualMachineConfiguration.maximumAllowedMemorySize,
                    "guestStarted": false,
                    "hostInputControlled": false,
                ])
            case "restore-info":
                let image = try await VZMacOSRestoreImage.latestSupported
                guard let requirement = image.mostFeaturefulSupportedConfiguration else {
                    throw NSError(domain: "JosiP0", code: 2, userInfo: [NSLocalizedDescriptionKey: "No supported restore configuration"])
                }
                emit([
                    "probe": "macos-restore-metadata",
                    "supported": image.isSupported,
                    "restoreURL": image.url.absoluteString,
                    "buildVersion": image.buildVersion,
                    "osVersion": "\(image.operatingSystemVersion.majorVersion).\(image.operatingSystemVersion.minorVersion).\(image.operatingSystemVersion.patchVersion)",
                    "minimumCPUCount": requirement.minimumSupportedCPUCount,
                    "minimumMemoryBytes": requirement.minimumSupportedMemorySize,
                    "hardwareModelSupported": requirement.hardwareModel.isSupported,
                    "guestStarted": false,
                ])
            case "install":
                try await install()
            case "lifecycle":
                try await lifecycle()
            default:
                throw NSError(domain: "JosiP0", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown probe"])
            }
        } catch {
            let failure = error as NSError
            emit(["status": "failed", "domain": failure.domain, "code": failure.code, "message": failure.localizedDescription])
            exit(1)
        }
    }
}
