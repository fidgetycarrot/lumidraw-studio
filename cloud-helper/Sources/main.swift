// LS Cloud Helper
//
// A small background program for Eric's Mac. Lumi Studio hands it a prompt and
// settings; it makes the picture on Draw Things' cloud (Draw Things+ API key)
// and hands the picture back.
//
// Why a job queue and not one long request: Lumiverse cuts every extension
// request off after 30 seconds, and a 50-step MOSS picture takes about a minute
// on the cloud. So LS posts a job, gets an id at once, and asks every few
// seconds until the picture is ready.
//
// The API key lives in the macOS Keychain (item "LS Cloud Helper"). It is never
// sent to Lumi Studio and never written to a file. DT_API_KEY in the environment
// is used instead when set, which is handy for a one-off test.
//
// Commands:
//   ls-cloud-helper save-key      ask for the key and keep it in the Keychain
//   ls-cloud-helper install       start the helper now and at every login
//   ls-cloud-helper uninstall     stop it and remove the login item
//   ls-cloud-helper restart       restart the installed helper (after a rebuild)
//   ls-cloud-helper status        is a key saved, is the helper answering
//   ls-cloud-helper test "prompt" make one picture and save it to the Desktop
//   ls-cloud-helper serve         run in this window (what the login item runs)

import Foundation
import Network
import UniformTypeIdentifiers
import _MediaGenerationKit

let helperVersion = "1.0.1"
let defaultPort: UInt16 = 7865
let defaultModel = "moss_image_sft_q8p.ckpt"
let keychainService = "LS Cloud Helper"
let keychainAccount = "drawthings-api-key"
let launchLabel = "com.fidgetycarrot.ls-cloud-helper"
let home = FileManager.default.homeDirectoryForCurrentUser

func log(_ text: String) {
  let stamp = ISO8601DateFormatter().string(from: Date())
  print("[\(stamp)] \(text)")
  fflush(stdout)
}

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ text: String) { description = text }
}

// MARK: - Small tools

@discardableResult
func runTool(_ path: String, _ args: [String], interactive: Bool = false) -> (code: Int32, out: String, err: String) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: path)
  process.arguments = args
  if interactive {
    do { try process.run() } catch { return (-1, "", "\(error)") }
    process.waitUntilExit()
    return (process.terminationStatus, "", "")
  }
  let out = Pipe(), err = Pipe()
  process.standardOutput = out
  process.standardError = err
  do { try process.run() } catch { return (-1, "", "\(error)") }
  let outData = out.fileHandleForReading.readDataToEndOfFile()
  let errData = err.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  return (process.terminationStatus, String(decoding: outData, as: UTF8.self), String(decoding: errData, as: UTF8.self))
}

func savedKey() -> String {
  if let env = ProcessInfo.processInfo.environment["DT_API_KEY"], !env.isEmpty { return env }
  let result = runTool("/usr/bin/security", ["find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w"])
  return result.code == 0 ? result.out.trimmingCharacters(in: .whitespacesAndNewlines) : ""
}

func text(_ value: Any?) -> String {
  if let s = value as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
  if let n = value as? NSNumber { return n.stringValue }
  return ""
}

func number(_ value: Any?) -> Double? {
  if let n = value as? NSNumber { return n.doubleValue }
  if let s = value as? String, let d = Double(s.trimmingCharacters(in: .whitespaces)) { return d }
  return nil
}

// Draw Things sizes are multiples of 64.
func size64(_ value: Double?, _ fallback: Int) -> Int {
  guard let value, value.isFinite, value > 0 else { return fallback }
  return max(256, min(2048, Int((value / 64).rounded()) * 64))
}

// "DPM++ 2M Karras" and the enum's own spelling ("dPMPP2MKarras") both flatten
// to "dpmpp2mkarras". The enum's case list is not published, so sweep it.
func flatten(_ name: String) -> String {
  name.lowercased().replacingOccurrences(of: "++", with: "pp").filter { $0.isLetter || $0.isNumber }
}

func samplerNamed<T: RawRepresentable>(_ name: String, like current: T) -> T? where T.RawValue: BinaryInteger {
  let want = flatten(name)
  guard !want.isEmpty else { return nil }
  for raw in 0..<128 {
    guard let candidate = T(rawValue: numericCast(raw)) else { continue }
    if flatten(String(describing: candidate)) == want { return candidate }
  }
  return nil
}

func samplerNames<T: RawRepresentable>(like current: T) -> [String] where T.RawValue: BinaryInteger {
  (0..<128).compactMap { raw in T(rawValue: numericCast(raw)).map { String(describing: $0) } }
}

// MARK: - Jobs

final class Job {
  let id: String
  let request: [String: Any]
  let created = Date()
  var state = "queued"        // queued, running, done, failed
  var step = 0
  var totalSteps = 0
  var error = ""
  var image = ""              // base64 PNG once done
  var seed: UInt32 = 0
  var seconds = 0
  var finished: Date?
  init(id: String, request: [String: Any]) { self.id = id; self.request = request }
}

let store = DispatchQueue(label: "ls-cloud-helper.jobs")
var jobs: [String: Job] = [:]
var queueTail: Task<Void, Never>?

actor Runner {
  var pipelines: [String: MediaGenerationPipeline] = [:]
  var defaults: [String: MediaGenerationPipeline.Configuration] = [:]
  var pipelineKey = ""

  func run(_ job: Job) async {
    store.sync { job.state = "running" }
    let started = Date()
    let request = job.request
    let model = text(request["model"]).isEmpty ? defaultModel : text(request["model"])
    do {
      let key = savedKey()
      guard !key.isEmpty else {
        throw HelperError("No Draw Things API key is saved. Run: ls-cloud-helper save-key")
      }
      if key != pipelineKey { pipelines = [:]; defaults = [:]; pipelineKey = key }
      var pipeline: MediaGenerationPipeline
      if let cached = pipelines[model] {
        pipeline = cached
      } else {
        log("Loading \(model) on the cloud…")
        pipeline = try await MediaGenerationPipeline.fromPretrained(model, backend: .cloudCompute(apiKey: key))
        defaults[model] = pipeline.configuration
      }
      if let base = defaults[model] { pipeline.configuration = base }

      var c = pipeline.configuration
      c.width = size64(number(request["width"]), c.width)
      c.height = size64(number(request["height"]), c.height)
      if let steps = number(request["steps"]), steps >= 1 { c.steps = min(150, Int(steps)) }
      if let cfg = number(request["guidance_scale"]), cfg >= 0 { c.guidanceScale = Float(cfg) }
      if let shift = number(request["shift"]), shift > 0 {
        c.shift = Float(shift)
        c.resolutionDependentShift = false
      }
      if let seed = number(request["seed"]), seed >= 0 {
        c.seed = UInt32(truncatingIfNeeded: Int64(seed))
      } else {
        c.seed = UInt32.random(in: 0...UInt32.max)
      }
      let sampler = text(request["sampler"])
      if !sampler.isEmpty {
        if let found = samplerNamed(sampler, like: c.sampler) {
          c.sampler = found
        } else {
          log("Sampler \"\(sampler)\" is not one Draw Things knows; using the model's own. Known: " +
            samplerNames(like: c.sampler).joined(separator: ", "))
        }
      }
      c.batchCount = 1
      c.batchSize = 1
      // LS writes the finished prompt; nothing should rewrite it on the way.
      c.expandPromptToJson = false
      pipeline.configuration = c
      pipelines[model] = pipeline

      let prompt = text(request["prompt"])
      let negative = text(request["negative_prompt"])
      log("Job \(job.id): \(model) · \(c.width)×\(c.height) · \(c.steps) steps · CFG \(c.guidanceScale) · shift \(c.shift) · seed \(c.seed)")
      let results = try await pipeline.generate(prompt: prompt, negativePrompt: negative, stateHandler: { state, _ in
        if case .generating(let step, let total) = state {
          store.sync { job.step = step; job.totalSteps = total }
        }
      })
      guard let first = results.first else { throw HelperError("Draw Things answered but sent no picture.") }
      let file = FileManager.default.temporaryDirectory.appendingPathComponent("ls-cloud-\(job.id).png")
      try first.write(to: file, type: .png)
      let data = try Data(contentsOf: file)
      try? FileManager.default.removeItem(at: file)
      let seconds = Int(Date().timeIntervalSince(started))
      store.sync {
        job.image = data.base64EncodedString()
        job.seed = c.seed
        job.seconds = seconds
        job.state = "done"
        job.finished = Date()
      }
      log("Job \(job.id) done in \(seconds)s (\(data.count / 1024) KB)")
    } catch {
      // A broken pipeline is not worth keeping; the next job loads it fresh.
      pipelines[model] = nil
      defaults[model] = nil
      let seconds = Int(Date().timeIntervalSince(started))
      store.sync {
        job.error = "\(error)"
        job.seconds = seconds
        job.state = "failed"
        job.finished = Date()
      }
      log("Job \(job.id) failed after \(seconds)s: \(error)")
    }
  }
}

let runner = Runner()

// Must be called on `store`.
func enqueue(_ request: [String: Any]) -> Job {
  let cutoff = Date().addingTimeInterval(-20 * 60)
  jobs = jobs.filter { $0.value.finished == nil || $0.value.finished! > cutoff }
  let job = Job(id: String(UUID().uuidString.prefix(8)).lowercased(), request: request)
  jobs[job.id] = job
  let previous = queueTail
  queueTail = Task {
    await previous?.value
    await runner.run(job)
  }
  return job
}

// MARK: - HTTP (loopback only)

struct Request {
  let method: String
  let path: String
  let body: Data
}

func parseRequest(_ buffer: Data) -> Request? {
  guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
  let head = String(decoding: buffer[buffer.startIndex..<headerEnd.lowerBound], as: UTF8.self)
  let lines = head.components(separatedBy: "\r\n")
  let first = (lines.first ?? "").split(separator: " ")
  guard first.count >= 2 else { return nil }
  var length = 0
  for line in lines.dropFirst() {
    let parts = line.split(separator: ":", maxSplits: 1)
    if parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
      length = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
    }
  }
  let bodyStart = headerEnd.upperBound
  guard buffer.count - (bodyStart - buffer.startIndex) >= length else { return nil }
  let body = buffer[bodyStart..<(bodyStart + length)]
  return Request(method: String(first[0]).uppercased(), path: String(first[1]), body: Data(body))
}

func respond(_ connection: NWConnection, _ status: Int, _ json: [String: Any]) {
  let body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data("{}".utf8)
  let reason = [200: "OK", 202: "Accepted", 400: "Bad Request", 404: "Not Found", 500: "Server Error"][status] ?? "OK"
  let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
  connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
}

func route(_ request: Request, _ connection: NWConnection) {
  let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
  if request.method == "GET" && path == "/health" {
    let key = !savedKey().isEmpty
    let counts = store.sync { () -> (Int, Bool) in
      (jobs.values.filter { $0.state == "queued" }.count, jobs.values.contains { $0.state == "running" })
    }
    respond(connection, 200, ["ok": true, "name": "ls-cloud-helper", "version": helperVersion,
                              "keySaved": key, "queued": counts.0, "busy": counts.1, "defaultModel": defaultModel])
    return
  }
  if request.method == "POST" && path == "/jobs" {
    guard let json = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] else {
      respond(connection, 400, ["error": "The request was not JSON."]); return
    }
    guard !text(json["prompt"]).isEmpty else {
      respond(connection, 400, ["error": "The request has no prompt."]); return
    }
    let job = store.sync { enqueue(json) }
    let ahead = store.sync { jobs.values.filter { $0.state == "queued" && $0.id != job.id }.count }
    respond(connection, 202, ["id": job.id, "ahead": ahead])
    return
  }
  if request.method == "GET" && path.hasPrefix("/jobs/") {
    let id = String(path.dropFirst("/jobs/".count))
    let info: [String: Any]? = store.sync {
      guard let job = jobs[id] else { return nil }
      var out: [String: Any] = ["id": job.id, "state": job.state, "step": job.step,
                                "totalSteps": job.totalSteps, "seconds": job.seconds]
      if job.state == "running" { out["seconds"] = Int(Date().timeIntervalSince(job.created)) }
      if job.state == "failed" { out["error"] = job.error }
      if job.state == "done" { out["image"] = job.image; out["seed"] = Int(job.seed) }
      return out
    }
    if let info { respond(connection, 200, info) } else { respond(connection, 404, ["error": "No such job (finished jobs are kept 20 minutes)."]) }
    return
  }
  respond(connection, 404, ["error": "Unknown address."])
}

final class Server {
  let listener: NWListener
  let queue = DispatchQueue(label: "ls-cloud-helper.http", attributes: .concurrent)
  let port: UInt16

  init(port: UInt16) throws {
    self.port = port
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    parameters.requiredInterfaceType = .loopback   // never reachable from other machines
    listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
  }

  func start() {
    let port = self.port
    listener.stateUpdateHandler = { state in
      switch state {
      case .ready: log("LS Cloud Helper \(helperVersion) listening on 127.0.0.1:\(port)")
      case .failed(let error):
        log("Could not listen on port \(port): \(error). Is another copy already running?")
        exit(1)
      default: break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return }
      connection.start(queue: self.queue)
      self.read(connection, Data())
    }
    listener.start(queue: queue)
  }

  func read(_ connection: NWConnection, _ buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
      var buffer = buffer
      if let data { buffer.append(data) }
      if let request = parseRequest(buffer) { route(request, connection); return }
      if complete || error != nil || buffer.count > 16 << 20 { connection.cancel(); return }
      self?.read(connection, buffer)
    }
  }
}

// MARK: - Login item

func plistURL() -> URL { home.appendingPathComponent("Library/LaunchAgents/\(launchLabel).plist") }
func logURL() -> URL { home.appendingPathComponent("Library/Logs/ls-cloud-helper.log") }

func install() {
  guard let exe = Bundle.main.executableURL?.resolvingSymlinksInPath() else {
    print("Could not tell where this program is."); exit(1)
  }
  let plist: [String: Any] = [
    "Label": launchLabel,
    "ProgramArguments": [exe.path, "serve"],
    "RunAtLoad": true,
    "KeepAlive": true,
    "StandardOutPath": logURL().path,
    "StandardErrorPath": logURL().path,
  ]
  do {
    try FileManager.default.createDirectory(at: plistURL().deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: logURL().deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: plistURL())
  } catch {
    print("Could not write the login item: \(error)"); exit(1)
  }
  let domain = "gui/\(getuid())"
  runTool("/bin/launchctl", ["bootout", "\(domain)/\(launchLabel)"])
  let result = runTool("/bin/launchctl", ["bootstrap", domain, plistURL().path])
  if result.code != 0 {
    print("launchctl could not start it: \(result.err)\(result.out)"); exit(1)
  }
  print("Installed. The helper is running now and will start at every login.")
  print("It runs: \(exe.path)")
  print("Log: \(logURL().path)")
  if savedKey().isEmpty { print("No API key saved yet — run: \(exe.path) save-key") }
}

func uninstall() {
  runTool("/bin/launchctl", ["bootout", "gui/\(getuid())/\(launchLabel)"])
  try? FileManager.default.removeItem(at: plistURL())
  print("Stopped and removed from login. Your key is still in the Keychain (item \"\(keychainService)\").")
}

// MARK: - Commands

func health(port: UInt16) -> String {
  guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return "?" }
  var answer = "not answering"
  let done = DispatchSemaphore(value: 0)
  URLSession.shared.dataTask(with: url) { data, _, _ in
    if let data, let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
      answer = "answering (version \(text(json["version"])), busy: \(json["busy"] as? Bool == true ? "yes" : "no"))"
    }
    done.signal()
  }.resume()
  _ = done.wait(timeout: .now() + 5)
  return answer
}

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? "serve"
let port = UInt16(ProcessInfo.processInfo.environment["LS_CLOUD_PORT"] ?? "") ?? defaultPort

switch command {
case "save-key":
  // Read here, not by letting `security` prompt: a child started by Process
  // is not in the Terminal's foreground group, so it can never read the
  // keyboard and the pasted key just echoed on screen (3 Nov 2026).
  print("Paste your Draw Things API key (from api.drawthings.ai/dashboard) and press Return.")
  print("Nothing shows while you paste — that is normal.")
  guard let raw = getpass("Key: ") else { print("No key read."); exit(1) }
  let key = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
  guard !key.isEmpty else { print("No key entered; nothing saved."); exit(1) }
  let result = runTool("/usr/bin/security",
    ["add-generic-password", "-U", "-A", "-s", keychainService, "-a", keychainAccount, "-l", keychainService, "-w", key])
  if result.code == 0 {
    print("Saved in the Keychain.")
    if FileManager.default.fileExists(atPath: plistURL().path) {
      runTool("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(launchLabel)"])
      print("Restarted the installed helper so it uses the new key.")
    }
  } else {
    print("The key was not saved: \(result.err)\(result.out)")
    exit(1)
  }

case "install":
  install()

case "uninstall":
  uninstall()

case "restart":
  let result = runTool("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(launchLabel)"])
  print(result.code == 0 ? "Restarted." : "Could not restart — is it installed? \(result.err)")

case "status":
  print("Key saved: \(savedKey().isEmpty ? "no" : "yes")")
  print("Login item: \(FileManager.default.fileExists(atPath: plistURL().path) ? "installed" : "not installed")")
  print("Helper on port \(port): \(health(port: port))")
  print("Log: \(logURL().path)")

case "test":
  let prompt = arguments.dropFirst().joined(separator: " ")
  let request: [String: Any] = [
    "prompt": prompt.isEmpty ? "An anime-style illustration. A young woman with long silver hair reads a book by a rainy window, in warm lamplight." : prompt,
    "negative_prompt": "worst quality, bad anatomy, watermark, text",
    "width": 1024, "height": 1024, "steps": 50, "guidance_scale": 4, "shift": 5,
  ]
  let job = store.sync { enqueue(request) }
  Task {
    var lastStep = -1
    while true {
      try? await Task.sleep(nanoseconds: 500_000_000)
      let snapshot = store.sync { (job.state, job.step, job.totalSteps, job.error, job.image, job.seconds) }
      if snapshot.1 != lastStep && snapshot.2 > 0 && snapshot.1 % 10 == 0 { print("  step \(snapshot.1) of \(snapshot.2)"); lastStep = snapshot.1 }
      if snapshot.0 == "failed" { print("FAILED after \(snapshot.5)s: \(snapshot.3)"); exit(3) }
      if snapshot.0 == "done" {
        let out = home.appendingPathComponent("Desktop/ls-cloud-\(Int(Date().timeIntervalSince1970)).png")
        do {
          try Data(base64Encoded: snapshot.4)?.write(to: out)
          print("Saved \(out.path) in \(snapshot.5)s")
          exit(0)
        } catch { print("Could not save: \(error)"); exit(4) }
      }
    }
  }
  dispatchMain()

case "serve":
  do {
    let server = try Server(port: port)
    server.start()
    if savedKey().isEmpty { log("No API key saved yet. Run: ls-cloud-helper save-key") }
    dispatchMain()
  } catch {
    log("Could not start: \(error)")
    exit(1)
  }

default:
  print("""
  LS Cloud Helper \(helperVersion)
    save-key    keep your Draw Things API key in the Keychain
    install     start the helper now and at every login
    uninstall   stop it and remove the login item
    restart     restart it (after a rebuild)
    status      is a key saved, is the helper answering
    test "…"    make one picture and save it to the Desktop
    serve       run in this window
  """)
}
