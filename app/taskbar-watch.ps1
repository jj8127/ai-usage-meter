# 작업표시줄이 지금 화면에 보이는지 감시한다.
#
# 자동 숨김을 켜면 작업표시줄 창은 사라지지 않고 화면 밖으로 밀려난다. 그래서
# 창 사각형과 그 창이 올라가 있는 모니터 사각형이 세로로 얼마나 겹치는지로 판정한다.
# 숨으면 2px만 남고, 올라오면 높이 전체(48px)가 겹친다.
#
# 작업 영역(workArea)으로는 판정할 수 없다. 자동 숨김이면 작업표시줄이 영역을
# 차지하지 않아 보이든 안 보이든 값이 같다.
#
# **모니터가 여러 대면 작업표시줄도 여러 개다.** 주 모니터는 Shell_TrayWnd,
# 나머지는 Shell_SecondaryTrayWnd 클래스를 쓴다. 하나라도 보이면 보이는 것으로 본다.
#
# 판정은 전부 C# 안에서 한다. PowerShell 함수로 쪼개 두었을 때 겹침 비율이 1.0인데도
# 0을 내보내는 일이 있었다(실측). 값이 오가는 곳을 없애는 편이 확실하다.
#
# 상태가 바뀔 때만 한 줄(1=보임, 0=숨음)을 내보낸다.

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TB {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  /// 숨은 작업표시줄은 2px만 남긴다. 미끄러져 나오는 중까지 보임으로 잡으려면
  /// 넉넉한 문턱이 낫다. 위젯이 늦게 뜨는 편보다 늦게 사라지는 편이 덜 거슬린다.
  const int MIN_VISIBLE_PX = 6;

  /// 마지막 판정 근거. 문제를 추적할 때만 읽는다.
  public static string Detail = "";

  /// 작업표시줄이 하나라도 화면에 올라와 있으면 1.
  public static int Shown() {
    int shown = 0;
    var log = new StringBuilder();

    EnumWindows((h, l) => {
      var sb = new StringBuilder(64);
      GetClassName(h, sb, sb.Capacity);
      var cls = sb.ToString();
      if (cls != "Shell_TrayWnd" && cls != "Shell_SecondaryTrayWnd") return true;
      if (!IsWindowVisible(h)) return true;

      RECT r;
      if (!GetWindowRect(h, out r)) return true;

      var mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return true;  // NEAREST

      // 가로 작업표시줄은 위아래로, 세로 작업표시줄은 좌우로 밀려 숨는다.
      int iy = Math.Min(r.Bottom, mi.rcMonitor.Bottom) - Math.Max(r.Top, mi.rcMonitor.Top);
      int ix = Math.Min(r.Right, mi.rcMonitor.Right) - Math.Max(r.Left, mi.rcMonitor.Left);
      bool one = ix >= MIN_VISIBLE_PX && iy >= MIN_VISIBLE_PX;
      if (one) shown = 1;

      log.Append(cls + " ix=" + ix + " iy=" + iy + " -> " + one + "; ");
      return true;
    }, IntPtr.Zero);

    // 작업표시줄을 못 찾으면 가린다고 보지 않는다. 숨은 채로 남는 편이 더 나쁘다.
    if (log.Length == 0) { Detail = "작업표시줄 없음"; return 1; }

    Detail = log.ToString();
    return shown;
  }
}
"@

# --dump: 지금 판정과 근거만 한 번 내보내고 끝낸다. 감시가 틀릴 때 확인용.
if ($args -contains '--dump') {
  $now = [TB]::Shown()
  [Console]::Out.WriteLine("shown=$now  $([TB]::Detail)")
  exit
}

$last = -1
while ($true) {
  $state = [TB]::Shown()
  if ($state -ne $last) {
    $last = $state
    [Console]::Out.WriteLine($state)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 150
}
