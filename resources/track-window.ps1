param(
  [Parameter(Mandatory = $true)][string]$Title,
  [int]$Interval = 120
)

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class ApmWindowTracker {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // FindWindow 对 SDL 窗口偶发找不到，改用 EnumWindows + 标题精确匹配
    public static IntPtr FindByTitle(string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            if (sb.ToString() == title) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

$last = ''
while ($true) {
  $h = [ApmWindowTracker]::FindByTitle($Title)
  if ($h -eq [IntPtr]::Zero) {
    if ($last -ne 'GONE') { Write-Output 'GONE'; $last = 'GONE' }
    Start-Sleep -Milliseconds $Interval
    continue
  }

  $r = New-Object ApmWindowTracker+RECT
  [ApmWindowTracker]::GetWindowRect($h, [ref]$r) | Out-Null
  $visible = [int]([ApmWindowTracker]::IsWindowVisible($h))
  $line = "$($r.Left) $($r.Top) $($r.Right - $r.Left) $($r.Bottom - $r.Top) $visible"
  if ($line -ne $last) {
    Write-Output $line
    $last = $line
  }
  Start-Sleep -Milliseconds $Interval
}
