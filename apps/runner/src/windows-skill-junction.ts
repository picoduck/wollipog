import { spawnSync } from "node:child_process";

/**
 * Retarget one runner-owned Windows directory junction without a remove/create gap.
 *
 * Node can create and read junctions, but `rename()` cannot replace an existing directory entry.
 * The fixed helper opens the reparse point itself, verifies its current target, and replaces the
 * mount-point payload through `FSCTL_SET_REPARSE_POINT`. It never deletes a path or follows the
 * junction. PowerShell only hosts this runner-owned P/Invoke; no skill content is executed.
 */
export const WINDOWS_SKILL_JUNCTION_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$encoded = $env:WOLLIPOG_SKILL_JUNCTION_SPEC
$env:WOLLIPOG_SKILL_JUNCTION_SPEC = $null
if ([string]::IsNullOrWhiteSpace($encoded)) { throw 'missing junction specification' }
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class WollipogSkillJunction {
  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint FILE_SHARE_WRITE = 0x00000002;
  const uint FILE_SHARE_DELETE = 0x00000004;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FSCTL_GET_REPARSE_POINT = 0x000900A8;
  const uint FSCTL_SET_REPARSE_POINT = 0x000900A4;
  const uint IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(SafeFileHandle file, uint code, byte[] input, int inputLength,
    byte[] output, int outputLength, out int returned, IntPtr overlapped);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFullPathNameW(string path, uint length, StringBuilder buffer, IntPtr filePart);

  static string NormalizeTarget(string value) {
    if (value.StartsWith(@"\??\UNC\", StringComparison.OrdinalIgnoreCase)) value = @"\\" + value.Substring(8);
    else if (value.StartsWith(@"\??\", StringComparison.Ordinal)) value = value.Substring(4);
    var buffer = new StringBuilder(32768);
    uint result = GetFullPathNameW(value, (uint)buffer.Capacity, buffer, IntPtr.Zero);
    if (result == 0 || result >= (uint)buffer.Capacity) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "the junction target path is invalid");
    }
    value = buffer.ToString();
    if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) value = @"\\" + value.Substring(8);
    else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) value = value.Substring(4);
    return value.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
  }

  static string OpenPath(string value) {
    var normalized = NormalizeTarget(value);
    return normalized.StartsWith(@"\\", StringComparison.Ordinal)
      ? @"\\?\UNC\" + normalized.Substring(2)
      : @"\\?\" + normalized;
  }

  static string CurrentTarget(SafeFileHandle handle) {
    var buffer = new byte[16 * 1024];
    int returned;
    if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, null, 0,
        buffer, buffer.Length, out returned, IntPtr.Zero)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "could not inspect the junction");
    }
    if (returned < 16 || BitConverter.ToUInt32(buffer, 0) != IO_REPARSE_TAG_MOUNT_POINT) {
      throw new InvalidOperationException("the managed path is not a directory junction");
    }
    int offset = BitConverter.ToUInt16(buffer, 8);
    int length = BitConverter.ToUInt16(buffer, 10);
    if (offset < 0 || length <= 0 || 16 + offset + length > returned) {
      throw new InvalidOperationException("the junction payload is malformed");
    }
    return Encoding.Unicode.GetString(buffer, 16 + offset, length);
  }

  static byte[] Payload(string target) {
    var printName = NormalizeTarget(target);
    var substituteName = printName.StartsWith(@"\\", StringComparison.Ordinal)
      ? @"\??\UNC\" + printName.Substring(2)
      : @"\??\" + printName;
    var substitute = Encoding.Unicode.GetBytes(substituteName);
    var print = Encoding.Unicode.GetBytes(printName);
    var pathBytes = new byte[substitute.Length + 2 + print.Length + 2];
    Buffer.BlockCopy(substitute, 0, pathBytes, 0, substitute.Length);
    Buffer.BlockCopy(print, 0, pathBytes, substitute.Length + 2, print.Length);
    var result = new byte[16 + pathBytes.Length];
    Buffer.BlockCopy(BitConverter.GetBytes(IO_REPARSE_TAG_MOUNT_POINT), 0, result, 0, 4);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)(8 + pathBytes.Length)), 0, result, 4, 2);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)0), 0, result, 8, 2);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)substitute.Length), 0, result, 10, 2);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)(substitute.Length + 2)), 0, result, 12, 2);
    Buffer.BlockCopy(BitConverter.GetBytes((ushort)print.Length), 0, result, 14, 2);
    Buffer.BlockCopy(pathBytes, 0, result, 16, pathBytes.Length);
    return result;
  }

  public static void Replace(string path, string expectedTarget, string target) {
    using (var handle = CreateFileW(OpenPath(path), GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "could not open the junction");
      if (!String.Equals(NormalizeTarget(CurrentTarget(handle)), NormalizeTarget(expectedTarget),
          StringComparison.OrdinalIgnoreCase)) {
        throw new InvalidOperationException("the junction target changed before replacement");
      }
      var payload = Payload(target);
      int returned;
      if (!DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, payload, payload.Length,
          null, 0, out returned, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "could not retarget the junction");
      }
    }
  }
}
'@

[WollipogSkillJunction]::Replace([string]$spec.path, [string]$spec.expectedTarget, [string]$spec.target)
`;

export function replaceWindowsSkillJunction(
  path: string,
  expectedTarget: string,
  target: string,
): void {
  const specification = Buffer.from(JSON.stringify({ path, expectedTarget, target }), "utf8").toString("base64");
  // `-EncodedCommand` carries only this fixed runner-owned program. Keeping it out of the
  // filesystem avoids trusting or repairing a helper path below a potentially stale data dir.
  const command = Buffer.from(WINDOWS_SKILL_JUNCTION_HELPER, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", command], {
    env: { ...process.env, WOLLIPOG_SKILL_JUNCTION_SPEC: specification },
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("the atomic Windows junction update failed");
}
