// 元枢服务宿主（Windows Service，2026-10-22）
//
// 为什么自己写：NSSM / WinSW 都要随包分发第三方二进制；这里用 .NET Framework 自带的
// csc.exe 编译一个 ~200 行的 ServiceBase，行为可控、可读、无外部依赖。
//
// 职责：把 `launcher\service.cjs`（元枢守护）当子进程跑起来，子进程退出就重启；
// 服务停止时优雅结束整棵子进程树。真正的健康检查仍在 watchdog 里，这里只管"活着"。
//
// 用法：
//   YuanshuServiceHost.exe              以服务方式运行（由 SCM 启动）
//   YuanshuServiceHost.exe --console    前台运行，便于验证（Ctrl+C 退出）
//   YuanshuServiceHost.exe --install    未使用（安装交给 install-service.ps1，需要管理员）
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;

static class YuanshuServiceHost
{
    const string ServiceName = "YuanShuService";

    static int Main(string[] argv)
    {
        bool console = argv.Length > 0 && (argv[0] == "--console" || argv[0] == "-c");
        if (console)
        {
            var host = new Host();
            host.StartAll();
            Console.WriteLine("元枢服务宿主（前台模式）。按 Ctrl+C 退出。");
            var quit = new ManualResetEvent(false);
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; quit.Set(); };
            quit.WaitOne();
            host.StopAll();
            return 0;
        }
        ServiceBase.Run(new ServiceImpl());
        return 0;
    }

    class ServiceImpl : ServiceBase
    {
        readonly Host host = new Host();
        public ServiceImpl() { ServiceName = YuanshuServiceHost.ServiceName; CanShutdown = true; }
        protected override void OnStart(string[] args) { host.StartAll(); }
        protected override void OnStop() { host.StopAll(); }
        protected override void OnShutdown() { host.StopAll(); base.OnShutdown(); }
    }

    class Host
    {
        readonly object gate = new object();
        Process child;
        volatile bool stopping;
        string root, node, script, logFile;

        public Host()
        {
            // exe 在 <root>\launcher\ 下
            string here = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            root = Path.GetDirectoryName(here);
            node = Path.Combine(root, @"runtime\node\node.exe");
            script = Path.Combine(root, @"launcher\service.cjs");
            logFile = Path.Combine(root, "service.log");
        }

        void Log(string msg)
        {
            try
            {
                var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg + Environment.NewLine;
                File.AppendAllText(logFile, line, Encoding.UTF8);
            }
            catch { }
        }

        public void StartAll()
        {
            stopping = false;
            Log("service starting: " + script);
            Launch();
        }

        public void StopAll()
        {
            stopping = true;
            lock (gate)
            {
                if (child != null && !child.HasExited)
                {
                    Log("service stopping, killing pid " + child.Id);
                    try { child.Kill(); } catch { }
                    try { child.WaitForExit(10000); } catch { }
                }
            }
            Log("service stopped");
        }

        void Launch()
        {
            if (!File.Exists(node) || !File.Exists(script))
            {
                Log("missing node or service.cjs: " + node + " / " + script);
                return;
            }
            var psi = new ProcessStartInfo(node, "\"" + script + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // 子进程输出是 UTF-8；不声明的话 .NET 按控制台代码页(936)解码，中文日志会乱码
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
            };
            // 工作区与 agent 目录：服务账户（可能是 SYSTEM）默认拿不到用户目录，这里显式传下去
            var cwd = Environment.GetEnvironmentVariable("YUANSHU_CWD", EnvironmentVariableTarget.Machine)
                      ?? Environment.GetEnvironmentVariable("YUANSHU_CWD");
            if (!string.IsNullOrEmpty(cwd)) psi.EnvironmentVariables["YUANSHU_CWD"] = cwd;
            var agent = Environment.GetEnvironmentVariable("YUANSHU_AGENT_DIR", EnvironmentVariableTarget.Machine)
                        ?? Environment.GetEnvironmentVariable("YUANSHU_AGENT_DIR");
            if (!string.IsNullOrEmpty(agent)) psi.EnvironmentVariables["YUANSHU_AGENT_DIR"] = agent;
            // 2026-10-23：限制老生代堆，避免内存吃紧时的大 GC 造成 100+ 秒停顿。
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("NODE_OPTIONS")))
                psi.EnvironmentVariables["NODE_OPTIONS"] = "--max-old-space-size=1536";

            try
            {
                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (s, e) => { if (e.Data != null) Log("[out] " + e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) Log("[err] " + e.Data); };
                p.Exited += (s, e) =>
                {
                    Log("child exited code=" + SafeExitCode(p));
                    if (stopping) return;
                    Thread.Sleep(3000);
                    if (!stopping) { Log("restarting child"); Launch(); }
                };
                lock (gate) { child = p; }
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                Log("child started pid " + p.Id);
            }
            catch (Exception ex)
            {
                Log("launch failed: " + ex.Message);
            }
        }

        static string SafeExitCode(Process p) { try { return p.ExitCode.ToString(); } catch { return "?"; } }
    }
}
