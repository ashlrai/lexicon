namespace LexiconBar;

/// <summary>
/// Which apps "Fix everywhere" stays out of. Terminals (a rewrite in a shell is
/// a command, not a sentence) and password managers are excluded by default;
/// the user can add or remove entries.
///
/// Windows has no bundle identifier, so the identity used here is the
/// **process executable name without its extension, lowercased** —
/// <c>WindowsTerminal.exe</c> is <c>windowsterminal</c>. Entries match
/// case-insensitively; a trailing <c>*</c> matches a prefix
/// (<c>keepass*</c> catches KeePass, KeePass2 and KeePassXC).
///
/// Vendor prefixes are preferred over exact names for the password managers.
/// An exact list is wrong the moment a vendor renames an executable, and being
/// wrong here means reading a vault field and POSTing it to the local API.
/// <see cref="SecretFieldHeuristic"/> is the second, name-independent guard for
/// the managers that are not on any list.
///
/// Clearing the list entirely is allowed and means what it says: nothing is
/// excluded. See <see cref="IsEmpty"/> for why that is honoured rather than
/// silently refilled, and for what still protects a field when it is.
///
/// One Windows-specific hole is worth knowing about: the classic Credential
/// Manager control panel runs inside <c>rundll32.exe</c>, which cannot be
/// excluded by name without excluding every other control panel applet. The
/// label heuristic is what covers it ("credential", "password"), which is
/// exactly the case that heuristic exists for.
/// </summary>
public sealed class AppExclusions
{
    public static readonly IReadOnlyList<string> Defaults = new[]
    {
        // Terminals and shells: a rewrite in a shell is a command, not a sentence.
        "windowsterminal",
        "wt",
        "openconsole",
        "conhost",
        "cmd",
        "powershell",
        "pwsh",
        "mintty",
        "bash",
        "sh",
        "alacritty",
        "wezterm",
        "wezterm-gui",
        "kitty",
        "putty",
        "kitty_portable",
        "conemu",
        "conemu64",
        "cmder",
        "hyper",
        "tabby",
        "terminus",
        "fluentterminal*",
        "mobaxterm",
        "ttermpro",
        // Remote sessions: keystrokes and values here belong to another machine.
        "mstsc",
        "vmconnect",
        "ssh",
        // Windows' own credential surfaces.
        "credentialuibroker",
        "consent",
        "logonui",
        "lsass",
        "keymgr",
        // Password managers, vendor prefixes where possible.
        "1password*",
        "agilebits*",
        "bitwarden*",
        "dashlane*",
        "lastpass*",
        "keepass*",
        "keeweb*",
        "nordpass*",
        "enpass*",
        "proton pass*",
        "protonpass*",
        "keeper*",
        "roboform*",
        "strongbox*",
        "zohovault*",
        "safeincloud*",
        "stickypassword*",
        "psono*",
        "pwsafe*",
        "passwordsafe*",
        "authy*",
        "winauth*",
        "cryptomator*",
        "veracrypt*",
    };

    /// <summary>
    /// What the preferences window says in place of the usual hint when the
    /// list excludes nothing, and what it asks before saving one. It lives here
    /// rather than in the form so the words and <see cref="Defaults"/> cannot
    /// drift apart.
    /// </summary>
    public const string EmptyWarning =
        "No exclusions. Fix everywhere will run in terminals, in Windows' own sign-in and "
            + "credential prompts, and in password managers. Restore defaults puts the list back.";

    public List<string> ProcessNames { get; }

    /// <summary>
    /// A null list means "nobody has configured this yet", which is the only
    /// case that falls back to <see cref="Defaults"/>. An empty list means the
    /// user cleared it, and that is honoured.
    /// </summary>
    public AppExclusions(IEnumerable<string>? processNames = null)
    {
        ProcessNames = (processNames ?? Defaults).ToList();
    }

    /// <summary>
    /// True when this list excludes nothing at all: it is empty, or holds only
    /// blanks.
    ///
    /// An empty list is honoured rather than quietly refilled with
    /// <see cref="Defaults"/>, the same way the macOS app honours an emptied
    /// excluded-apps list. Someone who deletes every entry has asked for Fix
    /// everywhere in every app and is entitled to get it. What it must never be
    /// is silent, and on Windows the list is one multi-line textbox that a
    /// single Ctrl+A can clear, so the preferences window shows
    /// <see cref="EmptyWarning"/> in place of the usual hint and asks before
    /// saving one. This is the property it asks.
    ///
    /// Two guards survive an empty list, because neither is a name on it: UIA's
    /// own <c>IsPassword</c>, which refuses a masked input before anything
    /// else, and <see cref="SecretFieldHeuristic"/>, which refuses a field
    /// whose labels read like a secret. They are not a substitute for the list.
    /// A password manager's notes field, its search box and its custom fields
    /// are neither masked nor labelled "password".
    /// </summary>
    public bool IsEmpty => !ProcessNames.Any(entry => Normalize(entry.Trim()).Length > 0);

    /// <summary>
    /// Normalizes whatever the caller has — a full path, an executable name, a
    /// bare process name — to the lowercased stem this class matches on.
    /// </summary>
    public static string Normalize(string? processNameOrPath)
    {
        if (string.IsNullOrWhiteSpace(processNameOrPath)) return string.Empty;
        string name = processNameOrPath.Trim();
        int slash = name.LastIndexOfAny(new[] { '\\', '/' });
        if (slash >= 0) name = name[(slash + 1)..];
        if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
        return name.ToLowerInvariant();
    }

    public bool IsExcluded(string? processNameOrPath) => MatchingEntry(processNameOrPath) is not null;

    /// <summary>
    /// The list entry that excludes <paramref name="processNameOrPath"/>, as
    /// the user wrote it, or null when nothing does.
    ///
    /// Exposed alongside <see cref="IsExcluded"/> because the tray menu has to
    /// be able to name the rule it is up against: <c>1password</c> comes off
    /// the list when you untick the app and <c>1password*</c> does not, and a
    /// checkbox that springs back without saying why is worse than one that
    /// cannot be ticked.
    /// </summary>
    public string? MatchingEntry(string? processNameOrPath)
    {
        string name = Normalize(processNameOrPath);
        if (name.Length == 0) return null;
        foreach (string entry in ProcessNames)
        {
            string pattern = Normalize(entry.Trim());
            if (pattern.Length == 0) continue;
            if (pattern.EndsWith('*'))
            {
                if (name.StartsWith(pattern[..^1], StringComparison.Ordinal)) return entry;
            }
            else if (pattern == name)
            {
                return entry;
            }
        }
        return null;
    }

    /// <summary>Adds <paramref name="processName"/> (exact, no wildcard) if not already matched.</summary>
    public void Exclude(string processName)
    {
        string name = Normalize(processName);
        if (name.Length == 0 || IsExcluded(name)) return;
        ProcessNames.Add(name);
    }

    /// <summary>
    /// Removes the exact entry for <paramref name="processName"/> and nothing
    /// else. A wildcard that still matches is <b>left alone</b>, and returned.
    ///
    /// This used to remove every rule that matched, wildcards included, which
    /// made "Fix everywhere in 1Password" a switch that silently deleted
    /// <c>1password*</c> and so admitted every other 1Password executable,
    /// current and future, on the strength of one click about one of them.
    /// <see cref="Exclude"/> only ever adds an exact name back, so the rule was
    /// gone for good. Widening a rule that exists to keep a vault out is not
    /// what that click means, so the narrow removal is all that happens and the
    /// caller is handed the rule that still covers the app, to say why nothing
    /// changed. The macOS app made the same change to its own `include`.
    /// </summary>
    /// <returns>The rule that still excludes the app, or null when it is now allowed.</returns>
    public string? Include(string processName)
    {
        string name = Normalize(processName);
        if (name.Length == 0) return null;
        ProcessNames.RemoveAll(entry => Normalize(entry.Trim()) == name);
        return MatchingEntry(name);
    }
}
