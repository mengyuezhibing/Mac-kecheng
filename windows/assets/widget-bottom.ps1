param([string]$Handle)

# 把指定窗口压到 Z 序最底部（HWND_BOTTOM），使桌面小组件不再遮挡其它应用窗口。
# 由 windows/main-win.js 的 sendWidgetToBottom() 调用，参数为窗口句柄（十进制）。

$ErrorActionPreference = 'SilentlyContinue'

$signature = @"
using System;
using System.Runtime.InteropServices;
public class CourseWidgetWinApi {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

try {
    Add-Type -TypeDefinition $signature -Language CSharp | Out-Null

    $hwnd = [IntPtr]::new([Convert]::ToInt64($Handle))
    if ($hwnd -eq [IntPtr]::Zero) { exit 1 }

    # HWND_BOTTOM = 1
    # SWP_NOSIZE(0x0001) | SWP_NOMOVE(0x0002) | SWP_NOACTIVATE(0x0010) = 0x0013
    # 注意：这里不能用 SWP_NOZORDER(0x0004)，否则 Z 序不会改变。
    [void][CourseWidgetWinApi]::SetWindowPos($hwnd, [IntPtr]1, 0, 0, 0, 0, 0x0013)
    exit 0
} catch {
    exit 1
}
