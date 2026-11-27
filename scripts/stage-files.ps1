# Publish new bytes to their final Windows paths in one NTFS transaction. The two
# volumes need not match, and live readers never see a partially written module.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class StageFiles {
    [DllImport("ktmw32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern SafeFileHandle CreateTransaction(IntPtr attributes, IntPtr guid, uint options,
        uint isolation, uint flags, uint timeout, string description);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool CopyFileTransacted(string source, string destination, IntPtr progress,
        IntPtr data, IntPtr cancel, uint flags, SafeFileHandle transaction);
    [DllImport("ktmw32.dll", SetLastError=true)]
    static extern bool CommitTransaction(SafeFileHandle transaction);
    public static void Copy(string[] sources, string[] destinations) {
        using (var tx = CreateTransaction(IntPtr.Zero, IntPtr.Zero, 0, 0, 0, 0, "AgentTower plugin staging")) {
            if (tx.IsInvalid) throw new Win32Exception();
            for (int i = 0; i < sources.Length; i++)
                if (!CopyFileTransacted(sources[i], destinations[i], IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, tx))
                    throw new Win32Exception();
            if (!CommitTransaction(tx)) throw new Win32Exception();
        }
    }
}
"@
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$plan = [Console]::In.ReadToEnd() | ConvertFrom-Json
[StageFiles]::Copy([string[]]$plan.sources, [string[]]$plan.destinations)
