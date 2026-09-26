using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// One-click Agent HQ: starts the hub and the office UI if they are not
// already listening, then opens the desktop window. Safe to click twice —
// anything already running is reused, never duplicated.
static class AgentHqLauncher
{
    const string Repo = @"D:\PersonalWork\MobileAIConnector";
    const int HubPort = 4517;
    const int UiPort = 5173;

    static readonly string AppExe =
        Path.Combine(Repo, @"packages\desktop\src-tauri\target\debug\agent-hq-desktop.exe");

    static Form splash;
    static Label status;

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    const int SW_RESTORE = 9;

    [STAThread]
    static void Main()
    {
        if (!Directory.Exists(Repo))
        {
            MessageBox.Show("Agent HQ is not at:\n" + Repo, "Agent HQ",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        Application.EnableVisualStyles();
        splash = BuildSplash();
        var worker = new Thread(Startup);
        worker.IsBackground = true;
        worker.Start();
        Application.Run(splash);
    }

    static void Startup()
    {
        try
        {
            bool hubWasUp = PortUp(HubPort);
            bool uiWasUp = PortUp(UiPort);

            if (!hubWasUp) { Say("starting the hub..."); Spawn("npm run hub"); }
            if (!uiWasUp) { Say("starting the office UI..."); Spawn("npm run desktop"); }

            if (!hubWasUp || !uiWasUp)
            {
                Say("waiting for services...");
                WaitFor(HubPort, 120);
                WaitFor(UiPort, 120);
            }

            // Already open? Bring that window forward instead of opening a
            // second one (it may be parked in the tray).
            var running = Process.GetProcessesByName("agent-hq-desktop").FirstOrDefault();
            if (running != null)
            {
                Say("Agent HQ is already open");
                if (running.MainWindowHandle != IntPtr.Zero)
                {
                    ShowWindow(running.MainWindowHandle, SW_RESTORE);
                    SetForegroundWindow(running.MainWindowHandle);
                }
                Thread.Sleep(900);
                return;
            }

            Say("opening Agent HQ...");
            if (File.Exists(AppExe))
            {
                Process.Start(AppExe);
            }
            else
            {
                var browser = new ProcessStartInfo("http://localhost:" + UiPort);
                browser.UseShellExecute = true;
                Process.Start(browser);
            }
            // Let the window paint before the splash disappears.
            Thread.Sleep(2500);
        }
        catch (Exception error)
        {
            MessageBox.Show("Could not start Agent HQ:\n\n" + error.Message,
                "Agent HQ", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            Close();
        }
    }

    static bool PortUp(int port)
    {
        try
        {
            return IPGlobalProperties.GetIPGlobalProperties()
                .GetActiveTcpListeners().Any(endpoint => endpoint.Port == port);
        }
        catch { return false; }
    }

    // Detached: the services keep running after this launcher exits.
    static void Spawn(string command)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c " + command);
        psi.WorkingDirectory = Repo;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process.Start(psi);
    }

    static void WaitFor(int port, int seconds)
    {
        for (int tick = 0; tick < seconds * 2; tick++)
        {
            if (PortUp(port)) return;
            Thread.Sleep(500);
        }
        throw new Exception("The service on port " + port + " did not come up in time.\n" +
            "Try running \"npm run hub\" in " + Repo + " to see the error.");
    }

    static void Say(string text)
    {
        if (splash == null || !splash.IsHandleCreated) return;
        try { splash.BeginInvoke((MethodInvoker)delegate { status.Text = text; }); } catch { }
    }

    static void Close()
    {
        if (splash == null || !splash.IsHandleCreated) { Application.Exit(); return; }
        try { splash.BeginInvoke((MethodInvoker)delegate { splash.Close(); }); } catch { }
    }

    static Form BuildSplash()
    {
        var form = new Form();
        form.FormBorderStyle = FormBorderStyle.None;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.Size = new Size(360, 104);
        form.BackColor = ColorTranslator.FromHtml("#0B0F16");
        form.TopMost = true;
        form.ShowInTaskbar = false;

        var title = new Label();
        title.Text = "AGENT HQ";
        title.ForeColor = ColorTranslator.FromHtml("#4FD8C4");
        title.Font = new Font("Consolas", 15F, FontStyle.Bold);
        title.TextAlign = ContentAlignment.MiddleCenter;
        title.Dock = DockStyle.Top;
        title.Height = 50;

        status = new Label();
        status.Text = "checking services...";
        status.ForeColor = ColorTranslator.FromHtml("#8B95A7");
        status.Font = new Font("Consolas", 9F);
        status.TextAlign = ContentAlignment.TopCenter;
        status.Dock = DockStyle.Fill;

        form.Controls.Add(status);
        form.Controls.Add(title);
        form.Paint += delegate(object sender, PaintEventArgs e)
        {
            using (var pen = new Pen(ColorTranslator.FromHtml("#1F6F66")))
            {
                e.Graphics.DrawRectangle(pen, 0, 0, form.Width - 1, form.Height - 1);
            }
        };
        return form;
    }
}
