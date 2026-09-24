using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class Program
{
    private static string Quote(string value)
    {
        if (value == null) return "\"\"";
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void Copy(Stream input, Stream output, bool closeOutput)
    {
        try
        {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, read);
                output.Flush();
            }
        }
        catch { }
        finally
        {
            if (closeOutput)
            {
                try { output.Close(); } catch { }
            }
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string configPath = Path.Combine(baseDir, "host-runtime.txt");
            if (!File.Exists(configPath))
            {
                Console.Error.WriteLine("[rwmcp-chrome-bridge] runtime config missing");
                return 2;
            }

            string[] lines = File.ReadAllLines(configPath);
            if (lines.Length < 2)
            {
                Console.Error.WriteLine("[rwmcp-chrome-bridge] runtime config invalid");
                return 2;
            }

            string nodePath = lines[0].Trim();
            string hostJs = lines[1].Trim();
            if (!File.Exists(nodePath) || !File.Exists(hostJs))
            {
                Console.Error.WriteLine("[rwmcp-chrome-bridge] runtime path missing");
                return 2;
            }

            var argumentBuilder = new StringBuilder();
            argumentBuilder.Append(Quote(hostJs));
            foreach (string arg in args)
            {
                argumentBuilder.Append(' ');
                argumentBuilder.Append(Quote(arg));
            }

            var psi = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = argumentBuilder.ToString(),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using (var child = Process.Start(psi))
            {
                if (child == null) return 3;

                Stream consoleIn = Console.OpenStandardInput();
                Stream consoleOut = Console.OpenStandardOutput();
                Stream consoleErr = Console.OpenStandardError();

                var inputThread = new Thread(() => Copy(consoleIn, child.StandardInput.BaseStream, true));
                var outputThread = new Thread(() => Copy(child.StandardOutput.BaseStream, consoleOut, false));
                var errorThread = new Thread(() => Copy(child.StandardError.BaseStream, consoleErr, false));

                inputThread.IsBackground = true;
                outputThread.IsBackground = true;
                errorThread.IsBackground = true;

                inputThread.Start();
                outputThread.Start();
                errorThread.Start();

                child.WaitForExit();
                outputThread.Join(2000);
                errorThread.Join(2000);
                return child.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[rwmcp-chrome-bridge] launcher failed: " + ex.Message);
            return 4;
        }
    }
}
