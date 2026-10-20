// Fixed account-config contract only. The installed Windows kernel/SystemRoot/PowerShell/.NET
// and OS administrators are trusted prerequisites, NOT independently attested by this helper.
// No HOME, grant, ACL repair, generic command or recovery operation is exposed.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class WollipogAccountConfigWindowsV1 {
 const int ConfigMax=2097152, FrameMax=8388608, RecordMax=32768, TotalMax=268435456, Control=65536;
 const uint R=0x80000000, W=0x40000000, Del=0x10000, RC=0x20000, Attr=0x80;
 const uint ReadShare=1, WriteShare=2, DeleteShare=4, Reparse=0x200000, Backup=0x2000000, Through=0x80000000;
 static readonly Encoding Utf=new UTF8Encoding(false,true);
 static readonly string[] Slots={"anchor","header","journal","guard","anchor.pending","header.pending","journal.pending","config.pending"};
 sealed class Refusal:Exception { internal string Code; internal Refusal(string code){Code=code;} }
 sealed class Request { internal byte Op,Fault; internal int Pid; internal string Path,Stamp,Birth,Before,After,Bindings; internal byte[] Next; }
 sealed class Tip { internal string Epoch="",Identity="",Digest="",Config=""; internal int Revision,Records; internal long Bytes; }
 sealed class Observation { internal string Path,Parent,ConfigId,Digest,Stamp,Birth; internal byte[] Raw; internal Tip Tip; }
 sealed class Context:IDisposable {
  internal string Path,Parent,Prefix,Sid,Birth; internal SafeFileHandle ParentProcess; internal readonly List<SafeFileHandle> Pins=new List<SafeFileHandle>();
  internal SafeFileHandle ParentHandle;
  internal string Slot(string name){return System.IO.Path.Combine(Parent,Prefix+name);}
  internal void Alive(){Need(WaitForSingleObject(ParentProcess,0)==258,"SOURCE_CHANGED");}
  public void Dispose(){foreach(var p in Pins)p.Dispose(); if(ParentProcess!=null)ParentProcess.Dispose();}
 }
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation,Access,Write,Change; public uint Attributes; }
 [StructLayout(LayoutKind.Sequential)] struct SA { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
 [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Reserved1,Peb,Reserved2,Reserved3,Pid,ParentPid; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StreamData { public long Size; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=296)] public string Name; }
 [StructLayout(LayoutKind.Sequential,Pack=4,CharSet=CharSet.Unicode)] struct FindData { public uint Attributes; public long Creation,Access,Write; public uint High,Low,Reserved0,Reserved1; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=14)] public string Alternate; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,ref SA sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int cls,out Basic info,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder name,uint size,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle h,StringBuilder volume,uint size,out uint serial,out uint max,out uint flags,StringBuilder fs,uint fsSize);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributesW(string path);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetDiskFreeSpaceW(string root,out uint sectors,out uint bytes,out uint free,out uint total);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int kind,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr descriptor,out uint bytes);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] data,int count,out int done,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] data,int count,out int done,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long move,out long position,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int cls,IntPtr info,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstStreamW(string path,int level,out StreamData data,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextStreamW(IntPtr h,out StreamData data);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindClose(IntPtr h);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstFileW(string path,out FindData data);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextFileW(IntPtr h,out FindData data);
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int cls,out PBI info,int size,out int returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeFileHandle h,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(SafeFileHandle h,uint timeout);
 static void Need(bool yes,string code="STORE_UNVERIFIABLE"){if(!yes)throw new Refusal(code);}
 static byte[] Hash(byte[] raw){using(var h=SHA256.Create())return h.ComputeHash(raw);}
 static string Hex(byte[] raw){return BitConverter.ToString(raw).Replace("-","").ToLowerInvariant();}
 static string Digest(byte[] raw){return Hex(Hash(raw));}
 static byte[] Bytes(string text){return Utf.GetBytes(text);}
 static string Part(BinaryReader r,int max){int n=r.ReadInt32();Need(n>=0&&n<=max,"CAPACITY");byte[] b=r.ReadBytes(n);Need(b.Length==n);return Utf.GetString(b);}
 static byte[] Blob(BinaryReader r,int max){int n=r.ReadInt32();Need(n>=0&&n<=max,"CAPACITY");byte[] b=r.ReadBytes(n);Need(b.Length==n);return b;}
 static void Part(BinaryWriter w,string text){byte[] b=Bytes(text);w.Write(b.Length);w.Write(b);}
 static void Blob(BinaryWriter w,byte[] b){w.Write(b.Length);w.Write(b);}
 static string ExactHash(string value){Need(value.Length==64);foreach(char c in value)Need(c>='0'&&c<='9'||c>='a'&&c<='f');return value;}
 static Info Stat(SafeFileHandle h){Info s;Need(GetFileInformationByHandle(h,out s));return s;}
 static string Id(SafeFileHandle h){var s=Stat(h);Need(s.IndexHigh!=0||s.IndexLow!=0);return s.Volume.ToString("x8")+":"+s.IndexHigh.ToString("x8")+s.IndexLow.ToString("x8");}
 static string Identity(SafeFileHandle h){Basic b;Need(GetFileInformationByHandleEx(h,0,out b,(uint)Marshal.SizeOf(typeof(Basic))));var s=Stat(h);return Id(h)+":"+s.SizeHigh+":"+s.SizeLow+":"+b.Change+":"+b.Write;}
 static string Canonical(SafeFileHandle h){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);Need(n>0&&n<b.Capacity);string s=b.ToString();Need(s.StartsWith("\\\\?\\",StringComparison.Ordinal));return s.Substring(4);}
 static bool TrustedSid(string sid,string user,bool ancestor){if(sid==user||sid=="S-1-5-18"||sid=="S-1-5-32-544")return true;if(!ancestor)return false;try{return sid==((SecurityIdentifier)new NTAccount("NT SERVICE","TrustedInstaller").Translate(typeof(SecurityIdentifier))).Value;}catch{return false;}}
 static void Security(SafeFileHandle h,string user,bool ancestor,bool privateFile,bool parent){
  IntPtr o,g,d,s,p;Need(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out p)==0);try{
   uint n=GetSecurityDescriptorLength(p);Need(n>0&&n<=4096);byte[] raw=new byte[n];Marshal.Copy(p,raw,0,(int)n);var sd=new RawSecurityDescriptor(raw,0);
   Need(sd.Owner!=null&&(ancestor?TrustedSid(sd.Owner.Value,user,true):sd.Owner.Value==user));Need(sd.DiscretionaryAcl!=null);
   foreach(GenericAce ace in sd.DiscretionaryAcl){var ca=ace as CommonAce;Need(ca!=null);Need(ca.AceType==AceType.AccessAllowed||ca.AceType==AceType.AccessDenied);Need(!ca.IsCallback);
    if((ca.AceFlags&AceFlags.InheritOnly)!=0||ca.AceType==AceType.AccessDenied)continue;
    if(TrustedSid(ca.SecurityIdentifier.Value,user,ancestor))continue;
    uint dangerous=ancestor&&!parent?0x000d0150u:0x000d0156u;
    // GENERIC_ALL/WRITE and maximum-allowed forms are never silently interpreted as read-only.
    Need((((uint)ca.AccessMask)&(dangerous|0x50000000u|0x02000000u))==0);
    if(privateFile)Need(ca.AccessMask==0);
   }
  }finally{LocalFree(p);}
 }
 static void Check(SafeFileHandle h,string user,bool dir,bool privateFile,bool parent=false){var s=Stat(h);Need((s.Attributes&0x400)==0);Need(((s.Attributes&0x10)!=0)==dir);if(!dir)Need(s.Links==1);Security(h,user,dir,privateFile,parent);}
 static SafeFileHandle Open(string path,string user,bool dir,bool priv,uint access=R,uint share=ReadShare|WriteShare|DeleteShare,bool parent=false){
  var h=CreateFileW(path,access|RC,share,IntPtr.Zero,3,Reparse|(dir?Backup:0)|((access&W)!=0?Through:0),IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new Refusal("STORE_UNVERIFIABLE");}
  try{Check(h,user,dir,priv,parent);Need(String.Equals(Canonical(h),System.IO.Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase));if(!dir)Streams(path);return h;}catch{h.Dispose();throw;}
 }
 static void Streams(string path){StreamData d;var h=FindFirstStreamW(path,0,out d,0);Need(h!=new IntPtr(-1));try{Need(d.Name=="::$DATA");bool more=FindNextStreamW(h,out d);Need(!more&&Marshal.GetLastWin32Error()==38);}finally{FindClose(h);}}
 static SafeFileHandle New(Context c,string path,byte[] data,string descriptor=null){
  c.Alive();IntPtr sd;uint n;string text=descriptor??("O:"+c.Sid+"G:"+c.Sid+"D:P(A;;FA;;;"+c.Sid+")(A;;FA;;;SY)(A;;FA;;;BA)");
  Need(ConvertStringSecurityDescriptorToSecurityDescriptorW(text,1,out sd,out n));var sa=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=sd,Inherit=false};SafeFileHandle h;
  try{h=CreateFileW(path,R|W|Del|RC,ReadShare,ref sa,1,Reparse|Through,IntPtr.Zero);}finally{LocalFree(sd);}
  if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Refusal(e==80||e==183?"SOURCE_BUSY":"IO");}
  try{if(descriptor==null)Check(h,c.Sid,false,true);Write(h,data);Need(FlushFileBuffers(h),"IO");return h;}catch{h.Dispose();throw;}
 }
 static void Write(SafeFileHandle h,byte[] b){int at=0;while(at<b.Length){int count=Math.Min(65536,b.Length-at);byte[] part=new byte[count];Buffer.BlockCopy(b,at,part,0,count);int done;Need(WriteFile(h,part,count,out done,IntPtr.Zero)&&done>0,"IO");at+=done;}}
 static byte[] Read(SafeFileHandle h,int max){var before=Identity(h);var s=Stat(h);Need(s.SizeHigh==0&&s.SizeLow<=max,"CAPACITY");long pos;Need(SetFilePointerEx(h,0,out pos,0));byte[] b=new byte[s.SizeLow];int at=0;while(at<b.Length){byte[] part=new byte[Math.Min(65536,b.Length-at)];int done;Need(ReadFile(h,part,part.Length,out done,IntPtr.Zero)&&done>0);Buffer.BlockCopy(part,0,b,at,done);at+=done;}Need(Identity(h)==before,"SOURCE_CHANGED");return b;}
 static void Rename(Context c,SafeFileHandle h,string target,bool replace){
  c.Alive();Need(target.Length>0&&target.IndexOfAny(new char[]{'\\','/',':','\0'})<0&&target!="."&&target!="..");
  byte[] name=Encoding.Unicode.GetBytes(target);int root=IntPtr.Size==8?8:4;int count=root+IntPtr.Size;int off=count+4;IntPtr p=Marshal.AllocHGlobal(off+name.Length);
  try{for(int i=0;i<off+name.Length;i++)Marshal.WriteByte(p,i,0);Marshal.WriteByte(p,0,(byte)(replace?1:0));Marshal.WriteIntPtr(p,root,c.ParentHandle.DangerousGetHandle());Marshal.WriteInt32(p,count,name.Length);Marshal.Copy(name,0,IntPtr.Add(p,off),name.Length);Need(SetFileInformationByHandle(h,3,p,(uint)(off+name.Length)),"IO");}finally{Marshal.FreeHGlobal(p);}
 }
 static void ReleaseGuard(SafeFileHandle h){IntPtr p=Marshal.AllocHGlobal(1);try{Marshal.WriteByte(p,1);Need(SetFileInformationByHandle(h,4,p,1),"IO");}finally{Marshal.FreeHGlobal(p);}}
 static Context ContextFor(Request r){
  Need(r.Path.Length>3&&r.Path.Length<32768&&Char.IsLetter(r.Path[0])&&r.Path[1]==':'&&r.Path[2]=='\\');Need(r.Path.IndexOf(':',2)<0);string full=System.IO.Path.GetFullPath(r.Path);Need(String.Equals(full,r.Path,StringComparison.OrdinalIgnoreCase));
  var c=new Context{Path=full,Parent=System.IO.Path.GetDirectoryName(full),Sid=WindowsIdentity.GetCurrent().User.Value};
  try{
   Need(IntPtr.Size==8);string name=System.IO.Path.GetFileName(full);Need(name.Length<=100&&!name.EndsWith(".")&&!name.EndsWith(" "));c.Prefix="."+name+".account-publications-win-v1.";
   PBI pi;int returned;Need(NtQueryInformationProcess(GetCurrentProcess(),0,out pi,Marshal.SizeOf(typeof(PBI)),out returned)==0&&pi.ParentPid.ToInt64()==r.Pid);
   c.ParentProcess=OpenProcess(0x101000,false,r.Pid);Need(!c.ParentProcess.IsInvalid);long creation,exit,kernel,user;Need(GetProcessTimes(c.ParentProcess,out creation,out exit,out kernel,out user));c.Birth=creation.ToString();Need(r.Birth==""||r.Birth==c.Birth,"SOURCE_CHANGED");c.Alive();
   string root=System.IO.Path.GetPathRoot(full);Need(GetDriveTypeW(root)==3);uint sectors,bytes,free,total;Need(GetDiskFreeSpaceW(root,out sectors,out bytes,out free,out total));Need(sectors>0&&bytes>0&&(long)sectors*bytes<=4096);
   string part=root;var dirs=c.Parent.Substring(root.Length).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries);c.Pins.Add(Open(part,c.Sid,true,false,Attr,ReadShare|WriteShare));
   foreach(string next in dirs){part=System.IO.Path.Combine(part,next);c.Pins.Add(Open(part,c.Sid,true,false,Attr,ReadShare|WriteShare));}
   c.ParentHandle=Open(c.Parent,c.Sid,true,false,Attr|2,ReadShare|WriteShare,true);c.Pins.Add(c.ParentHandle);
   uint serial,max,flags;var fs=new StringBuilder(32);Need(GetVolumeInformationByHandleW(c.ParentHandle,null,0,out serial,out max,out flags,fs,(uint)fs.Capacity)&&fs.ToString()=="NTFS");
   foreach(string legacy in new string[]{"."+name+".account-publications-v1","."+name+".account-publications-anchor-v1"}){uint attr=GetFileAttributesW(System.IO.Path.Combine(c.Parent,legacy));int error=Marshal.GetLastWin32Error();Need(attr==0xffffffff&&(error==2||error==3));}return c;
  }catch{c.Dispose();throw;}
 }
 static HashSet<string> Entries(Context c,bool ownGuard){
  var found=new HashSet<string>(StringComparer.OrdinalIgnoreCase);FindData d;IntPtr h=FindFirstFileW(System.IO.Path.Combine(c.Parent,c.Prefix+"*"),out d);
  if(h==new IntPtr(-1)){int e=Marshal.GetLastWin32Error();Need(e==2);return found;}
  try{do{Need(found.Count<Slots.Length);Need(d.Name.StartsWith(c.Prefix,StringComparison.OrdinalIgnoreCase));string s=d.Name.Substring(c.Prefix.Length);Need(Array.IndexOf(Slots,s)>=0);Need(!s.EndsWith(".pending"));if(s=="guard")Need(ownGuard,"SOURCE_BUSY");found.Add(s);}while(FindNextFileW(h,out d));Need(Marshal.GetLastWin32Error()==18);}finally{FindClose(h);}return found;
 }
 static byte[] Seal(byte[] raw){byte[] b=new byte[raw.Length+32];Buffer.BlockCopy(raw,0,b,0,raw.Length);Buffer.BlockCopy(Hash(raw),0,b,raw.Length,32);return b;}
 static byte[] Unseal(byte[] raw){Need(raw.Length>=32);byte[] b=new byte[raw.Length-32];Buffer.BlockCopy(raw,0,b,0,b.Length);byte[] hash=Hash(b);for(int i=0;i<32;i++)Need(hash[i]==raw[b.Length+i]);return b;}
 static byte[] Header(string key,string epoch,string ids,string initial){using(var m=new MemoryStream()){using(var w=new BinaryWriter(m,Utf,true)){Part(w,"WACWH1");Part(w,key);Part(w,epoch);Part(w,ids);Part(w,initial);}return Seal(m.ToArray());}}
 static Tip TipFor(Context c,bool ownGuard){
  var entries=Entries(c,ownGuard);if(entries.Count==(ownGuard?1:0))return new Tip{Digest=Digest(new byte[0])};
  Need(entries.Count==(ownGuard?4:3)&&entries.Contains("anchor")&&entries.Contains("header")&&entries.Contains("journal"));
  using(var a=Open(c.Slot("anchor"),c.Sid,false,true))using(var h=Open(c.Slot("header"),c.Sid,false,true))using(var j=Open(c.Slot("journal"),c.Sid,false,true)){
   byte[] header=Read(h,4096),anchor=Read(a,4096);Need(Digest(header)==Digest(anchor));string key=Digest(Bytes(c.Path.ToUpperInvariant()+"|"+Id(c.ParentHandle)));string epoch,initial;
   using(var m=new MemoryStream(Unseal(header)))using(var r=new BinaryReader(m,Utf)){Need(Part(r,32)=="WACWH1"&&Part(r,64)==key);epoch=Part(r,36);Guid guid;Need(Guid.TryParseExact(epoch,"D",out guid));Need(Part(r,256)==Id(c.ParentHandle)+"|"+Id(h)+"|"+Id(j));initial=ExactHash(Part(r,64));Need(m.Position==m.Length);}
   var tip=new Tip{Epoch=epoch,Identity=Id(a)+"|"+Id(h)+"|"+Id(j),Config=initial};var stat=Stat(j);Need(stat.SizeHigh==0&&stat.SizeLow<=TotalMax-Control,"CAPACITY");tip.Bytes=stat.SizeLow;
   using(var hs=SHA256.Create()){
    long pos;Need(SetFilePointerEx(j,0,out pos,0));int expected=1;string pending="",prev=new string('0',64);
    while(pos<tip.Bytes){Need(tip.Records<8192,"CAPACITY");byte[] len=ReadCount(j,4);int n=BitConverter.ToInt32(len,0);Need(n>=32&&n<=RecordMax&&pos+4+n<=tip.Bytes);byte[] record=ReadCount(j,n);byte[] payload=Unseal(record);hs.TransformBlock(len,0,len.Length,len,0);hs.TransformBlock(record,0,record.Length,record,0);
     using(var m=new MemoryStream(payload))using(var rr=new BinaryReader(m,Utf)){byte kind=rr.ReadByte();int rev=rr.ReadInt32();string ep=Part(rr,36),ticket=Part(rr,36);Need(ep==epoch&&rev==expected&&Part(rr,64)==prev);string before=ExactHash(Part(rr,64)),after=ExactHash(Part(rr,64));Need(before==tip.Config);
      ExactHash(Part(rr,64));ExactHash(Part(rr,64));int temp=rr.ReadInt32(),outcome=rr.ReadInt32(),bindings=rr.ReadInt32();Need(temp>=0&&temp<=ConfigMax&&outcome==RecordMax&&bindings>=0&&bindings<=512);for(int k=0;k<bindings;k++)ExactHash(Part(rr,64));Need(rr.ReadByte()==1&&m.Position==m.Length);
      if(kind==1){Need(pending=="");pending=ticket+"|"+after;}else{Need(kind==2&&pending==ticket+"|"+after);pending="";tip.Config=after;tip.Revision=rev;expected++;}
     }prev=Digest(record);tip.Records++;pos+=4+n;
    }Need(pending==""&&tip.Records==tip.Revision*2);hs.TransformFinalBlock(new byte[0],0,0);tip.Digest=Hex(hs.Hash);
   }return tip;
  }
 }
 static byte[] ReadCount(SafeFileHandle h,int n){byte[] all=new byte[n];int at=0;while(at<n){byte[] b=new byte[n-at];int done;Need(ReadFile(h,b,b.Length,out done,IntPtr.Zero)&&done>0);Buffer.BlockCopy(b,0,all,at,done);at+=done;}return all;}
 static Observation Observe(Context c,bool ownGuard){c.Alive();var first=TipFor(c,ownGuard);using(var f=Open(c.Path,c.Sid,false,false,R,ReadShare|DeleteShare)){
  var raw=Read(f,ConfigMax);var second=TipFor(c,ownGuard);Need(first.Epoch==second.Epoch&&first.Identity==second.Identity&&first.Digest==second.Digest,"SOURCE_CHANGED");string digest=Digest(raw);if(first.Epoch!="")Need(digest==first.Config,"SOURCE_CHANGED");
  var o=new Observation{Path=Canonical(f),Parent=Id(c.ParentHandle),ConfigId=Identity(f),Digest=digest,Raw=raw,Tip=second,Birth=c.Birth};o.Stamp=Digest(Bytes(o.Path+"|"+o.Parent+"|"+o.ConfigId+"|"+o.Digest+"|"+second.Epoch+"|"+second.Identity+"|"+second.Revision+"|"+second.Digest+"|"+o.Birth));return o;
 }}
 static void Bootstrap(Context c,Observation old){
  Need(old.Tip.Epoch=="");using(var j=New(c,c.Slot("journal.pending"),new byte[0]))using(var h=New(c,c.Slot("header.pending"),new byte[0])){
   string key=Digest(Bytes(c.Path.ToUpperInvariant()+"|"+Id(c.ParentHandle))),epoch=Guid.NewGuid().ToString("D");byte[] bytes=Header(key,epoch,Id(c.ParentHandle)+"|"+Id(h)+"|"+Id(j),old.Digest);Write(h,bytes);Need(FlushFileBuffers(h));
   Rename(c,h,c.Prefix+"header",false);Rename(c,j,c.Prefix+"journal",false);
   using(var a=New(c,c.Slot("anchor.pending"),bytes)){Rename(c,a,c.Prefix+"anchor",false);}
  }
 }
 static string LastRecordDigest(Context c){using(var j=Open(c.Slot("journal"),c.Sid,false,true)){var s=Stat(j);if(s.SizeLow==0)return new string('0',64);long at=0,pos;byte[] last=null;Need(SetFilePointerEx(j,0,out pos,0));while(at<s.SizeLow){byte[] len=ReadCount(j,4);int n=BitConverter.ToInt32(len,0);Need(n>=32&&n<=RecordMax&&at+4+n<=s.SizeLow);last=ReadCount(j,n);at+=4+n;}return Digest(last);}}
 static byte[] Record(Context c,Request r,Observation old,Tip tip,byte kind,string ticket,int revision,string previous=null){using(var m=new MemoryStream()){using(var w=new BinaryWriter(m,Utf,true)){
  w.Write(kind);w.Write(revision);Part(w,tip.Epoch);Part(w,ticket);Part(w,previous??LastRecordDigest(c));Part(w,old.Digest);Part(w,Digest(r.Next));Part(w,ExactHash(r.Before));Part(w,ExactHash(r.After));w.Write(r.Next.Length);w.Write(RecordMax);var b=r.Bindings==""?new string[0]:r.Bindings.Split('\n');Need(b.Length<=512,"CAPACITY");w.Write(b.Length);foreach(var x in b)Part(w,ExactHash(x));w.Write((byte)1);
 }byte[] sealedBytes=Seal(m.ToArray());Need(sealedBytes.Length<=RecordMax,"CAPACITY");return sealedBytes;}}
 static void Append(Context c,byte[] record,string expectedId){c.Alive();using(var j=Open(c.Slot("journal"),c.Sid,false,true,R|W)){
  Need(Id(j)==expectedId,"SOURCE_CHANGED");long pos;Need(SetFilePointerEx(j,0,out pos,2));Need(pos+4+record.Length+Control+ConfigMax+RecordMax<=TotalMax,"CAPACITY");Write(j,BitConverter.GetBytes(record.Length));Write(j,record);Need(FlushFileBuffers(j),"IO");
 }}
 static void Fault(Request r,int phase){
#if WACW_FIXTURE
  if(r.Fault==phase)throw new Refusal("IO");
#else
  Need(r.Fault==0);
#endif
 }
 public static void Run(Stream input,Stream output){
  bool attempted=false,committed=false;Request req=null;Observation obs=null;string code="IO";byte state=0;bool ok=false;
  try{
   byte[] l=new byte[4];ReadStream(input,l);int size=BitConverter.ToInt32(l,0);Need(size>0&&size<=FrameMax,"CAPACITY");byte[] raw=new byte[size];ReadStream(input,raw);Need(input.ReadByte()==-1);
   using(var m=new MemoryStream(raw))using(var r=new BinaryReader(m,Utf)){Need(Encoding.ASCII.GetString(r.ReadBytes(5))=="WACW1");req=new Request{Op=r.ReadByte(),Fault=r.ReadByte(),Pid=r.ReadInt32(),Path=Part(r,65536),Stamp=Part(r,64),Birth=Part(r,32),Before=Part(r,64),After=Part(r,64),Bindings=Part(r,65536),Next=Blob(r,ConfigMax)};Need(m.Position==m.Length&&req.Pid>0&&(req.Op==1||req.Op==2)&&req.Fault<=6);}
#if !WACW_FIXTURE
   Need(req.Fault==0);
#endif
   using(var c=ContextFor(req)){
    obs=Observe(c,false);if(req.Op==1){Need(req.Next.Length==0&&req.Stamp==""&&req.Fault==0&&req.Birth==""&&req.Before==""&&req.After==""&&req.Bindings=="");ok=true;}
    else{
     Need(req.Stamp==obs.Stamp&&req.Birth==obs.Birth,"SOURCE_CHANGED");Need(req.Next.Length>0&&obs.Tip.Revision<4096&&obs.Tip.Records+2<=8192,"CAPACITY");Need(obs.Tip.Bytes+Control+req.Next.Length+2*RecordMax<=TotalMax,"CAPACITY");
     string ticket=Guid.NewGuid().ToString("D");
     // Construct/validate the bounded intent reservation before creating any producer.
     var probeTip=new Tip{Epoch=Guid.NewGuid().ToString("D")};byte[] probe=RecordAbsent(req,obs,probeTip,ticket);Need(probe.Length<=RecordMax,"CAPACITY");
     using(var guard=New(c,c.Slot("guard"),Bytes(ticket))){
      Fault(req,1);if(obs.Tip.Epoch=="")Bootstrap(c,obs);var tip=TipFor(c,true);
      using(var f=Open(c.Path,c.Sid,false,false,R,ReadShare|DeleteShare)){Need(Identity(f)==obs.ConfigId&&Digest(Read(f,ConfigMax))==obs.Digest,"SOURCE_CHANGED");}
      string journalId=tip.Identity.Split('|')[2];int rev=tip.Revision+1;Append(c,Record(c,req,obs,tip,1,ticket,rev),journalId);Fault(req,2);
      using(var pending=New(c,c.Slot("config.pending"),req.Next)){
       Fault(req,3);using(var f=Open(c.Path,c.Sid,false,false,R,ReadShare|DeleteShare)){Need(Identity(f)==obs.ConfigId&&Digest(Read(f,ConfigMax))==obs.Digest,"SOURCE_CHANGED");}
       Need(Id(c.ParentHandle)==obs.Parent);Check(guard,c.Sid,false,true);Check(pending,c.Sid,false,true);attempted=true;Fault(req,4);
       Rename(c,pending,System.IO.Path.GetFileName(c.Path),true);committed=true;Fault(req,5);Need(FlushFileBuffers(pending),"IO");
       using(var f=Open(c.Path,c.Sid,false,true)){Need(Id(f)==Id(pending)&&Digest(Read(f,ConfigMax))==Digest(req.Next));}
       Append(c,Record(c,req,obs,tip,2,ticket,rev),journalId);Fault(req,6);ReleaseGuard(guard);ok=true;
      }
     }
    }
   }
  }catch(Refusal e){code=e.Code;}catch{code="IO";}
  if(!ok)state=(byte)(committed?2:attempted?1:0);
  using(var payload=new MemoryStream()){using(var w=new BinaryWriter(payload,Utf,true)){w.Write(Encoding.ASCII.GetBytes("WACW1"));w.Write((byte)(ok?req.Op:0));w.Write(state);Part(w,ok?"":code);
   string[] fields=ok&&req.Op==1?new string[]{obs.Path,obs.ConfigId,obs.Digest,obs.Parent,obs.Tip.Epoch,obs.Tip.Identity,obs.Tip.Revision.ToString(),obs.Tip.Digest,obs.Stamp,obs.Birth}:new string[10];foreach(var f in fields)Part(w,f??"");Blob(w,ok&&req.Op==1?obs.Raw:new byte[0]);}
   byte[] raw=payload.ToArray();Need(raw.Length<=FrameMax);output.Write(BitConverter.GetBytes(raw.Length),0,4);output.Write(raw,0,raw.Length);output.Flush();}
 }
 static byte[] RecordAbsent(Request r,Observation o,Tip t,string ticket){using(var m=new MemoryStream()){using(var w=new BinaryWriter(m,Utf,true)){w.Write((byte)1);w.Write(1);Part(w,t.Epoch);Part(w,ticket);Part(w,new string('0',64));Part(w,o.Digest);Part(w,Digest(r.Next));Part(w,ExactHash(r.Before));Part(w,ExactHash(r.After));w.Write(r.Next.Length);w.Write(RecordMax);var b=r.Bindings==""?new string[0]:r.Bindings.Split('\n');Need(b.Length<=512,"CAPACITY");w.Write(b.Length);foreach(var x in b)Part(w,ExactHash(x));w.Write((byte)1);}return Seal(m.ToArray());}}
 static void ReadStream(Stream s,byte[] b){int at=0;while(at<b.Length){int n=s.Read(b,at,b.Length-at);Need(n>0);at+=n;}}
#if WACW_FIXTURE
 // Test build only; never embedded in the production SEA. Only creates fresh synthetic inputs.
 public static string Fixture(string path,string mode){
  if(mode=="owner-path"){
   string os=System.IO.Path.Combine(Environment.SystemDirectory,"kernel32.dll");using(var h=CreateFileW(os,RC|Attr,ReadShare|WriteShare|DeleteShare,IntPtr.Zero,3,Reparse,IntPtr.Zero)){
    Need(!h.IsInvalid);IntPtr owner,group,dacl,sacl,ownerDescriptor;Need(GetSecurityInfo(h,1,1,out owner,out group,out dacl,out sacl,out ownerDescriptor)==0);try{Need(new SecurityIdentifier(owner).Value!=WindowsIdentity.GetCurrent().User.Value);return Canonical(h);}finally{LocalFree(ownerDescriptor);}
   }
  }
  Need(System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(path)).StartsWith("wollipog-account-config-",StringComparison.Ordinal));Need(!File.Exists(path));
  var c=new Context{Sid=WindowsIdentity.GetCurrent().User.Value};
  string sd="O:"+c.Sid+"G:"+c.Sid+"D:P(A;;FA;;;"+c.Sid+")(A;;FA;;;SY)(A;;FA;;;BA)";
  if(mode=="foreign-write")sd+="(A;;GW;;;WD)";else if(mode=="null-dacl")sd="O:"+c.Sid+"G:"+c.Sid+"D:NO_ACCESS_CONTROL";else Need(mode=="private"||mode=="full-store");
  IntPtr p;uint n;Need(ConvertStringSecurityDescriptorToSecurityDescriptorW(sd,1,out p,out n));var sa=new SA{Length=Marshal.SizeOf(typeof(SA)),Descriptor=p};try{
   using(var h=CreateFileW(path,R|W|RC,ReadShare,ref sa,1,Through|Reparse,IntPtr.Zero)){Need(!h.IsInvalid);Write(h,Bytes("{\"runnerId\":\"synthetic\",\"providerAccounts\":[],\"untouched\":true}"));Need(FlushFileBuffers(h));}
  }finally{LocalFree(p);}
  if(mode=="full-store"){
   PBI parent;int returned;Need(NtQueryInformationProcess(GetCurrentProcess(),0,out parent,Marshal.SizeOf(typeof(PBI)),out returned)==0);
   var r=new Request{Path=path,Pid=parent.ParentPid.ToInt32(),Birth="",Bindings="",Before=Digest(Bytes("[]")),After=Digest(Bytes("[]"))};
   using(var context=ContextFor(r)){var old=Observe(context,false);r.Next=old.Raw;
    using(var guard=New(context,context.Slot("guard"),Bytes("synthetic-full-store"))){Bootstrap(context,old);var tip=TipFor(context,true);string prev=new string('0',64);
     using(var journal=Open(context.Slot("journal"),context.Sid,false,true,R|W)){
      for(int revision=1;revision<=4096;revision++){context.Alive();string ticket=Guid.NewGuid().ToString("D");for(byte kind=1;kind<=2;kind++){
       var record=Record(context,r,old,tip,kind,ticket,revision,prev);Write(journal,BitConverter.GetBytes(record.Length));Write(journal,record);prev=Digest(record);
      }}Need(FlushFileBuffers(journal));
     }ReleaseGuard(guard);
    }
   }
  }return "";
 }
#endif
}
