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
# **창을 EnumWindows로 찾으면 안 된다.** 시작 메뉴가 열려 있는 동안 주 작업표시줄
# (Shell_TrayWnd)은 EnumWindows 목록에서 통째로 빠진다(실측: 열려 있는 4초 내내
# 한 번도 나오지 않음). 같은 순간 FindWindow로는 같은 핸들이 그대로 잡히고,
# 최상위 창이며 보이고, 사각형은 완전히 올라온 상태(top=1032, 겹침 48px)였다.
# 그래서 Win키로 시작 메뉴를 열면 작업표시줄은 올라오는데 위젯은 안 떴다.
# 창은 FindWindow/FindWindowEx로 찾는다.
#
# 판정은 전부 C# 안에서 한다. PowerShell 함수로 쪼개 두었을 때 겹침 비율이 1.0인데도
# 0을 내보내는 일이 있었다(실측). 값이 오가는 곳을 없애는 편이 확실하다.
#
# 상태가 바뀔 때만 한 줄(1=보임, 0=숨음)을 내보낸다.

$ErrorActionPreference = 'Stop'

# **이 프로세스를 DPI 인식으로 만든다.** 그러지 않으면 Windows가 창 좌표를 배율로
# 나눠서 돌려준다. 125% 화면에서 작업표시줄 위쪽이 1380인데 1104로 보이고, 받는 쪽은
# 그 값을 다시 배율로 나눠 DIP로 바꾸므로 두 번 나뉜다. 실측: 작업표시줄 위가 1104인데
# 위젯이 840으로 올라가, 264px이나 떠 있었다.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DPI {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void Aware() {
    // -4 = PER_MONITOR_AWARE_V2. 없는 Windows에서는 예전 방식으로 떨어진다.
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
"@
[DPI]::Aware()

Add-Type @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class TB {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  /// 숨은 작업표시줄은 2px만 남긴다. 미끄러져 나오는 중까지 보임으로 잡으려면
  /// 넉넉한 문턱이 낫다. 위젯이 늦게 뜨는 편보다 늦게 사라지는 편이 덜 거슬린다.
  const int MIN_VISIBLE_PX = 6;

  /// 마지막 판정 근거. 문제를 추적할 때만 읽는다.
  public static string Detail = "";

  /// 올라와 있는 작업표시줄의 사각형들. "l,t,r,b l,t,r,b" 꼴, 화면 픽셀 기준.
  /// 위젯이 그 아래 깔리지 않게 비켜 줄 때 쓴다.
  public static string Rects = "";

  /// 화면에 있는 작업표시줄 창 전부. 주 모니터 하나 + 보조 모니터 수만큼.
  static List<KeyValuePair<string, IntPtr>> Bars() {
    var bars = new List<KeyValuePair<string, IntPtr>>();
    var primary = FindWindow("Shell_TrayWnd", null);
    if (primary != IntPtr.Zero) bars.Add(new KeyValuePair<string, IntPtr>("Shell_TrayWnd", primary));
    var prev = IntPtr.Zero;
    while (true) {
      prev = FindWindowEx(IntPtr.Zero, prev, "Shell_SecondaryTrayWnd", null);
      if (prev == IntPtr.Zero) break;
      bars.Add(new KeyValuePair<string, IntPtr>("Shell_SecondaryTrayWnd", prev));
    }
    return bars;
  }

  /// 작업표시줄이 하나라도 화면에 올라와 있으면 1.
  public static int Shown() {
    int shown = 0;
    var log = new StringBuilder();
    var rects = new StringBuilder();
    var bars = Bars();
    Rects = "";

    // 작업표시줄을 못 찾으면 가린다고 보지 않는다. 숨은 채로 남는 편이 더 나쁘다.
    if (bars.Count == 0) { Detail = "작업표시줄 없음"; return 1; }

    foreach (var bar in bars) {
      var cls = bar.Key;
      var h = bar.Value;
      if (!IsWindowVisible(h)) { log.Append(cls + " 숨은 창; "); continue; }

      RECT r;
      if (!GetWindowRect(h, out r)) { log.Append(cls + " 사각형 실패; "); continue; }

      var mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) { log.Append(cls + " 모니터 실패; "); continue; }  // NEAREST

      // 가로 작업표시줄은 위아래로, 세로 작업표시줄은 좌우로 밀려 숨는다.
      int iy = Math.Min(r.Bottom, mi.rcMonitor.Bottom) - Math.Max(r.Top, mi.rcMonitor.Top);
      int ix = Math.Min(r.Right, mi.rcMonitor.Right) - Math.Max(r.Left, mi.rcMonitor.Left);
      bool one = ix >= MIN_VISIBLE_PX && iy >= MIN_VISIBLE_PX;
      if (one) {
        shown = 1;
        if (rects.Length > 0) rects.Append(" ");
        rects.Append(r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom);
      }

      log.Append(cls + " ix=" + ix + " iy=" + iy + " -> " + one + "; ");
    }

    Detail = log.ToString();
    Rects = rects.ToString();
    return shown;
  }
}
"@

# --dump: 지금 판정과 근거만 한 번 내보내고 끝낸다. 감시가 틀릴 때 확인용.
if ($args -contains '--dump') {
  $now = [TB]::Shown()
  [Console]::Out.WriteLine("shown=$now  $([TB]::Detail)")
  [Console]::Out.WriteLine("rects=$([TB]::Rects)")
  exit
}

# 보임이면 올라와 있는 작업표시줄 사각형도 함께 보낸다: "1 l,t,r,b l,t,r,b".
# 숨음이면 "0" 한 글자. 사각형이 달라져도 다시 보낸다. 작업표시줄이 어디까지
# 차지하는지 알아야 위젯이 그 아래로 깔리지 않게 비켜설 수 있다.
$last = ""
while ($true) {
  $state = [TB]::Shown()
  $line = if ($state -eq 1) { "1 $([TB]::Rects)".Trim() } else { "0" }
  if ($line -ne $last) {
    $last = $line
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 150
}
