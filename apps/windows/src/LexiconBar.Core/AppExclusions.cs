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

    public List<string> ProcessNames { get; }

    public AppExclusions(IEnumerable<string>? processNames = null)
    {
        ProcessNames = (processNames ?? Defaults).ToList();
    }

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

    public bool IsExcluded(string? processNameOrPath)
    {
        string name = Normalize(processNameOrPath);
        if (name.Length == 0) return false;
        foreach (string entry in ProcessNames)
        {
            string pattern = Normalize(entry.Trim());
            if (pattern.Length == 0) continue;
            if (pattern.EndsWith('*'))
            {
                if (name.StartsWith(pattern[..^1], StringComparison.Ordinal)) return true;
            }
            else if (pattern == name)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>Adds <paramref name="processName"/> (exact, no wildcard) if not already matched.</summary>
    public void Exclude(string processName)
    {
        string name = Normalize(processName);
        if (name.Length == 0 || IsExcluded(name)) return;
        ProcessNames.Add(name);
    }

    /// <summary>Removes every entry that matches <paramref name="processName"/> (exact entries and wildcards alike).</summary>
    public void Include(string processName)
    {
        string name = Normalize(processName);
        ProcessNames.RemoveAll(entry =>
        {
            string pattern = Normalize(entry.Trim());
            if (pattern.EndsWith('*')) return name.StartsWith(pattern[..^1], StringComparison.Ordinal);
            return pattern == name;
        });
    }
}
