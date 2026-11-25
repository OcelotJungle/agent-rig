using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Read-only: attaches to the console of a process and returns the visible text of its screen buffer, one line per
// non-empty screen row. It writes nothing to the console. Run by console-text.ps1 in its own hidden powershell, because
// AttachConsole needs a process that holds no console of its own.
public static class Con {
  const uint GENERIC_READ_WRITE = 0xC0000000;
  const uint SHARE_READ_WRITE = 3;
  const uint OPEN_EXISTING = 3;
  static readonly IntPtr InvalidHandle = new IntPtr(-1);

  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct INFO { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Window; public COORD Max; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out INFO info);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr h, [Out] char[] buf, uint len, COORD at, out uint read);

  // Throws Win32Exception when the console cannot be attached or read.
  public static string Read(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr h = InvalidHandle;
    try {
      h = CreateFileW("CONOUT$", GENERIC_READ_WRITE, SHARE_READ_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
      if (h == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error());
      INFO info;
      if (!GetConsoleScreenBufferInfo(h, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var text = new StringBuilder();
      for (short y = info.Window.Top; y <= info.Window.Bottom; y++) {
        var line = new char[info.Size.X];
        uint read;
        var at = new COORD(); at.X = 0; at.Y = y;
        if (!ReadConsoleOutputCharacterW(h, line, (uint)line.Length, at, out read)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var row = new string(line, 0, (int)Math.Min(read, (uint)line.Length)).TrimEnd();
        if (row.Length > 0) text.Append(row).Append('\n');
      }
      return text.ToString();
    } finally {
      if (h != InvalidHandle) CloseHandle(h);
      FreeConsole();
    }
  }
}
