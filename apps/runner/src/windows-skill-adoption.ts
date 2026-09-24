import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { validSkillName } from "@wollipog/protocol";
import type {
  PlatformAdoptionRequest,
  PlatformRestoreRequest,
  RecoveryDirectoryFacts,
  RecoveryJournalFacts,
  RecoverySourceFacts,
  SkillAdoptionPlatformHelper,
} from "./skill-adoption-platform.js";
import { skillsStoreRoot } from "./skills.js";
import { WINDOWS_JUNCTION_REPARSE_TYPES } from "./windows-skill-junction.js";
import { WINDOWS_SKILL_SNAPSHOT_TYPES } from "./windows-skill-snapshots.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTITY = /^\d+:\d+$/u;
/** Test-only checkpoint variables. The runner removes them from every helper environment. */
export const WINDOWS_ADOPTION_CHECKPOINT_VARIABLES = [
  "WOLLIPOG_SKILL_ADOPTION_TEST_CHECKPOINT",
  "WOLLIPOG_SKILL_ADOPTION_TEST_CONTROL",
] as const;

/**
 * Fixed native Windows adoption transaction, compiled with the snapshot reader and the junction
 * payload code so it shares their pinned no-follow walk, discovery generation, and mount-point
 * handling. It mirrors the Linux module: two content passes against the approved digest, a private
 * journal, a handle-relative no-replace rename of the original, and a junction published only by
 * creating a new empty directory. Nothing is deleted, overwritten, or restored automatically.
 *
 * The source is held with DELETE access and without FILE_SHARE_DELETE from discovery to rename, so
 * no other process can move or replace it; verification opens that directory again only with
 * FILE_SHARE_DELETE, which Windows requires alongside the runner's own DELETE handle.
 */
const WINDOWS_SKILL_ADOPTION_TYPES = String.raw`
public static class WollipogWindowsSkillAdoption {
  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint DELETE = 0x00010000;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint FILE_SHARE_WRITE = 0x00000002;
  const uint FILE_SHARE_DELETE = 0x00000004;
  const uint CREATE_NEW = 1;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  const int ERROR_FILE_NOT_FOUND = 2;
  const int ERROR_PATH_NOT_FOUND = 3;
  const int ERROR_FILE_EXISTS = 80;
  const int FILE_RENAME_INFORMATION = 10;
  const int MAX_JOURNAL_BYTES = 8192;
  const int MAX_RECOVERY_OPERATIONS = 64;
  const string JournalPrefix = ".wollipog-adoption-";
  static readonly Regex Uuid = new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    RegexOptions.CultureInvariant);
  static readonly Regex Hex64 = new Regex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
  static readonly Regex IdentityPattern = new Regex("^[0-9]+:[0-9]+$", RegexOptions.CultureInvariant);
  static readonly Regex RelativeDirectory = new Regex("^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$",
    RegexOptions.CultureInvariant);
  static readonly Regex Account = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.CultureInvariant);
  static readonly Regex NameField = new Regex("\"name\":\"([a-z0-9][a-z0-9._-]{0,63})\"", RegexOptions.CultureInvariant);
  static readonly Regex DigestField = new Regex("\"digest\":\"([0-9a-f]{64})\"", RegexOptions.CultureInvariant);

  [StructLayout(LayoutKind.Sequential)]
  struct IO_STATUS_BLOCK { public IntPtr Status; public IntPtr Information; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateDirectoryW(string path, IntPtr security);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FlushFileBuffers(SafeFileHandle file);

  [DllImport("ntdll.dll")]
  static extern int NtSetInformationFile(SafeFileHandle file, out IO_STATUS_BLOCK status, IntPtr information,
    uint length, int informationClass);

  public sealed class Journal {
    public string OperationId { get; set; }
    public string Intent { get; set; }
    public string Name { get; set; }
    public string Digest { get; set; }
    public string OriginalIdentity { get; set; }
    public int Kind { get; set; }
    public string SourceIdentity { get; set; }
    public int Role { get; set; }
  }

  public sealed class Inspection {
    public string ParentIdentity { get; set; }
    public List<Journal> Journals { get; set; }
    public bool Truncated { get; set; }
  }

  sealed class Entry { public string Path; public string Sha; public long Size; }
  sealed class Budget { public int Entries; public int Files; public long Bytes; }

  public static void Emit(string line) {
    Console.Out.Write(line + "\n");
    Console.Out.Flush();
  }

  // Test-only fault injection. The runner strips both variables from the helper environment.
  static void Checkpoint(string stage) {
    var selected = Environment.GetEnvironmentVariable("WOLLIPOG_SKILL_ADOPTION_TEST_CHECKPOINT");
    var control = Environment.GetEnvironmentVariable("WOLLIPOG_SKILL_ADOPTION_TEST_CONTROL");
    if (selected != stage || String.IsNullOrEmpty(control)) return;
    Emit("checkpoint");
    var deadline = DateTime.UtcNow.AddSeconds(60);
    while (!File.Exists(control)) {
      if (DateTime.UtcNow > deadline) throw new TimeoutException("checkpoint was not released");
      System.Threading.Thread.Sleep(50);
    }
    var command = File.ReadAllText(control).Trim();
    if (command == "k") {
      System.Diagnostics.Process.GetCurrentProcess().Kill();
      System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);
    }
    if (command != "c") throw new InvalidOperationException("checkpoint failure");
  }

  static string Identity(SafeFileHandle handle) {
    var info = WollipogWindowsSkillSnapshots.Info(handle);
    ulong index = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;
    return info.VolumeSerialNumber.ToString() + ":" + index.ToString();
  }

  static string Hex(byte[] bytes) {
    var result = new StringBuilder(bytes.Length * 2);
    foreach (var b in bytes) result.Append(b.ToString("x2"));
    return result.ToString();
  }

  static void Require(bool condition, string message) {
    if (!condition) throw new InvalidOperationException(message);
  }

  static SafeFileHandle OpenRaw(string path, uint access, uint share, uint flags) {
    var handle = CreateFileW(path, access, share, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new Win32Exception(error);
    }
    return handle;
  }

  // The source is pinned with DELETE access and without FILE_SHARE_DELETE until it is renamed.
  static SafeFileHandle OpenSourceForRename(string path, string root) {
    var handle = OpenRaw(path, GENERIC_READ | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    try {
      var info = WollipogWindowsSkillSnapshots.Info(handle);
      Require((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
        (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
        WollipogWindowsSkillSnapshots.Below(WollipogWindowsSkillSnapshots.FinalPath(handle), root), "unsafe skill path");
      return handle;
    } catch { handle.Dispose(); throw; }
  }

  // Classify one entry without following it: 0 absent, 1 directory, 2 link, 3 other.
  static int Probe(string path, string root, out string identity, out string target) {
    identity = "";
    target = null;
    var handle = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return 0;
      throw new Win32Exception(error);
    }
    using (handle) {
      var info = WollipogWindowsSkillSnapshots.Info(handle);
      if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        target = WollipogJunctionReparse.MountPointTarget(handle);
        return 2;
      }
      if ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
          WollipogWindowsSkillSnapshots.Below(WollipogWindowsSkillSnapshots.FinalPath(handle), root)) {
        identity = Identity(handle);
        return 1;
      }
      return 3;
    }
  }

  // Identity of whatever a link text resolves to now; used to prove it names the pinned target.
  static string ResolvedIdentity(string path) {
    using (var handle = OpenRaw(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        FILE_FLAG_BACKUP_SEMANTICS)) {
      Require((WollipogWindowsSkillSnapshots.Info(handle).FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0,
        "link target is not a directory");
      return Identity(handle);
    }
  }

  // Re-walk a fixed relative directory from a pinned root's final path without following any
  // component. The configured root is never resolved again, so verification cannot switch roots.
  static void CheckPath(string root, string relative, string expected) {
    var current = root;
    string identity = "", target;
    foreach (var segment in relative.Split('/')) {
      current = Path.Combine(current, segment);
      Require(Probe(current, root, out identity, out target) == 1, "the recorded path changed");
    }
    Require(identity == expected, "the recorded identity changed");
  }

  // Mirrors validSkillFilePath; the exact path participates in the canonical version digest.
  static void ValidatePath(string path) {
    Require(path.Length > 0 && path.Length <= 256 && path[0] != '/' && path.IndexOf('\\') < 0, "invalid skill file path");
    Require(!(path.Length >= 2 && path[1] == ':' &&
      ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z'))), "invalid skill file path");
    var parts = path.Split('/');
    Require(parts.Length <= 8, "invalid skill file path");
    foreach (var part in parts) Require(part.Length > 0 && part != "." && part != "..", "invalid skill file path");
    for (int index = 0; index < path.Length; index++) {
      char current = path[index];
      Require(current >= 0x20 && current != 0x7f, "invalid skill file path");
      if (Char.IsHighSurrogate(current)) {
        Require(index + 1 < path.Length && Char.IsLowSurrogate(path[index + 1]), "invalid skill file path");
        index++;
      } else Require(!Char.IsLowSurrogate(current), "invalid skill file path");
    }
  }

  static void Collect(string directoryPath, string root, string prefix, int depth, Budget budget, List<Entry> entries) {
    Require(depth <= 16, "skill tree is too deep");
    foreach (var childPath in Directory.EnumerateFileSystemEntries(directoryPath)) {
      Require(++budget.Entries <= WollipogWindowsSkillSnapshots.MAX_USEFUL_ENTRIES, "skill tree has too many entries");
      var relative = prefix + Path.GetFileName(childPath);
      ValidatePath(relative);
      SafeFileHandle child = null;
      try {
        try { child = WollipogWindowsSkillSnapshots.Open(childPath, true, root); } catch { }
        if (child != null) {
          Collect(WollipogWindowsSkillSnapshots.FinalPath(child), root, relative + "/", depth + 1, budget, entries);
          continue;
        }
        child = WollipogWindowsSkillSnapshots.Open(childPath, false, root);
        var before = WollipogWindowsSkillSnapshots.Info(child);
        Require(before.NumberOfLinks == 1, "hard-linked files are unsupported");
        long size = ((long)before.FileSizeHigh << 32) | before.FileSizeLow;
        Require(size <= WollipogWindowsSkillSnapshots.MAX_FILE_BYTES &&
          budget.Bytes + size <= WollipogWindowsSkillSnapshots.MAX_TOTAL_BYTES &&
          ++budget.Files <= WollipogWindowsSkillSnapshots.MAX_FILES, "skill content is too large");
        string sha;
        using (var hash = SHA256.Create())
        using (var borrowed = new SafeFileHandle(child.DangerousGetHandle(), false))
        using (var stream = new FileStream(borrowed, FileAccess.Read, 65536, false)) {
          var buffer = new byte[65536];
          long total = 0;
          int read;
          while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) {
            total += read;
            Require(total <= size, "skill file changed");
            hash.TransformBlock(buffer, 0, read, null, 0);
          }
          hash.TransformFinalBlock(new byte[0], 0, 0);
          Require(total == size, "skill file changed");
          sha = Hex(hash.Hash);
        }
        Require(WollipogWindowsSkillSnapshots.Fingerprint(before) ==
          WollipogWindowsSkillSnapshots.Fingerprint(WollipogWindowsSkillSnapshots.Info(child)), "skill file changed");
        budget.Bytes += size;
        entries.Add(new Entry { Path = relative, Sha = sha, Size = size });
      } finally { if (child != null) child.Dispose(); }
    }
  }

  // Mirrors skillVersionDigest: SHA-256 over {"files":[{"path","sha256","size"}]} in UTF-16 order.
  // Validated paths contain no control characters or backslashes, so only a quote needs escaping.
  static string TreeDigest(string directoryPath, string root) {
    var entries = new List<Entry>();
    Collect(directoryPath, root, "", 0, new Budget(), entries);
    entries.Sort((left, right) => String.CompareOrdinal(left.Path, right.Path));
    Require(entries.Exists(entry => entry.Path == "SKILL.md"), "SKILL.md is missing");
    var json = new StringBuilder("{\"files\":[");
    for (int index = 0; index < entries.Count; index++) {
      if (index > 0) json.Append(',');
      json.Append("{\"path\":\"").Append(entries[index].Path.Replace("\"", "\\\"")).Append("\",\"sha256\":\"")
        .Append(entries[index].Sha).Append("\",\"size\":").Append(entries[index].Size.ToString()).Append('}');
    }
    json.Append("]}");
    using (var hash = SHA256.Create()) return Hex(hash.ComputeHash(new UTF8Encoding(false).GetBytes(json.ToString())));
  }

  static void CheckContent(SafeFileHandle directory, string path, string root, string digest) {
    var before = WollipogWindowsSkillSnapshots.DirectoryGeneration(directory, path, root);
    var first = TreeDigest(path, root);
    var second = TreeDigest(path, root);
    var after = WollipogWindowsSkillSnapshots.DirectoryGeneration(directory, path, root);
    Require(first == digest && second == digest && before == after, "skill content changed");
  }

  static byte[] ReadRecord(string path) {
    using (var handle = OpenRaw(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_FLAG_OPEN_REPARSE_POINT)) {
      var info = WollipogWindowsSkillSnapshots.Info(handle);
      Require((info.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) == 0 &&
        info.FileSizeHigh == 0 && info.FileSizeLow <= MAX_JOURNAL_BYTES, "unsafe journal record");
      var bytes = new byte[info.FileSizeLow];
      using (var borrowed = new SafeFileHandle(handle.DangerousGetHandle(), false))
      using (var stream = new FileStream(borrowed, FileAccess.Read, 4096, false)) {
        int offset = 0;
        while (offset < bytes.Length) {
          int read = stream.Read(bytes, offset, bytes.Length - offset);
          if (read == 0) break;
          offset += read;
        }
        Require(offset == bytes.Length && stream.ReadByte() == -1, "journal record changed");
      }
      return bytes;
    }
  }

  // Exclusive create, write, and flush. A write-once record accepts only identical existing bytes.
  static void WriteRecord(string directory, string name, string content, bool once) {
    var path = Path.Combine(directory, name);
    var bytes = new UTF8Encoding(false).GetBytes(content);
    var handle = CreateFileW(path, GENERIC_WRITE, 0, IntPtr.Zero, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      if (!once || error != ERROR_FILE_EXISTS) throw new Win32Exception(error);
      var existing = ReadRecord(path);
      Require(existing.Length == bytes.Length, "recovery record conflict");
      for (int index = 0; index < bytes.Length; index++) Require(existing[index] == bytes[index], "recovery record conflict");
      return;
    }
    using (handle) {
      using (var borrowed = new SafeFileHandle(handle.DangerousGetHandle(), false))
      using (var stream = new FileStream(borrowed, FileAccess.Write, 4096, false)) {
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
      }
      if (!FlushFileBuffers(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }

  static string JsonString(string value) {
    var result = new StringBuilder("\"");
    foreach (var current in value) {
      if (current == '"' || current == '\\') result.Append('\\').Append(current);
      else if (current < 0x20) result.Append("\\u").Append(((int)current).ToString("x4"));
      else result.Append(current);
    }
    return result.Append('"').ToString();
  }

  // Handle-relative, no-replace rename: the original can only land inside the pinned journal.
  static void RenameInto(SafeFileHandle handle, SafeFileHandle directory, string name) {
    var nameBytes = Encoding.Unicode.GetBytes(name);
    int rootOffset = IntPtr.Size;
    int lengthOffset = rootOffset + IntPtr.Size;
    int nameOffset = lengthOffset + 4;
    int size = nameOffset + nameBytes.Length + 2;
    var buffer = Marshal.AllocHGlobal(size);
    bool added = false;
    try {
      directory.DangerousAddRef(ref added);
      for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
      Marshal.WriteIntPtr(buffer, rootOffset, directory.DangerousGetHandle());
      Marshal.WriteInt32(buffer, lengthOffset, nameBytes.Length);
      Marshal.Copy(nameBytes, 0, IntPtr.Add(buffer, nameOffset), nameBytes.Length);
      IO_STATUS_BLOCK status;
      int result = NtSetInformationFile(handle, out status, buffer, (uint)size, FILE_RENAME_INFORMATION);
      Require(result == 0, "the no-replace rename failed with status 0x" + result.ToString("x8"));
    } finally {
      if (added) directory.DangerousRelease();
      Marshal.FreeHGlobal(buffer);
    }
  }

  // Publish a junction only by creating a new empty directory: CreateDirectoryW fails on any
  // occupant, and the reparse payload is set through an exclusive-write handle to that directory.
  static void CreateJunction(string path, string target, string root) {
    if (!CreateDirectoryW(path, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    using (var handle = OpenRaw(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)) {
      var info = WollipogWindowsSkillSnapshots.Info(handle);
      Require((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
        (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
        WollipogWindowsSkillSnapshots.Below(WollipogWindowsSkillSnapshots.FinalPath(handle), root),
        "the new link directory changed");
      var payload = WollipogJunctionReparse.Payload(target);
      int returned;
      if (!WollipogJunctionReparse.DeviceIoControl(handle, WollipogJunctionReparse.FSCTL_SET_REPARSE_POINT,
          payload, payload.Length, null, 0, out returned, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "could not publish the junction");
      }
    }
  }

  static bool LinkIs(string path, string root, string expected) {
    string identity, target;
    return Probe(path, root, out identity, out target) == 2 && target != null &&
      WollipogJunctionReparse.SameTarget(target, expected);
  }

  static string Pinned(List<SafeFileHandle> handles, SafeFileHandle handle) {
    handles.Add(handle);
    return WollipogWindowsSkillSnapshots.FinalPath(handle);
  }

  static void CheckSource(string local, string name, string parentId, string sourceId,
      SafeFileHandle source, string sourcePath, string root, string generation, string digest) {
    CheckPath(root, local, parentId);
    CheckPath(root, local + "/" + name, sourceId);
    Require(WollipogWindowsSkillSnapshots.DirectoryGeneration(source, sourcePath, root) == generation, "source generation changed");
    CheckContent(source, sourcePath, root, digest);
    Require(WollipogWindowsSkillSnapshots.DirectoryGeneration(source, sourcePath, root) == generation, "source generation changed");
  }

  public static void Adopt(string home, string local, string sourceDirectory, string name, string generation,
      string digest, string dataDir, string operation, string account, string managedLink) {
    Require(RelativeDirectory.IsMatch(local) && RelativeDirectory.IsMatch(sourceDirectory) &&
      WollipogWindowsSkillSnapshots.SkillName.IsMatch(name) && Hex64.IsMatch(generation) && Hex64.IsMatch(digest) &&
      Uuid.IsMatch(operation) && (String.IsNullOrEmpty(account) || Account.IsMatch(account)) &&
      !String.IsNullOrEmpty(managedLink), "invalid adoption request");
    var targetRelative = "skills/store/" + name + "/" + digest;
    var handles = new List<SafeFileHandle>();
    try {
      var homeHandle = WollipogWindowsSkillSnapshots.OpenHome(home);
      var root = Pinned(handles, homeHandle);
      string parentPath, targetPath;
      var ancestry = new List<SafeFileHandle>();
      var parent = WollipogWindowsSkillSnapshots.OpenRelativeDirectory(homeHandle, local, out parentPath, ancestry);
      handles.AddRange(ancestry);
      var sourcePath = Path.Combine(parentPath, name);
      var source = OpenSourceForRename(sourcePath, root);
      handles.Add(source);
      var dataHandle = WollipogWindowsSkillSnapshots.OpenHome(dataDir);
      var dataRoot = Pinned(handles, dataHandle);
      var storeAncestry = new List<SafeFileHandle>();
      var target = WollipogWindowsSkillSnapshots.OpenRelativeDirectory(dataHandle, targetRelative, out targetPath, storeAncestry);
      handles.AddRange(storeAncestry);
      Require(!WollipogWindowsSkillSnapshots.Below(sourcePath, targetPath) &&
        !WollipogWindowsSkillSnapshots.Below(targetPath, sourcePath), "source and store overlap");
      string parentId = Identity(parent), sourceId = Identity(source), targetId = Identity(target);
      // The link text is the runner's own spelling of the store path; it must name the pinned version.
      Require(ResolvedIdentity(managedLink) == targetId, "the store link does not name the verified version");
      CheckSource(local, name, parentId, sourceId, source, sourcePath, root, generation, digest);
      CheckContent(target, targetPath, dataRoot, digest);

      var backupName = JournalPrefix + operation;
      var backupPath = Path.Combine(parentPath, backupName);
      Emit("journal");
      if (!CreateDirectoryW(backupPath, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var backup = WollipogWindowsSkillSnapshots.Open(backupPath, true, root);
      handles.Add(backup);
      var intent = String.IsNullOrEmpty(account)
        ? "{\"format\":1,\"operationId\":\"" + operation + "\",\"sourceDirectory\":\"" + sourceDirectory +
          "\",\"name\":\"" + name + "\",\"digest\":\"" + digest + "\",\"generation\":\"" + generation +
          "\",\"sourceIdentity\":\"" + sourceId + "\",\"parentIdentity\":\"" + parentId + "\",\"targetIdentity\":\"" +
          targetId + "\",\"targetRelative\":\"" + targetRelative + "\"}"
        : "{\"format\":2,\"operationId\":\"" + operation + "\",\"sourceDirectory\":\"" + sourceDirectory +
          "\",\"localSourceDirectory\":\"" + local + "\",\"providerAccountId\":\"" + account + "\",\"name\":\"" + name +
          "\",\"digest\":\"" + digest + "\",\"generation\":\"" + generation + "\",\"sourceIdentity\":\"" + sourceId +
          "\",\"parentIdentity\":\"" + parentId + "\",\"targetIdentity\":\"" + targetId + "\",\"targetRelative\":\"" +
          targetRelative + "\"}";
      WriteRecord(backupPath, "intent.json", intent, false);
      Checkpoint("intent_durable");

      CheckSource(local, name, parentId, sourceId, source, sourcePath, root, generation, digest);
      CheckPath(dataRoot, targetRelative, targetId);
      // The original may only move into the journal that recovery inspection will find.
      var backupRelative = local + "/" + backupName;
      CheckPath(root, backupRelative, Identity(backup));
      RenameInto(source, backup, "original");
      Checkpoint("source_preserved");
      var originalPath = Path.Combine(backupPath, "original");
      Require(Identity(source) == sourceId, "the preserved original changed");
      CheckPath(root, backupRelative + "/original", sourceId);
      CheckContent(source, originalPath, root, digest);
      WriteRecord(backupPath, "preserved.json", "{\"sourceIdentity\":\"" + sourceId + "\",\"digest\":\"" + digest + "\"}", false);
      CheckPath(root, local, parentId);
      CheckPath(root, backupRelative + "/original", sourceId);
      CheckPath(dataRoot, targetRelative, targetId);
      CheckContent(target, targetPath, dataRoot, digest);
      CreateJunction(sourcePath, managedLink, root);
      Checkpoint("link_created");
      CheckPath(root, local, parentId);
      CheckPath(root, backupRelative + "/original", sourceId);
      CheckPath(dataRoot, targetRelative, targetId);
      CheckContent(target, targetPath, dataRoot, digest);
      Require(LinkIs(sourcePath, root, managedLink) && ResolvedIdentity(sourcePath) == targetId,
        "the published link changed");
      WriteRecord(backupPath, "linked.json", "{\"digest\":\"" + digest + "\"}", false);
      Emit("adopted");
    } finally {
      for (int index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
    }
  }

  public static Inspection Inspect(string home, string local, string homeLink, string storeLink, string only) {
    Require(RelativeDirectory.IsMatch(local) && (String.IsNullOrEmpty(only) || Uuid.IsMatch(only)), "invalid inspection");
    var result = new Inspection { ParentIdentity = "", Journals = new List<Journal>(), Truncated = false };
    SafeFileHandle homeHandle;
    try { homeHandle = WollipogWindowsSkillSnapshots.OpenHome(home); } catch { return result; }
    var ancestry = new List<SafeFileHandle>();
    try {
      string parentPath;
      SafeFileHandle parent;
      try { parent = WollipogWindowsSkillSnapshots.OpenRelativeDirectory(homeHandle, local, out parentPath, ancestry); }
      catch { return result; }
      var root = WollipogWindowsSkillSnapshots.FinalPath(homeHandle);
      result.ParentIdentity = Identity(parent);
      if (!String.IsNullOrEmpty(only)) {
        // A targeted lookup opens the named journal directly, like Linux restore, so it is never
        // hidden behind the bounded listing scan of a very large harness directory.
        var targeted = InspectJournal(parentPath, JournalPrefix + only, only, root, local, homeLink, storeLink);
        if (targeted != null) result.Journals.Add(targeted);
        return result;
      }
      int raw = 0;
      foreach (var entryPath in Directory.EnumerateFileSystemEntries(parentPath)) {
        if (++raw > WollipogWindowsSkillSnapshots.MAX_RAW_ENTRIES) { result.Truncated = true; break; }
        var entryName = Path.GetFileName(entryPath);
        if (!entryName.StartsWith(JournalPrefix, StringComparison.Ordinal)) continue;
        var operation = entryName.Substring(JournalPrefix.Length);
        if (!Uuid.IsMatch(operation)) continue;
        if (result.Journals.Count >= MAX_RECOVERY_OPERATIONS) { result.Truncated = true; break; }
        var journal = InspectJournal(parentPath, entryName, operation, root, local, homeLink, storeLink);
        if (journal != null) result.Journals.Add(journal);
      }
      return result;
    } finally {
      WollipogWindowsSkillSnapshots.DisposeAll(ancestry);
      homeHandle.Dispose();
    }
  }

  // Facts for one journal entry, or null when it is not a readable journal directory.
  static Journal InspectJournal(string parentPath, string entryName, string operation, string root, string local,
      string homeLink, string storeLink) {
    var entryPath = Path.Combine(parentPath, entryName);
    SafeFileHandle backup;
    try { backup = WollipogWindowsSkillSnapshots.Open(entryPath, true, root); } catch { return null; }
    using (backup) {
      string intent;
      try { intent = new UTF8Encoding(false, true).GetString(ReadRecord(Path.Combine(entryPath, "intent.json"))); }
      catch { return null; }
      var journal = new Journal { OperationId = operation, Intent = intent, Name = "", Digest = "",
        OriginalIdentity = "", Kind = 3, SourceIdentity = "", Role = 0 };
      string identity, target;
      if (Probe(Path.Combine(entryPath, "original"), root, out identity, out target) == 1) journal.OriginalIdentity = identity;
      var nameMatch = NameField.Match(intent);
      var digestMatch = DigestField.Match(intent);
      if (nameMatch.Success && digestMatch.Success) {
        journal.Name = nameMatch.Groups[1].Value;
        journal.Digest = digestMatch.Groups[1].Value;
        journal.Kind = Probe(Path.Combine(parentPath, journal.Name), root, out identity, out target);
        if (journal.Kind == 1) journal.SourceIdentity = identity;
        if (journal.Kind == 2) {
          var managed = String.IsNullOrEmpty(storeLink) ? "" : storeLink + "\\" + journal.Name + "\\" + journal.Digest;
          var recovery = homeLink + "\\" + local.Replace('/', '\\') + "\\" + entryName + "\\original";
          try {
            journal.Role = target == null ? 3
              : managed.Length > 0 && WollipogJunctionReparse.SameTarget(target, managed) ? 1
              : homeLink.Length > 0 && WollipogJunctionReparse.SameTarget(target, recovery) ? 2 : 3;
          } catch { journal.Role = 3; }
        }
      }
      return journal;
    }
  }

  public static void Restore(string home, string local, string operation, string name, string digest,
      string parentExpected, string sourceExpected, string managedLink, string recoveryLink) {
    Require(RelativeDirectory.IsMatch(local) && Uuid.IsMatch(operation) &&
      WollipogWindowsSkillSnapshots.SkillName.IsMatch(name) && Hex64.IsMatch(digest) &&
      IdentityPattern.IsMatch(parentExpected) && IdentityPattern.IsMatch(sourceExpected) &&
      !String.IsNullOrEmpty(managedLink) && !String.IsNullOrEmpty(recoveryLink), "invalid restore request");
    var handles = new List<SafeFileHandle>();
    try {
      var homeHandle = WollipogWindowsSkillSnapshots.OpenHome(home);
      var root = Pinned(handles, homeHandle);
      string parentPath;
      var ancestry = new List<SafeFileHandle>();
      var parent = WollipogWindowsSkillSnapshots.OpenRelativeDirectory(homeHandle, local, out parentPath, ancestry);
      handles.AddRange(ancestry);
      Require(Identity(parent) == parentExpected, "the source parent identity changed");
      var backupName = JournalPrefix + operation;
      var backupPath = Path.Combine(parentPath, backupName);
      var backup = WollipogWindowsSkillSnapshots.Open(backupPath, true, root);
      handles.Add(backup);
      var originalPath = Path.Combine(backupPath, "original");
      var original = WollipogWindowsSkillSnapshots.Open(originalPath, true, root);
      handles.Add(original);
      Require(Identity(original) == sourceExpected && TreeDigest(originalPath, root) == digest, "the preserved original changed");
      WriteRecord(backupPath, "restore-intent.json",
        "{\"operationId\":\"" + operation + "\",\"sourceIdentity\":\"" + sourceExpected + "\"}", true);
      Checkpoint("restore_intent_durable");

      var sourcePath = Path.Combine(parentPath, name);
      var preservedPath = Path.Combine(backupPath, "managed-link");
      string identity, sourceTarget, preservedTarget;
      int sourceKind = Probe(sourcePath, root, out identity, out sourceTarget);
      int preservedKind = Probe(preservedPath, root, out identity, out preservedTarget);
      if (sourceKind == 2) {
        Require(preservedKind == 0 && sourceTarget != null &&
          WollipogJunctionReparse.SameTarget(sourceTarget, managedLink), "the source is not the managed link");
        using (var link = OpenRaw(sourcePath, GENERIC_READ | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)) {
          var current = WollipogJunctionReparse.MountPointTarget(link);
          Require(current != null && WollipogJunctionReparse.SameTarget(current, managedLink), "the managed link changed");
          // Moving the live link is only safe into the journal that recovery inspection will find.
          CheckPath(root, local, parentExpected);
          CheckPath(root, local + "/" + backupName, Identity(backup));
          RenameInto(link, backup, "managed-link");
        }
        sourceKind = 0;
        preservedKind = 2;
        preservedTarget = sourceTarget;
      }
      if (preservedKind == 2) {
        Require(preservedTarget != null && WollipogJunctionReparse.SameTarget(preservedTarget, managedLink),
          "the preserved managed link changed");
        WriteRecord(backupPath, "managed-link-preserved.json", "{\"target\":" + JsonString(managedLink) + "}", true);
        Checkpoint("managed_link_preserved");
      } else Require(preservedKind == 0, "the preserved managed link is not a junction");
      Require(sourceKind == 0, "the source path is occupied");
      // The junction names the original by path, so the parent and journal must still be where that
      // path leads on both sides of publication.
      var originalRelative = local + "/" + backupName + "/original";
      CheckPath(root, local, parentExpected);
      CheckPath(root, originalRelative, sourceExpected);
      Require(ResolvedIdentity(recoveryLink) == sourceExpected, "the recovery link does not name the preserved original");
      CreateJunction(sourcePath, recoveryLink, root);
      Checkpoint("recovery_link_created");
      CheckPath(root, local, parentExpected);
      CheckPath(root, originalRelative, sourceExpected);
      Require(LinkIs(sourcePath, root, recoveryLink) && ResolvedIdentity(sourcePath) == sourceExpected &&
        Identity(original) == sourceExpected && TreeDigest(originalPath, root) == digest, "the recovery link changed");
      WriteRecord(backupPath, "restored.json",
        "{\"sourceIdentity\":\"" + sourceExpected + "\",\"digest\":\"" + digest + "\"}", true);
      Emit("restored");
    } finally {
      for (int index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
    }
  }
}
`;

export const WINDOWS_SKILL_ADOPTION_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$encoded = $env:WOLLIPOG_SKILL_ADOPTION_SPEC
$env:WOLLIPOG_SKILL_ADOPTION_SPEC = $null
if ([string]::IsNullOrWhiteSpace($encoded)) { throw 'missing adoption specification' }
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json

Add-Type -TypeDefinition @'
${WINDOWS_SKILL_SNAPSHOT_TYPES}
${WINDOWS_JUNCTION_REPARSE_TYPES}
${WINDOWS_SKILL_ADOPTION_TYPES}
'@

$operation = [string]$spec.operation
if ($operation -eq 'adopt') {
  [WollipogWindowsSkillAdoption]::Adopt([string]$spec.home, [string]$spec.localSourceDirectory,
    [string]$spec.sourceDirectory, [string]$spec.name, [string]$spec.generation, [string]$spec.digest,
    [string]$spec.dataDir, [string]$spec.operationId, [string]$spec.providerAccountId, [string]$spec.managedLink)
} elseif ($operation -eq 'inspect') {
  $result = [WollipogWindowsSkillAdoption]::Inspect([string]$spec.home, [string]$spec.localSourceDirectory,
    [string]$spec.homeLink, [string]$spec.storeLink, [string]$spec.operationId)
  [pscustomobject]@{ parentIdentity = $result.ParentIdentity; journals = @($result.Journals);
    truncated = $result.Truncated } | ConvertTo-Json -Depth 5 -Compress
} elseif ($operation -eq 'restore') {
  [WollipogWindowsSkillAdoption]::Restore([string]$spec.home, [string]$spec.localSourceDirectory,
    [string]$spec.operationId, [string]$spec.name, [string]$spec.digest, [string]$spec.parentIdentity,
    [string]$spec.sourceIdentity, [string]$spec.managedLink, [string]$spec.recoveryLink)
} else { throw 'invalid adoption operation' }
`;

/** PowerShell reads this fixed program from stdin; the bootstrap and specification stay small. */
export function windowsAdoptionInvocation(specification: Record<string, unknown>) {
  const bootstrap = "$p=[Console]::In.ReadToEnd();if([string]::IsNullOrWhiteSpace($p)){throw 'missing program'};Invoke-Expression $p";
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")],
    specification: Buffer.from(JSON.stringify(specification), "utf8").toString("base64"),
    input: WINDOWS_SKILL_ADOPTION_HELPER,
  };
}

function run(specification: Record<string, unknown>): { lines: string[]; stdout: string; succeeded: boolean } {
  const invocation = windowsAdoptionInvocation(specification);
  const env: NodeJS.ProcessEnv = { ...process.env, WOLLIPOG_SKILL_ADOPTION_SPEC: invocation.specification };
  for (const name of WINDOWS_ADOPTION_CHECKPOINT_VARIABLES) delete env[name];
  const result = spawnSync(invocation.command, invocation.args, {
    env, input: invocation.input, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000, windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return { stdout, lines: stdout.split(/\r?\n/u), succeeded: !result.error && !result.signal && result.status === 0 };
}

/** Link text uses the same Node realpath spelling as managed deployment, so reconciliation
 * classifies an adopted junction exactly like one it created itself. */
function managedLink(dataDir: string, name: string, digest: string): string {
  return win32.join(realpathSync(skillsStoreRoot(dataDir)), name, digest);
}

function optionalRealpath(path: string): string {
  try { return realpathSync(path); } catch { return ""; }
}

export function parseWindowsRecoveryInspection(value: unknown): RecoveryDirectoryFacts {
  if (!value || typeof value !== "object") throw new Error("invalid helper result");
  const output = value as { parentIdentity?: unknown; journals?: unknown; truncated?: unknown };
  const parentIdentity = output.parentIdentity;
  if (typeof parentIdentity !== "string" || (parentIdentity !== "" && !IDENTITY.test(parentIdentity)) ||
      !Array.isArray(output.journals) || output.journals.length > 64 || typeof output.truncated !== "boolean" ||
      (parentIdentity === "" && output.journals.length !== 0)) throw new Error("invalid helper result");
  const text = (entry: unknown, pattern: RegExp) => {
    if (typeof entry !== "string" || (entry !== "" && !pattern.test(entry))) throw new Error("invalid helper result");
    return entry;
  };
  const journals = output.journals.map((item): RecoveryJournalFacts => {
    const journal = item as Record<string, unknown>;
    const operationId = text(journal.OperationId, UUID);
    const name = journal.Name;
    const kind = journal.Kind;
    const role = journal.Role;
    const sourceIdentity = text(journal.SourceIdentity, IDENTITY);
    if (!operationId || typeof journal.Intent !== "string" || journal.Intent.length > 8192 ||
        typeof name !== "string" || (name !== "" && !validSkillName(name)) ||
        !Number.isInteger(kind) || !Number.isInteger(role) || (kind as number) < 0 || (kind as number) > 3 ||
        (role as number) < 0 || (role as number) > 3 || (kind === 2) !== (role !== 0) ||
        (kind !== 1 && sourceIdentity !== "")) throw new Error("invalid helper result");
    const originalIdentity = text(journal.OriginalIdentity, IDENTITY);
    const source: RecoverySourceFacts = kind === 0 ? { kind: "absent" }
      : kind === 1 ? { kind: "directory", identity: sourceIdentity || null }
        : kind === 2 ? { kind: "link", role: role === 1 ? "managed" : role === 2 ? "recovery" : "foreign" }
          : { kind: "other" };
    return { operationId, intent: journal.Intent, name, digest: text(journal.Digest, DIGEST),
      originalIdentity: originalIdentity || null, source };
  });
  return { parentIdentity: parentIdentity || null, journals, truncated: output.truncated };
}

export function windowsAdoptionSpecification(request: PlatformAdoptionRequest): Record<string, unknown> {
  return { operation: "adopt", home: request.home, localSourceDirectory: request.localSourceDirectory,
    sourceDirectory: request.sourceDirectory, name: request.name, generation: request.generation,
    digest: request.digest, dataDir: request.dataDir, operationId: request.operationId,
    providerAccountId: request.providerAccountId ?? "",
    managedLink: managedLink(request.dataDir, request.name, request.digest) };
}

export function windowsRestoreSpecification(request: PlatformRestoreRequest): Record<string, unknown> {
  return { operation: "restore", home: request.home, localSourceDirectory: request.localSourceDirectory,
    operationId: request.operationId, name: request.name, digest: request.digest,
    parentIdentity: request.parentIdentity, sourceIdentity: request.sourceIdentity,
    managedLink: managedLink(request.dataDir, request.name, request.digest),
    recoveryLink: win32.join(realpathSync(request.home), ...request.localSourceDirectory.split("/"),
      `.wollipog-adoption-${request.operationId}`, "original") };
}

/** Map helper progress lines onto the runner's adoption outcome. */
export function windowsAdoptionOutcome(lines: string[], succeeded: boolean): { journal: boolean; adopted: boolean } {
  return { journal: lines.includes("journal"), adopted: succeeded && lines.includes("adopted") };
}

/** The fixed native helper owns every handle-anchored step of Windows adoption and recovery. */
export function windowsSkillAdoptionHelper(): SkillAdoptionPlatformHelper {
  return {
    adopt: (request) => {
      let specification;
      try { specification = windowsAdoptionSpecification(request); }
      catch { return { journal: false, adopted: false }; }
      const result = run(specification);
      return windowsAdoptionOutcome(result.lines, result.succeeded);
    },
    inspect: (request) => {
      const result = run({ operation: "inspect", home: request.home,
        localSourceDirectory: request.localSourceDirectory, homeLink: optionalRealpath(request.home),
        storeLink: optionalRealpath(skillsStoreRoot(request.dataDir)), operationId: request.operationId ?? "" });
      if (!result.succeeded) throw new Error("Windows adoption helper failed");
      return parseWindowsRecoveryInspection(JSON.parse(result.stdout));
    },
    restore: (request) => {
      const result = run(windowsRestoreSpecification(request));
      return result.succeeded && result.lines.includes("restored");
    },
  };
}
