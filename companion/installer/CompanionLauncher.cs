using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Bangumi Analyzer Companion")]
[assembly: AssemblyProduct("Bangumi Analyzer Companion")]
[assembly: AssemblyCompany("Bangumi Analyzer Community")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace BangumiCompanionInstaller {
  static class CompanionLauncher {
    [STAThread]
    static int Main(string[] args) {
      string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
      string electronExe = Path.Combine(baseDir, "host", "node_modules", "electron", "dist", "electron.exe");
      string mainScript = Path.Combine(baseDir, "host", "main.mjs");

      if (!File.Exists(electronExe) || !File.Exists(mainScript)) {
        MessageBox.Show(
          "找不到 Companion 核心组件（electron.exe 或 main.mjs）。\n\n期望路径：\n" + electronExe + "\n\n请重新运行安装包或使用完整便携目录启动。",
          "Bangumi Analyzer Companion",
          MessageBoxButtons.OK,
          MessageBoxIcon.Error
        );
        return 1;
      }

      var psi = new ProcessStartInfo();
      psi.FileName = electronExe;
      psi.WorkingDirectory = Path.Combine(baseDir, "host");
      psi.UseShellExecute = false;
      psi.CreateNoWindow = false;

      if (psi.EnvironmentVariables.ContainsKey("ELECTRON_RUN_AS_NODE")) {
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
      }
      if (psi.EnvironmentVariables.ContainsKey("NODE_OPTIONS")) {
        psi.EnvironmentVariables.Remove("NODE_OPTIONS");
      }

      bool hasExplicitTarget = false;
      if (args != null) {
        foreach (string a in args) {
          if (string.Equals(a, "--companionHome", StringComparison.OrdinalIgnoreCase) ||
              string.Equals(a, "--packageRoot", StringComparison.OrdinalIgnoreCase)) {
            hasExplicitTarget = true;
            break;
          }
        }
      }

      bool isPortable = File.Exists(Path.Combine(baseDir, ".companion-portable")) &&
                        !File.Exists(Path.Combine(baseDir, ".companion-installed"));

      string quotedMain = "\"" + mainScript + "\"";
      if (args != null && args.Length > 0) {
        var extra = new string[args.Length];
        for (int i = 0; i < args.Length; i++) {
          extra[i] = "\"" + args[i].Replace("\"", "\\\"") + "\"";
        }
        psi.Arguments = quotedMain + " " + string.Join(" ", extra);
      } else {
        psi.Arguments = quotedMain;
      }

      if (isPortable && !hasExplicitTarget) {
        string portableHome = Path.Combine(baseDir, "companion-data");
        psi.Arguments += " --companionHome \"" + portableHome + "\"";
      }

      try {
        Process.Start(psi);
        return 0;
      } catch (Exception ex) {
        MessageBox.Show(
          "无法启动 Bangumi Analyzer Companion：\n" + ex.Message,
          "启动失败",
          MessageBoxButtons.OK,
          MessageBoxIcon.Error
        );
        return 1;
      }
    }
  }
}
