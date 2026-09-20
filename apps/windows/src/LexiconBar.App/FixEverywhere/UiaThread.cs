using System.Diagnostics;

namespace LexiconBar.FixEverywhere;

/// <summary>
/// The one thread every UI Automation call is made on, and where all the Fix
/// everywhere state lives. The counterpart of <c>AXThread</c> in the macOS app,
/// and it exists for the same two reasons plus one that is Windows-specific:
///
/// <list type="number">
/// <item>Cross-process UIA calls block. Making them on the UI thread freezes
///   the tray menu whenever the app being watched is busy.</item>
/// <item>Microsoft's guidance is explicit that a UIA client must not call back
///   into UI Automation from inside an event handler — the handler runs on a
///   UIA-owned thread and re-entering can deadlock. So handlers here do nothing
///   but post work to this queue.</item>
/// <item>This thread is MTA. A UIA client on an STA thread needs a running
///   message pump for callbacks to be delivered, and the WinForms pump is on a
///   different thread; MTA sidesteps that entirely.</item>
/// </list>
///
/// UNVERIFIED on real Windows, like everything else under this folder.
/// </summary>
internal sealed class UiaThread : IDisposable
{
    private readonly object _gate = new();
    private readonly Queue<Action> _immediate = new();
    private readonly List<(double DueSeconds, Action Work)> _delayed = new();
    private readonly Thread _thread;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private bool _stopping;

    internal UiaThread()
    {
        _thread = new Thread(Loop)
        {
            IsBackground = true,
            Name = "LexiconBar UIA",
        };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
    }

    /// <summary>
    /// Monotonic seconds. The burst detector is fed from this rather than from
    /// the wall clock so that a clock adjustment cannot make a run look as
    /// though it has been quiet for an hour.
    /// </summary>
    internal double Now => _clock.Elapsed.TotalSeconds;

    internal bool IsCurrent => Thread.CurrentThread == _thread;

    internal void Post(Action work)
    {
        lock (_gate)
        {
            if (_stopping) return;
            _immediate.Enqueue(work);
            Monitor.Pulse(_gate);
        }
    }

    /// <summary>
    /// Runs <paramref name="work"/> on this thread and waits for the answer.
    /// Only for start-up: calling this from the UI thread while the UIA thread
    /// is blocked on a cross-process call would freeze the tray.
    /// </summary>
    internal T Invoke<T>(Func<T> work)
    {
        if (IsCurrent) return work();

        using ManualResetEventSlim done = new(false);
        T result = default!;
        Exception? failure = null;

        Post(() =>
        {
            try
            {
                result = work();
            }
            catch (Exception ex)
            {
                failure = ex;
            }
            finally
            {
                done.Set();
            }
        });

        if (!done.Wait(TimeSpan.FromSeconds(20)))
        {
            throw new TimeoutException("The UI Automation thread did not answer within 20 seconds.");
        }

        if (failure is not null) throw failure;
        return result;
    }

    internal void PostAfter(double seconds, Action work)
    {
        lock (_gate)
        {
            if (_stopping) return;
            _delayed.Add((Now + seconds, work));
            Monitor.Pulse(_gate);
        }
    }

    private void Loop()
    {
        while (true)
        {
            Action? work = null;
            lock (_gate)
            {
                while (true)
                {
                    if (_stopping) return;

                    if (_immediate.Count > 0)
                    {
                        work = _immediate.Dequeue();
                        break;
                    }

                    double now = Now;
                    int ready = _delayed.FindIndex(item => item.DueSeconds <= now);
                    if (ready >= 0)
                    {
                        work = _delayed[ready].Work;
                        _delayed.RemoveAt(ready);
                        break;
                    }

                    int waitMs = Timeout.Infinite;
                    if (_delayed.Count > 0)
                    {
                        double soonest = _delayed.Min(item => item.DueSeconds);
                        waitMs = Math.Max(1, (int)Math.Ceiling((soonest - now) * 1000));
                    }

                    Monitor.Wait(_gate, waitMs);
                }
            }

            try
            {
                work?.Invoke();
            }
            catch (Exception ex)
            {
                // A provider that goes away mid-call throws COMException, and a
                // dead element throws ElementNotAvailable. Neither is a reason
                // to take the whole watcher down: the next focus change
                // rebuilds everything anyway.
                Log.Warn($"UIA work item failed: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _stopping = true;
            _immediate.Clear();
            _delayed.Clear();
            Monitor.PulseAll(_gate);
        }

        _thread.Join(TimeSpan.FromSeconds(2));
    }
}
