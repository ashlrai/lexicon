using System.Drawing;
using System.Drawing.Drawing2D;

namespace LexiconBar.Ui;

/// <summary>
/// Draws the tray icon at runtime instead of shipping a .ico.
///
/// Two reasons. It keeps a binary out of the repo for something that is four
/// arcs, and — more usefully — it means the icon can be re-rendered at the
/// notification area's actual DPI and recoloured for the "busy" and "error"
/// states without three more files. The Mac app uses an SF Symbol, which is the
/// same idea with a system font doing the drawing.
/// </summary>
internal static class TrayIconFactory
{
    internal enum State
    {
        Idle,
        Working,
        Problem,
    }

    private static readonly Dictionary<(State, int), Icon> Cache = new();

    internal static Icon Waveform(State state, int size = 32)
    {
        lock (Cache)
        {
            if (Cache.TryGetValue((state, size), out Icon? cached)) return cached;

            Icon icon = Render(state, size);
            Cache[(state, size)] = icon;
            return icon;
        }
    }

    private static Icon Render(State state, int size)
    {
        using Bitmap bitmap = new(size, size);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);

            Color color = state switch
            {
                State.Working => Color.FromArgb(255, 90, 160, 255),
                State.Problem => Color.FromArgb(255, 235, 110, 90),
                _ => Color.White,
            };

            float unit = size / 32f;
            using Pen pen = new(color, 2.6f * unit) { StartCap = LineCap.Round, EndCap = LineCap.Round };

            // Four bars of different heights: a waveform, legible at 16px.
            float[] heights = { 0.30f, 0.62f, 0.94f, 0.48f };
            float centre = size / 2f;
            float spacing = 6f * unit;
            float left = centre - ((heights.Length - 1) * spacing / 2f);

            for (int i = 0; i < heights.Length; i++)
            {
                float x = left + (i * spacing);
                float half = heights[i] * size / 2.4f;
                graphics.DrawLine(pen, x, centre - half, x, centre + half);
            }
        }

        // Icon.FromHandle does not own the HICON, so the bitmap's handle would
        // leak on every call; round-tripping through a cloned Icon detaches it.
        IntPtr handle = bitmap.GetHicon();
        try
        {
            using Icon temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            NativeIcon.Destroy(handle);
        }
    }

    private static class NativeIcon
    {
        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        [System.Runtime.InteropServices.DefaultDllImportSearchPaths(
            System.Runtime.InteropServices.DllImportSearchPath.System32)]
        private static extern bool DestroyIcon(IntPtr handle);

        internal static void Destroy(IntPtr handle)
        {
            if (handle != IntPtr.Zero) DestroyIcon(handle);
        }
    }
}
