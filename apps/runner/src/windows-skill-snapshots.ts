import { spawnSync } from "node:child_process";
import {
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  validSkillFilePath,
  validSkillName,
  type MachineSkillCandidate,
  type SkillFile,
} from "@wollipog/protocol";

interface WindowsSnapshotFile { path: unknown; content: unknown }
interface WindowsSnapshotOutput {
  candidates?: unknown;
  generation?: unknown;
  files?: unknown;
}

/**
 * Fixed native reader for Windows machine-skill snapshots.
 *
 * Every untrusted component is opened with FILE_FLAG_OPEN_REPARSE_POINT while its parent handle
 * remains open without FILE_SHARE_DELETE. That pins the walked ancestry, rejects junctions and
 * symlinks before traversal, and lets the helper check hard-link count and stable file identity
 * through the same handles used for reads. PowerShell only hosts this runner-owned P/Invoke.
 */
export const WINDOWS_SKILL_SNAPSHOT_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$encoded = $env:WOLLIPOG_SKILL_SNAPSHOT_SPEC
$env:WOLLIPOG_SKILL_SNAPSHOT_SPEC = $null
if ([string]::IsNullOrWhiteSpace($encoded)) { throw 'missing snapshot specification' }
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class WollipogWindowsSkillSnapshots {
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint FILE_SHARE_WRITE = 0x00000002;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  const int MAX_PATH_CHARS = 32768;
  const int MAX_RAW_ENTRIES = 4096;
  const int MAX_USEFUL_ENTRIES = 256;
  const int MAX_FILES = 64;
  const long MAX_FILE_BYTES = 512 * 1024;
  const long MAX_TOTAL_BYTES = 2 * 1024 * 1024;
  static readonly Regex SkillName = new Regex("^[a-z0-9][a-z0-9._-]{0,63}$", RegexOptions.CultureInvariant);

  [StructLayout(LayoutKind.Sequential)]
  struct FILETIME { public uint Low; public uint High; }

  [StructLayout(LayoutKind.Sequential)]
  struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public FILETIME CreationTime;
    public FILETIME LastAccessTime;
    public FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  public sealed class Candidate {
    public string Name { get; set; }
    public string SourceDirectory { get; set; }
    public string Generation { get; set; }
  }

  public sealed class SnapshotFile {
    public string Path { get; set; }
    public string Content { get; set; }
  }

  public sealed class Snapshot {
    public string Generation { get; set; }
    public List<SnapshotFile> Files { get; set; }
  }

  sealed class Counts { public int Entries; public int Files; public long Bytes; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION info);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);

  static BY_HANDLE_FILE_INFORMATION Info(SafeFileHandle handle) {
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return info;
  }

  static bool IsDirectory(BY_HANDLE_FILE_INFORMATION info) {
    return (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  }

  static string Fingerprint(BY_HANDLE_FILE_INFORMATION info) {
    return info.VolumeSerialNumber + ":" + info.FileIndexHigh + ":" + info.FileIndexLow + ":" +
      info.LastWriteTime.High + ":" + info.LastWriteTime.Low + ":" + info.FileSizeHigh + ":" + info.FileSizeLow;
  }

  static string FinalPath(SafeFileHandle handle) {
    var buffer = new StringBuilder(MAX_PATH_CHARS);
    uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
    if (length == 0 || length >= (uint)buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
    return buffer.ToString().TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
  }

  static string DisplayPath(string path) {
    if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path.Substring(8);
    if (path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return path.Substring(4);
    return path;
  }

  static bool Below(string path, string root) {
    var candidate = DisplayPath(path).TrimEnd('\\');
    var boundary = DisplayPath(root).TrimEnd('\\');
    return candidate.Equals(boundary, StringComparison.OrdinalIgnoreCase) ||
      candidate.StartsWith(boundary + "\\", StringComparison.OrdinalIgnoreCase);
  }

  static SafeFileHandle Open(string path, bool directory, string root) {
    var flags = FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
    var handle = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero,
      OPEN_EXISTING, flags, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    try {
      var info = Info(handle);
      if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || IsDirectory(info) != directory ||
          !Below(FinalPath(handle), root)) throw new InvalidOperationException("unsafe skill path");
      return handle;
    } catch { handle.Dispose(); throw; }
  }

  static SafeFileHandle OpenHome(string home) {
    // The configured HOME itself may resolve through a user-selected link. Descendants may not.
    var handle = CreateFileW(home, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    if (!IsDirectory(Info(handle))) { handle.Dispose(); throw new InvalidOperationException("HOME is not a directory"); }
    return handle;
  }

  static string[] RelativeSegments(string relative) {
    var segments = relative.Split('/');
    if (segments.Length < 1 || segments.Length > 4) throw new InvalidOperationException("invalid source directory");
    foreach (var segment in segments) {
      if (segment.Length == 0 || segment == "." || segment == ".." || segment.IndexOfAny(new[] {'\\', ':', '\0'}) >= 0)
        throw new InvalidOperationException("invalid source directory");
    }
    return segments;
  }

  static SafeFileHandle OpenRelativeDirectory(SafeFileHandle home, string relative, out string path,
      List<SafeFileHandle> ancestry) {
    var root = FinalPath(home);
    path = root;
    foreach (var segment in RelativeSegments(relative)) {
      path = Path.Combine(path, segment);
      ancestry.Add(Open(path, true, root));
    }
    return ancestry[ancestry.Count - 1];
  }

  static void DisposeAll(List<SafeFileHandle> handles) {
    for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
  }

  static string Sha256(string value) {
    using (var sha = SHA256.Create()) {
      var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
      var result = new StringBuilder(bytes.Length * 2);
      foreach (var b in bytes) result.Append(b.ToString("x2"));
      return result.ToString();
    }
  }

  static string DirectoryGeneration(SafeFileHandle directory, string path, string root) {
    var entries = new List<string>();
    int raw = 0;
    foreach (var childPath in Directory.EnumerateFileSystemEntries(path)) {
      if (++raw > MAX_RAW_ENTRIES) throw new InvalidOperationException("directory is too large");
      var name = Path.GetFileName(childPath);
      string type = "other";
      try {
        using (var child = Open(childPath, true, root)) { type = "directory"; }
      } catch {
        try { using (var child = Open(childPath, false, root)) { type = "file"; } } catch { }
      }
      entries.Add(name + "\0" + type);
    }
    entries.Sort(StringComparer.Ordinal);
    return Sha256(Fingerprint(Info(directory)) + "\0" + String.Join("\0", entries.ToArray()));
  }

  static bool ValidFilePath(string path) {
    if (path.Length == 0 || path.Length > 2048 || path[0] == '/' || path.IndexOfAny(new[] {'\\', ':', '\0', '\r', '\n'}) >= 0)
      return false;
    var parts = path.Split('/');
    if (parts.Length > 8) return false;
    foreach (var part in parts) if (part.Length == 0 || part.Length > 256 || part == "." || part == "..") return false;
    return true;
  }

  static void Visit(SafeFileHandle directory, string directoryPath, string root, string prefix, int depth,
      Counts counts, List<SnapshotFile> files) {
    if (depth > 16) throw new InvalidOperationException("skill tree is too deep");
    foreach (var childPath in Directory.EnumerateFileSystemEntries(directoryPath)) {
      if (++counts.Entries > MAX_USEFUL_ENTRIES) throw new InvalidOperationException("skill tree has too many entries");
      var relative = prefix + Path.GetFileName(childPath);
      if (!ValidFilePath(relative)) throw new InvalidOperationException("invalid skill file path");
      SafeFileHandle child = null;
      try {
        try { child = Open(childPath, true, root); } catch { }
        if (child != null) {
          Visit(child, FinalPath(child), root, relative + "/", depth + 1, counts, files);
          continue;
        }
        child = Open(childPath, false, root);
        var before = Info(child);
        if (before.NumberOfLinks != 1) throw new InvalidOperationException("hard-linked files are unsupported");
        long size = ((long)before.FileSizeHigh << 32) | before.FileSizeLow;
        if (size > MAX_FILE_BYTES || counts.Bytes + size > MAX_TOTAL_BYTES || ++counts.Files > MAX_FILES)
          throw new InvalidOperationException("skill content is too large");
        var bytes = new byte[(int)size];
        using (var borrowed = new SafeFileHandle(child.DangerousGetHandle(), false))
        using (var stream = new FileStream(borrowed, FileAccess.Read, 65536, false)) {
          int offset = 0;
          while (offset < bytes.Length) {
            int read = stream.Read(bytes, offset, bytes.Length - offset);
            if (read == 0) break;
            offset += read;
          }
          if (offset != bytes.Length || stream.ReadByte() != -1) throw new InvalidOperationException("skill file changed");
        }
        if (Fingerprint(before) != Fingerprint(Info(child))) throw new InvalidOperationException("skill file changed");
        counts.Bytes += size;
        files.Add(new SnapshotFile { Path = relative, Content = Convert.ToBase64String(bytes) });
      } finally { if (child != null) child.Dispose(); }
    }
  }

  static Snapshot ReadOnce(string homePath, string sourceDirectory, string name) {
    using (var home = OpenHome(homePath)) {
      var ancestry = new List<SafeFileHandle>();
      string sourcePath;
      try {
        var source = OpenRelativeDirectory(home, sourceDirectory, out sourcePath, ancestry);
        var root = FinalPath(home);
        var skillPath = Path.Combine(sourcePath, name);
        using (var skill = Open(skillPath, true, root)) {
          var generation = DirectoryGeneration(skill, skillPath, root);
          var files = new List<SnapshotFile>();
          Visit(skill, skillPath, root, "", 0, new Counts(), files);
          files.Sort((a, b) => StringComparer.Ordinal.Compare(a.Path, b.Path));
          if (!files.Exists(file => file.Path == "SKILL.md") || DirectoryGeneration(skill, skillPath, root) != generation)
            throw new InvalidOperationException("skill changed");
          return new Snapshot { Generation = generation, Files = files };
        }
      } finally { DisposeAll(ancestry); }
    }
  }

  public static List<Candidate> List(string homePath, string[] sourceDirectories) {
    var result = new List<Candidate>();
    using (var home = OpenHome(homePath)) {
      foreach (var sourceDirectory in sourceDirectories) {
        if (result.Count >= 64) break;
        var ancestry = new List<SafeFileHandle>();
        string sourcePath;
        try {
          SafeFileHandle source;
          try { source = OpenRelativeDirectory(home, sourceDirectory, out sourcePath, ancestry); }
          catch { continue; }
          var root = FinalPath(home);
          int useful = 0;
          int raw = 0;
          foreach (var childPath in Directory.EnumerateFileSystemEntries(sourcePath)) {
            if (++raw > MAX_RAW_ENTRIES || useful >= MAX_USEFUL_ENTRIES || result.Count >= 64) break;
            var name = Path.GetFileName(childPath);
            if (name.StartsWith(".wollipog-adoption-", StringComparison.Ordinal)) continue;
            useful++;
            if (!SkillName.IsMatch(name)) continue;
            try {
              using (var skill = Open(childPath, true, root))
              using (var manifest = Open(Path.Combine(childPath, "SKILL.md"), false, root)) {
                if (Info(manifest).NumberOfLinks != 1) continue;
                result.Add(new Candidate { Name = name, SourceDirectory = sourceDirectory,
                  Generation = DirectoryGeneration(skill, childPath, root) });
              }
            } catch { }
          }
        } finally { DisposeAll(ancestry); }
      }
    }
    return result;
  }

  public static Snapshot Read(string homePath, string sourceDirectory, string name, string expectedGeneration) {
    if (!SkillName.IsMatch(name)) throw new InvalidOperationException("invalid skill name");
    var first = ReadOnce(homePath, sourceDirectory, name);
    var second = ReadOnce(homePath, sourceDirectory, name);
    if (first.Generation != expectedGeneration || second.Generation != expectedGeneration || first.Files.Count != second.Files.Count)
      throw new InvalidOperationException("skill changed");
    for (int i = 0; i < first.Files.Count; i++) {
      if (first.Files[i].Path != second.Files[i].Path || first.Files[i].Content != second.Files[i].Content)
        throw new InvalidOperationException("skill changed");
    }
    return first;
  }
}
'@

if ([string]$spec.operation -eq 'list') {
  $items = [WollipogWindowsSkillSnapshots]::List([string]$spec.home, [string[]]$spec.directories)
  [pscustomobject]@{ candidates = @($items) } | ConvertTo-Json -Depth 5 -Compress
} elseif ([string]$spec.operation -eq 'read') {
  $item = [WollipogWindowsSkillSnapshots]::Read([string]$spec.home, [string]$spec.sourceDirectory,
    [string]$spec.name, [string]$spec.generation)
  [pscustomobject]@{ generation = $item.Generation; files = @($item.Files) } | ConvertTo-Json -Depth 5 -Compress
} else { throw 'invalid snapshot operation' }
`;

function invoke(specification: Record<string, unknown>): WindowsSnapshotOutput {
  const encodedSpec = Buffer.from(JSON.stringify(specification), "utf8").toString("base64");
  // A tiny encoded bootstrap explicitly reads the fixed runner-owned program from stdin.
  // Encoding the complete helper would exceed CreateProcessW's 32,767-character command line;
  // using `-Command -` directly is not reliable on Windows PowerShell 5.1's redirected stdin.
  const bootstrap = "$p=[Console]::In.ReadToEnd();if([string]::IsNullOrWhiteSpace($p)){throw 'missing program'};Invoke-Expression $p";
  const encodedBootstrap = Buffer.from(bootstrap, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodedBootstrap], {
    env: { ...process.env, WOLLIPOG_SKILL_SNAPSHOT_SPEC: encodedSpec },
    input: WINDOWS_SKILL_SNAPSHOT_HELPER,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    // MachineSkillSnapshots catches and sanitizes this internal diagnostic before it crosses the
    // runner protocol; retaining a bounded native error here makes platform failures actionable.
    const detail = (result.stderr || result.stdout || result.error?.message || "no output")
      .replace(/\s+/g, " ").trim().slice(0, 1_000);
    throw new Error(`Windows snapshot helper failed: ${detail}`);
  }
  return JSON.parse(result.stdout) as WindowsSnapshotOutput;
}

export function listWindowsSkillCandidates(home: string, directories: string[]): Omit<MachineSkillCandidate, "id">[] {
  const output = invoke({ operation: "list", home, directories });
  if (!Array.isArray(output.candidates) || output.candidates.length > 64) throw new Error("invalid helper result");
  return output.candidates.map((value) => {
    const candidate = value as Record<string, unknown>;
    const name = candidate.Name;
    const sourceDirectory = candidate.SourceDirectory;
    const generation = candidate.Generation;
    if (typeof name !== "string" || !validSkillName(name) || typeof sourceDirectory !== "string" ||
        !directories.includes(sourceDirectory) || typeof generation !== "string" || !/^[0-9a-f]{64}$/.test(generation)) {
      throw new Error("invalid helper result");
    }
    return { name, sourceDirectory, generation };
  });
}

export function readWindowsSkillCandidate(home: string, candidate: MachineSkillCandidate): SkillFile[] {
  const output = invoke({ operation: "read", home, sourceDirectory: candidate.sourceDirectory,
    name: candidate.name, generation: candidate.generation });
  if (output.generation !== candidate.generation || !Array.isArray(output.files) ||
      output.files.length === 0 || output.files.length > SKILL_MAX_FILES) throw new Error("invalid helper result");
  let total = 0;
  const seen = new Set<string>();
  const files = (output.files as WindowsSnapshotFile[]).map((value) => {
    if (typeof value.path !== "string" || !validSkillFilePath(value.path) || seen.has(value.path) ||
        typeof value.content !== "string") throw new Error("invalid helper result");
    seen.add(value.path);
    const bytes = Buffer.from(value.content, "base64");
    if (bytes.toString("base64") !== value.content || bytes.length > SKILL_MAX_FILE_BYTES ||
        (total += bytes.length) > SKILL_MAX_TOTAL_BYTES) throw new Error("invalid helper result");
    const utf8 = bytes.toString("utf8");
    return Buffer.from(utf8).equals(bytes)
      ? { path: value.path, encoding: "utf8" as const, content: utf8 }
      : { path: value.path, encoding: "base64" as const, content: value.content };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!seen.has("SKILL.md")) throw new Error("invalid helper result");
  return files;
}
