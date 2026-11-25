using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Bangumi Analyzer Companion Setup")]
[assembly: AssemblyDescription("Bangumi Analyzer Companion Windows Installer (with Analyzer 2.0.0 r5)")]
[assembly: AssemblyProduct("Bangumi Analyzer Companion Installer")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace BangumiCompanionInstaller {
  static class CompanionSetup {
    const string UNINSTALL_REG_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\BangumiAnalyzerCompanion";
    const string RESOURCE_NAME = "companion-payload.zip";

    [DllImport("shell32.dll")]
    static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);

    [STAThread]
    static int Main(string[] args) {
      bool silent = false;
      bool noLaunch = false;
      bool noShortcuts = false;
      string customDir = null;

      foreach (string a in args) {
        if (string.Equals(a, "/S", StringComparison.OrdinalIgnoreCase)) silent = true;
        else if (string.Equals(a, "/NOLAUNCH", StringComparison.OrdinalIgnoreCase)) noLaunch = true;
        else if (string.Equals(a, "/NOSHORTCUT", StringComparison.OrdinalIgnoreCase)) noShortcuts = true;
        else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) customDir = a.Substring(3).Trim().Trim('"');
      }

      string defaultDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs",
        "Bangumi Analyzer Companion"
      );
      string targetDir = string.IsNullOrEmpty(customDir) ? defaultDir : customDir;

      if (silent) {
        string err = ValidateInstallPath(targetDir);
        if (err != null) {
          Console.Error.WriteLine("INVALID_INSTALL_PATH: " + err);
          return 2;
        }
        try {
          InstallPayload(targetDir, !noShortcuts, !noShortcuts, !noLaunch, null);
          return 0;
        } catch (Exception ex) {
          Console.Error.WriteLine("INSTALL_FAILED: " + ex.Message);
          return 1;
        }
      }

      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      using (var form = new SetupForm(targetDir)) {
        Application.Run(form);
        return form.ExitCode;
      }
    }

    internal static string ValidateInstallPath(string rawPath) {
      if (string.IsNullOrWhiteSpace(rawPath)) return "请选择安装文件夹。";
      string p = rawPath.Trim();
      if (p.StartsWith(@"\\")) return "不支持网络共享路径（\\server），请选择本地磁盘。";
      if (!Path.IsPathRooted(p) || !Regex.IsMatch(p, @"^[A-Za-z]:\\")) return "请输入完整的本地路径，例如 C:\\BangumiCompanion。";

      string full;
      try {
        full = Path.GetFullPath(p);
      } catch {
        return "路径格式不合法。";
      }

      string lower = full.ToLowerInvariant();
      if (Regex.IsMatch(lower, @"\\windows(\\|$)", RegexOptions.IgnoreCase)) {
        return "不能安装到 Windows 系统目录。";
      }
      if (Regex.IsMatch(lower, @"\\program files( \(x86\))?(\\|$)", RegexOptions.IgnoreCase)) {
        return "Program Files 需要管理员权限且受保护，建议安装到用户目录（无需管理员权限）。";
      }
      if (Regex.IsMatch(lower, @"(onedrive|dropbox|百度网盘|坚果云|icloud|google drive)", RegexOptions.IgnoreCase)) {
        return "请勿安装到云盘同步目录，避免文件锁冲突。";
      }
      return null;
    }

    internal static void CreateShortcut(string shortcutPath, string targetExe, string workingDir, string description) {
      Type shellType = Type.GetTypeFromProgID("WScript.Shell");
      if (shellType == null) return;
      object shell = Activator.CreateInstance(shellType);
      try {
        object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
        Type lnkType = lnk.GetType();
        lnkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { targetExe });
        lnkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workingDir });
        lnkType.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { description });
        lnkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { targetExe + ",0" });
        lnkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
      } finally {
        System.Runtime.InteropServices.Marshal.ReleaseComObject(shell);
      }
    }

    internal static void InstallPayload(
      string installDir,
      bool createDesktopShortcut,
      bool createStartMenu,
      bool launchAfter,
      Action<int, string> onProgress
    ) {
      string normalizedRoot = Path.GetFullPath(installDir);
      Directory.CreateDirectory(normalizedRoot);

      Assembly asm = Assembly.GetExecutingAssembly();
      using (Stream stream = asm.GetManifestResourceStream(RESOURCE_NAME)) {
        if (stream == null) throw new InvalidOperationException("安装包内嵌载荷缺失。");
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read)) {
          int total = Math.Max(1, archive.Entries.Count);
          int done = 0;
          string rootWithSep = normalizedRoot.EndsWith(Path.DirectorySeparatorChar.ToString())
            ? normalizedRoot
            : normalizedRoot + Path.DirectorySeparatorChar;

          foreach (ZipArchiveEntry entry in archive.Entries) {
            if (string.Equals(entry.FullName.TrimStart('/', '\\'), ".companion-portable", StringComparison.OrdinalIgnoreCase)) {
              done++;
              continue;
            }
            string destPath = Path.GetFullPath(Path.Combine(normalizedRoot, entry.FullName));
            if (!destPath.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(destPath, normalizedRoot, StringComparison.OrdinalIgnoreCase)) {
              throw new InvalidOperationException("发现不安全的压缩包路径条目：" + entry.FullName);
            }

            if (string.IsNullOrEmpty(entry.Name)) {
              Directory.CreateDirectory(destPath);
            } else {
              Directory.CreateDirectory(Path.GetDirectoryName(destPath));
              entry.ExtractToFile(destPath, true);
            }
            done++;
            if (onProgress != null && (done % 12 == 0 || done == total)) {
              int pct = Math.Min(92, (int)Math.Round(done * 90.0 / total));
              onProgress(pct, "正在解包安装组件 (" + done + " / " + total + ")…");
            }
          }
        }
      }

      string launcherExe = Path.Combine(normalizedRoot, "Bangumi-Analyzer-Companion.exe");
      string uninstallExe = Path.Combine(normalizedRoot, "Uninstall-Companion.exe");
      try {
        string portableMarker = Path.Combine(normalizedRoot, ".companion-portable");
        if (File.Exists(portableMarker)) File.Delete(portableMarker);
        File.WriteAllText(Path.Combine(normalizedRoot, ".companion-installed"), "installed-2.0.0\n");
      } catch { }

      if (createDesktopShortcut) {
        if (onProgress != null) onProgress(95, "正在创建桌面快捷方式…");
        string desk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Bangumi Analyzer Companion.lnk");
        CreateShortcut(desk, launcherExe, normalizedRoot, "Bangumi Analyzer Companion · 小番桌面助手");
      }

      if (createStartMenu) {
        if (onProgress != null) onProgress(97, "正在注册开始菜单入口…");
        string smDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Bangumi Analyzer Companion");
        Directory.CreateDirectory(smDir);
        CreateShortcut(Path.Combine(smDir, "Bangumi Analyzer Companion.lnk"), launcherExe, normalizedRoot, "Bangumi Analyzer Companion");
        if (File.Exists(uninstallExe)) {
          CreateShortcut(Path.Combine(smDir, "卸载 Bangumi Analyzer Companion.lnk"), uninstallExe, normalizedRoot, "卸载 Bangumi Analyzer Companion");
        }
      }

      if (createDesktopShortcut || createStartMenu) {
        try { SHChangeNotify(0x08000000, 0x0000, IntPtr.Zero, IntPtr.Zero); } catch { }
        if (onProgress != null) onProgress(99, "正在写入当前用户卸载注册信息…");
        try {
          using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UNINSTALL_REG_KEY)) {
            if (key != null) {
              key.SetValue("DisplayName", "Bangumi Analyzer Companion");
              key.SetValue("DisplayVersion", "2.0.0");
              key.SetValue("Publisher", "Bangumi Analyzer Community");
              key.SetValue("InstallLocation", normalizedRoot);
              key.SetValue("DisplayIcon", launcherExe);
              key.SetValue("UninstallString", "\"" + uninstallExe + "\"");
              key.SetValue("NoModify", 1, RegistryValueKind.DWord);
              key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
          }
        } catch { }
      }

      if (onProgress != null) onProgress(100, "安装完成！即将就绪。");

      if (launchAfter && File.Exists(launcherExe)) {
        var psi = new ProcessStartInfo(launcherExe);
        psi.WorkingDirectory = normalizedRoot;
        psi.UseShellExecute = false;
        if (psi.EnvironmentVariables.ContainsKey("ELECTRON_RUN_AS_NODE")) {
          psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        }
        Process.Start(psi);
      }
    }

    sealed class SetupForm : Form {
      public int ExitCode { get; private set; }
      private readonly TextBox _txtDir;
      private readonly Label _lblPathState;
      private readonly CheckBox _chkDesk;
      private readonly CheckBox _chkStart;
      private readonly CheckBox _chkLaunch;
      private readonly ProgressBar _progress;
      private readonly Label _lblStatus;
      private readonly Button _btnInstall;
      private readonly Button _btnBrowse;
      private readonly Button _btnCancel;

      public SetupForm(string initialDir) {
        ExitCode = 1;
        Text = "Bangumi Analyzer Companion 安装向导 v2.0.0";
        Size = new Size(580, 440);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(14, 17, 32);
        ForeColor = Color.FromArgb(245, 243, 250);
        Font = new Font("Microsoft YaHei UI", 9.5f);
        try {
          var appIco = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
          if (appIco != null) Icon = appIco;
        } catch { }

        var hero = new Panel {
          Dock = DockStyle.Top,
          Height = 92,
          BackColor = Color.FromArgb(24, 28, 49)
        };
        var hTitle = new Label {
          Text = "Bangumi Analyzer Companion",
          Font = new Font("Microsoft YaHei UI", 16f, FontStyle.Bold),
          ForeColor = Color.FromArgb(249, 168, 212),
          Location = new Point(24, 16),
          AutoSize = true
        };
        var hSub = new Label {
          Text = "二次元本地番剧档案桌面伴侣 · 内置 Analyzer 2.0.0 (r5) · 无需管理员权限",
          ForeColor = Color.FromArgb(182, 188, 210),
          Location = new Point(26, 52),
          AutoSize = true
        };
        hero.Controls.AddRange(new Control[] { hTitle, hSub });

        var lblDir = new Label {
          Text = "安装位置（建议保留默认用户目录）：",
          Location = new Point(26, 112),
          AutoSize = true,
          ForeColor = Color.FromArgb(228, 230, 242)
        };

        _txtDir = new TextBox {
          Text = initialDir,
          Location = new Point(26, 138),
          Size = new Size(428, 28),
          BackColor = Color.FromArgb(26, 30, 52),
          ForeColor = Color.White,
          BorderStyle = BorderStyle.FixedSingle
        };

        _btnBrowse = new Button {
          Text = "浏览…",
          Location = new Point(464, 136),
          Size = new Size(80, 30),
          FlatStyle = FlatStyle.Flat,
          BackColor = Color.FromArgb(39, 44, 74),
          ForeColor = Color.White
        };

        _lblPathState = new Label {
          Location = new Point(26, 172),
          Size = new Size(518, 22),
          ForeColor = Color.FromArgb(74, 222, 128),
          Text = "安装路径安全可用"
        };

        _chkDesk = new CheckBox {
          Text = "创建桌面快捷方式（Bangumi Analyzer Companion）",
          Location = new Point(26, 206),
          Size = new Size(500, 24),
          Checked = true
        };
        _chkStart = new CheckBox {
          Text = "添加到开始菜单并注册 Windows 卸载入口",
          Location = new Point(26, 234),
          Size = new Size(500, 24),
          Checked = true
        };
        _chkLaunch = new CheckBox {
          Text = "安装完成后立即启动 Companion（开始首次向导或日常使用）",
          Location = new Point(26, 262),
          Size = new Size(500, 24),
          Checked = true
        };

        _progress = new ProgressBar {
          Location = new Point(26, 304),
          Size = new Size(518, 18),
          Minimum = 0,
          Maximum = 100
        };
        _lblStatus = new Label {
          Location = new Point(26, 326),
          Size = new Size(518, 22),
          ForeColor = Color.FromArgb(182, 188, 210),
          Text = "准备就绪。全部用户数据将保持在独立本地目录中。"
        };

        _btnCancel = new Button {
          Text = "取消",
          Location = new Point(352, 358),
          Size = new Size(88, 34),
          FlatStyle = FlatStyle.Flat,
          BackColor = Color.FromArgb(39, 44, 74),
          ForeColor = Color.White
        };
        _btnInstall = new Button {
          Text = "立即安装",
          Location = new Point(450, 358),
          Size = new Size(94, 34),
          FlatStyle = FlatStyle.Flat,
          BackColor = Color.FromArgb(236, 72, 153),
          ForeColor = Color.White,
          Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold)
        };

        _txtDir.TextChanged += (s, e) => RefreshPathCheck();
        _btnBrowse.Click += (s, e) => {
          using (var dlg = new FolderBrowserDialog()) {
            dlg.Description = "选择 Bangumi Analyzer Companion 安装文件夹";
            dlg.SelectedPath = _txtDir.Text;
            if (dlg.ShowDialog() == DialogResult.OK) _txtDir.Text = dlg.SelectedPath;
          }
        };
        _btnCancel.Click += (s, e) => Close();
        _btnInstall.Click += async (s, e) => await StartInstallAsync();

        Controls.AddRange(new Control[] {
          hero, lblDir, _txtDir, _btnBrowse, _lblPathState,
          _chkDesk, _chkStart, _chkLaunch, _progress, _lblStatus,
          _btnCancel, _btnInstall
        });
        RefreshPathCheck();
      }

      private void RefreshPathCheck() {
        string err = ValidateInstallPath(_txtDir.Text);
        if (err != null) {
          _lblPathState.Text = "× " + err;
          _lblPathState.ForeColor = Color.FromArgb(248, 113, 113);
          _btnInstall.Enabled = false;
        } else {
          _lblPathState.Text = "✓ 路径可用（无需管理员权限）";
          _lblPathState.ForeColor = Color.FromArgb(74, 222, 128);
          _btnInstall.Enabled = true;
        }
      }

      private async Task StartInstallAsync() {
        _btnInstall.Enabled = false;
        _btnBrowse.Enabled = false;
        _btnCancel.Enabled = false;
        _txtDir.Enabled = false;

        string targetDir = _txtDir.Text.Trim();
        bool desk = _chkDesk.Checked;
        bool sm = _chkStart.Checked;
        bool launch = _chkLaunch.Checked;

        try {
          await Task.Run(() => InstallPayload(targetDir, desk, sm, launch, (pct, msg) => {
            if (!IsDisposed && InvokeRequired) {
              BeginInvoke(new Action(() => {
                _progress.Value = Math.Max(0, Math.Min(100, pct));
                _lblStatus.Text = msg;
              }));
            }
          }));
          ExitCode = 0;
          if (!launch) {
            MessageBox.Show("Bangumi Analyzer Companion 已安装到：\n" + targetDir, "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
          }
          Close();
        } catch (Exception ex) {
          ExitCode = 1;
          MessageBox.Show("安装过程中发生错误：\n" + ex.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
          _btnInstall.Enabled = true;
          _btnBrowse.Enabled = true;
          _btnCancel.Enabled = true;
          _txtDir.Enabled = true;
        }
      }
    }
  }
}
