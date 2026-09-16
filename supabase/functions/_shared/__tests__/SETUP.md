# Test Setup Guide

## Installing Deno

Deno is required to run the tests. Install it using one of these methods:

### macOS/Linux (using installer script)
```bash
curl -fsSL https://deno.land/install.sh | sh
```

### Using Homebrew (macOS)
```bash
brew install deno
```

### Using Cargo (Rust)
```bash
cargo install deno --locked
```

## Adding Deno to PATH

After installation, add Deno to your PATH:

### For zsh (macOS default)
```bash
echo 'export PATH="$HOME/.deno/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### For bash
```bash
echo 'export PATH="$HOME/.deno/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### For fish
```bash
echo 'set -Ux PATH "$HOME/.deno/bin" $PATH' >> ~/.config/fish/config.fish
```

## Verify Installation

```bash
deno --version
```

You should see something like:
```
deno 1.40.0
```

## Running Tests

Once Deno is installed and in your PATH:

```bash
# Run all tests
npm run test

# Or directly with deno
deno test --allow-net --allow-env supabase/functions/_shared/__tests__/
```

## Troubleshooting

### "deno: command not found"
- Make sure Deno is installed: `ls ~/.deno/bin/deno`
- Add Deno to your PATH (see above)
- Restart your terminal or run `source ~/.zshrc` (or `source ~/.bashrc`)

### Permission errors
- Make sure you're using `--allow-net --allow-env` flags
- On macOS, you may need to allow network access in System Preferences

