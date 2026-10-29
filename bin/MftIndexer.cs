// dsh-mft-indexer: a self-contained NTFS index service for the DeepSeek
// Harness @file search. It reproduces the fast part of Everything: read every
// fixed NTFS volume's MFT through FSCTL_ENUM_USN_DATA, keep the names in memory,
// and answer substring queries over a named pipe.
//
// The MFT read needs a volume handle, which Windows only grants to an elevated
// process. That is why this program runs as a Windows service (LocalSystem):
// the Harness plugin itself never needs elevation, only the one-time service
// installation does.
//
// After the initial MFT scan the service tails each volume's USN journal
// (FSCTL_READ_USN_JOURNAL) and applies creates, renames and deletes to a small
// in-memory overlay, so ordinary changes appear within a second without a full
// rebuild. A full rebuild runs rarely (journal wrap, journal id change, overlay
// growth, or the periodic compaction interval) and at below-normal priority.
//
// Modes:
//   dsh-mft-indexer --service
//   dsh-mft-indexer --console [--source=mft|fs] [--roots=C:\;D:\]
//                   [--pipe=dsh-mft-index] [--rebuild=6] [--watch] [--once]
//
// Pipe protocol (tab separated, text is base64 UTF-8):
//   <id> QUERY <max> <matchPath 0|1> <base64 query> [<base64 ext1,ext2>]
//   <id> RECENT <max>
//   <id> STATUS
//   <id> REBUILD
//
// Compile with the in-box .NET Framework compiler:
//   csc /nologo /platform:x64 /optimize+ /r:System.ServiceProcess.dll
//       /out:dsh-mft-indexer.exe MftIndexer.cs

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace DshMftIndex
{
    internal static class Program
    {
        private static void Main(string[] args)
        {
            if (Array.IndexOf(args, "--service") >= 0)
            {
                ServiceBase.Run(new MftIndexService());
                return;
            }
            ConsoleRunner.Run(args);
        }
    }

    internal sealed class Options
    {
        public string Source = "mft";
        public string[] Roots = new string[0];
        public string PipeName = "dsh-mft-index";
        public int RebuildHours = 6;
        public bool Watch;
        public bool Once;
        public string LogPath;

        public static Options Parse(string[] args)
        {
            var options = new Options();
            foreach (var arg in args)
            {
                if (StartsWith(arg, "--source=")) options.Source = arg.Substring(9).ToLowerInvariant();
                else if (StartsWith(arg, "--roots=")) options.Roots = arg.Substring(8).Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
                else if (StartsWith(arg, "--pipe=")) options.PipeName = arg.Substring(7);
                else if (StartsWith(arg, "--rebuild=")) options.RebuildHours = ParseInt(arg.Substring(10), 6);
                else if (StartsWith(arg, "--log=")) options.LogPath = arg.Substring(6);
                else if (arg.Equals("--watch", StringComparison.OrdinalIgnoreCase)) options.Watch = true;
                else if (arg.Equals("--once", StringComparison.OrdinalIgnoreCase)) options.Once = true;
            }
            return options;
        }

        private static bool StartsWith(string value, string prefix)
        {
            return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        private static int ParseInt(string text, int fallback)
        {
            int value;
            return int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }
    }

    internal static class ConsoleRunner
    {
        public static void Run(string[] args)
        {
            var options = Options.Parse(args);
            if (options.LogPath == null)
                options.LogPath = Path.Combine(Path.GetTempPath(), "dsh-mft-indexer.log");
            var host = new IndexHost(options);
            if (options.Once)
            {
                host.BuildOnce();
                Console.WriteLine(host.DescribeStatus());
                return;
            }
            host.Start();
            Console.WriteLine(host.DescribeStatus());
            Console.WriteLine("pipe=" + options.PipeName + " source=" + options.Source + " (Ctrl+C to stop)");
            var stop = new ManualResetEvent(false);
            Console.CancelKeyPress += (sender, e) => { e.Cancel = true; stop.Set(); };
            stop.WaitOne();
            host.Stop();
        }
    }

    internal sealed class MftIndexService : ServiceBase
    {
        private IndexHost host;

        public MftIndexService()
        {
            ServiceName = "dsh-mft-index";
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            var options = new Options();
            options.Source = "mft";
            options.PipeName = "dsh-mft-index";
            options.RebuildHours = 6;
            options.LogPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "dsh-mft-index", "indexer.log");
            host = new IndexHost(options);
            host.Start();
        }

        protected override void OnStop()
        {
            if (host != null) host.Stop();
        }

        protected override void OnShutdown()
        {
            OnStop();
            base.OnShutdown();
        }
    }

    /// <summary>One immutable index generation: names, per-entry arrays and the parent map.</summary>
    internal sealed class Snapshot
    {
        public string Names;
        public int[] Start;
        public int[] Length;
        public ulong[] Frn;
        public ulong[] Parent;
        public byte[] Flags;   // bit 0: directory
        public byte[] Volume;
        public ulong[] Time;
        public Dictionary<ulong, int> ByKey;
        public string[] VolumeRoots;
        public int[] Recent;
        public long BuildMilliseconds;
        public bool Ready;

        public int Count { get { return Start.Length; } }
    }

    /// <summary>One changed or created entry kept above the immutable snapshot.</summary>
    internal sealed class OverlayRow
    {
        public ulong Key;
        public ulong Parent;
        public string Name;
        public byte Flags;
        public ulong Time;
        public bool Deleted;
    }

    /// <summary>Mutable changes since the last full rebuild.</summary>
    internal sealed class Overlay
    {
        private readonly Dictionary<ulong, OverlayRow> rows = new Dictionary<ulong, OverlayRow>();
        private int live;

        public int LiveCount { get { return live; } }
        public int TotalCount { get { return rows.Count; } }

        public bool HasChange(ulong key)
        {
            return rows.ContainsKey(key);
        }

        public OverlayRow Get(ulong key)
        {
            OverlayRow row;
            return rows.TryGetValue(key, out row) ? row : null;
        }

        public void Upsert(ulong key, ulong parent, string name, byte flags, ulong time)
        {
            OverlayRow row;
            if (rows.TryGetValue(key, out row))
            {
                if (row.Deleted) live++;
                row.Parent = parent;
                row.Name = name;
                row.Flags = flags;
                row.Time = time;
                row.Deleted = false;
                return;
            }
            row = new OverlayRow();
            row.Key = key;
            row.Parent = parent;
            row.Name = name;
            row.Flags = flags;
            row.Time = time;
            rows.Add(key, row);
            live++;
        }

        public void Delete(ulong key)
        {
            OverlayRow row;
            if (rows.TryGetValue(key, out row))
            {
                if (!row.Deleted) live--;
                row.Deleted = true;
                return;
            }
            row = new OverlayRow();
            row.Key = key;
            row.Parent = 0;
            row.Name = string.Empty;
            row.Flags = 0;
            row.Time = 0;
            row.Deleted = true;
            rows.Add(key, row);
        }

        public void Clear()
        {
            rows.Clear();
            live = 0;
        }

        public List<OverlayRow> LiveRows()
        {
            var result = new List<OverlayRow>(live);
            foreach (var row in rows.Values)
            {
                if (!row.Deleted) result.Add(row);
            }
            return result;
        }
    }

    /// <summary>The current snapshot plus its incremental overlay and their lock.</summary>
    internal sealed class IndexState
    {
        public readonly ReaderWriterLockSlim Gate = new ReaderWriterLockSlim(LockRecursionPolicy.NoRecursion);
        public volatile Snapshot Base;
        public readonly Overlay Overlay = new Overlay();
        public bool Ready;

        public int EntryCount
        {
            get
            {
                var snapshot = Base;
                if (snapshot == null) return 0;
                return snapshot.Count + Overlay.LiveCount;
            }
        }
    }

    internal sealed class QueryRow
    {
        public string Path;
        public bool Directory;
    }

    internal sealed class IndexHost
    {
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);
        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint FsctlEnumUsnData = 0x000900B3;
        private const uint FsctlQueryUsnJournal = 0x000900F4;
        private const uint FsctlReadUsnJournal = 0x000900BB;
        private const int EnumBufferBytes = 4 * 1024 * 1024;
        private const int JournalBufferBytes = 1024 * 1024;
        private const int RecentCapacity = 512;
        private const uint FileDeleteReason = 0x00000200;
        private const uint RenameOldNameReason = 0x00001000;
        private const uint RenameNewNameReason = 0x00002000;

        private readonly Options options;
        private readonly object logLock = new object();
        private readonly ManualResetEvent stopEvent = new ManualResetEvent(false);
        private readonly IndexState state = new IndexState();
        private volatile bool building;
        private Thread buildThread;
        private Thread journalThread;
        private Thread timerThread;
        private Thread pipeThread;
        private long lastBuildMs;
        private long lastBuildTicks;
        private long lastPipeErrorTicks;
        private readonly List<VolumeContext> volumes = new List<VolumeContext>();
        private readonly Dictionary<string, ulong> fsKeys = new Dictionary<string, ulong>(StringComparer.OrdinalIgnoreCase);
        private ulong fsKeyCounter = 1000000000UL;

        public IndexHost(Options options)
        {
            this.options = options;
        }

        public void Start()
        {
            Log("starting: source=" + options.Source + " pipe=" + options.PipeName + " rebuild=" + options.RebuildHours + "h watch=" + options.Watch);
            if (options.Source == "mft")
            {
                OpenVolumes();
                CaptureJournalStarts();
            }

            pipeThread = new Thread(() => { PipeLoop(); });
            pipeThread.IsBackground = true;
            pipeThread.Name = "pipe";
            pipeThread.Start();

            buildThread = new Thread(() => { BuildLoop(); });
            buildThread.IsBackground = true;
            buildThread.Name = "index-build";
            buildThread.Start();

            if (options.Source == "mft")
            {
                journalThread = new Thread(() => { JournalLoop(); });
                journalThread.IsBackground = true;
                journalThread.Name = "usn-journal";
                journalThread.Start();
            }
            if (options.Watch)
            {
                var watcher = new Thread(() => { WatchLoop(); });
                watcher.IsBackground = true;
                watcher.Name = "fs-watch";
                watcher.Start();
            }
            if (options.RebuildHours > 0)
            {
                timerThread = new Thread(() => { RebuildLoop(); });
                timerThread.IsBackground = true;
                timerThread.Name = "rebuild-timer";
                timerThread.Start();
            }
        }

        public void Stop()
        {
            stopEvent.Set();
            foreach (var volume in volumes)
            {
                if (volume.Handle != InvalidHandle)
                {
                    CloseHandle(volume.Handle);
                    volume.Handle = InvalidHandle;
                }
            }
            Log("stopping");
        }

        public void BuildOnce()
        {
            var snapshot = Build();
            state.Base = snapshot;
            state.Ready = true;
        }

        public string DescribeStatus()
        {
            var text = "STATUS " + (state.Ready ? 1 : 0) + " " + state.EntryCount + " " + (building ? 1 : 0) + " " + lastBuildMs + " " + options.Source;
            text += " overlay=" + state.Overlay.LiveCount;
            return text;
        }

        private void BuildLoop()
        {
            try
            {
                var snapshot = Build();
                ApplySnapshot(snapshot);
                Log("index ready: " + snapshot.Count + " entries in " + snapshot.BuildMilliseconds + " ms; volumes=" + string.Join(",", snapshot.VolumeRoots));
            }
            catch (Exception error)
            {
                Log("build failed: " + error);
                building = false;
            }
        }

        private void ApplySnapshot(Snapshot snapshot)
        {
            state.Gate.EnterWriteLock();
            try
            {
                state.Base = snapshot;
                state.Overlay.Clear();
                state.Ready = true;
                lastBuildMs = snapshot.BuildMilliseconds;
                lastBuildTicks = DateTime.UtcNow.Ticks;
                // Rewind the journal cursor to the pre-build position so every
                // change that happened while the MFT was being scanned is
                // replayed on top of the new snapshot.
                foreach (var volume in volumes)
                {
                    if (volume.JournalId != 0 && volume.BuildStartUsn > 0)
                        volume.NextUsn = volume.BuildStartUsn;
                }
            }
            finally
            {
                state.Gate.ExitWriteLock();
            }
        }

        private void RebuildLoop()
        {
            while (!stopEvent.WaitOne(TimeSpan.FromMinutes(30)))
            {
                if (building) continue;
                var age = TimeSpan.FromTicks(DateTime.UtcNow.Ticks - lastBuildTicks);
                var dueOverlay = state.Overlay.TotalCount > 150000;
                if (age < TimeSpan.FromHours(Math.Max(1, options.RebuildHours)) && !dueOverlay) continue;
                RequestRebuild("periodic");
            }
        }

        private void RequestRebuild(string reason)
        {
            if (building) return;
            var thread = new Thread(() =>
            {
                try
                {
                    Log("rebuild requested: " + reason);
                    var snapshot = Build();
                    ApplySnapshot(snapshot);
                    Log("rebuild done: " + snapshot.Count + " entries in " + snapshot.BuildMilliseconds + " ms");
                }
                catch (Exception error)
                {
                    Log("rebuild failed: " + error);
                    building = false;
                }
            });
            thread.IsBackground = true;
            thread.Name = "index-rebuild";
            thread.Start();
        }

        private Snapshot Build()
        {
            building = true;
            if (options.Source == "fs") { lock (fsKeys) fsKeys.Clear(); }
            var previousPriority = Thread.CurrentThread.Priority;
            try
            {
                Thread.CurrentThread.Priority = ThreadPriority.BelowNormal;
                foreach (var volume in volumes)
                    volume.BuildStartUsn = volume.NextUsn;
                var watch = Stopwatch.StartNew();
                var names = new StringBuilder(1 << 22);
                var starts = new List<int>(1 << 20);
                var lengths = new List<int>(1 << 20);
                var frns = new List<ulong>(1 << 20);
                var parents = new List<ulong>(1 << 20);
                var flags = new List<byte>(1 << 20);
                var volumesList = new List<byte>(1 << 20);
                var times = new List<ulong>(1 << 20);
                var byKey = new Dictionary<ulong, int>(1 << 20);
                var roots = new List<string>();
                var recentHeap = new RecentHeap(RecentCapacity);

                if (options.Source == "fs")
                {
                    roots.Add("FS");
                    var index = 0;
                    foreach (var root in options.Roots)
                        index = WalkDirectory(root, 0, -1, names, starts, lengths, frns, parents, flags, volumesList, times, byKey, recentHeap, index);
                }
                else
                {
                    foreach (var volume in volumes)
                    {
                        AppendVolume(volume, names, starts, lengths, frns, parents, flags, volumesList, times, byKey, recentHeap);
                        Log("volume " + volume.Root + ": entries so far " + starts.Count);
                    }
                }

                watch.Stop();
                var snapshot = new Snapshot();
                snapshot.Names = names.ToString();
                snapshot.Start = starts.ToArray();
                snapshot.Length = lengths.ToArray();
                snapshot.Frn = frns.ToArray();
                snapshot.Parent = parents.ToArray();
                snapshot.Flags = flags.ToArray();
                snapshot.Volume = volumesList.ToArray();
                snapshot.Time = times.ToArray();
                snapshot.ByKey = byKey;
                snapshot.VolumeRoots = roots.ToArray();
                snapshot.Recent = recentHeap.ToSortedArray();
                snapshot.BuildMilliseconds = watch.ElapsedMilliseconds;
                snapshot.Ready = true;
                return snapshot;
            }
            finally
            {
                Thread.CurrentThread.Priority = previousPriority;
                building = false;
            }
        }

        private int WalkDirectory(
            string absolute, int volumeIndex, int parentIndex,
            StringBuilder names, List<int> starts, List<int> lengths,
            List<ulong> frns, List<ulong> parents, List<byte> flags,
            List<byte> volumes, List<ulong> times, Dictionary<ulong, int> byKey,
            RecentHeap recent, int nextIndex)
        {
            IEnumerable<string> entries;
            try
            {
                entries = Directory.EnumerateFileSystemEntries(absolute);
            }
            catch
            {
                return nextIndex;
            }

            var stack = new Stack<KeyValuePair<string, int>>();
            stack.Push(new KeyValuePair<string, int>(absolute, parentIndex));
            while (stack.Count > 0)
            {
                var item = stack.Pop();
                string directory = item.Key;
                int directoryIndex = item.Value;
                try
                {
                    foreach (var path in Directory.EnumerateFileSystemEntries(directory))
                    {
                        bool isDirectory;
                        try
                        {
                            var attributes = File.GetAttributes(path);
                            if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                            isDirectory = (attributes & FileAttributes.Directory) != 0;
                        }
                        catch
                        {
                            continue;
                        }

                        var name = Path.GetFileName(path);
                        if (string.IsNullOrEmpty(name)) continue;
                        int start = names.Length;
                        names.Append(name);
                        names.Append('\n');
                        int index = nextIndex++;
                        var frn = (ulong)index + 1;
                        var parentKey = directoryIndex < 0 ? frn : ((ulong)directoryIndex + 1);
                        starts.Add(start);
                        lengths.Add(name.Length);
                        frns.Add(frn);
                        parents.Add(parentKey);
                        flags.Add((byte)(isDirectory ? 1 : 0));
                        volumes.Add((byte)volumeIndex);
                        long ticks = 0;
                        try { ticks = File.GetLastWriteTimeUtc(path).ToFileTimeUtc(); } catch { }
                        times.Add((ulong)ticks);
                        byKey[Key(frn, (byte)volumeIndex)] = index;
                        lock (fsKeys) fsKeys[path] = Key(frn, (byte)volumeIndex);
                        recent.Push(ticks, index);
                        if (isDirectory) stack.Push(new KeyValuePair<string, int>(path, index));
                    }
                }
                catch
                {
                    // Unreadable directory contributes no entries.
                }
            }
            // Root pseudo-entry so parent chains terminate cleanly.
            int rootStart = names.Length;
            names.Append('\n');
            starts.Add(rootStart);
            lengths.Add(0);
            frns.Add(1);
            parents.Add(1);
            flags.Add(1);
            volumes.Add((byte)volumeIndex);
            times.Add(0);
            byKey[Key(1, (byte)volumeIndex)] = starts.Count - 1;
            lock (fsKeys) fsKeys[absolute] = Key(1, (byte)volumeIndex);
            return nextIndex;
        }

        private void AppendVolume(
            VolumeContext volume,
            StringBuilder names, List<int> starts, List<int> lengths,
            List<ulong> frns, List<ulong> parents, List<byte> flags,
            List<byte> volumes, List<ulong> times, Dictionary<ulong, int> byKey,
            RecentHeap recent)
        {
            if (volume.Handle == InvalidHandle) return;
            var input = Marshal.AllocHGlobal(24);
            var output = Marshal.AllocHGlobal(EnumBufferBytes);
            var buffer = new byte[EnumBufferBytes];
            try
            {
                WriteInt64(input, 0, 0);
                WriteInt64(input, 8, 0);
                WriteInt64(input, 16, long.MaxValue);
                var recordCount = 0;
                while (!stopEvent.WaitOne(0))
                {
                    uint returned;
                    var ok = DeviceIoControl(volume.Handle, FsctlEnumUsnData, input, 24, output, (uint)EnumBufferBytes, out returned, IntPtr.Zero);
                    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "FSCTL_ENUM_USN_DATA " + volume.Root);
                    if (returned <= 8) break;
                    Marshal.Copy(output, buffer, 0, (int)returned);
                    long nextStart = BitConverter.ToInt64(buffer, 0);
                    int offset = 8;
                    while (offset + 60 <= returned)
                    {
                        int recordLength = BitConverter.ToInt32(buffer, offset);
                        if (recordLength < 60 || offset + recordLength > returned) break;
                        ulong frn = BitConverter.ToUInt64(buffer, offset + 8);
                        ulong parentFrn = BitConverter.ToUInt64(buffer, offset + 16);
                        long timestamp = BitConverter.ToInt64(buffer, offset + 32);
                        uint attributes = BitConverter.ToUInt32(buffer, offset + 52);
                        int nameBytes = BitConverter.ToUInt16(buffer, offset + 56);
                        int nameOffset = BitConverter.ToUInt16(buffer, offset + 58);
                        if (nameBytes > 0 && nameOffset + nameBytes <= recordLength)
                        {
                            var name = Encoding.Unicode.GetString(buffer, offset + nameOffset, nameBytes);
                            if (name.Length > 0 && name[0] != '$')
                            {
                                int start = names.Length;
                                names.Append(name);
                                names.Append('\n');
                                int index = starts.Count;
                                starts.Add(start);
                                lengths.Add(name.Length);
                                frns.Add(frn);
                                parents.Add(parentFrn);
                                flags.Add((byte)((attributes & 0x10) != 0 ? 1 : 0));
                                volumes.Add(volume.Index);
                                times.Add((ulong)timestamp);
                                byKey[Key(frn, volume.Index)] = index;
                                recent.Push(timestamp, index);
                                recordCount++;
                                if ((recordCount & 0xFFFF) == 0) Thread.Sleep(1);
                            }
                        }
                        offset += recordLength;
                    }
                    if (nextStart <= 0) break;
                    WriteInt64(input, 0, nextStart);
                }
                // Ensure the volume root FRN (5) resolves even when the enum
                // stream starts after it.
                var rootKey = Key(5UL, volume.Index);
                if (!byKey.ContainsKey(rootKey))
                {
                    int start = names.Length;
                    names.Append('\n');
                    int index = starts.Count;
                    starts.Add(start);
                    lengths.Add(0);
                    frns.Add(5);
                    parents.Add(5);
                    flags.Add(1);
                    volumes.Add(volume.Index);
                    times.Add(0);
                    byKey[rootKey] = index;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(input);
                Marshal.FreeHGlobal(output);
            }
        }

        private void OpenVolumes()
        {
            foreach (var drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.DriveType != DriveType.Fixed) continue;
                    if (!string.Equals(drive.DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase)) continue;
                    var root = drive.Name.Substring(0, 2);
                    var path = @"\\.\" + root;
                    var handle = CreateFile(path, GenericRead, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
                    if (handle == InvalidHandle)
                    {
                        Log("volume " + root + " skipped: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                        continue;
                    }
                    var volume = new VolumeContext();
                    volume.Root = root;
                    volume.Index = (byte)volumes.Count;
                    volume.Handle = handle;
                    volumes.Add(volume);
                }
                catch (Exception error)
                {
                    Log("volume " + drive.Name + " skipped: " + error.Message);
                }
            }
            if (volumes.Count == 0)
            {
                Log("no readable NTFS volumes; run the service as LocalSystem (administrator)");
            }
        }

        private void CaptureJournalStarts()
        {
            foreach (var volume in volumes)
            {
                UsnJournalData data;
                if (QueryJournal(volume, out data))
                {
                    volume.JournalId = data.UsnJournalID;
                    volume.NextUsn = data.NextUsn;
                    volume.BuildStartUsn = data.NextUsn;
                    Log("journal " + volume.Root + ": id=" + data.UsnJournalID + " next=" + data.NextUsn);
                }
                else
                {
                    Log("journal " + volume.Root + " unavailable; periodic rebuild only");
                }
            }
        }

        private void JournalLoop()
        {
            while (!stopEvent.WaitOne(400))
            {
                if (!state.Ready || state.Base == null || building) continue;
                foreach (var volume in volumes)
                {
                    try
                    {
                        if (volume.Handle == InvalidHandle || volume.JournalId == 0) continue;
                        UsnJournalData data;
                        if (!QueryJournal(volume, out data)) continue;
                        if (data.UsnJournalID != volume.JournalId || data.FirstUsn > volume.NextUsn)
                        {
                            Log("journal " + volume.Root + " wrapped or recreated; rebuild");
                            volume.JournalId = data.UsnJournalID;
                            volume.NextUsn = data.NextUsn;
                            RequestRebuild("journal " + volume.Root);
                            continue;
                        }
                        ReadJournal(volume);
                    }
                    catch (Exception error)
                    {
                        Log("journal " + volume.Root + " read failed: " + error.Message);
                    }
                }
            }
        }

        private void ReadJournal(VolumeContext volume)
        {
            var input = Marshal.AllocHGlobal(40);
            var output = Marshal.AllocHGlobal(JournalBufferBytes);
            var buffer = new byte[JournalBufferBytes];
            try
            {
                while (!stopEvent.WaitOne(0))
                {
                    WriteInt64(input, 0, volume.NextUsn);
                    Marshal.WriteInt32(input, 8, unchecked((int)0xFFFFFFFF));
                    Marshal.WriteInt32(input, 12, 0);
                    WriteInt64(input, 16, 0);
                    WriteInt64(input, 24, 0);
                    WriteInt64(input, 32, (long)volume.JournalId);
                    uint returned;
                    var ok = DeviceIoControl(volume.Handle, FsctlReadUsnJournal, input, 40, output, (uint)JournalBufferBytes, out returned, IntPtr.Zero);
                    if (!ok)
                    {
                        Log("FSCTL_READ_USN_JOURNAL " + volume.Root + " failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                        return;
                    }
                    if (returned < 8) return;
                    Marshal.Copy(output, buffer, 0, (int)returned);
                    long nextUsn = BitConverter.ToInt64(buffer, 0);
                    var records = ParseJournalRecords(buffer, (int)returned, volume.Index);
                    if (records.Count > 0) ApplyJournalRecords(records);
                    if (nextUsn <= volume.NextUsn) return;
                    volume.NextUsn = nextUsn;
                    if (records.Count == 0) return;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(input);
                Marshal.FreeHGlobal(output);
            }
        }

        private List<JournalRecord> ParseJournalRecords(byte[] buffer, int length, byte volumeIndex)
        {
            var records = new List<JournalRecord>();
            int offset = 8;
            while (offset + 60 <= length)
            {
                int recordLength = BitConverter.ToInt32(buffer, offset);
                if (recordLength < 60 || offset + recordLength > length) break;
                var record = new JournalRecord();
                record.Frn = BitConverter.ToUInt64(buffer, offset + 8);
                record.ParentFrn = BitConverter.ToUInt64(buffer, offset + 16);
                record.Time = BitConverter.ToInt64(buffer, offset + 32);
                record.Reason = BitConverter.ToUInt32(buffer, offset + 40);
                record.Attributes = BitConverter.ToUInt32(buffer, offset + 52);
                int nameBytes = BitConverter.ToUInt16(buffer, offset + 56);
                int nameOffset = BitConverter.ToUInt16(buffer, offset + 58);
                if (nameBytes > 0 && nameOffset + nameBytes <= recordLength)
                {
                    record.Name = Encoding.Unicode.GetString(buffer, offset + nameOffset, nameBytes);
                    record.Volume = volumeIndex;
                    if (record.Name.Length > 0 && record.Name[0] != '$') records.Add(record);
                }
                offset += recordLength;
            }
            return records;
        }

        private void ApplyJournalRecords(List<JournalRecord> records)
        {
            state.Gate.EnterWriteLock();
            try
            {
                foreach (var record in records)
                {
                    var key = Key(record.Frn, record.Volume);
                    if ((record.Reason & FileDeleteReason) != 0)
                    {
                        state.Overlay.Delete(key);
                        continue;
                    }
                    if ((record.Reason & RenameOldNameReason) != 0 && (record.Reason & RenameNewNameReason) == 0)
                        continue;
                    state.Overlay.Upsert(
                        key,
                        record.ParentFrn,
                        record.Name,
                        (byte)((record.Attributes & 0x10) != 0 ? 1 : 0),
                        (ulong)record.Time);
                }
            }
            finally
            {
                state.Gate.ExitWriteLock();
            }
        }

        private bool QueryJournal(VolumeContext volume, out UsnJournalData data)
        {
            data = new UsnJournalData();
            var output = Marshal.AllocHGlobal(128);
            try
            {
                uint returned;
                var ok = DeviceIoControl(volume.Handle, FsctlQueryUsnJournal, IntPtr.Zero, 0, output, 128, out returned, IntPtr.Zero);
                if (!ok || returned < 56) return false;
                data.UsnJournalID = (ulong)Marshal.ReadInt64(output, 0);
                data.FirstUsn = Marshal.ReadInt64(output, 8);
                data.NextUsn = Marshal.ReadInt64(output, 16);
                return true;
            }
            finally
            {
                Marshal.FreeHGlobal(output);
            }
        }

        private void WatchLoop()
        {
            var watchers = new List<FileSystemWatcher>();
            foreach (var root in options.Roots)
            {
                try
                {
                    var watcher = new FileSystemWatcher(root);
                    watcher.IncludeSubdirectories = true;
                    watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite;
                    watcher.InternalBufferSize = 64 * 1024;
                    watcher.Created += (sender, e) => ApplyFileSystemChange(e.FullPath, false);
                    watcher.Changed += (sender, e) => ApplyFileSystemChange(e.FullPath, false);
                    watcher.Deleted += (sender, e) => ApplyFileSystemChange(e.FullPath, true);
                    watcher.Renamed += (sender, e) => ApplyFileSystemRename(e.OldFullPath, e.FullPath);
                    watcher.EnableRaisingEvents = true;
                    watchers.Add(watcher);
                }
                catch (Exception error)
                {
                    Log("watch " + root + " failed: " + error.Message);
                }
            }
            stopEvent.WaitOne();
            foreach (var watcher in watchers) watcher.Dispose();
        }

        private void ApplyFileSystemChange(string path, bool deleted)
        {
            try
            {
                var key = SyntheticKeyForPath(path);
                if (deleted)
                {
                    state.Gate.EnterWriteLock();
                    try { state.Overlay.Delete(key); } finally { state.Gate.ExitWriteLock(); }
                    return;
                }
                var attributes = File.GetAttributes(path);
                var parentPath = Path.GetDirectoryName(path);
                var parentKey = SyntheticKeyForPath(parentPath);
                var flags = (byte)((attributes & FileAttributes.Directory) != 0 ? 1 : 0);
                var ticks = File.GetLastWriteTimeUtc(path).ToFileTimeUtc();
                state.Gate.EnterWriteLock();
                try
                {
                    state.Overlay.Upsert(key, IndexHost.FrnOf(parentKey), Path.GetFileName(path), flags, (ulong)ticks);
                }
                finally
                {
                    state.Gate.ExitWriteLock();
                }
            }
            catch
            {
                // The watcher is a test/diagnostic path; unreadable entries are skipped.
            }
        }

        private void ApplyFileSystemRename(string oldPath, string newPath)
        {
            var key = SyntheticKeyForPath(oldPath);
            ApplyFileSystemChange(newPath, false);
            state.Gate.EnterWriteLock();
            try { state.Overlay.Delete(key); } finally { state.Gate.ExitWriteLock(); }
        }

        private ulong SyntheticKeyForPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return Key(1, 0);
            lock (fsKeys)
            {
                ulong key;
                if (fsKeys.TryGetValue(path, out key)) return key;
                key = ((fsKeyCounter++) << 4);
                fsKeys[path] = key;
                return key;
            }
        }

        private void PipeLoop()
        {
            while (!stopEvent.WaitOne(0))
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = CreatePipe();
                    pipe.WaitForConnection();
                    var client = pipe;
                    var thread = new Thread(() => { ServeClient(client); });
                    thread.IsBackground = true;
                    thread.Start();
                    pipe = null; // ownership moved to the client thread
                }
                catch (Exception error)
                {
                    if (!(error is IOException))
                    {
                        // Recreating a pipe instance can transiently fail while the
                        // previous client is still closing; retry quietly and log
                        // at most once a minute.
                        var now = DateTime.UtcNow.Ticks;
                        if (now - lastPipeErrorTicks > TimeSpan.TicksPerMinute)
                        {
                            lastPipeErrorTicks = now;
                            Log("pipe error: " + error.Message);
                        }
                    }
                    Thread.Sleep(300);
                }
                finally
                {
                    if (pipe != null) pipe.Dispose();
                }
            }
        }

        private NamedPipeServerStream CreatePipe()
        {
            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
                PipeAccessRights.ReadWrite, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                PipeAccessRights.FullControl, AccessControlType.Allow));
            return new NamedPipeServerStream(
                options.PipeName, PipeDirection.InOut, 8,
                PipeTransmissionMode.Byte, PipeOptions.None, 65536, 65536, security);
        }

        private void ServeClient(NamedPipeServerStream pipe)
        {
            try
            {
                using (pipe)
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096))
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096))
                {
                    writer.AutoFlush = false;
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        var parts = line.Split('\t');
                        if (parts.Length < 2) continue;
                        var id = parts[0];
                        var command = parts[1];
                        if (command == "STATUS")
                        {
                            WriteStatus(writer, id);
                        }
                        else if (command == "RECENT")
                        {
                            var max = parts.Length >= 3 ? ParseInt(parts[2], 20) : 20;
                            WriteRecent(writer, id, max);
                        }
                        else if (command == "QUERY" && parts.Length >= 5)
                        {
                            var max = ParseInt(parts[2], 100);
                            var matchPath = parts[3] == "1";
                            var query = Encoding.UTF8.GetString(Convert.FromBase64String(parts[4]));
                            string[] extensions = new string[0];
                            if (parts.Length >= 6 && parts[5].Length > 0)
                                extensions = Encoding.UTF8.GetString(Convert.FromBase64String(parts[5])).Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                            WriteQuery(writer, id, query, max, matchPath, extensions);
                        }
                        else if (command == "REBUILD")
                        {
                            WriteSimple(writer, id, "REBUILD", "1");
                            RequestRebuild("client");
                        }
                        else
                        {
                            WriteError(writer, id, 9, "unknown command");
                        }
                        writer.Flush();
                    }
                }
            }
            catch
            {
                // Client disconnected or protocol error; the next connection retries.
            }
        }

        private void WriteStatus(StreamWriter writer, string id)
        {
            writer.Write(id + "\tSTATUS\t" + (state.Ready ? "1" : "0") + "\t" + state.EntryCount + "\t" + (building ? "1" : "0") + "\t" + lastBuildMs + "\n");
        }

        private void WriteSimple(StreamWriter writer, string id, string name, string value)
        {
            writer.Write(id + "\t" + name + "\t" + value + "\n");
        }

        private void WriteRecent(StreamWriter writer, string id, int max)
        {
            if (!state.Ready)
            {
                WriteError(writer, id, 6, "index is still building");
                return;
            }
            var rows = QueryRecent(state, max);
            WriteRows(writer, id, rows);
        }

        private void WriteQuery(StreamWriter writer, string id, string query, int max, bool matchPath, string[] extensions)
        {
            if (!state.Ready)
            {
                WriteError(writer, id, 6, "index is still building");
                return;
            }
            if (max < 1) max = 1;
            if (max > 2000) max = 2000;
            var rows = QueryEngine.Query(state, query, max, matchPath, extensions);
            WriteRows(writer, id, rows);
        }

        private static List<QueryRow> QueryRecent(IndexState state, int max)
        {
            var rows = new List<QueryRow>();
            state.Gate.EnterReadLock();
            try
            {
                var snapshot = state.Base;
                if (snapshot == null) return rows;
                var candidates = new List<KeyValuePair<ulong, ulong>>();
                if (snapshot.Recent != null)
                {
                    foreach (var index in snapshot.Recent)
                    {
                        var key = Key(snapshot.Frn[index], snapshot.Volume[index]);
                        if (state.Overlay.HasChange(key)) continue;
                        candidates.Add(new KeyValuePair<ulong, ulong>(snapshot.Time[index], key));
                    }
                }
                foreach (var row in state.Overlay.LiveRows())
                    candidates.Add(new KeyValuePair<ulong, ulong>(row.Time, row.Key));
                candidates.Sort((left, right) => right.Key.CompareTo(left.Key));
                foreach (var candidate in candidates)
                {
                    if (rows.Count >= max) break;
                    string path;
                    if (!QueryEngine.TryResolve(state, candidate.Value, out path)) continue;
                    var flags = QueryEngine.FlagsOf(state, candidate.Value);
                    rows.Add(new QueryRow { Path = path, Directory = (flags & 1) != 0 });
                }
            }
            finally
            {
                state.Gate.ExitReadLock();
            }
            return rows;
        }

        private void WriteRows(StreamWriter writer, string id, List<QueryRow> rows)
        {
            writer.Write(id + "\tOK\t" + rows.Count + "\n");
            foreach (var row in rows)
            {
                writer.Write(row.Directory ? "D\t" : "F\t");
                writer.Write(row.Path);
                writer.Write('\n');
            }
            writer.Write(id + "\tEND\n");
        }

        private static void WriteError(StreamWriter writer, string id, int code, string message)
        {
            writer.Write(id + "\tERR\t" + code + "\t" + message.Replace('\t', ' ').Replace('\n', ' ') + "\n");
        }

        private static int ParseInt(string text, int fallback)
        {
            int value;
            return int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }

        private void Log(string message)
        {
            try
            {
                lock (logLock)
                {
                    var directory = Path.GetDirectoryName(options.LogPath);
                    if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                    File.AppendAllText(options.LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine);
                }
            }
            catch
            {
                // Logging must never take the index down.
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(
            string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
            uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DeviceIoControl(
            IntPtr device, uint controlCode, IntPtr inBuffer, uint inBufferSize,
            IntPtr outBuffer, uint outBufferSize, out uint bytesReturned, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static void WriteInt64(IntPtr buffer, int offset, long value)
        {
            Marshal.WriteInt64(buffer, offset, value);
        }

        internal static ulong Key(ulong frn, byte volume)
        {
            return ((frn & 0xFFFFFFFFFFFFUL) << 4) | volume;
        }

        internal static ulong FrnOf(ulong key) { return key >> 4; }
        internal static byte VolumeOf(ulong key) { return (byte)(key & 0xF); }

        private sealed class VolumeContext
        {
            public string Root;
            public byte Index;
            public IntPtr Handle = InvalidHandle;
            public ulong JournalId;
            public long NextUsn;
            public long BuildStartUsn;
        }

        private struct UsnJournalData
        {
            public ulong UsnJournalID;
            public long FirstUsn;
            public long NextUsn;
        }

        private sealed class JournalRecord
        {
            public ulong Frn;
            public ulong ParentFrn;
            public long Time;
            public uint Reason;
            public uint Attributes;
            public string Name;
            public byte Volume;
        }
    }

    /// <summary>Query, path resolution and entry lookup over snapshot + overlay.</summary>
    internal static class QueryEngine
    {
        public static List<QueryRow> Query(IndexState state, string rawQuery, int max, bool matchPath, string[] extensions)
        {
            var rows = new List<QueryRow>(Math.Min(max, 256));
            var query = (rawQuery ?? string.Empty).Trim();
            if (query.Length == 0) return rows;
            var tokens = query.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (tokens.Length == 0) return rows;

            var normalizedPath = query.Replace('/', '\\');
            var pathQuery = matchPath || normalizedPath.IndexOf('\\') >= 0;
            string scanToken;
            if (pathQuery)
            {
                var trimmedPath = normalizedPath.TrimEnd('\\');
                var lastSlash = trimmedPath.LastIndexOf('\\');
                scanToken = lastSlash >= 0 ? trimmedPath.Substring(lastSlash + 1) : trimmedPath;
            }
            else
            {
                scanToken = tokens[0];
                for (var i = 1; i < tokens.Length; i++)
                    if (tokens[i].Length > scanToken.Length) scanToken = tokens[i];
            }
            if (scanToken.Length == 0) return rows;

            state.Gate.EnterReadLock();
            try
            {
                var snapshot = state.Base;
                if (snapshot == null) return rows;
                var seen = new HashSet<ulong>();
                var scanLimit = Math.Max(max * 40, 20000);
                var attempts = 0;
                var position = 0;
                while (attempts < scanLimit)
                {
                    var hit = snapshot.Names.IndexOf(scanToken, position, StringComparison.OrdinalIgnoreCase);
                    if (hit < 0) break;
                    position = hit + 1;
                    attempts++;
                    var index = EntryAt(snapshot, hit);
                    if (index < 0) continue;
                    var key = IndexHost.Key(snapshot.Frn[index], snapshot.Volume[index]);
                    if (state.Overlay.HasChange(key)) continue;
                    if (!seen.Add(key)) continue;
                    var nameLength = snapshot.Length[index];
                    if (!ContainsToken(snapshot.Names, snapshot.Start[index], nameLength, scanToken)) continue;
                    if (!pathQuery && !MatchesAllTokens(snapshot.Names, snapshot.Start[index], nameLength, tokens)) continue;
                    if (extensions.Length > 0 && !HasExtension(snapshot.Names, snapshot.Start[index], nameLength, extensions)) continue;
                    string path;
                    if (!TryResolve(state, key, out path)) continue;
                    if (pathQuery && path.IndexOf(normalizedPath, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var flags = snapshot.Flags[index];
                    rows.Add(new QueryRow { Path = path, Directory = (flags & 1) != 0 });
                    if (rows.Count >= max) break;
                    position = Math.Max(position, snapshot.Start[index] + nameLength + 1);
                }

                if (rows.Count < max)
                {
                    foreach (var row in state.Overlay.LiveRows())
                    {
                        if (rows.Count >= max) break;
                        if (!seen.Add(row.Key)) continue;
                        if (!ContainsToken(row.Name, 0, row.Name.Length, scanToken)) continue;
                        if (!pathQuery && !MatchesAllTokens(row.Name, 0, row.Name.Length, tokens)) continue;
                        if (extensions.Length > 0 && !HasExtension(row.Name, 0, row.Name.Length, extensions)) continue;
                        string path;
                        if (!TryResolve(state, row.Key, out path)) continue;
                        if (pathQuery && path.IndexOf(normalizedPath, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        rows.Add(new QueryRow { Path = path, Directory = (row.Flags & 1) != 0 });
                    }
                }
            }
            finally
            {
                state.Gate.ExitReadLock();
            }
            return rows;
        }

        public static byte FlagsOf(IndexState state, ulong key)
        {
            var overlay = state.Overlay.Get(key);
            if (overlay != null) return overlay.Deleted ? (byte)0 : overlay.Flags;
            var snapshot = state.Base;
            int index;
            if (snapshot != null && snapshot.ByKey.TryGetValue(key, out index)) return snapshot.Flags[index];
            return 0;
        }

        public static bool TryResolve(IndexState state, ulong key, out string path)
        {
            var segments = new List<string>(8);
            var cursor = key;
            var guard = 0;
            byte volume = IndexHost.VolumeOf(key);
            while (guard++ < 512)
            {
                ulong parent;
                string name;
                byte flags;
                if (!TryGetEntry(state, cursor, out parent, out name, out flags))
                {
                    path = null;
                    return false;
                }
                if (name.Length > 0) segments.Add(name);
                var frn = IndexHost.FrnOf(cursor);
                if (parent == frn) break;
                var next = IndexHost.Key(parent, volume);
                if (next == cursor) break;
                cursor = next;
            }
            if (segments.Count == 0)
            {
                path = null;
                return false;
            }
            segments.Reverse();
            var root = state.Base != null && state.Base.VolumeRoots.Length > volume ? state.Base.VolumeRoots[volume] : "?";
            path = root + "\\" + string.Join("\\", segments.ToArray());
            return true;
        }

        private static bool TryGetEntry(IndexState state, ulong key, out ulong parent, out string name, out byte flags)
        {
            var overlay = state.Overlay.Get(key);
            if (overlay != null)
            {
                if (overlay.Deleted)
                {
                    parent = 0; name = null; flags = 0;
                    return false;
                }
                parent = overlay.Parent;
                name = overlay.Name;
                flags = overlay.Flags;
                return true;
            }
            var snapshot = state.Base;
            int index;
            if (snapshot != null && snapshot.ByKey.TryGetValue(key, out index))
            {
                parent = snapshot.Parent[index];
                var start = snapshot.Start[index];
                var length = snapshot.Length[index];
                name = length > 0 ? snapshot.Names.Substring(start, length) : string.Empty;
                flags = snapshot.Flags[index];
                return true;
            }
            parent = 0; name = null; flags = 0;
            return false;
        }

        private static bool ContainsToken(string text, int start, int length, string token)
        {
            if (token.Length == 0) return true;
            if (token.Length > length) return false;
            return text.IndexOf(token, start, length, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool MatchesAllTokens(string text, int start, int length, string[] tokens)
        {
            foreach (var token in tokens)
                if (!ContainsToken(text, start, length, token)) return false;
            return true;
        }

        private static bool HasExtension(string text, int start, int length, string[] extensions)
        {
            foreach (var extension in extensions)
            {
                var suffix = "." + extension.TrimStart('.').ToLowerInvariant();
                if (length <= suffix.Length) continue;
                if (text[start + length - suffix.Length] != '.') continue;
                var matched = true;
                for (var i = 0; i < suffix.Length; i++)
                {
                    if (char.ToLowerInvariant(text[start + length - suffix.Length + i]) != suffix[i]) { matched = false; break; }
                }
                if (matched) return true;
            }
            return false;
        }

        private static int EntryAt(Snapshot snapshot, int offset)
        {
            var low = 0;
            var high = snapshot.Start.Length - 1;
            while (low <= high)
            {
                var middle = low + ((high - low) >> 1);
                if (snapshot.Start[middle] <= offset) low = middle + 1;
                else high = middle - 1;
            }
            var index = high;
            if (index < 0) return -1;
            return offset < snapshot.Start[index] + snapshot.Length[index] ? index : -1;
        }
    }

    /// <summary>Fixed-size min-heap keeping the newest entries for the empty-query page.</summary>
    internal sealed class RecentHeap
    {
        private readonly KeyValuePair<long, int>[] items;
        private int count;

        public RecentHeap(int capacity)
        {
            items = new KeyValuePair<long, int>[capacity];
        }

        public void Push(long time, int index)
        {
            if (count < items.Length)
            {
                items[count] = new KeyValuePair<long, int>(time, index);
                count++;
                if (count == items.Length) Heapify();
                return;
            }
            if (time <= items[0].Key) return;
            items[0] = new KeyValuePair<long, int>(time, index);
            SiftDown(0);
        }

        private void Heapify()
        {
            for (var i = (count / 2) - 1; i >= 0; i--) SiftDown(i);
        }

        private void SiftDown(int index)
        {
            while (true)
            {
                var left = (index * 2) + 1;
                var right = left + 1;
                var smallest = index;
                if (left < count && items[left].Key < items[smallest].Key) smallest = left;
                if (right < count && items[right].Key < items[smallest].Key) smallest = right;
                if (smallest == index) return;
                var swap = items[index];
                items[index] = items[smallest];
                items[smallest] = swap;
                index = smallest;
            }
        }

        public int[] ToSortedArray()
        {
            var copy = new KeyValuePair<long, int>[count];
            Array.Copy(items, copy, count);
            Array.Sort(copy, (left, right) => right.Key.CompareTo(left.Key));
            var result = new int[count];
            for (var i = 0; i < count; i++) result[i] = copy[i].Value;
            return result;
        }
    }
}
