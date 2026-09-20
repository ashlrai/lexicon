# Homebrew formula for @ashlr/lexicon. Published to github.com/ashlrai/homebrew-tap
# as Formula/lexicon.rb; bump `url` and `sha256` on every release (see docs/RELEASING.md):
#   curl -sL https://github.com/ashlrai/lexicon/archive/refs/tags/v<version>.tar.gz | shasum -a 256
class Lexicon < Formula
  desc "Personal lexicon for voice-to-agents: fixes the words STT gets wrong"
  homepage "https://github.com/ashlrai/lexicon"
  url "https://github.com/ashlrai/lexicon/archive/refs/tags/v0.5.0.tar.gz"
  sha256 "7a644716f7494f03c8040a6622044570b11ad1533fcfa8457d6ce3533bf630fa"
  license "MIT"
  head "https://github.com/ashlrai/lexicon.git", branch: "main"

  depends_on "node"
  # `lexicon voice` (local push-to-talk) needs both; everything else works without them.
  depends_on "ffmpeg" => :recommended
  depends_on "whisper.cpp" => :recommended

  def install
    # The tarball ships TypeScript sources only: install the dev toolchain,
    # build dist/ and the plugin bundles, then install the package globally
    # into libexec (the `files` list in package.json keeps node_modules out).
    system "npm", "install", *std_npm_args(prefix: false)
    system "npm", "run", "build"
    system "npm", "run", "build:bundle"
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/lexicon --version")
    ENV["HOME"] = testpath
    system bin/"lexicon", "add", "Ashlr.AI", "Ashler", "--category", "brand"
    assert_match "tell Ashlr.AI to ship it", shell_output("#{bin}/lexicon normalize 'tell Ashler to ship it'")
  end
end
