using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Uninstall Bangumi Analyzer Companion")]
[assembly: AssemblyProduct("Bangumi Analyzer Companion")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace BangumiCompanionInstaller {
  static class CompanionUninstaller {
    const string UNINSTALL_REG_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\BangumiAnalyzerCompanion";

    [DllImport("shell32.dll")]
    static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);

    [STAThread]
    static int Main(string[] args) {
      bool silent = false;
      bool removeMeta = false;
      foreach (string a in args) {
        if (string.Equals(a, "/S", StringComparison.OrdinalIgnoreCase)) silent = true;
        if (string.Equals(a, "/WIPE_META", StringComparison.OrdinalIgnoreCase)) removeMeta = true;
      }

      string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
      if (silent) {
        return RunUninstall(installDir, removeMeta, true);
      }

      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      using (var form = new UninstallForm(installDir)) {
        Application.Run(form);
        return form.ExitCode;
      }
    }

    internal static int RunUninstall(string installDir, bool removeMeta, bool silent) {
      try {
        // 1. 删除桌面快捷方式与开始菜单入口
        string desktopLnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Bangumi Analyzer Companion.lnk");
        if (File.Exists(desktopLnk)) File.Delete(desktopLnk);

        string startDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Bangumi Analyzer Companion");
        if (Directory.Exists(startDir)) Directory.Delete(startDir, true);
        try { SHChangeNotify(0x08000000, 0x0000, IntPtr.Zero, IntPtr.Zero); } catch { }

        // 2. 删除注册表卸载项
        try {
          Registry.CurrentUser.DeleteSubKeyTree(UNINSTALL_REG_KEY, false);
        } catch { }

        // 3. 可选清理 Companion 元配置（用户独立的 Bangumi 数据目录不受此影响）
        if (removeMeta) {
          string localMeta = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BangumiAnalyzerCompanion");
          if (Directory.Exists(localMeta)) Directory.Delete(localMeta, true);
        }

        // 4. 在退出后异步清理安装目录本身（避免自删锁冲突）
        string cmdArgs = "/c timeout /t 1 /nobreak >nul & rmdir /s /q \"" + installDir + "\"";
        var psi = new ProcessStartInfo("cmd.exe", cmdArgs);
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Path.GetTempPath();
        Process.Start(psi);
        return 0;
      } catch (Exception ex) {
        if (!silent) {
          MessageBox.Show(
            "卸载未能全部完成：\n" + ex.Message + "\n\n如果 Companion 正在运行，请先关闭主窗口后再卸载。",
            "卸载提示",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning
          );
        }
        return 1;
      }
    }

    sealed class UninstallForm : Form {
      public int ExitCode { get; private set; }
      private readonly string _installDir;
      private readonly CheckBox _chkMeta;

      public UninstallForm(string installDir) {
        _installDir = installDir;
        Text = "卸载 Bangumi Analyzer Companion";
        Size = new Size(490, 290);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(18, 21, 38);
        ForeColor = Color.FromArgb(245, 243, 250);
        Font = new Font("Microsoft YaHei UI", 9.5f);
        try {
          var appIco = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
          if (appIco != null) Icon = appIco;
        } catch { }

        var title = new Label {
          Text = "卸载 Bangumi Analyzer Companion",
          Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold),
          ForeColor = Color.FromArgb(244, 114, 182),
          Location = new Point(24, 20),
          AutoSize = true
        };
        var desc = new Label {
          Text = "将从以下位置移除 Companion 程序文件与快捷方式：\n" + _installDir + "\n\n您在独立目录中的 Bangumi 数据库 (data/bangumi.db) 与备份不会被删除。",
          Location = new Point(24, 56),
          Size = new Size(430, 74),
          ForeColor = Color.FromArgb(209, 213, 219)
        };
        _chkMeta = new CheckBox {
          Text = "同时清理 Companion 窗口/配置缓存（%LOCALAPPDATA%\\BangumiAnalyzerCompanion）",
          Location = new Point(24, 144),
          Size = new Size(430, 24),
          ForeColor = Color.FromArgb(209, 213, 219),
          Checked = false
        };

        var btnCancel = new Button {
          Text = "取消",
          Location = new Point(268, 198),
          Size = new Size(86, 34),
          FlatStyle = FlatStyle.Flat,
          BackColor = Color.FromArgb(38, 43, 68),
          ForeColor = Color.White
        };
        btnCancel.Click += (s, e) => { ExitCode = 1; Close(); };

        var btnUninstall = new Button {
          Text = "确认卸载",
          Location = new Point(364, 198),
          Size = new Size(92, 34),
          FlatStyle = FlatStyle.Flat,
          BackColor = Color.FromArgb(219, 39, 119),
          ForeColor = Color.White
        };
        btnUninstall.Click += (s, e) => {
          btnUninstall.Enabled = false;
          ExitCode = RunUninstall(_installDir, _chkMeta.Checked, false);
          if (ExitCode == 0) {
            MessageBox.Show("已完成卸载！您的 Bangumi 数据目录已完整保留。", "Bangumi Analyzer Companion", MessageBoxButtons.OK, MessageBoxIcon.Information);
          }
          Close();
        };

        Controls.AddRange(new Control[] { title, desc, _chkMeta, btnCancel, btnUninstall });
      }
    }
  }
}
