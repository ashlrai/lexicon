using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace LexiconBar;

/// <summary>
/// Talks to <c>lexicon serve</c> on loopback, with the bearer token from
/// <c>serve.json</c>. The token file is read lazily and re-read after any
/// failure, so restarting the server with a fresh token heals on the next burst
/// instead of needing the tray app restarted.
///
/// A direct port of <c>NormalizeClient.swift</c> apart from where the file
/// lives; see <see cref="ServePaths"/> for that, because the answer is not the
/// one you would guess.
/// </summary>
public sealed class NormalizeClient : IDisposable
{
    public abstract record Failure(string Description)
    {
        public sealed record NoCredentials(string SearchedPath) : Failure(
            $"serve.json not found at {SearchedPath}; run `lexicon serve` on this machine.");

        public sealed record Transport(string Why) : Failure($"Local API unreachable: {Why}");

        public sealed record Http(int Status, string Body) : Failure(
            $"Local API returned {Status}{(Body.Length == 0 ? "" : ": " + Body)}");

        public sealed record BadBody() : Failure("Local API returned an unexpected body.");
    }

    public sealed record Result(NormalizeResponse? Response, Failure? Failure)
    {
        public bool Ok => Response is not null;
    }

    private readonly HttpClient _http;
    private readonly object _gate = new();
    private ServeCredentials? _cached;
    private string? _cachedPath;

    public NormalizeClient(TimeSpan? timeout = null)
    {
        _http = new HttpClient(new SocketsHttpHandler
        {
            // Loopback only, no proxy, no connection reuse surprises.
            UseProxy = false,
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromMilliseconds(500),
        })
        {
            Timeout = timeout ?? TimeSpan.FromSeconds(1.5),
        };
    }

    /// <summary>The path <c>serve.json</c> was last found at, for the doctor window.</summary>
    public string? ResolvedPath => _cachedPath;

    public ServeCredentials? Credentials(bool reload = false)
    {
        lock (_gate)
        {
            if (!reload && _cached is not null) return _cached;
            _cached = null;
            _cachedPath = null;

            IReadOnlyDictionary<string, string?> env = ServePaths.CurrentEnvironment();
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            foreach (string candidate in ServePaths.Candidates(env, home))
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    if (ServeCredentials.Parse(File.ReadAllText(candidate)) is not ServeCredentials parsed) continue;
                    _cached = parsed;
                    _cachedPath = candidate;
                    return parsed;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    // Being read by the server right now; try the next one and
                    // then try again on the next burst.
                }
            }

            return null;
        }
    }

    public void InvalidateCredentials()
    {
        lock (_gate)
        {
            _cached = null;
        }
    }

    /// <summary><c>POST /normalize</c>.</summary>
    public async Task<Result> NormalizeAsync(string text, CancellationToken cancellation = default)
    {
        if (Credentials() is not ServeCredentials credentials)
        {
            IReadOnlyDictionary<string, string?> env = ServePaths.CurrentEnvironment();
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return new Result(null, new Failure.NoCredentials(ServePaths.Candidates(env, home).FirstOrDefault() ?? "(none)"));
        }

        using HttpRequestMessage request = new(HttpMethod.Post, new Uri(credentials.BaseUri, "normalize"))
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new Dictionary<string, string> { ["text"] = text }),
                Encoding.UTF8,
                "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credentials.Token);

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, cancellation).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            InvalidateCredentials();
            return new Result(null, new Failure.Transport(ex.Message));
        }

        using (response)
        {
            if (response.StatusCode != HttpStatusCode.OK)
            {
                if (response.StatusCode == HttpStatusCode.Unauthorized) InvalidateCredentials();
                string body = await ReadCappedAsync(response, cancellation).ConfigureAwait(false);
                return new Result(null, new Failure.Http((int)response.StatusCode, body));
            }

            string json = await response.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false);
            return NormalizeResponse.Parse(json) is NormalizeResponse parsed
                ? new Result(parsed, null)
                : new Result(null, new Failure.BadBody());
        }
    }

    /// <summary><c>GET /health</c>. Returns the term count, for the doctor window.</summary>
    public async Task<int?> HealthAsync(CancellationToken cancellation = default)
    {
        if (Credentials() is not ServeCredentials credentials) return null;
        try
        {
            using HttpRequestMessage request = new(HttpMethod.Get, new Uri(credentials.BaseUri, "health"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credentials.Token);
            using HttpResponseMessage response = await _http.SendAsync(request, cancellation).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.OK) return null;

            string json = await response.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false);
            using JsonDocument document = JsonDocument.Parse(json);
            return document.RootElement.TryGetProperty("terms", out JsonElement terms)
                   && terms.TryGetInt32(out int count)
                ? count
                : 0;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException
                                      or OperationCanceledException or JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// <c>POST /add {canonical, never:[original]}</c> — the bubble's Never button.
    /// </summary>
    public Task<bool> NeverAsync(string canonical, string original, CancellationToken cancellation = default) =>
        PostAsync("add", new Dictionary<string, object>
        {
            ["canonical"] = canonical,
            ["never"] = new[] { original },
        }, cancellation);

    /// <summary>
    /// <c>POST /learn {heard, meant}</c> — the bubble's Add button.
    /// </summary>
    public Task<bool> LearnAsync(string heard, string meant, CancellationToken cancellation = default) =>
        PostAsync("learn", new Dictionary<string, object>
        {
            ["heard"] = heard,
            ["meant"] = meant,
        }, cancellation);

    private async Task<bool> PostAsync(
        string route,
        Dictionary<string, object> body,
        CancellationToken cancellation)
    {
        if (Credentials() is not ServeCredentials credentials) return false;
        try
        {
            using HttpRequestMessage request = new(HttpMethod.Post, new Uri(credentials.BaseUri, route))
            {
                Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credentials.Token);
            using HttpResponseMessage response = await _http.SendAsync(request, cancellation).ConfigureAwait(false);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            InvalidateCredentials();
            return false;
        }
    }

    private static async Task<string> ReadCappedAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        try
        {
            string body = await response.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false);
            return body.Length <= 200 ? body : body[..200];
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            return string.Empty;
        }
    }

    public void Dispose() => _http.Dispose();
}
