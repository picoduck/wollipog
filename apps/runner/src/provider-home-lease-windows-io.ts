import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/** Lease-only native handles. This shares no skill/adoption or account ownership state. */
export const WINDOWS_LEASE_IO_TYPES = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class WollipogProviderHomeLeaseIo {
  const uint READ=0x80000000, WRITE=0x40000000, DELETE=0x10000, SHARE_READ=1, SHARE_WRITE=2, SHARE_DELETE=4;
  const uint BACKUP=0x02000000, REPARSE=0x00200000, WRITE_THROUGH=0x80000000, DIRECTORY=0x10, REPARSE_ATTRIBUTE=0x400;
  const string GUARD="protocol-v4.json", ANCHOR="mutable-home.recovery.json", ALIAS=".mutable-home.retired";
  const int MAX_FILE=2*1024*1024, MAX_INPUT=64*1024*1024, MAX_WORK=256*1024*1024;
  static uint fenceWaitMs;
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct INFO { public uint Attributes; public FT Created,Accessed,Written; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long Created,Accessed,Written,Changed; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct OVERLAPPED { public IntPtr Internal,InternalHigh; public uint Offset,OffsetHigh; public IntPtr Event; }
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Exit,Peb,Affinity,Priority,Pid,Parent; }
  [StructLayout(LayoutKind.Sequential)] struct RENAME { public uint Flags; public IntPtr Root; public uint Length; public ushort First; }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status,Information; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out INFO info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int type,out BASIC info,uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file,StringBuilder path,uint length,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool LockFileEx(SafeFileHandle file,uint flags,uint reserved,uint low,uint high,ref OVERLAPPED overlap);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle file,out IO_STATUS_BLOCK status,IntPtr information,uint size,int kind);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLinkW(string target,string source,IntPtr security);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteFileW(string path);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out FT created,out FT exited,out FT kernel,out FT user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle,int kind,out PBI information,int size,out int returned);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationW(string root,StringBuilder label,uint labelSize,out uint serial,out uint length,out uint flags,StringBuilder filesystem,uint filesystemSize);

  sealed class Entry {
    public byte Dir; public bool Optional; public string Name,Dev,Ino,Stamp; public uint Mode,Links,Uid; public byte[] Raw;
  }
  sealed class Job { public string Name; public byte[] Raw; public bool Copies; public uint[] Retire; }
  sealed class Refusal:Exception { public byte Code; public Refusal(byte code,string message):base(message){Code=code;} }
  static BinaryReader input; static BinaryWriter output; static int inputBytes; static uint reads; static uint allowedReads; static ulong allowedBytes; static ulong bytes;
  static string root,lockPath,rootDev,rootIno,lockDev,lockIno,barrierStage,barrierPath,guardStamp,anchorStamp;
  static SafeFileHandle rootHandle,lockHandle,guardHandle,anchorHandle,selectingHandle;
  static string selectingStamp;
  static IntPtr parentHandle; static uint parentId; static List<SafeFileHandle> ancestry;
  static void Need(bool value,string message){if(!value)throw new Refusal(1,message);}
  static void Move(SafeFileHandle source,string target,string message){
    Pinned();Need(Name(target)&&Info(source).Volume==Info(rootHandle).Volume,"unsafe or cross-volume lease rename");
    int rootOffset=Marshal.OffsetOf(typeof(RENAME),"Root").ToInt32(),lengthOffset=Marshal.OffsetOf(typeof(RENAME),"Length").ToInt32(),nameOffset=Marshal.OffsetOf(typeof(RENAME),"First").ToInt32();
    Need(rootOffset==IntPtr.Size&&lengthOffset==2*IntPtr.Size&&nameOffset==lengthOffset+4&&Marshal.SizeOf(typeof(RENAME))>=nameOffset+2&&Marshal.SizeOf(typeof(IO_STATUS_BLOCK))==2*IntPtr.Size,"native lease rename layout unavailable");
    byte[] name=Encoding.Unicode.GetBytes(target);Need(name.Length>=2&&name.Length<=510,"lease rename UTF-16 length exceeded");
    int size=Marshal.SizeOf(typeof(RENAME))+name.Length+2;IntPtr buffer=Marshal.AllocHGlobal(size);bool added=false;
    try{rootHandle.DangerousAddRef(ref added);Marshal.Copy(new byte[size],0,buffer,size);Marshal.StructureToPtr(new RENAME{Flags=1|2,Root=rootHandle.DangerousGetHandle(),Length=(uint)name.Length},buffer,false);Marshal.Copy(name,0,IntPtr.Add(buffer,nameOffset),name.Length);
      IO_STATUS_BLOCK status;int result=NtSetInformationFile(source,out status,buffer,(uint)size,65);
      if(result!=0||status.Status.ToInt64()!=0)throw new Refusal(1,message+" (NTSTATUS 0x"+result.ToString("x8")+", completion 0x"+status.Status.ToInt64().ToString("x")+")");
    }finally{if(added)rootHandle.DangerousRelease();Marshal.FreeHGlobal(buffer);}
  }
  static void Alive(){Need(parentHandle!=IntPtr.Zero&&WaitForSingleObject(parentHandle,0)==258,"lease helper parent exited; preserve all evidence");}
  static byte[] Blob(int maximum){uint size=input.ReadUInt32();Need(size<=maximum&&size<=int.MaxValue,"lease I/O field limit exceeded");inputBytes+=(int)size;Need(inputBytes<=MAX_INPUT,"lease I/O input limit exceeded");byte[] value=input.ReadBytes((int)size);Need(value.Length==size,"truncated lease I/O input");return value;}
  static string Text(int maximum){string value=Utf8.GetString(Blob(maximum));Need(value.IndexOf('\0')<0,"invalid lease I/O text");return value;}
  static void Put(byte[] value){output.Write((uint)value.Length);output.Write(value);}
  static void Put(string value){Put(Utf8.GetBytes(value));}
  static INFO Info(SafeFileHandle handle){INFO info;Need(GetFileInformationByHandle(handle,out info),"lease file identity unavailable");return info;}
  static string Dev(INFO info){return info.Volume.ToString(System.Globalization.CultureInfo.InvariantCulture);}
  static string Ino(INFO info){return (((ulong)info.IndexHigh<<32)|info.IndexLow).ToString(System.Globalization.CultureInfo.InvariantCulture);}
  static long Size(INFO info){return ((long)info.SizeHigh<<32)|info.SizeLow;}
  static string Fingerprint(SafeFileHandle handle){INFO info=Info(handle);BASIC basic;Need(GetFileInformationByHandleEx(handle,0,out basic,(uint)Marshal.SizeOf(typeof(BASIC))),"lease change identity unavailable");return basic.Changed+":"+basic.Written+":"+Size(info)+":"+info.Links;}
  static string Final(SafeFileHandle handle){var path=new StringBuilder(32768);uint count=GetFinalPathNameByHandleW(handle,path,(uint)path.Capacity,0);Need(count>0&&count<path.Capacity,"lease canonical path unavailable");string value=path.ToString();if(value.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase))return @"\\"+value.Substring(8);if(value.StartsWith(@"\\?\",StringComparison.Ordinal))return value.Substring(4);return value;}
  static bool Name(string value){if(value.Length<1||value.Length>255||value=="."||value=="..")return false;foreach(char c in value)if(!((c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='.'||c=='-'||c=='_'))return false;return true;}
  static bool Slot(string value){return value==".mutable-home.checkpoint.pending"||value==".mutable-home.checkpoint.pending-2";}
  static string PathFor(byte dir,string name){Need(dir<2&&Name(name)&&(dir==0||lockHandle!=null),"invalid lease relative path");return Path.Combine(dir==0?root:lockPath,name);}
  static SafeFileHandle Open(string path,bool directory,bool write=false,bool deletion=false,bool shareWrite=false){
    uint access=READ|(write?WRITE:0)|(deletion?DELETE:0);uint sharing=SHARE_READ|(directory||shareWrite?SHARE_WRITE:0)|(directory?0:SHARE_DELETE);
    if(Path.GetFileName(path)==GUARD)sharing&=~SHARE_DELETE;
    SafeFileHandle handle;var elapsed=Stopwatch.StartNew();
    for(;;){handle=CreateFileW(path,access,sharing,IntPtr.Zero,3,REPARSE|(directory?BACKUP:0)|(write?WRITE_THROUGH:0),IntPtr.Zero);
      if(!handle.IsInvalid)break;int error=Marshal.GetLastWin32Error();handle.Dispose();
      if(error!=32&&error!=33)throw new Win32Exception(error);
      Alive();if(elapsed.ElapsedMilliseconds>=fenceWaitMs)throw new Refusal(2,"provider HOME already in use: checkpoint publication is in progress; retry (Windows code "+error+")");Thread.Sleep(10);
    }
    try{INFO info=Info(handle);Need((info.Attributes&REPARSE_ATTRIBUTE)==0&&((info.Attributes&DIRECTORY)!=0)==directory,"unsafe reparse or lease entry type");return handle;}catch{handle.Dispose();throw;}
  }
  static bool Missing(Exception error){var native=error as Win32Exception;return native!=null&&(native.NativeErrorCode==2||native.NativeErrorCode==3);}
  static bool Exists(byte dir,string name){try{using(var handle=Open(PathFor(dir,name),false,false,false,true))return true;}catch(Exception error){if(Missing(error))return false;throw;}}
  static void CheckNamed(string path,SafeFileHandle handle,string dev,string ino,string stamp=null){using(var named=Open(path,(Info(handle).Attributes&DIRECTORY)!=0,false,false,true)){INFO info=Info(named);Need(Dev(info)==dev&&Ino(info)==ino&&(stamp==null||Fingerprint(named)==stamp),"pinned lease identity changed");}}
  static void Pinned(){Alive();CheckNamed(root,rootHandle,rootDev,rootIno);if(lockHandle!=null)CheckNamed(lockPath,lockHandle,lockDev,lockIno);if(guardHandle!=null){INFO info=Info(guardHandle);CheckNamed(PathFor(1,GUARD),guardHandle,Dev(info),Ino(info),guardStamp);}if(selectingHandle!=null){INFO info=Info(selectingHandle);CheckNamed(PathFor(0,ANCHOR),selectingHandle,Dev(info),Ino(info),selectingStamp);}else if(anchorHandle!=null){INFO info=Info(anchorHandle);CheckNamed(PathFor(0,ANCHOR),anchorHandle,Dev(info),Ino(info),anchorStamp);}}
  static void Roots(string configured){
    Need(Path.IsPathRooted(configured)&&configured.Length<=32768,"invalid lease root");string full=Path.GetFullPath(configured);string volume=Path.GetPathRoot(full);
    var label=new StringBuilder(256);var filesystem=new StringBuilder(256);uint serial,length,flags;
    Need(GetVolumeInformationW(volume,label,256,out serial,out length,out flags,filesystem,256)&&filesystem.ToString()=="NTFS"&&(GetDriveTypeW(volume)==3||GetDriveTypeW(volume)==2),"provider-HOME lease durability requires coherent local NTFS");
    string current=volume;var first=Open(current,true);ancestry.Add(first);
    foreach(string component in full.Substring(volume.Length).Split(new[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries)){Need(component!="."&&component!="..","unsafe lease ancestry");current=Path.Combine(current,component);ancestry.Add(Open(current,true));}
    rootHandle=ancestry[ancestry.Count-1];root=Final(rootHandle);Need(String.Equals(root.TrimEnd('\\'),full.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase),"lease root ancestry changed");INFO rootInfo=Info(rootHandle);rootDev=Dev(rootInfo);rootIno=Ino(rootInfo);
    lockPath=Path.Combine(root,"mutable-home.lock");try{lockHandle=Open(lockPath,true);ancestry.Add(lockHandle);INFO info=Info(lockHandle);lockDev=Dev(info);lockIno=Ino(info);}catch(Exception error){if(!Missing(error))throw;}
  }
  static void Fence(bool exclusive){
    if(guardHandle==null){try{guardHandle=Open(PathFor(1,GUARD),false,true,false,true);}catch(Exception error){if(!exclusive&&Missing(error))return;throw;}
      INFO info=Info(guardHandle);Need(info.Links>=1&&info.Links<=3,"unsafe permanent lease fence");guardStamp=Fingerprint(guardHandle);}
    var overlap=new OVERLAPPED{Offset=0xffffffff};var elapsed=Stopwatch.StartNew();
    while(!LockFileEx(guardHandle,(exclusive?2u:0u)|1u,0,1,0,ref overlap)){
      int error=Marshal.GetLastWin32Error();Alive();Need(error==33,"permanent lease fence unavailable");
      if(elapsed.ElapsedMilliseconds>=fenceWaitMs)throw new Refusal(2,"provider HOME already in use: checkpoint publication is in progress; retry");Thread.Sleep(10);
    }
  }
  static byte[] ReadBytes(SafeFileHandle handle){INFO before=Info(handle);long size=Size(before);Need(size>=0&&size<=MAX_FILE&&before.Links>=1&&before.Links<=3,"unsafe lease record");
    Need(++reads<=allowedReads&&(bytes+=(ulong)size)<=allowedBytes,"lease verification work limit exceeded");string stamp=Fingerprint(handle);byte[] raw=new byte[(int)size];
    using(var borrowed=new SafeFileHandle(handle.DangerousGetHandle(),false))using(var stream=new FileStream(borrowed,FileAccess.Read,65536,false)){stream.Position=0;int offset=0;while(offset<raw.Length){int count=stream.Read(raw,offset,raw.Length-offset);Need(count>0,"lease record changed during read");offset+=count;}Need(stream.ReadByte()<0,"lease record expanded during read");}
    Need(Fingerprint(handle)==stamp,"lease record changed during read");return raw;
  }
  static Entry Read(byte dir,string name,bool shareWrite=false){Alive();using(var handle=Open(PathFor(dir,name),false,false,false,shareWrite||name==GUARD)){INFO info=Info(handle);Need(Size(info)<=4096||(dir==0&&(Slot(name)||name==ANCHOR||name==ALIAS)),"ordinary lease record byte limit exceeded");byte[] raw=ReadBytes(handle);return new Entry{Dir=dir,Name=name,Dev=Dev(info),Ino=Ino(info),Stamp=Fingerprint(handle),Mode=0x81b6,Links=info.Links,Uid=0,Raw=raw};}}
  static string Key(Entry entry){return entry.Dir+"/"+entry.Name;}
  static bool BytesEqual(byte[] a,byte[] b){if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
  static void Actor(byte[] raw){string value=Utf8.GetString(raw);int depth=0,found=0;bool key=false;for(int i=0;i<value.Length;i++){char c=value[i];if(c=='"'){int begin=++i;bool escaped=false;for(;i<value.Length&&value[i]!='"';i++)if(value[i]=='\\'){escaped=true;i++;}Need(i<value.Length,"invalid acquired lease JSON");if(depth==1&&key){key=false;if(!escaped&&i-begin==3&&value.Substring(begin,3)=="pid"){int at=i+1;while(at<value.Length&&Char.IsWhiteSpace(value[at]))at++;Need(at<value.Length&&value[at++]==':',"invalid acquired PID");while(at<value.Length&&Char.IsWhiteSpace(value[at]))at++;int digits=at;while(at<value.Length&&value[at]>='0'&&value[at]<='9')at++;uint pid;Need(at>digits&&at-digits<=10&&UInt32.TryParse(value.Substring(digits,at-digits),out pid)&&pid==parentId&&found++==0,"acquired token does not belong to helper parent");}}}else if(c=='{'||c=='['){depth++;if(depth==1)key=true;}else if(c=='}'||c==']'){Need(depth>0,"invalid acquired lease JSON");depth--;}else if(c==','&&depth==1)key=true;}Need(found==1&&depth==0,"acquired token PID could not be proven");}
  static bool Equal(Entry a,Entry b,bool name=true){return (!name||(a.Dir==b.Dir&&a.Name==b.Name))&&a.Dev==b.Dev&&a.Ino==b.Ino&&BytesEqual(a.Raw,b.Raw);}
  static List<Entry> Snapshot(){var result=new List<Entry>();for(byte dir=0;dir<2;dir++){if(dir==1&&lockHandle==null)continue;int count=0;var names=new List<string>();foreach(string path in Directory.EnumerateFileSystemEntries(dir==0?root:lockPath)){Need(++count<=4096,"lease directory scan limit exceeded");string name=Path.GetFileName(path);if(dir==0&&name=="mutable-home.lock")continue;Need(Name(name),"invalid lease entry name");names.Add(name);}names.Sort(StringComparer.Ordinal);foreach(string name in names)result.Add(Read(dir,name));}Need(result.Count<=8192,"lease snapshot limit exceeded");Pinned();return result;}
  static void OutputSnapshot(List<Entry> entries){output.Write((byte)'S');Put(rootDev);Put(rootIno);output.Write((byte)(lockHandle==null?0:1));if(lockHandle!=null){Put(lockDev);Put(lockIno);}output.Write((uint)entries.Count);foreach(var e in entries){output.Write(e.Dir);Put(e.Name);Put(e.Dev);Put(e.Ino);Put(e.Stamp);output.Write(e.Mode);output.Write(e.Links);output.Write(e.Uid);Put(e.Raw);}output.Write(reads);output.Write(bytes);output.Flush();}
  static void Barrier(string stage){Pinned();if(stage!=barrierStage||String.IsNullOrEmpty(stage))return;using(var stream=new FileStream(barrierPath,FileMode.CreateNew,FileAccess.Write,FileShare.Read,4096,FileOptions.WriteThrough)){byte[] value=Utf8.GetBytes("ready");stream.Write(value,0,value.Length);stream.Flush(true);}for(;;){Alive();Thread.Sleep(10);}}
  static void Flush(SafeFileHandle handle){Alive();Need(FlushFileBuffers(handle),"durable lease metadata flush unavailable");}
  static void WriteNew(byte dir,string name,byte[] raw,bool guard){Pinned();Need(raw.Length<=MAX_FILE,"lease publication byte limit exceeded");string path=PathFor(dir,name);
    using(var handle=CreateFileW(path,READ|WRITE,SHARE_READ|SHARE_DELETE,IntPtr.Zero,1,REPARSE|WRITE_THROUGH,IntPtr.Zero)){
      Need(!handle.IsInvalid,"lease staging slot unavailable");INFO info=Info(handle);Need((info.Attributes&(DIRECTORY|REPARSE_ATTRIBUTE))==0,"unsafe lease publication");
      using(var borrowed=new SafeFileHandle(handle.DangerousGetHandle(),false))using(var stream=new FileStream(borrowed,FileAccess.Write,65536,false)){stream.Write(raw,0,raw.Length);stream.Flush();}
      Barrier(guard?"guard-temp-written":"candidate-written");Flush(handle);Barrier(guard?"guard-file-durable":"candidate-file-durable");
    }
  }
  static void Verify(Entry expected,bool optional){if(!Exists(expected.Dir,expected.Name)){Need(optional,"verified lease evidence disappeared");return;}Need(Equal(expected,Read(expected.Dir,expected.Name)),"verified lease evidence changed");}
  static void Owned(Entry tip,string future,bool copied){Pinned();Need(!Exists(0,future),"acquired lease has a future successor");if(!copied)Verify(tip,false);}
  static void KeepAnchor(){if(anchorHandle!=null)anchorHandle.Dispose();anchorHandle=Open(PathFor(0,ANCHOR),false);anchorStamp=Fingerprint(anchorHandle);}
  static void Select(Entry proof){Pinned();using(var candidate=Open(PathFor(0,proof.Name),false,true,true,false)){INFO identity=Info(candidate);Need(Dev(identity)==proof.Dev&&Ino(identity)==proof.Ino&&BytesEqual(ReadBytes(candidate),proof.Raw),"checkpoint candidate changed before selection");Flush(candidate);Barrier("before-selection");Move(candidate,ANCHOR,"durable checkpoint selection failed");
      // The old anchor handle remains valid through POSIX replacement, but its name now
      // resolves to the candidate. Parent-death checks still precede this exact inode flush.
      selectingHandle=candidate;selectingStamp=Fingerprint(candidate);
      try{Barrier("selection-published");Flush(candidate);using(var named=Open(PathFor(0,ANCHOR),false,false,false,true)){INFO info=Info(named);Need(Dev(info)==proof.Dev&&Ino(info)==proof.Ino&&BytesEqual(ReadBytes(named),proof.Raw),"selected checkpoint proof changed");}}
      finally{selectingHandle=null;}
    }KeepAnchor();Barrier("selection-durable");}

  static void Retire(Entry expected,List<Entry> manifest){if(expected.Dir==0&&expected.Name==ALIAS)return;
    using(var source=Open(PathFor(expected.Dir,expected.Name),false,true,true,false)){
      INFO info=Info(source);Need(Dev(info)==expected.Dev&&Ino(info)==expected.Ino&&BytesEqual(ReadBytes(source),expected.Raw),"retirement source changed");Need(info.Volume==Info(rootHandle).Volume,"cross-volume retirement refused");
      SafeFileHandle oldAlias=null;try{if(Exists(0,ALIAS)){oldAlias=Open(PathFor(0,ALIAS),false,false,true,true);INFO prior=Info(oldAlias);byte[] raw=ReadBytes(oldAlias);bool valid=false;foreach(var entry in manifest)if(entry.Dev==Dev(prior)&&entry.Ino==Ino(prior)&&BytesEqual(entry.Raw,raw)){valid=true;break;}Need(valid,"retirement alias lacks selected-manifest authority");if(Dev(prior)==expected.Dev&&Ino(prior)==expected.Ino)return;}
        Pinned();Move(source,ALIAS,"durable evidence retirement move failed");
        Barrier("retirement-moved");using(var named=Open(PathFor(0,ALIAS),false,false,false,true)){INFO moved=Info(named);Need(Dev(moved)==expected.Dev&&Ino(moved)==expected.Ino,"retirement alias identity changed");}
        Flush(source);using(var named=Open(PathFor(0,ALIAS),false,false,false,true)){INFO moved=Info(named);Need(Dev(moved)==expected.Dev&&Ino(moved)==expected.Ino&&BytesEqual(ReadBytes(named),expected.Raw),"flushed retirement alias proof changed");}Barrier("retirement-flushed");
      }finally{if(oldAlias!=null)oldAlias.Dispose();}
    }
  }
  static void Apply(byte operation){
    Need(lockHandle!=null,"lease lock unavailable");Need(Text(20)==rootDev&&Text(20)==rootIno&&Text(20)==lockDev&&Text(20)==lockIno,"lease directory identity changed");
    barrierStage=Text(64);barrierPath=Text(32768);byte[] guardRaw=Blob(4096);string guardTemp=Text(255);uint count=input.ReadUInt32();Need(count<=16384,"lease input entry limit exceeded");
    var expected=new List<Entry>();var byName=new Dictionary<string,Entry>(StringComparer.Ordinal);
    for(uint i=0;i<count;i++){byte dir=input.ReadByte(),optional=input.ReadByte();Need(dir<2&&optional<2,"invalid lease input flags");var e=new Entry{Dir=dir,Optional=optional==1,Name=Text(255),Dev=Text(20),Ino=Text(20),Stamp=Text(160),Mode=input.ReadUInt32(),Links=input.ReadUInt32(),Uid=input.ReadUInt32(),Raw=Blob(MAX_FILE)};Need(Name(e.Name)&&!byName.ContainsKey(Key(e)),"duplicate or invalid lease snapshot entry");byName.Add(Key(e),e);expected.Add(e);}
    uint tipIndex=input.ReadUInt32();Need(tipIndex<count,"invalid acquired lease reference");Entry tip=expected[(int)tipIndex];string future=Text(255);Need(Name(future)&&future.StartsWith("next-",StringComparison.Ordinal),"invalid lease successor");
    uint jobCount=input.ReadUInt32();Need(jobCount<=4,"lease job limit exceeded");var jobs=new List<Job>();
    for(uint i=0;i<jobCount;i++){string name=Text(255);Need(operation==1?(name.Length==0||Slot(name)):Name(name),"invalid checkpoint slot");byte[] raw=Blob(MAX_FILE);byte copies=input.ReadByte();uint n=input.ReadUInt32();Need(copies<2&&n<=8192,"invalid retirement manifest");var indexes=new uint[n];for(uint k=0;k<n;k++){indexes[k]=input.ReadUInt32();Need(indexes[k]<count,"invalid retirement reference");Entry e=expected[(int)indexes[k]];Need(e.Name!=GUARD&&e.Name!=ANCHOR&&e.Name!=future&&(e.Dir==0?(e.Name.StartsWith("next-",StringComparison.Ordinal)||Slot(e.Name)||e.Name==ALIAS):(e.Name.StartsWith("next-",StringComparison.Ordinal)||e.Name.StartsWith("lease-",StringComparison.Ordinal)||e.Name=="checkpoint.json")),"unsafe retirement path");}jobs.Add(new Job{Name=name,Raw=raw,Copies=copies==1,Retire=indexes});}
    Need(input.BaseStream.ReadByte()<0,"extra lease I/O input");Need(operation>=1&&operation<=3,"invalid lease operation");
    if(operation==1){Actor(tip.Raw);foreach(var job in jobs)if(job.Copies&&job.Raw.Length>0)Actor(job.Raw);}if(operation==2){Need(jobs.Count==1&&jobs[0].Name==future&&future.StartsWith("next-",StringComparison.Ordinal)&&jobs[0].Retire.Length==0&&jobs[0].Raw.Length<=4096,"invalid successor publication");Actor(jobs[0].Raw);}if(operation==3)Need(jobs.Count==1&&jobs[0].Retire.Length==0&&tip.Dir==0&&(jobs[0].Name==tip.Name||jobs[0].Name=="checkpoint.json"||jobs[0].Name.StartsWith("lease-",StringComparison.Ordinal)),"invalid mirror publication");
    bool newGuard=!Exists(1,GUARD);
    if(newGuard){Need(operation==1&&guardRaw.Length>0&&Name(guardTemp)&&guardTemp.StartsWith(".provider-home-lease-",StringComparison.Ordinal),"invalid guard publication");Barrier("before-guard");WriteNew(0,guardTemp,guardRaw,true);Pinned();Need(CreateHardLinkW(PathFor(1,GUARD),PathFor(0,guardTemp),IntPtr.Zero),"permanent lease fence changed during creation");Barrier("guard-published");using(var guard=Open(PathFor(1,GUARD),false,true,false,true))Flush(guard);Need(DeleteFileW(PathFor(0,guardTemp)),"guard staging cleanup failed");}
    Fence(true);if(newGuard)Barrier("guard-durable");Need(BytesEqual(Read(1,GUARD).Raw,guardRaw),"permanent format guard changed");
    var actual=Snapshot();var seen=new HashSet<string>(StringComparer.Ordinal);foreach(var e in actual){if(newGuard&&e.Dir==1&&e.Name==GUARD)continue;Entry wanted;Need(byName.TryGetValue(Key(e),out wanted)&&Equal(e,wanted),"lease snapshot changed before checkpoint publication");seen.Add(Key(e));}foreach(var e in expected)Need(e.Optional||seen.Contains(Key(e)),"verified lease evidence disappeared");
    if(operation==3){Pinned();using(var source=Open(PathFor(0,tip.Name),false,true,false,false)){INFO info=Info(source);Need(Dev(info)==tip.Dev&&Ino(info)==tip.Ino&&BytesEqual(ReadBytes(source),tip.Raw),"canonical mirror source changed");string target=PathFor(1,jobs[0].Name);if(!CreateHardLinkW(target,PathFor(0,tip.Name),IntPtr.Zero))Need(Exists(1,jobs[0].Name)&&BytesEqual(Read(1,jobs[0].Name,true).Raw,tip.Raw),"canonical mirror conflicts with source");Flush(source);}output.Write((byte)'D');output.Write(reads);output.Write(bytes);output.Flush();return;}
    KeepAnchor();
    bool copiedOwner=false;Owned(tip,future,copiedOwner);
    if(operation==2){WriteNew(0,guardTemp,jobs[0].Raw,false);Owned(tip,future,false);Pinned();Need(CreateHardLinkW(PathFor(0,jobs[0].Name),PathFor(0,guardTemp),IntPtr.Zero),"canonical successor changed during publication");using(var successor=Open(PathFor(0,jobs[0].Name),false,true,false,true))Flush(successor);Need(DeleteFileW(PathFor(0,guardTemp)),"successor staging cleanup failed");output.Write((byte)'D');output.Write(reads);output.Write(bytes);output.Flush();return;}
    foreach(var job in jobs){if(job.Name.Length>0){if(!Exists(0,job.Name)){Barrier("before-candidate");WriteNew(0,job.Name,job.Raw,false);Barrier("candidate-durable");}Entry candidate=Read(0,job.Name);Need(BytesEqual(candidate.Raw,job.Raw),"completed checkpoint candidate changed");Entry previous; if(byName.TryGetValue(Key(candidate),out previous))Need(Equal(previous,candidate),"completed candidate identity changed");Owned(tip,future,copiedOwner);Select(candidate);if(job.Copies)copiedOwner=true;}
      var manifest=new List<Entry>();foreach(uint index in job.Retire)manifest.Add(expected[(int)index]);
      for(int pass=0;pass<2;pass++)foreach(var e in manifest){if((e.Dir==0&&e.Name==ALIAS)||!Exists(e.Dir,e.Name))continue;Need(copiedOwner||e.Dir!=tip.Dir||e.Name!=tip.Name,"cannot retire acquired tip before selecting its checkpoint");Owned(tip,future,copiedOwner);Barrier("before-retire");Owned(tip,future,copiedOwner);Retire(e,manifest);Barrier("after-retire");}Barrier("retirement-durable");
    }
    output.Write((byte)'D');output.Write(reads);output.Write(bytes);output.Flush();
  }
  public static void Run(){
    input=new BinaryReader(Console.OpenStandardInput(),Utf8);output=new BinaryWriter(Console.OpenStandardOutput(),Utf8);ancestry=new List<SafeFileHandle>();
    try{Need(Encoding.ASCII.GetString(input.ReadBytes(5))=="WPLL4","invalid lease I/O protocol");byte operation=input.ReadByte();uint parent=input.ReadUInt32();allowedReads=input.ReadUInt32();allowedBytes=input.ReadUInt64();fenceWaitMs=input.ReadUInt32();Need((fenceWaitMs==0||fenceWaitMs==10000)&&allowedReads<=131072&&allowedBytes<=268435456,"invalid remaining lease work budget");parentId=parent;PBI info;int returned;Need(NtQueryInformationProcess(Process.GetCurrentProcess().Handle,0,out info,Marshal.SizeOf(typeof(PBI)),out returned)==0&&(ulong)info.Parent.ToInt64()==parent,"lease helper parent identity changed");parentHandle=OpenProcess(0x1000|0x100000,false,parent);Alive();FT parentCreated,selfCreated,exited,kernel,user;Need(GetProcessTimes(parentHandle,out parentCreated,out exited,out kernel,out user)&&GetProcessTimes(Process.GetCurrentProcess().Handle,out selfCreated,out exited,out kernel,out user)&&(((ulong)parentCreated.High<<32)|parentCreated.Low)<=(((ulong)selfCreated.High<<32)|selfCreated.Low),"lease helper parent PID was reused");Roots(Text(32768));if(operation==0){if(lockHandle!=null)Fence(false);OutputSnapshot(Snapshot());}else Apply(operation);
    }catch(Exception error){try{var refusal=error as Refusal;var native=error as Win32Exception;output.Write((byte)'E');output.Write(refusal==null?(byte)1:refusal.Code);Put(refusal==null?"provider-HOME native lease I/O failed"+(native==null?"":" (Windows code "+native.NativeErrorCode+")")+"; preserve all evidence":refusal.Message);output.Flush();}catch{}}
    finally{if(anchorHandle!=null)anchorHandle.Dispose();if(guardHandle!=null)guardHandle.Dispose();for(int i=ancestry.Count-1;i>=0;i--)ancestry[i].Dispose();if(parentHandle!=IntPtr.Zero)CloseHandle(parentHandle);}
  }
}
`;

let assembly: { path: string; sha256: string; dev: bigint; ino: bigint } | undefined;
const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`;
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Load verified assembly bytes into memory instead of reopening a mutable path after hashing. */
export function windowsLeaseIoCommand(roots = [tmpdir()]): { command: string; args: string[] } {
  if (process.platform !== "win32") throw new Error("native Windows lease I/O requires Windows");
  if (assembly && existsSync(assembly.path)) {
    if (!roots.some(root => { const path = relative(root, assembly!.path); return path !== ".." && !path.startsWith("..\\") && !isAbsolute(path); })) throw new Error("safe Windows lease helper staging directory unavailable");
    const file = lstatSync(assembly.path, { bigint: true });
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || file.dev !== assembly.dev || file.ino !== assembly.ino || sha256(readFileSync(assembly.path)) !== assembly.sha256) throw new Error("trusted Windows lease helper changed");
  }
  if (!assembly || !existsSync(assembly.path) || sha256(readFileSync(assembly.path)) !== assembly.sha256) {
    assembly = undefined;
    const stagingRoot = roots.find(root => { try { const stat = lstatSync(root); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } });
    if (!stagingRoot) throw new Error("safe Windows lease helper staging directory unavailable");
    const directory = mkdtempSync(join(stagingRoot, "wollipog-provider-home-lease-io-"));
    const directoryStat = lstatSync(directory, { bigint: true });
    const path = join(directory, "lease-io.dll");
    let fileIdentity: { dev: bigint; ino: bigint } | undefined;
    const cleanup = () => {
      try {
        const current = lstatSync(directory, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryStat.dev || current.ino !== directoryStat.ino) return;
        if (fileIdentity) {
          const file = lstatSync(path, { bigint: true });
          if (!file.isFile() || file.isSymbolicLink() || file.dev !== fileIdentity.dev || file.ino !== fileIdentity.ino) return;
          unlinkSync(path);
        }
        rmdirSync(directory);
      } catch { /* Retain unknown or substituted cache entries. */ }
    };
    const program = `$ErrorActionPreference='Stop';$source=[Console]::In.ReadToEnd();Add-Type -TypeDefinition $source -OutputAssembly ${quote(path)}`;
    const compiled = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
      { input: WINDOWS_LEASE_IO_TYPES, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
    if (existsSync(path)) {
      const file = lstatSync(path, { bigint: true });
      if (file.isFile() && !file.isSymbolicLink() && file.nlink === 1n) fileIdentity = { dev: file.dev, ino: file.ino };
    }
    if (compiled.error || compiled.status !== 0) {
      cleanup();
      throw new Error("the fixed Windows provider-HOME lease helper could not be compiled", {
        cause: new Error((compiled.stderr ?? "").slice(0, 2_048)),
      });
    }
    if (!fileIdentity) { cleanup(); throw new Error("unsafe Windows lease helper staging file"); }
    assembly = { path, sha256: sha256(readFileSync(path)), ...fileIdentity };
    process.once("exit", cleanup);
  }
  const program = `$ErrorActionPreference='Stop';$bytes=[IO.File]::ReadAllBytes(${quote(assembly.path)});$sha=[Security.Cryptography.SHA256]::Create();$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant();if($hash -ne ${quote(assembly.sha256)}){throw 'trusted lease helper changed'};$loaded=[Reflection.Assembly]::Load($bytes);$loaded.GetType('WollipogProviderHomeLeaseIo').GetMethod('Run').Invoke($null,@())|Out-Null`;
  return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program] };
}
