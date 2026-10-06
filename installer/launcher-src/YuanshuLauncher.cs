// 元枢桌面启动器（安装版快捷方式的目标）。
// 取代 wscript.exe + open.vbs：不依赖 Windows 脚本宿主（VBScript 正在被微软逐步下线，
// 杀软/组策略也常拦 wscript），快捷方式「打开文件所在位置」落在安装目录而不是 System32。
// 做的事：用包内 node 跑 launcher\open.cjs；服务起来前显示一个「正在启动」小窗，失败给出明确提示。
// 构建：installer/build.mjs 的 launcher 步骤用 .NET Framework 自带的 csc.exe 编译，不进 git。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class YuanshuLauncher
{
    [STAThread]
    static int Main(string[] argv)
    {
        string here = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string root = Path.GetDirectoryName(here);
        string node = Path.Combine(root, @"runtime\node\node.exe");
        string script = Path.Combine(here, "open.cjs");
        bool quiet = argv.Length > 0;
        if (!File.Exists(node) || !File.Exists(script))
        {
            if (!quiet) Fail("安装不完整：找不到 " + (File.Exists(node) ? script : node) + "\n\n请重新运行安装包修复。");
            return 3;
        }

        var psi = new ProcessStartInfo(node, Quote(script) + (quiet ? " " + string.Join(" ", argv) : ""))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = root,
        };
        Process p;
        try { p = Process.Start(psi); }
        catch (Exception e)
        {
            if (!quiet) Fail("无法运行包内 Node：" + e.Message + "\n\n可能被安全软件拦截，请把安装目录加入信任后再试。");
            return 4;
        }
        if (quiet) { p.WaitForExit(); return p.ExitCode; }

        // 服务已在运行时 open.cjs 一两秒就退出，不必弹窗；超过 1.2 秒才显示「正在启动」
        if (p.WaitForExit(1200)) return Report(p.ExitCode, root);
        Application.EnableVisualStyles();
        using (var splash = Splash())
        {
            var t = new Thread(() => { p.WaitForExit(); try { splash.BeginInvoke((Action)splash.Close); } catch { } }) { IsBackground = true };
            splash.Shown += (s, e) => t.Start();
            Application.Run(splash);
        }
        p.WaitForExit();
        return Report(p.ExitCode, root);
    }

    static int Report(int code, string root)
    {
        if (code != 0)
            Fail("元枢服务没有启动成功。\n\n第一次启动要初始化工作区，可以等半分钟再点一次；\n仍然不行请查看日志：\n" + Path.Combine(root, @"app\watchdog.log"));
        return code;
    }

    static Form Splash()
    {
        var f = new Form
        {
            Text = "元枢",
            FormBorderStyle = FormBorderStyle.FixedDialog,
            ControlBox = false,
            StartPosition = FormStartPosition.CenterScreen,
            ClientSize = new Size(320, 96),
            ShowInTaskbar = true,
            TopMost = true,
        };
        try { f.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var label = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Microsoft YaHei UI", 10f),
            Text = "元枢正在启动…\n首次启动约需半分钟，完成后会自动打开浏览器",
        };
        f.Controls.Add(label);
        return f;
    }

    static void Fail(string msg)
    {
        MessageBox.Show(msg, "元枢", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    static string Quote(string s) { return "\"" + s + "\""; }
}
