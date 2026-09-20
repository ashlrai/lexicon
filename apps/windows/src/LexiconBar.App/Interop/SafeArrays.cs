using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.System.Com;

namespace LexiconBar.Interop;

/// <summary>
/// The only pointer code in the app. Two UI Automation calls hand back a raw
/// <c>SAFEARRAY*</c> that the caller owns — <c>GetRuntimeId</c> (VT_I4, the
/// element's identity) and <c>GetBoundingRectangles</c> (VT_R8, four doubles
/// per rectangle) — and both have to be read and then destroyed or the client
/// leaks a little on every focus change.
/// </summary>
internal static unsafe class SafeArrays
{
    /// <summary>Reads a one-dimensional SAFEARRAY of 4-byte integers and destroys it.</summary>
    internal static int[] ConsumeInt32(SAFEARRAY* array)
    {
        if (array is null) return Array.Empty<int>();
        try
        {
            if (array->cDims != 1 || array->cbElements != sizeof(int) || array->pvData is null)
            {
                return Array.Empty<int>();
            }

            int count = (int)array->rgsabound[0].cElements;
            if (count <= 0 || count > 4096) return Array.Empty<int>();
            int[] result = new int[count];
            new ReadOnlySpan<int>(array->pvData, count).CopyTo(result);
            return result;
        }
        finally
        {
            PInvoke.SafeArrayDestroy(array);
        }
    }

    /// <summary>Reads a one-dimensional SAFEARRAY of doubles and destroys it.</summary>
    internal static double[] ConsumeDouble(SAFEARRAY* array)
    {
        if (array is null) return Array.Empty<double>();
        try
        {
            if (array->cDims != 1 || array->cbElements != sizeof(double) || array->pvData is null)
            {
                return Array.Empty<double>();
            }

            int count = (int)array->rgsabound[0].cElements;
            // A wrapped line can produce a rectangle per visual line; a few
            // hundred is plenty and the cap keeps a hostile provider cheap.
            if (count <= 0 || count > 4096) return Array.Empty<double>();
            double[] result = new double[count];
            new ReadOnlySpan<double>(array->pvData, count).CopyTo(result);
            return result;
        }
        finally
        {
            PInvoke.SafeArrayDestroy(array);
        }
    }
}

/// <summary>
/// UI Automation returns strings as BSTRs that the caller owns. CsWin32's
/// <c>BSTR</c> is a bare pointer with no finalizer, so every one has to be
/// turned into a <see cref="string"/> and freed by hand.
/// </summary>
internal static unsafe class Bstr
{
    /// <summary>Copies a returned BSTR into a managed string and frees it.</summary>
    internal static string? Consume(BSTR value)
    {
        if (value.Value is null) return null;
        try
        {
            return value.ToString();
        }
        finally
        {
            PInvoke.SysFreeString(value);
        }
    }

    /// <summary>Allocates a BSTR to pass into COM. The caller must <see cref="Free"/> it.</summary>
    internal static BSTR Allocate(string value) =>
        (BSTR)System.Runtime.InteropServices.Marshal.StringToBSTR(value);

    internal static void Free(BSTR value)
    {
        if (value.Value is not null) System.Runtime.InteropServices.Marshal.FreeBSTR(value);
    }
}
